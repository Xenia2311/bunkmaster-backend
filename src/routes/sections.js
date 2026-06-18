const express = require("express");
const { body, validationResult } = require("express-validator");

const prisma = require("../utils/prisma");
const { requireAuth, requireSectionRole } = require("../middleware/auth");
const { generateJoinCode } = require("../utils/joinCode");

const router = express.Router();

/**
 * POST /sections
 * Create a new section. The creator automatically becomes a CR.
 * body: { name, institutionName? }
 */
router.post(
  "/",
  requireAuth,
  [
    body("name").trim().notEmpty().withMessage("Section name is required"),
    body("institutionName").optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { name, institutionName } = req.body;

      // Generate a unique join code (retry on rare collision)
      let joinCode;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateJoinCode();
        const exists = await prisma.section.findUnique({ where: { joinCode: candidate } });
        if (!exists) {
          joinCode = candidate;
          break;
        }
      }
      if (!joinCode) {
        return res.status(500).json({ error: "Could not generate a unique join code, please retry" });
      }

      const section = await prisma.$transaction(async (tx) => {
        const newSection = await tx.section.create({
          data: { name, institutionName: institutionName || null, joinCode },
        });

        await tx.sectionMembership.create({
          data: {
            userId: req.user.id,
            sectionId: newSection.id,
            role: "cr",
            batchNumber: 1,
          },
        });

        // Seed an empty 5-day x 9-slot timetable, marking slot index 4 as BREAK
        const BREAK_SLOT_INDEX = 4;
        const slotsData = [];
        for (let day = 0; day < 5; day++) {
          for (let slot = 0; slot < 9; slot++) {
            slotsData.push({
              sectionId: newSection.id,
              dayOfWeek: day,
              slotIndex: slot,
              isBreak: slot === BREAK_SLOT_INDEX,
            });
          }
        }
        await tx.timetableSlot.createMany({ data: slotsData });

        return newSection;
      });

      res.status(201).json({
        section: {
          id: section.id,
          name: section.name,
          joinCode: section.joinCode,
          institutionName: section.institutionName,
        },
        role: "cr",
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /sections/join
 * Join an existing section via its join code.
 * body: { joinCode, batchNumber? }
 */
router.post(
  "/join",
  requireAuth,
  [
    body("joinCode").trim().notEmpty().withMessage("Join code is required"),
    body("batchNumber").optional().isInt({ min: 1, max: 4 }).withMessage("batchNumber must be 1-4"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { joinCode, batchNumber } = req.body;

      const section = await prisma.section.findUnique({
        where: { joinCode: joinCode.toUpperCase() },
      });

      if (!section) {
        return res.status(404).json({ error: "No section found with that join code" });
      }

      const existing = await prisma.sectionMembership.findUnique({
        where: { userId_sectionId: { userId: req.user.id, sectionId: section.id } },
      });

      if (existing) {
        return res.status(409).json({ error: "You are already a member of this section" });
      }

      const membership = await prisma.sectionMembership.create({
        data: {
          userId: req.user.id,
          sectionId: section.id,
          role: "student",
          batchNumber: batchNumber || 1,
        },
      });

      res.status(201).json({
        section: { id: section.id, name: section.name, joinCode: section.joinCode },
        role: membership.role,
        batchNumber: membership.batchNumber,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /sections/:sectionId
 * Get section details: subjects, members, your role/batch.
 */
router.get("/:sectionId", requireAuth, requireSectionRole(null), async (req, res, next) => {
  try {
    const section = await prisma.section.findUnique({
      where: { id: req.params.sectionId },
      include: {
        subjects: { orderBy: { createdAt: "asc" } },
        memberships: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    });

    if (!section) {
      return res.status(404).json({ error: "Section not found" });
    }

    res.json({
      section: {
        id: section.id,
        name: section.name,
        joinCode: section.joinCode,
        institutionName: section.institutionName,
        semesterStartDate: section.semesterStartDate,
      },
      subjects: section.subjects,
      members: section.memberships.map((m) => ({
        userId: m.userId,
        name: m.user.name,
        email: m.user.email,
        role: m.role,
        batchNumber: m.batchNumber,
      })),
      yourRole: req.membership.role,
      yourBatchNumber: req.membership.batchNumber,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /sections/:sectionId
 * CR/SR only: update section settings (currently: semesterStartDate).
 * body: { semesterStartDate: "YYYY-MM-DD" }
 */
router.patch(
  "/:sectionId",
  requireAuth,
  requireSectionRole(["cr", "sr"]),
  [body("semesterStartDate").optional().isISO8601().withMessage("semesterStartDate must be YYYY-MM-DD")],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { semesterStartDate } = req.body;

      const updated = await prisma.section.update({
        where: { id: req.params.sectionId },
        data: {
          ...(semesterStartDate !== undefined ? { semesterStartDate: new Date(semesterStartDate) } : {}),
        },
      });

      res.json({
        section: {
          id: updated.id,
          name: updated.name,
          joinCode: updated.joinCode,
          institutionName: updated.institutionName,
          semesterStartDate: updated.semesterStartDate,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /sections/:sectionId/members/:userId
 * CR/SR only: update a member's role or batch number.
 * body: { role?, batchNumber? }
 */
router.patch(
  "/:sectionId/members/:userId",
  requireAuth,
  requireSectionRole(["cr", "sr"]),
  [
    body("role").optional().isIn(["student", "cr", "sr"]),
    body("batchNumber").optional().isInt({ min: 1, max: 4 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { role, batchNumber } = req.body;
      const { sectionId, userId } = req.params;

      const membership = await prisma.sectionMembership.findUnique({
        where: { userId_sectionId: { userId, sectionId } },
      });

      if (!membership) {
        return res.status(404).json({ error: "Member not found in this section" });
      }

      const updated = await prisma.sectionMembership.update({
        where: { userId_sectionId: { userId, sectionId } },
        data: {
          ...(role !== undefined ? { role } : {}),
          ...(batchNumber !== undefined ? { batchNumber } : {}),
        },
      });

      res.json({
        userId: updated.userId,
        role: updated.role,
        batchNumber: updated.batchNumber,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /sections/:sectionId
 * CR/SR only: update section-level settings, currently semesterStartDate.
 * body: { semesterStartDate: "YYYY-MM-DD" }
 */
router.patch(
  "/:sectionId",
  requireAuth,
  requireSectionRole(["cr", "sr"]),
  [body("semesterStartDate").isISO8601().withMessage("semesterStartDate must be a valid date (YYYY-MM-DD)")],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const updated = await prisma.section.update({
        where: { id: req.params.sectionId },
        data: { semesterStartDate: new Date(req.body.semesterStartDate) },
      });

      res.json({
        section: {
          id: updated.id,
          name: updated.name,
          semesterStartDate: updated.semesterStartDate,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;

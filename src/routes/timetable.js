const express = require("express");
const { body, param, validationResult } = require("express-validator");

const prisma = require("../utils/prisma");
const { requireAuth, requireSectionRole } = require("../middleware/auth");

const router = express.Router({ mergeParams: true });

/**
 * GET /sections/:sectionId/timetable
 * Returns the full 5x9 timetable with lecture + lab assignments.
 */
router.get("/", requireAuth, requireSectionRole(null), async (req, res, next) => {
  try {
    const slots = await prisma.timetableSlot.findMany({
      where: { sectionId: req.params.sectionId },
      include: {
        subject: { select: { id: true, name: true } },
        labSlots: {
          include: { subject: { select: { id: true, name: true } } },
        },
      },
      orderBy: [{ dayOfWeek: "asc" }, { slotIndex: "asc" }],
    });

    res.json({ timetable: slots });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /sections/:sectionId/timetable/:dayOfWeek/:slotIndex
 * CR/SR only: set the lecture subject and/or lab assignments for a slot.
 * body: { subjectId?: string|null, labAssignments?: { batchNumber: number, subjectId: string|null }[] }
 */
router.put(
  "/:dayOfWeek/:slotIndex",
  requireAuth,
  requireSectionRole(["cr", "sr"]),
  [
    param("dayOfWeek").isInt({ min: 0, max: 4 }),
    param("slotIndex").isInt({ min: 0, max: 8 }),
    body("subjectId").optional({ nullable: true }).isString(),
    body("labAssignments").optional().isArray(),
    body("labAssignments.*.batchNumber").optional().isInt({ min: 1, max: 4 }),
    body("labAssignments.*.subjectId").optional({ nullable: true }).isString(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { sectionId, dayOfWeek, slotIndex } = req.params;
      const { subjectId, labAssignments } = req.body;

      const slot = await prisma.timetableSlot.findUnique({
        where: {
          sectionId_dayOfWeek_slotIndex: {
            sectionId,
            dayOfWeek: Number(dayOfWeek),
            slotIndex: Number(slotIndex),
          },
        },
      });

      if (!slot) {
        return res.status(404).json({ error: "Timetable slot not found" });
      }

      if (slot.isBreak) {
        return res.status(400).json({ error: "Cannot assign a subject to a break slot" });
      }

      // Validate referenced subjects belong to this section
      const subjectIdsToCheck = new Set();
      if (subjectId) subjectIdsToCheck.add(subjectId);
      if (labAssignments) {
        labAssignments.forEach((la) => {
          if (la.subjectId) subjectIdsToCheck.add(la.subjectId);
        });
      }
      if (subjectIdsToCheck.size > 0) {
        const count = await prisma.subject.count({
          where: { id: { in: [...subjectIdsToCheck] }, sectionId },
        });
        if (count !== subjectIdsToCheck.size) {
          return res.status(400).json({ error: "One or more subjectIds are invalid for this section" });
        }
      }

      const updated = await prisma.$transaction(async (tx) => {
        const updatedSlot = await tx.timetableSlot.update({
          where: { id: slot.id },
          data: { ...(subjectId !== undefined ? { subjectId } : {}) },
        });

        if (labAssignments) {
          for (const la of labAssignments) {
            await tx.timetableLabSlot.upsert({
              where: {
                timetableSlotId_batchNumber: {
                  timetableSlotId: slot.id,
                  batchNumber: la.batchNumber,
                },
              },
              update: { subjectId: la.subjectId ?? null },
              create: {
                timetableSlotId: slot.id,
                batchNumber: la.batchNumber,
                subjectId: la.subjectId ?? null,
              },
            });
          }
        }

        return tx.timetableSlot.findUnique({
          where: { id: slot.id },
          include: {
            subject: { select: { id: true, name: true } },
            labSlots: { include: { subject: { select: { id: true, name: true } } } },
          },
        });
      });

      res.json({ slot: updated });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;

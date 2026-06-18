const express = require("express");
const { body, validationResult } = require("express-validator");

const prisma = require("../utils/prisma");
const { requireAuth, requireSectionRole } = require("../middleware/auth");

const router = express.Router({ mergeParams: true });

/**
 * GET /sections/:sectionId/subjects
 */
router.get("/", requireAuth, requireSectionRole(null), async (req, res, next) => {
  try {
    const subjects = await prisma.subject.findMany({
      where: { sectionId: req.params.sectionId },
      orderBy: { createdAt: "asc" },
    });
    res.json({ subjects });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /sections/:sectionId/subjects
 * Any member can propose a subject (kept simple); could be restricted to CR/SR if desired.
 * body: { name, semesterTotal? }
 */
router.post(
  "/",
  requireAuth,
  requireSectionRole(null),
  [
    body("name").trim().notEmpty().withMessage("Subject name is required"),
    body("semesterTotal").optional().isInt({ min: 0 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { name, semesterTotal } = req.body;

      const subject = await prisma.subject.create({
        data: {
          sectionId: req.params.sectionId,
          name,
          semesterTotal: semesterTotal ?? null,
          createdById: req.user.id,
        },
      });

      res.status(201).json({ subject });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /sections/:sectionId/subjects/:subjectId
 * CR/SR only: rename or update semesterTotal.
 * body: { name?, semesterTotal? }
 */
router.patch(
  "/:subjectId",
  requireAuth,
  requireSectionRole(["cr", "sr"]),
  [
    body("name").optional().trim().notEmpty(),
    body("semesterTotal").optional({ nullable: true }).isInt({ min: 0 }),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { name, semesterTotal } = req.body;

      const subject = await prisma.subject.findFirst({
        where: { id: req.params.subjectId, sectionId: req.params.sectionId },
      });
      if (!subject) {
        return res.status(404).json({ error: "Subject not found in this section" });
      }

      const updated = await prisma.subject.update({
        where: { id: subject.id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(semesterTotal !== undefined ? { semesterTotal } : {}),
        },
      });

      res.json({ subject: updated });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /sections/:sectionId/subjects/:subjectId
 * CR/SR only.
 */
router.delete(
  "/:subjectId",
  requireAuth,
  requireSectionRole(["cr", "sr"]),
  async (req, res, next) => {
    try {
      const subject = await prisma.subject.findFirst({
        where: { id: req.params.subjectId, sectionId: req.params.sectionId },
      });
      if (!subject) {
        return res.status(404).json({ error: "Subject not found in this section" });
      }

      await prisma.subject.delete({ where: { id: subject.id } });

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;

const express = require("express");
const { body, validationResult } = require("express-validator");

const prisma = require("../utils/prisma");
const { requireAuth, requireSectionRole } = require("../middleware/auth");

const router = express.Router({ mergeParams: true });

/**
 * GET /sections/:sectionId/holidays?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Any member can view. Optional date range filter.
 */
router.get("/", requireAuth, requireSectionRole(null), async (req, res, next) => {
  try {
    const { from, to } = req.query;

    const where = { sectionId: req.params.sectionId };
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }

    const holidays = await prisma.holidayCalendar.findMany({
      where,
      orderBy: { date: "asc" },
    });

    res.json({ holidays });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /sections/:sectionId/holidays
 * CR/SR only. Add a holiday (national/college/custom).
 * body: { date: "YYYY-MM-DD", name: string, type?: "national"|"college"|"custom" }
 */
router.post(
  "/",
  requireAuth,
  requireSectionRole(["cr", "sr"]),
  [
    body("date").isISO8601().withMessage("date must be a valid ISO date (YYYY-MM-DD)"),
    body("name").trim().notEmpty().withMessage("name is required"),
    body("type").optional().isIn(["national", "college", "custom"]),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { date, name, type } = req.body;

      const holiday = await prisma.holidayCalendar.upsert({
        where: {
          sectionId_date: { sectionId: req.params.sectionId, date: new Date(date) },
        },
        update: { name, type: type || "custom" },
        create: {
          sectionId: req.params.sectionId,
          date: new Date(date),
          name,
          type: type || "custom",
        },
      });

      res.status(201).json({ holiday });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /sections/:sectionId/holidays/bulk
 * CR/SR only. Bulk-add holidays, e.g. importing a national holiday list.
 * body: { holidays: [{ date, name, type? }] }
 */
router.post(
  "/bulk",
  requireAuth,
  requireSectionRole(["cr", "sr"]),
  [body("holidays").isArray({ min: 1 })],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { holidays } = req.body;
      const sectionId = req.params.sectionId;

      const results = [];
      for (const h of holidays) {
        if (!h.date || !h.name) continue;
        const holiday = await prisma.holidayCalendar.upsert({
          where: { sectionId_date: { sectionId, date: new Date(h.date) } },
          update: { name: h.name, type: h.type || "national" },
          create: { sectionId, date: new Date(h.date), name: h.name, type: h.type || "national" },
        });
        results.push(holiday);
      }

      res.status(201).json({ holidays: results, count: results.length });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /sections/:sectionId/holidays/:holidayId
 * CR/SR only.
 */
router.delete(
  "/:holidayId",
  requireAuth,
  requireSectionRole(["cr", "sr"]),
  async (req, res, next) => {
    try {
      const holiday = await prisma.holidayCalendar.findFirst({
        where: { id: req.params.holidayId, sectionId: req.params.sectionId },
      });
      if (!holiday) {
        return res.status(404).json({ error: "Holiday not found in this section" });
      }

      await prisma.holidayCalendar.delete({ where: { id: holiday.id } });

      res.json({ success: true });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;

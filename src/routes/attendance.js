const express = require("express");
const { body, param, query, validationResult } = require("express-validator");

const prisma = require("../utils/prisma");
const { requireAuth, requireSectionRole, isClassAdmin } = require("../middleware/auth");
const {
  syncAttendanceForSection,
  syncAttendanceToToday,
  dateOnly,
} = require("../utils/attendanceSync");

const router = express.Router({ mergeParams: true });

/**
 * POST /sections/:sectionId/attendance/sync
 * Manual sync trigger. Any member can sync (it only generates records,
 * doesn't overwrite existing ones) - but date range is capped for students
 * to avoid abuse; CR/SR can pass an explicit range.
 *
 * body: { from?: "YYYY-MM-DD", to?: "YYYY-MM-DD" }
 * Defaults: from = section.semesterStartDate, to = today
 */
router.post(
  "/sync",
  requireAuth,
  requireSectionRole(null),
  [
    body("from").optional().isISO8601(),
    body("to").optional().isISO8601(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { from, to } = req.body;
      const sectionId = req.params.sectionId;

      let result;
      if (from || to) {
        // Custom range - restrict to CR/SR to avoid students requesting huge ranges
        if (!isClassAdmin(req.membership.role)) {
          return res.status(403).json({ error: "Only CR/SR can specify a custom sync range" });
        }
        const section = await prisma.section.findUnique({
          where: { id: sectionId },
          select: { semesterStartDate: true },
        });
        const fromDate = from ? new Date(from) : section?.semesterStartDate;
        const toDate = to ? new Date(to) : new Date();

        if (!fromDate) {
          return res.status(400).json({ error: "No 'from' date provided and section has no semesterStartDate set" });
        }

        result = await syncAttendanceForSection(sectionId, fromDate, toDate);
      } else {
        result = await syncAttendanceToToday(sectionId, null);
        if (result.skipped === "no_start_date") {
          return res.status(400).json({
            error: "Section has no semesterStartDate set. Ask your CR/SR to set one via PATCH /sections/:sectionId",
          });
        }
      }

      res.json({ synced: result });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /sections/:sectionId/attendance/stats
 * Per-subject derived stats for the authenticated student: attended,
 * conducted, percentage, and a simple prediction (replaces the old
 * client-side "Crunch Numbers").
 *
 * Lazily syncs from semesterStartDate to today first.
 *
 * Query params:
 *   target - attendance target percentage (default 75)
 *
 * NOTE: this route MUST be registered before GET /:date, otherwise Express
 * would match "/stats" as the :date param and fail date validation.
 */
router.get(
  "/stats",
  requireAuth,
  requireSectionRole(null),
  [query("target").optional().isFloat({ min: 0, max: 100 })],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const sectionId = req.params.sectionId;
      const target = req.query.target ? Number(req.query.target) : 75;

      // Lazy sync up to today
      const syncResult = await syncAttendanceToToday(sectionId, null);

      const subjects = await prisma.subject.findMany({
        where: { sectionId },
        select: { id: true, name: true, semesterTotal: true },
      });

      const records = await prisma.attendanceRecord.findMany({
        where: {
          userId: req.user.id,
          subjectId: { in: subjects.map((s) => s.id) },
        },
        select: { subjectId: true, status: true },
      });

      const stats = subjects.map((subject) => {
        const subjectRecords = records.filter((r) => r.subjectId === subject.id);

        const conducted = subjectRecords.filter(
          (r) => r.status === "attended" || r.status === "missed"
        ).length;
        const attended = subjectRecords.filter((r) => r.status === "attended").length;

        const percentage = conducted > 0 ? (attended / conducted) * 100 : 0;

        let prediction;
        if (conducted === 0) {
          prediction = "No lectures conducted yet.";
        } else if (percentage >= target) {
          // How many can be bunked before dropping below target
          let canBunk = 0;
          let a = attended;
          let t = conducted;
          while (t < 100000 && (a / (t + 1)) * 100 >= target) {
            t++;
            canBunk++;
          }
          prediction = `Can bunk ${canBunk} more class${canBunk === 1 ? "" : "es"} & stay safe.`;
        } else {
          let need = 0;
          let a = attended;
          let t = conducted;
          while (t < 100000 && ((a + 1) / (t + 1)) * 100 < target) {
            a++;
            t++;
            need++;
          }
          need++;
          prediction = `Attend next ${need} class${need === 1 ? "" : "es"} to hit target.`;
        }

        // Strategy: max possible if semesterTotal is set
        let maxPossible = null;
        if (subject.semesterTotal) {
          const remaining = Math.max(subject.semesterTotal - conducted, 0);
          maxPossible = ((attended + remaining) / subject.semesterTotal) * 100;
        }

        return {
          subjectId: subject.id,
          name: subject.name,
          attended,
          conducted,
          percentage: Math.round(percentage * 10) / 10,
          semesterTotal: subject.semesterTotal,
          maxPossiblePercentage: maxPossible !== null ? Math.round(maxPossible * 10) / 10 : null,
          prediction,
        };
      });

      res.json({ target, stats, syncInfo: syncResult });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /sections/:sectionId/attendance/:date
 * Get the authenticated student's schedule + attendance status for a
 * specific date (YYYY-MM-DD). Lazily syncs that date first so records
 * exist even if sync hasn't run yet.
 */
router.get(
  "/:date",
  requireAuth,
  requireSectionRole(null),
  [param("date").isISO8601().withMessage("date must be YYYY-MM-DD")],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const sectionId = req.params.sectionId;
      const targetDate = dateOnly(req.params.date);

      // Lazy sync just for this date to ensure records exist
      await syncAttendanceForSection(sectionId, targetDate, targetDate);

      const records = await prisma.attendanceRecord.findMany({
        where: { userId: req.user.id, date: targetDate },
        include: {
          subject: { select: { id: true, name: true } },
          timetableSlot: { select: { id: true, dayOfWeek: true, slotIndex: true } },
        },
        orderBy: { timetableSlot: { slotIndex: "asc" } },
      });

      res.json({
        date: req.params.date,
        records: records.map((r) => ({
          id: r.id,
          subject: r.subject,
          slotIndex: r.timetableSlot?.slotIndex ?? null,
          dayOfWeek: r.timetableSlot?.dayOfWeek ?? null,
          status: r.status,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /sections/:sectionId/attendance/:recordId
 * Mark a single attendance record as attended/missed. Students can only
 * update their own records, and only records that aren't `cancelled`.
 *
 * body: { status: "attended" | "missed" }
 */
router.patch(
  "/:recordId",
  requireAuth,
  requireSectionRole(null),
  [body("status").isIn(["attended", "missed"]).withMessage("status must be 'attended' or 'missed'")],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const record = await prisma.attendanceRecord.findUnique({
        where: { id: req.params.recordId },
      });

      if (!record || record.userId !== req.user.id) {
        return res.status(404).json({ error: "Attendance record not found" });
      }

      if (record.status === "cancelled") {
        return res.status(400).json({ error: "Cannot mark attendance for a cancelled lecture" });
      }

      const updated = await prisma.attendanceRecord.update({
        where: { id: record.id },
        data: { status: req.body.status },
      });

      res.json({ record: updated });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /sections/:sectionId/attendance/by-date/:date
 * Bulk-mark all of the authenticated student's records for a given date.
 *
 * body: { status: "attended" | "missed", subjectIds?: string[] }
 *   - If subjectIds is omitted, applies to ALL of that day's records.
 *   - `cancelled` records are always skipped.
 */
router.patch(
  "/by-date/:date",
  requireAuth,
  requireSectionRole(null),
  [
    param("date").isISO8601().withMessage("date must be YYYY-MM-DD"),
    body("status").isIn(["attended", "missed"]).withMessage("status must be 'attended' or 'missed'"),
    body("subjectIds").optional().isArray(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const targetDate = dateOnly(req.params.date);
      const { status, subjectIds } = req.body;

      const where = {
        userId: req.user.id,
        date: targetDate,
        status: { not: "cancelled" },
      };
      if (subjectIds && subjectIds.length > 0) {
        where.subjectId = { in: subjectIds };
      }

      const result = await prisma.attendanceRecord.updateMany({
        where,
        data: { status },
      });

      res.json({ updated: result.count });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;

const express = require("express");
const { body, param, query, validationResult } = require("express-validator");

const prisma = require("../utils/prisma");
const { requireAuth, requireSectionRole } = require("../middleware/auth");
const { syncAttendanceForSection, dateOnly, toTimetableDayOfWeek, toDateKey } = require("../utils/attendanceSync");

const router = express.Router({ mergeParams: true });

const DEFAULT_RESCHEDULE_WINDOW_DAYS = 14;
const MAX_RESCHEDULE_WINDOW_DAYS = 60;

/**
 * GET /sections/:sectionId/cancellations?from=&to=
 * List cancellations in a date range. Any member can view.
 */
router.get(
  "/",
  requireAuth,
  requireSectionRole(null),
  [
    query("from").optional().isISO8601(),
    query("to").optional().isISO8601(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { from, to } = req.query;
      const where = { sectionId: req.params.sectionId };

      if (from || to) {
        where.date = {};
        if (from) where.date.gte = dateOnly(from);
        if (to) where.date.lte = dateOnly(to);
      }

      const cancellations = await prisma.cancellation.findMany({
        where,
        include: {
          subject: { select: { id: true, name: true } },
          timetableSlot: { select: { id: true, dayOfWeek: true, slotIndex: true, isBreak: true } },
        },
        orderBy: { date: "asc" },
      });

      res.json({ cancellations });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /sections/:sectionId/cancellations
 * CR/SR only. Mark a scheduled lecture/lab as cancelled for a given date.
 *
 * body: { date: "YYYY-MM-DD", timetableSlotId, subjectId, reason? }
 *
 * After creating the cancellation, re-syncs attendance for that date so
 * existing AttendanceRecord rows for (subjectId, date, timetableSlotId)
 * flip to status="cancelled" (the sync engine checks for matching
 * Cancellation rows).
 */
router.post(
  "/",
  requireAuth,
  requireSectionRole(["cr", "sr"]),
  [
    body("date").isISO8601().withMessage("date must be YYYY-MM-DD"),
    body("timetableSlotId").isString().notEmpty(),
    body("subjectId").isString().notEmpty(),
    body("reason").optional().trim(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const sectionId = req.params.sectionId;
      const { date, timetableSlotId, subjectId, reason } = req.body;
      const targetDate = dateOnly(date);

      // Validate the slot belongs to this section and isn't a break
      const slot = await prisma.timetableSlot.findFirst({
        where: { id: timetableSlotId, sectionId },
        include: { labSlots: true },
      });
      if (!slot) {
        return res.status(404).json({ error: "Timetable slot not found in this section" });
      }
      if (slot.isBreak) {
        return res.status(400).json({ error: "Cannot cancel a break slot" });
      }

      // Validate the subject is actually scheduled in this slot (lecture or lab)
      const isLecture = slot.subjectId === subjectId;
      const isLab = slot.labSlots.some((l) => l.subjectId === subjectId);
      if (!isLecture && !isLab) {
        return res.status(400).json({ error: "This subject is not scheduled in the given slot" });
      }

      // Prevent duplicate cancellations for the same date+slot+subject
      const existing = await prisma.cancellation.findFirst({
        where: { sectionId, date: targetDate, timetableSlotId, subjectId },
      });
      if (existing) {
        return res.status(409).json({ error: "This lecture is already marked as cancelled", cancellation: existing });
      }

      const cancellation = await prisma.cancellation.create({
        data: {
          sectionId,
          date: targetDate,
          timetableSlotId,
          subjectId,
          reason: reason || null,
          createdById: req.user.id,
          status: "cancelled",
        },
        include: {
          subject: { select: { id: true, name: true } },
          timetableSlot: { select: { id: true, dayOfWeek: true, slotIndex: true } },
        },
      });

      // Re-sync that date so existing AttendanceRecords flip to "cancelled"
      await syncAttendanceForSection(sectionId, targetDate, targetDate);
      await prisma.attendanceRecord.updateMany({
        where: { subjectId, date: targetDate, timetableSlotId },
        data: { status: "cancelled" },
      });

      res.status(201).json({ cancellation });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /sections/:sectionId/cancellations/:cancellationId/reschedule-options
 * CR/SR only. Suggests candidate date+slot combinations to reschedule a
 * cancelled lecture into.
 *
 * Looks at real calendar dates over the next `windowDays` (default 14,
 * max 60), skipping weekends and holidays. A slot is a candidate if:
 *   - It's not a break
 *   - It has NO subject assigned in the timetable grid (neither lecture
 *     nor any lab batch) - i.e. genuinely empty in the weekly pattern
 *   - No OTHER cancellation has already been rescheduled into that
 *     date+slot
 *
 * Query params:
 *   windowDays - how many days ahead to search (default 14, max 60)
 *
 * NOTE: this route must be registered BEFORE any generic "/:cancellationId"
 * routes to avoid Express matching "reschedule-options" as a param segment.
 * Since all routes here use distinct sub-paths under :cancellationId, this
 * is naturally fine, but kept early for clarity.
 */
router.get(
  "/:cancellationId/reschedule-options",
  requireAuth,
  requireSectionRole(["cr", "sr"]),
  [query("windowDays").optional().isInt({ min: 1, max: MAX_RESCHEDULE_WINDOW_DAYS })],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const sectionId = req.params.sectionId;
      const windowDays = req.query.windowDays ? Number(req.query.windowDays) : DEFAULT_RESCHEDULE_WINDOW_DAYS;

      const cancellation = await prisma.cancellation.findFirst({
        where: { id: req.params.cancellationId, sectionId },
        include: { subject: { select: { id: true, name: true } } },
      });
      if (!cancellation) {
        return res.status(404).json({ error: "Cancellation not found in this section" });
      }
      if (cancellation.status === "rescheduled") {
        return res.status(400).json({ error: "This cancellation has already been rescheduled", cancellation });
      }

      const today = dateOnly(new Date());
      const windowEnd = new Date(today);
      windowEnd.setUTCDate(windowEnd.getUTCDate() + windowDays);

      // All non-break timetable slots, with their lecture + lab assignments
      const allSlots = await prisma.timetableSlot.findMany({
        where: { sectionId, isBreak: false },
        include: { labSlots: true },
      });

      // A slot is "empty in the grid" if it has no lecture subject AND no lab subjects assigned
      const emptySlots = allSlots.filter(
        (slot) => !slot.subjectId && slot.labSlots.every((l) => !l.subjectId)
      );

      if (emptySlots.length === 0) {
        return res.json({
          cancellation: {
            id: cancellation.id,
            subject: cancellation.subject,
            originalDate: cancellation.date,
          },
          windowDays,
          options: [],
          message: "No empty slots found in the weekly timetable grid.",
        });
      }

      // Holidays in the window
      const holidays = await prisma.holidayCalendar.findMany({
        where: { sectionId, date: { gte: today, lte: windowEnd } },
        select: { date: true },
      });
      const holidayDateKeys = new Set(holidays.map((h) => toDateKey(h.date)));

      // Other cancellations already rescheduled INTO a date+slot within the window
      // (avoid double-booking the same empty slot on the same date)
      const rescheduledInto = await prisma.cancellation.findMany({
        where: {
          sectionId,
          status: "rescheduled",
          rescheduledDate: { gte: today, lte: windowEnd },
          id: { not: cancellation.id },
        },
        select: { rescheduledDate: true, rescheduledTimetableSlotId: true },
      });
      const takenKeys = new Set(
        rescheduledInto
          .filter((r) => r.rescheduledDate && r.rescheduledTimetableSlotId)
          .map((r) => `${toDateKey(r.rescheduledDate)}|${r.rescheduledTimetableSlotId}`)
      );

      // Group empty slots by dayOfWeek for quick lookup
      const emptySlotsByDay = new Map();
      for (const slot of emptySlots) {
        if (!emptySlotsByDay.has(slot.dayOfWeek)) emptySlotsByDay.set(slot.dayOfWeek, []);
        emptySlotsByDay.get(slot.dayOfWeek).push(slot);
      }

      const options = [];

      for (let d = new Date(today); d <= windowEnd; d.setUTCDate(d.getUTCDate() + 1)) {
        const current = new Date(d);
        const dateKey = toDateKey(current);

        const timetableDay = toTimetableDayOfWeek(current.getUTCDay());
        if (timetableDay === null) continue; // weekend
        if (holidayDateKeys.has(dateKey)) continue; // holiday

        const daySlots = emptySlotsByDay.get(timetableDay) || [];

        for (const slot of daySlots) {
          // Don't suggest the exact same date+slot as the original cancellation
          if (
            current.getTime() === dateOnly(cancellation.date).getTime() &&
            slot.id === cancellation.timetableSlotId
          ) {
            continue;
          }

          const key = `${dateKey}|${slot.id}`;
          if (takenKeys.has(key)) continue;

          options.push({
            date: dateKey,
            timetableSlotId: slot.id,
            dayOfWeek: slot.dayOfWeek,
            slotIndex: slot.slotIndex,
          });
        }
      }

      res.json({
        cancellation: {
          id: cancellation.id,
          subject: cancellation.subject,
          originalDate: cancellation.date,
          originalTimetableSlotId: cancellation.timetableSlotId,
        },
        windowDays,
        options,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /sections/:sectionId/cancellations/:cancellationId/reschedule
 * CR/SR only. Commit a cancelled lecture to a new date+slot.
 *
 * body: { date: "YYYY-MM-DD", timetableSlotId }
 *
 * Sets status="rescheduled", records the target, and generates
 * AttendanceRecord rows for the new date+slot+subject for all relevant
 * students (lecture -> whole section, lab -> matching batch only).
 */
router.post(
  "/:cancellationId/reschedule",
  requireAuth,
  requireSectionRole(["cr", "sr"]),
  [
    body("date").isISO8601().withMessage("date must be YYYY-MM-DD"),
    body("timetableSlotId").isString().notEmpty(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const sectionId = req.params.sectionId;
      const { date, timetableSlotId } = req.body;
      const targetDate = dateOnly(date);

      const cancellation = await prisma.cancellation.findFirst({
        where: { id: req.params.cancellationId, sectionId },
      });
      if (!cancellation) {
        return res.status(404).json({ error: "Cancellation not found in this section" });
      }
      if (cancellation.status === "rescheduled") {
        return res.status(400).json({ error: "This cancellation has already been rescheduled" });
      }

      const slot = await prisma.timetableSlot.findFirst({
        where: { id: timetableSlotId, sectionId },
      });
      if (!slot) {
        return res.status(404).json({ error: "Target timetable slot not found in this section" });
      }
      if (slot.isBreak) {
        return res.status(400).json({ error: "Cannot reschedule into a break slot" });
      }

      const updated = await prisma.cancellation.update({
        where: { id: cancellation.id },
        data: {
          status: "rescheduled",
          rescheduledDate: targetDate,
          rescheduledTimetableSlotId: timetableSlotId,
        },
        include: {
          subject: { select: { id: true, name: true } },
        },
      });

      // Determine which students need an AttendanceRecord for the new slot:
      // - If the cancelled item was a lecture, it applies to everyone.
      // - If it was a lab, it applies only to that batch.
      const originalSlot = await prisma.timetableSlot.findUnique({
        where: { id: cancellation.timetableSlotId },
        include: { labSlots: true },
      });

      const labMatch = originalSlot?.labSlots.find((l) => l.subjectId === cancellation.subjectId);

      let targetUserIds;
      if (labMatch) {
        const batchMembers = await prisma.sectionMembership.findMany({
          where: { sectionId, batchNumber: labMatch.batchNumber },
          select: { userId: true },
        });
        targetUserIds = batchMembers.map((m) => m.userId);
      } else {
        const allMembers = await prisma.sectionMembership.findMany({
          where: { sectionId },
          select: { userId: true },
        });
        targetUserIds = allMembers.map((m) => m.userId);
      }

      const recordsToCreate = targetUserIds.map((userId) => ({
        userId,
        subjectId: cancellation.subjectId,
        date: targetDate,
        status: "not_yet_occurred",
        timetableSlotId,
      }));

      let created = 0;
      if (recordsToCreate.length > 0) {
        const result = await prisma.attendanceRecord.createMany({
          data: recordsToCreate,
          skipDuplicates: true,
        });
        created = result.count;
      }

      res.json({ cancellation: updated, attendanceRecordsCreated: created });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;

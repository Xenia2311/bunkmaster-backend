const prisma = require("./prisma");

/**
 * ---------------------------------------------------------------------------
 * Attendance Sync Engine
 * ---------------------------------------------------------------------------
 *
 * Generates AttendanceRecord rows for students based on:
 *   - The section's weekly timetable (lecture + lab slots)
 *   - The holiday calendar (national/college/custom - no class that day)
 *   - Weekends (Sat/Sun are never scheduled - timetable only has Mon-Fri)
 *   - Cancellations (Phase 3) - if a cancellation exists for a slot/date,
 *     the generated record is marked `cancelled` instead of `not_yet_occurred`
 *     and does NOT count toward "conducted" totals.
 *
 * For each (date, timetableSlot) combination with a subject assigned:
 *   - Lecture slots apply to ALL students in the section.
 *   - Lab slots apply only to students whose batchNumber matches the
 *     TimetableLabSlot's batchNumber.
 *
 * Records are created idempotently: the unique constraint on
 * (userId, subjectId, date, timetableSlotId) means re-running sync for the
 * same range will not create duplicates (we upsert / skip-if-exists).
 *
 * Status logic for newly created records:
 *   - If the date is in the future (after "today"): `not_yet_occurred`
 *   - If the date is today or in the past: `not_yet_occurred` as well -
 *     the student (or the notification flow in Phase 4) is responsible for
 *     marking it `attended` / `missed`. We deliberately do NOT default past
 *     records to `missed`, since that would penalize students before they've
 *     had a chance to respond.
 *   - If a cancellation exists for that date+slot: `cancelled`
 * ---------------------------------------------------------------------------
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Convert a JS Date's getDay() (0=Sun..6=Sat) to our timetable's
 * dayOfWeek convention (0=Mon..4=Fri). Returns null for weekends.
 */
function toTimetableDayOfWeek(jsDay) {
  // jsDay: 0=Sun, 1=Mon, ..., 6=Sat
  if (jsDay === 0 || jsDay === 6) return null; // weekend
  return jsDay - 1; // Mon(1)->0 ... Fri(5)->4
}

/**
 * Normalize a Date to midnight UTC (date-only), matching how Prisma stores
 * @db.Date fields.
 */
function dateOnly(d) {
  const copy = new Date(d);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function toDateKey(d) {
  return dateOnly(d).toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/**
 * Sync attendance records for a section across a date range [from, to] (inclusive).
 *
 * @param {string} sectionId
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<{ created: number, scannedDays: number }>}
 */
async function syncAttendanceForSection(sectionId, from, to) {
  const fromDate = dateOnly(from);
  const toDate = dateOnly(to);

  if (fromDate > toDate) {
    return { created: 0, scannedDays: 0 };
  }

  // Load all the static data we need once up front
  const [timetableSlots, holidays, memberships, cancellations] = await Promise.all([
    prisma.timetableSlot.findMany({
      where: { sectionId, isBreak: false },
      include: { labSlots: true },
    }),
    prisma.holidayCalendar.findMany({
      where: { sectionId, date: { gte: fromDate, lte: toDate } },
    }),
    prisma.sectionMembership.findMany({
      where: { sectionId },
      select: { userId: true, batchNumber: true },
    }),
    prisma.cancellation.findMany({
      where: { sectionId, date: { gte: fromDate, lte: toDate } },
    }),
  ]);

  const holidayDateKeys = new Set(holidays.map((h) => toDateKey(h.date)));

  // Map: "dayOfWeek" -> array of relevant slots (lecture or lab)
  const slotsByDay = new Map();
  for (const slot of timetableSlots) {
    if (!slotsByDay.has(slot.dayOfWeek)) slotsByDay.set(slot.dayOfWeek, []);
    slotsByDay.get(slot.dayOfWeek).push(slot);
  }

  // Map: "date|timetableSlotId|subjectId" -> cancellation row (for quick lookup)
  const cancellationMap = new Map();
  for (const c of cancellations) {
    const key = `${toDateKey(c.date)}|${c.timetableSlotId}|${c.subjectId}`;
    cancellationMap.set(key, c);
  }

  // Records to create, batched
  const recordsToCreate = [];
  let scannedDays = 0;

  for (let d = new Date(fromDate); d <= toDate; d.setUTCDate(d.getUTCDate() + 1)) {
    const current = new Date(d);
    const dateKey = toDateKey(current);

    const timetableDay = toTimetableDayOfWeek(current.getUTCDay());
    if (timetableDay === null) continue; // weekend
    if (holidayDateKeys.has(dateKey)) continue; // holiday - no records at all

    scannedDays++;

    const daySlots = slotsByDay.get(timetableDay) || [];

    for (const slot of daySlots) {
      // --- Lecture (applies to all students) ---
      if (slot.subjectId) {
        const cancellation = cancellationMap.get(`${dateKey}|${slot.id}|${slot.subjectId}`);
        const status = cancellation ? "cancelled" : "not_yet_occurred";

        for (const member of memberships) {
          recordsToCreate.push({
            userId: member.userId,
            subjectId: slot.subjectId,
            date: current.toISOString(),
            status,
            timetableSlotId: slot.id,
          });
        }
      }

      // --- Labs (per-batch) ---
      for (const lab of slot.labSlots) {
        if (!lab.subjectId) continue;

        const cancellation = cancellationMap.get(`${dateKey}|${slot.id}|${lab.subjectId}`);
        const status = cancellation ? "cancelled" : "not_yet_occurred";

        const batchMembers = memberships.filter((m) => m.batchNumber === lab.batchNumber);

        for (const member of batchMembers) {
          recordsToCreate.push({
            userId: member.userId,
            subjectId: lab.subjectId,
            date: current.toISOString(),
            status,
            // Use the parent timetableSlotId so lecture+lab on the same
            // physical slot don't collide on the unique constraint when
            // they're different subjects - but if lecture and lab subject
            // are the SAME, we'd get a duplicate. Guard against that below.
            timetableSlotId: slot.id,
          });
        }
      }
    }
  }

  if (recordsToCreate.length === 0) {
    return { created: 0, scannedDays };
  }

  // De-duplicate in-memory (in case lecture and lab subject are identical
  // for the same slot/user/date - unique constraint is
  // userId+subjectId+date+timetableSlotId)
  const seen = new Set();
  const deduped = [];
  for (const rec of recordsToCreate) {
    const key = `${rec.userId}|${rec.subjectId}|${rec.date}|${rec.timetableSlotId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(rec);
  }

  // createMany with skipDuplicates handles idempotency against existing rows
  const result = await prisma.attendanceRecord.createMany({
    data: deduped,
    skipDuplicates: true,
  });

  return { created: result.count, scannedDays };
}

/**
 * Convenience: sync from the section's semesterStartDate (or a fallback)
 * through today (inclusive).
 *
 * @param {string} sectionId
 * @param {Date} [fallbackFrom] used if the section has no semesterStartDate set
 */
async function syncAttendanceToToday(sectionId, fallbackFrom) {
  const section = await prisma.section.findUnique({
    where: { id: sectionId },
    select: { semesterStartDate: true },
  });

  const from = section?.semesterStartDate || fallbackFrom;
  if (!from) {
    // Nothing to sync - no semester start date configured and no fallback given
    return { created: 0, scannedDays: 0, skipped: "no_start_date" };
  }

  const today = new Date();
  return syncAttendanceForSection(sectionId, from, today);
}

module.exports = {
  syncAttendanceForSection,
  syncAttendanceToToday,
  toTimetableDayOfWeek,
  dateOnly,
  toDateKey,
  DAY_NAMES,
};

# BunkMaster Pro — Backend (Phase 1)

A multi-section attendance management backend. Built with **Express**,
**PostgreSQL**, and **Prisma**.

## Phase 1 scope

This phase covers the foundation:

- Email/password auth with JWT
- Multi-section ("class/batch") support
- Roles: `student`, `cr` (Class Representative), `sr` (Student Representative)
  — `cr` and `sr` share the same admin permissions
- Subjects per section
- Weekly timetable (5 days × 9 slots, with lab batch assignments per slot)
- Holiday calendar (national / college / custom)

Not yet included (future phases): attendance record auto-calculation engine,
cancellations & CR reschedule finder, push notifications.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

- `DATABASE_URL` — your PostgreSQL connection string. You can use a local
  Postgres instance, or a hosted free-tier database (Supabase, Neon, Railway,
  Render).
- `JWT_SECRET` — generate a long random string, e.g.:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- `CORS_ORIGIN` — the URL of your frontend (e.g. `http://localhost:5173`).

### 3. Run migrations

This creates all tables defined in `prisma/schema.prisma`:

```bash
npx prisma migrate dev --name init
```

### 4. Start the server

```bash
npm run dev   # with auto-reload (nodemon)
# or
npm start
```

The API will be available at `http://localhost:4000` (or your configured
`PORT`).

## API overview

### Auth

| Method | Route          | Description                          | Auth |
|--------|----------------|--------------------------------------|------|
| POST   | `/auth/register` | Create account `{email, password, name}` | No |
| POST   | `/auth/login`    | Login `{email, password}` -> JWT      | No |
| GET    | `/auth/me`       | Current user + their section memberships | Yes |

### Sections

| Method | Route                              | Description | Auth |
|--------|-------------------------------------|-------------|------|
| POST   | `/sections`                         | Create a section (creator becomes CR) `{name, institutionName?}` | Yes |
| POST   | `/sections/join`                    | Join via code `{joinCode, batchNumber?}` | Yes |
| GET    | `/sections/:sectionId`               | Section details, subjects, members | Yes (member) |
| PATCH  | `/sections/:sectionId/members/:userId` | Update a member's role/batch `{role?, batchNumber?}` | Yes (CR/SR) |

### Subjects

| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| GET    | `/sections/:sectionId/subjects` | List subjects | Yes (member) |
| POST   | `/sections/:sectionId/subjects` | Create subject `{name, semesterTotal?}` | Yes (member) |
| PATCH  | `/sections/:sectionId/subjects/:subjectId` | Update `{name?, semesterTotal?}` | Yes (CR/SR) |
| DELETE | `/sections/:sectionId/subjects/:subjectId` | Delete subject | Yes (CR/SR) |

### Timetable

| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| GET  | `/sections/:sectionId/timetable` | Full 5x9 timetable with subjects + lab assignments | Yes (member) |
| PUT  | `/sections/:sectionId/timetable/:dayOfWeek/:slotIndex` | Set lecture/lab subjects for a slot `{subjectId?, labAssignments?}` | Yes (CR/SR) |

`dayOfWeek`: 0=Mon ... 4=Fri. `slotIndex`: 0-8 (one is a break, cannot be assigned).

### Holidays

| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| GET    | `/sections/:sectionId/holidays?from=&to=` | List holidays | Yes (member) |
| POST   | `/sections/:sectionId/holidays` | Add/update holiday `{date, name, type?}` | Yes (CR/SR) |
| POST   | `/sections/:sectionId/holidays/bulk` | Bulk-import `{holidays: [{date, name, type?}]}` | Yes (CR/SR) |
| DELETE | `/sections/:sectionId/holidays/:holidayId` | Remove holiday | Yes (CR/SR) |

### Attendance (Phase 2)

The attendance sync engine generates `AttendanceRecord` rows from the
timetable + holiday calendar, skipping weekends and holidays automatically.
Records start as `not_yet_occurred` and are updated by the student (or, in
Phase 4, by the notification flow) to `attended` / `missed`.

| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| POST   | `/sections/:sectionId/attendance/sync` | Manually trigger a sync. No body = sync from `semesterStartDate` to today for everyone. `{from?, to?}` (CR/SR only for custom ranges). | Yes (member) |
| GET    | `/sections/:sectionId/attendance/:date` | Your schedule + status for a date (YYYY-MM-DD). Lazily syncs that date. | Yes (member) |
| PATCH  | `/sections/:sectionId/attendance/:recordId` | Mark one record `{status: "attended"\|"missed"}`. Own records only, not `cancelled`. | Yes (member) |
| PATCH  | `/sections/:sectionId/attendance/by-date/:date` | Bulk-mark all (or selected `subjectIds`) records for a day `{status, subjectIds?}` | Yes (member) |
| GET    | `/sections/:sectionId/attendance/stats?target=75` | Per-subject `{attended, conducted, percentage, prediction, maxPossiblePercentage}`. Lazily syncs to today first. Replaces client-side "Crunch Numbers"/"Strategy Plan". | Yes (member) |
| PATCH  | `/sections/:sectionId` | Set `{semesterStartDate: "YYYY-MM-DD"}` — required before sync/stats work. | Yes (CR/SR) |

**Important**: a CR/SR must set `semesterStartDate` via `PATCH /sections/:sectionId`
before `/attendance/sync` or `/attendance/stats` will generate records.

### Cancellations & Reschedule Finder (Phase 3)

| Method | Route | Description | Auth |
|--------|-------|-------------|------|
| GET    | `/sections/:sectionId/cancellations?from=&to=` | List cancellations/reschedules in a date range | Yes (member) |
| POST   | `/sections/:sectionId/cancellations` | Mark a lecture/lab cancelled `{date, timetableSlotId, subjectId, reason?}`. Re-syncs that date so affected `AttendanceRecord`s flip to `cancelled`. | Yes (CR/SR) |
| GET    | `/sections/:sectionId/cancellations/:id/reschedule-options?windowDays=14` | Suggests free date+slot combos (next `windowDays` calendar days, default 14, max 60) where the cancelled lecture could be moved. Skips weekends/holidays and slots already used by another reschedule. | Yes (CR/SR) |
| POST   | `/sections/:sectionId/cancellations/:id/reschedule` | Commit to a chosen `{date, timetableSlotId}`. Sets status to `rescheduled` and generates `AttendanceRecord`s for the new slot (whole section for lecture-type, matching batch only for lab-type). | Yes (CR/SR) |

A "reschedule option" is a timetable slot that is **completely empty in the
weekly grid** (no lecture subject, no lab subjects for any batch) on a real
upcoming weekday that isn't a holiday and isn't already claimed by another
reschedule.

## Auth header format

All authenticated routes require:

```
Authorization: Bearer <JWT from login/register>
```

## Data model notes

- **Roles**: `cr` and `sr` are functionally identical (`isClassAdmin` helper
  in `src/middleware/auth.js` checks for either). This makes it easy to
  diverge their permissions later without a schema change.
- **Batches**: `batchNumber` (1-4) on `SectionMembership` determines which lab
  group a student belongs to; `TimetableLabSlot` holds per-batch lab subject
  assignments for each timetable slot.
- **Join codes**: auto-generated 6-character codes (e.g. `7K2QXP`), unique
  across all sections.

## Next phases

- **Phase 4**: Web push notifications for attendance check-ins (e.g. "Did you
  attend [Subject] just now?" -> Yes/No -> updates the matching
  `AttendanceRecord`).

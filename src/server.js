require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { errorHandler, notFoundHandler } = require("./middleware/errorHandler");

const authRoutes = require("./routes/auth");
const sectionRoutes = require("./routes/sections");
const subjectRoutes = require("./routes/subjects");
const timetableRoutes = require("./routes/timetable");
const holidayRoutes = require("./routes/holidays");
const attendanceRoutes = require("./routes/attendance");
const cancellationRoutes = require("./routes/cancellations");

const app = express();

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
  })
);
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Auth (register/login/me)
app.use("/auth", authRoutes);

// Sections (create/join/details/members)
app.use("/sections", sectionRoutes);

// Nested resources under a section
app.use("/sections/:sectionId/subjects", subjectRoutes);
app.use("/sections/:sectionId/timetable", timetableRoutes);
app.use("/sections/:sectionId/holidays", holidayRoutes);
app.use("/sections/:sectionId/attendance", attendanceRoutes);
app.use("/sections/:sectionId/cancellations", cancellationRoutes);

// 404 + error handling (must be last)
app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`BunkMaster backend listening on port ${PORT}`);
});

module.exports = app;

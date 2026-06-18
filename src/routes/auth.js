const express = require("express");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");

const prisma = require("../utils/prisma");
const { signToken } = require("../utils/jwt");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const SALT_ROUNDS = 10;

/**
 * POST /auth/register
 * body: { email, password, name }
 */
router.post(
  "/register",
  [
    body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
    body("password").isLength({ min: 8 }).withMessage("Password must be at least 8 characters"),
    body("name").trim().notEmpty().withMessage("Name is required"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { email, password, name } = req.body;

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({ error: "An account with this email already exists" });
      }

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

      const user = await prisma.user.create({
        data: { email, passwordHash, name },
      });

      const token = signToken(user.id);

      res.status(201).json({
        token,
        user: { id: user.id, email: user.email, name: user.name },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /auth/login
 * body: { email, password }
 */
router.post(
  "/login",
  [
    body("email").isEmail().withMessage("Valid email is required").normalizeEmail(),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: "Validation failed", details: errors.array() });
      }

      const { email, password } = req.body;

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const passwordMatches = await bcrypt.compare(password, user.passwordHash);
      if (!passwordMatches) {
        return res.status(401).json({ error: "Invalid email or password" });
      }

      const token = signToken(user.id);

      res.json({
        token,
        user: { id: user.id, email: user.email, name: user.name },
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /auth/me
 * Returns the currently authenticated user and their section memberships.
 */
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const memberships = await prisma.sectionMembership.findMany({
      where: { userId: req.user.id },
      include: {
        section: {
          select: { id: true, name: true, joinCode: true, institutionName: true },
        },
      },
    });

    res.json({
      user: { id: req.user.id, email: req.user.email, name: req.user.name },
      memberships: memberships.map((m) => ({
        sectionId: m.sectionId,
        section: m.section,
        role: m.role,
        batchNumber: m.batchNumber,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

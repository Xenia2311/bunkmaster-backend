const { verifyToken } = require("../utils/jwt");
const prisma = require("../utils/prisma");

/**
 * Middleware: requires a valid JWT in the Authorization header
 * (format: "Bearer <token>"). Attaches `req.user` (without passwordHash)
 * on success.
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ error: "Missing or malformed Authorization header" });
    }

    let payload;
    try {
      payload = verifyToken(token);
    } catch (err) {
      return res.status(401).json({ error: "Invalid or expired token" });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    // Attach user without the password hash
    const { passwordHash, ...safeUser } = user;
    req.user = safeUser;

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware factory: requires the authenticated user to have a
 * membership in the section referenced by `req.params[sectionIdParam]`,
 * and that membership's role to be one of `allowedRoles`.
 *
 * Attaches `req.membership` (the SectionMembership row) on success.
 *
 * @param {string[]|null} allowedRoles - e.g. ["cr", "sr"]. If null, any
 *   membership role is allowed (just checks membership exists).
 * @param {string} sectionIdParam - name of the route param holding the section id
 */
function requireSectionRole(allowedRoles = null, sectionIdParam = "sectionId") {
  return async (req, res, next) => {
    try {
      const sectionId = req.params[sectionIdParam];
      if (!sectionId) {
        return res.status(400).json({ error: `Missing route param: ${sectionIdParam}` });
      }

      const membership = await prisma.sectionMembership.findUnique({
        where: {
          userId_sectionId: {
            userId: req.user.id,
            sectionId,
          },
        },
      });

      if (!membership) {
        return res.status(403).json({ error: "You are not a member of this section" });
      }

      if (allowedRoles && !allowedRoles.includes(membership.role)) {
        return res.status(403).json({ error: "You do not have permission to perform this action" });
      }

      req.membership = membership;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Convenience: true if a role is allowed to perform "class admin" actions
 * (managing timetable, cancellations, reschedules, holidays).
 * Both CR and SR share this permission set.
 */
function isClassAdmin(role) {
  return role === "cr" || role === "sr";
}

module.exports = { requireAuth, requireSectionRole, isClassAdmin };

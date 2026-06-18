const { PrismaClient } = require("@prisma/client");

// Reuse a single PrismaClient instance across the app (recommended pattern)
const prisma = new PrismaClient();

module.exports = prisma;

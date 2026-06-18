/**
 * Generate a short, human-friendly join code for a section
 * e.g. "CS3B-7K2Q"
 * @param {number} length number of random characters (default 6)
 * @returns {string}
 */
function generateJoinCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // avoids ambiguous chars (0/O, 1/I)
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

module.exports = { generateJoinCode };

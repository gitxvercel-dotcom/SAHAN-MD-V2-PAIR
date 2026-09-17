module.exports = {
  // ========== MEGA.NZ CREDENTIALS (REQUIRED) ==========
  MEGA_EMAIL: "your-email@example.com",      // Your mega.nz email
  MEGA_PASSWORD: "your-mega-password",       // Your mega.nz password

  // ========== PAIR SITE SETTINGS ==========
  PORT: process.env.PORT || 3000,
  SESSION_PREFIX: "sᴀʜᴀɴ-ᴍᴅ~",              // SESSION_ID format prefix
  BOT_NAME: "SAHAN-MD V2",
  OWNER_NAME: "Sahan",
  THEME_COLOR: "#00ffcc",

  // ========== OPTIONAL ==========
  MAX_SESSIONS: 5,                           // Max concurrent pairing sessions
  SESSION_TIMEOUT: 120000                    // 2 minutes
};

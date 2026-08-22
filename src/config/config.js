'use strict';

require('dotenv').config();

/**
 * Parses a comma-separated env var into a trimmed, de-duplicated string array.
 * @param {string|undefined} value
 * @returns {string[]}
 */
function parseList(value) {
  if (!value) return [];
  return [...new Set(value.split(',').map((v) => v.trim()).filter(Boolean))];
}

function parseIntSafe(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseFloatSafe(value, fallback) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

const REQUIRED_VARS = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'VOICE_CHANNEL_ID',
  'CATEGORY_ID',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

const missing = REQUIRED_VARS.filter((key) => !process.env[key] || process.env[key].trim() === '');
if (missing.length > 0) {
  // Fail fast and loud at boot. This is intentionally NOT routed through the
  // logger, since the logger itself may depend on config having loaded.
  // eslint-disable-next-line no-console
  console.error(
    `[FATAL] Missing required environment variables: ${missing.join(', ')}\n` +
      'Copy .env.example to .env and fill in the values before starting the bot.',
  );
  process.exit(1);
}

const config = Object.freeze({
  discord: Object.freeze({
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID,
    devGuildId: process.env.DISCORD_DEV_GUILD_ID || null,
    voiceChannelId: process.env.VOICE_CHANNEL_ID,
    categoryId: process.env.CATEGORY_ID,
    allowedRoleIds: parseList(process.env.ALLOWED_ROLE_IDS),
  }),
  supabase: Object.freeze({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bucketName: process.env.SUPABASE_BUCKET_NAME || 'discord',
    songsTable: process.env.SUPABASE_SONGS_TABLE || 'songs',
    signedUrlExpirySeconds: parseIntSafe(process.env.SIGNED_URL_EXPIRY_SECONDS, 3600),
  }),
  playback: Object.freeze({
    autoJoinDelayMs: parseIntSafe(process.env.AUTO_JOIN_DELAY_MS, 30000),
    autoLeaveDelayMs: parseIntSafe(process.env.AUTO_LEAVE_DELAY_MS, 30000),
    defaultVolume: Math.min(1, Math.max(0, parseFloatSafe(process.env.DEFAULT_VOLUME, 0.5))),
    commandCooldownMs: parseIntSafe(process.env.COMMAND_COOLDOWN_MS, 3000),
    librarySyncIntervalMs: parseIntSafe(process.env.LIBRARY_SYNC_INTERVAL_MS, 5 * 60 * 1000),
  }),
  ops: Object.freeze({
    logLevel: process.env.LOG_LEVEL || 'info',
    logFormat: process.env.LOG_FORMAT || 'friendly',
    nodeEnv: process.env.NODE_ENV || 'development',
    port: process.env.PORT ? parseIntSafe(process.env.PORT, null) : null,
  }),
});

module.exports = config;

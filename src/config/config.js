'use strict';

require('dotenv').config();

const path = require('node:path');

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

function isValidSnowflake(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
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

const supabaseUrl = process.env.SUPABASE_URL.trim();
try {
  const parsed = new URL(supabaseUrl);
  if (parsed.protocol !== 'https:') {
    // eslint-disable-next-line no-console
    console.error('[FATAL] SUPABASE_URL must use https://');
    process.exit(1);
  }
} catch {
  // eslint-disable-next-line no-console
  console.error('[FATAL] SUPABASE_URL is not a valid URL.');
  process.exit(1);
}

const snowflakeVars = {
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID.trim(),
  VOICE_CHANNEL_ID: process.env.VOICE_CHANNEL_ID.trim(),
  CATEGORY_ID: process.env.CATEGORY_ID.trim(),
};
if (process.env.DISCORD_DEV_GUILD_ID) {
  snowflakeVars.DISCORD_DEV_GUILD_ID = process.env.DISCORD_DEV_GUILD_ID.trim();
}

const invalidSnowflakes = Object.entries(snowflakeVars).filter(([, value]) => !isValidSnowflake(value));
if (invalidSnowflakes.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `[FATAL] Invalid Discord snowflake ID(s): ${invalidSnowflakes.map(([k]) => k).join(', ')}. IDs must be 17-20 digits.`,
  );
  process.exit(1);
}

const allowedRoleIds = parseList(process.env.ALLOWED_ROLE_IDS);
const invalidRoles = allowedRoleIds.filter((id) => !isValidSnowflake(id));
if (invalidRoles.length > 0) {
  // eslint-disable-next-line no-console
  console.error('[FATAL] ALLOWED_ROLE_IDS contains invalid snowflake ID(s).');
  process.exit(1);
}

const logDir = process.env.LOG_DIR || path.join(process.cwd(), 'logs');

const config = Object.freeze({
  discord: Object.freeze({
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.DISCORD_CLIENT_ID.trim(),
    devGuildId: process.env.DISCORD_DEV_GUILD_ID?.trim() || null,
    voiceChannelId: process.env.VOICE_CHANNEL_ID.trim(),
    categoryId: process.env.CATEGORY_ID.trim(),
    allowedRoleIds,
  }),
  supabase: Object.freeze({
    url: supabaseUrl.replace(/\/+$/, ''),
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
    guildCommandCooldownMs: parseIntSafe(process.env.GUILD_COMMAND_COOLDOWN_MS, 1000),
    librarySyncIntervalMs: parseIntSafe(process.env.LIBRARY_SYNC_INTERVAL_MS, 120_000),
    maxQueueLength: parseIntSafe(process.env.MAX_QUEUE_LENGTH, 200),
    maxVoiceConnections: parseIntSafe(process.env.MAX_VOICE_CONNECTIONS, 5),
    maxFileSizeBytes: parseIntSafe(process.env.MAX_FILE_SIZE_BYTES, 50 * 1024 * 1024),
    maxConsecutiveTrackFailures: parseIntSafe(process.env.MAX_CONSECUTIVE_TRACK_FAILURES, 5),
  }),
  ops: Object.freeze({
    logLevel: process.env.LOG_LEVEL || 'info',
    logFormat: process.env.LOG_FORMAT || 'friendly',
    logDir,
    heartbeatPath: process.env.HEARTBEAT_PATH || path.join(logDir, 'heartbeat.json'),
    heartbeatIntervalMs: parseIntSafe(process.env.HEARTBEAT_INTERVAL_MS, 15000),
    metricsIntervalMs: parseIntSafe(process.env.METRICS_INTERVAL_MS, 60_000),
    nodeEnv: process.env.NODE_ENV || 'development',
    port: process.env.PORT ? parseIntSafe(process.env.PORT, null) : null,
    healthPort: process.env.HEALTH_PORT ? parseIntSafe(process.env.HEALTH_PORT, null) : null,
    // Render Web Services must bind 0.0.0.0. Local HEALTH_PORT defaults to loopback.
    healthBind: process.env.HEALTH_BIND || (process.env.PORT ? '0.0.0.0' : '127.0.0.1'),
    healthToken: process.env.HEALTH_TOKEN?.trim() || '',
  }),
});

module.exports = config;

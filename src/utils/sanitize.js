'use strict';

const path = require('node:path');

const MAX_QUERY_LENGTH = 100;

/**
 * Strips control characters, collapses whitespace, and truncates user-supplied
 * free-text search input before it touches a DB query or a log line.
 * @param {string} input
 * @returns {string}
 */
function sanitizeSearchQuery(input) {
  if (typeof input !== 'string') return '';
  return input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/["'`]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_QUERY_LENGTH);
}

/**
 * Escapes PostgREST filter / `ilike` metacharacters so user input cannot
 * alter `.or()` syntax (commas, dots, parens, colons) or LIKE wildcards.
 * @param {string} input
 * @returns {string}
 */
function escapeForIlike(input) {
  // Backslashes first so later escapes are not double-processed.
  return input.replace(/\\/g, '\\\\').replace(/[%_,.():]/g, (match) => `\\${match}`);
}

/**
 * Strips signed-URL tokens and JWT-shaped strings before they hit logs.
 * @param {unknown} value
 * @returns {unknown}
 */
function redactSecrets(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/([?&](?:token|sig|signature|key)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-jwt]');
}

/**
 * Sanitizes + validates a search query in one step, ready to interpolate
 * into a Supabase `.ilike()` filter.
 * @param {string} rawInput
 * @returns {string}
 */
function sanitizeAndEscapeQuery(rawInput) {
  return escapeForIlike(sanitizeSearchQuery(rawInput));
}

/**
 * Parses and clamps a volume input (0-100 integer from the slash command)
 * into a safe 0-1 float used by the audio player.
 * @param {number} rawVolumePercent
 * @returns {number|null} null if invalid.
 */
function sanitizeVolumePercent(rawVolumePercent) {
  const n = Number(rawVolumePercent);
  if (!Number.isFinite(n)) return null;
  const clamped = Math.min(100, Math.max(0, Math.round(n)));
  return clamped / 100;
}

/**
 * Validates a Discord snowflake ID format to guard against injection via
 * IDs pulled from env vars or interaction payloads before using them in
 * API calls.
 * @param {string} id
 * @returns {boolean}
 */
function isValidSnowflake(id) {
  return typeof id === 'string' && /^\d{17,20}$/.test(id);
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.webm']);

/**
 * Rejects path traversal and absolute paths before a storage object key is
 * used to generate a signed URL. Keys are relative POSIX-style paths.
 * @param {string} filePath
 * @returns {boolean}
 */
function isSafeStoragePath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 512) return false;
  if (filePath.includes('\0')) return false;
  if (filePath.startsWith('/') || filePath.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(filePath)) return false;
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => segment === '..' || segment === '')) return false;
  const ext = path.posix.extname(normalized).toLowerCase();
  return AUDIO_EXTENSIONS.has(ext);
}

/**
 * Escapes Discord markdown so a song title cannot break embed layout or inject
 * spoiler/mention-like formatting in replies.
 * @param {unknown} text
 * @returns {string}
 */
function escapeMarkdown(text) {
  return String(text ?? '')
    .replace(/[\\*_`|~]/g, '\\$&')
    .slice(0, 200);
}

/**
 * Validates a song row from Supabase before playback. Never trust DB content
 * blindly — a compromised or hand-edited row could point at an unexpected object.
 * @param {object} song
 * @param {string} expectedBucket
 * @returns {boolean}
 */
function isValidSongRecord(song, expectedBucket) {
  if (!song || typeof song !== 'object') return false;
  if (typeof song.id !== 'string' || !song.id) return false;
  if (typeof song.title !== 'string' || typeof song.artist !== 'string') return false;
  if (!isSafeStoragePath(song.file_path)) return false;
  const bucket = song.bucket_name || expectedBucket;
  if (typeof bucket !== 'string' || bucket !== expectedBucket) return false;
  return true;
}

/**
 * Confirms a signed URL is HTTPS and points at the configured Supabase host.
 * @param {string} url
 * @param {string} supabaseUrl
 * @returns {boolean}
 */
function isTrustedSignedUrl(url, supabaseUrl) {
  try {
    const parsed = new URL(url);
    const expected = new URL(supabaseUrl);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname === expected.hostname;
  } catch {
    return false;
  }
}

module.exports = {
  sanitizeSearchQuery,
  escapeForIlike,
  sanitizeAndEscapeQuery,
  sanitizeVolumePercent,
  isValidSnowflake,
  isSafeStoragePath,
  isValidSongRecord,
  isTrustedSignedUrl,
  redactSecrets,
  escapeMarkdown,
  AUDIO_EXTENSIONS,
};

'use strict';

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
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_QUERY_LENGTH);
}

/**
 * Escapes PostgREST `ilike` wildcard characters so a search query can't be
 * used to construct unintended wildcard patterns against the songs table.
 * @param {string} input
 * @returns {string}
 */
function escapeForIlike(input) {
  return input.replace(/[%_,()]/g, (match) => `\\${match}`);
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

module.exports = {
  sanitizeSearchQuery,
  escapeForIlike,
  sanitizeAndEscapeQuery,
  sanitizeVolumePercent,
  isValidSnowflake,
};

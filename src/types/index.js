'use strict';

/**
 * This project is plain JavaScript, but we define shared shapes here via
 * JSDoc typedefs so editors get autocomplete/type-checking and so the data
 * contracts between modules (queue <-> services <-> commands) are explicit
 * and documented in one place.
 */

/**
 * @typedef {Object} SongRecord
 * @property {string} id - UUID primary key from the `songs` table.
 * @property {string} title
 * @property {string} artist
 * @property {number|null} duration_seconds
 * @property {string} file_path - Path of the object inside the Supabase bucket.
 * @property {string} bucket_name
 * @property {string|null} added_by - Discord user ID who added the track.
 * @property {boolean} is_active
 * @property {string} created_at - ISO timestamp.
 */

/**
 * @typedef {Object} QueuedTrack
 * @property {SongRecord} song
 * @property {string} requestedBy - Discord user ID, or "auto-shuffle".
 */

/**
 * @typedef {'idle'|'buffering'|'playing'|'paused'|'error'} PlaybackState
 */

/**
 * @typedef {Object} CommandContext
 * @property {import('discord.js').Client} client
 * @property {import('../services/queueManager')} queueManager
 * @property {import('../services/supabaseService')} supabaseService
 * @property {import('../services/voiceManager')} voiceManager
 * @property {import('../services/playbackService')} playbackService
 * @property {import('../utils/logger')} logger
 */

/**
 * @typedef {Object} SlashCommandModule
 * @property {import('discord.js').SlashCommandBuilder} data
 * @property {(interaction: import('discord.js').ChatInputCommandInteraction, ctx: CommandContext) => Promise<void>} execute
 * @property {boolean} [requiresVoiceMembership] - If true, the invoking member must be in the configured voice channel.
 */

module.exports = {};

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config/config');
const { isValidSongRecord } = require('./sanitize');
const logger = require('./logger').child('queueSnapshot');

const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

function snapshotPath() {
  return path.join(config.ops.logDir, 'queue-snapshot.json');
}

/**
 * Persists in-memory queues so a controlled restart can resume playback
 * instead of dropping the upcoming list. Best-effort; never throws.
 * @param {import('../services/musicQueue').QueueManager} queueManager
 */
function save(queueManager) {
  try {
    const guilds = [];
    for (const [guildId, queue] of queueManager.queues) {
      if (!queue.nowPlaying && queue.upcoming.length === 0) continue;
      guilds.push({
        guildId,
        volume: queue.volume,
        lastPlayedSongId: queue.lastPlayedSongId,
        nowPlaying: queue.nowPlaying,
        upcoming: queue.upcoming.slice(0, config.playback.maxQueueLength),
      });
    }
    fs.mkdirSync(config.ops.logDir, { recursive: true });
    fs.writeFileSync(
      snapshotPath(),
      `${JSON.stringify({ ts: new Date().toISOString(), guilds })}\n`,
    );
    logger.info('queue_snapshot_saved', { guilds: guilds.length });
  } catch (err) {
    logger.warn('queue_snapshot_save_failed', { error: err.message });
  }
}

/**
 * Restores queues saved on the previous process. Ignores stale or invalid data.
 * @param {import('../services/musicQueue').QueueManager} queueManager
 */
function restore(queueManager) {
  try {
    const file = snapshotPath();
    if (!fs.existsSync(file)) return 0;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ageMs = Date.now() - Date.parse(parsed.ts);
    if (!Number.isFinite(ageMs) || ageMs > SNAPSHOT_MAX_AGE_MS) {
      logger.info('queue_snapshot_stale', { ageMs });
      fs.unlinkSync(file);
      return 0;
    }

    let restored = 0;
    for (const entry of parsed.guilds || []) {
      if (!entry?.guildId) continue;
      const queue = queueManager.getOrCreate(entry.guildId);
      const upcoming = [];
      for (const track of entry.upcoming || []) {
        if (track?.song && isValidSongRecord(track.song, config.supabase.bucketName)) {
          upcoming.push({ song: track.song, requestedBy: String(track.requestedBy || 'auto-shuffle') });
        }
      }
      queue.upcoming = upcoming.slice(0, config.playback.maxQueueLength);
      if (entry.nowPlaying?.song && isValidSongRecord(entry.nowPlaying.song, config.supabase.bucketName)) {
        queue.upcoming.unshift({
          song: entry.nowPlaying.song,
          requestedBy: String(entry.nowPlaying.requestedBy || 'auto-shuffle'),
        });
      }
      if (typeof entry.volume === 'number' && entry.volume >= 0 && entry.volume <= 1) {
        queue.volume = entry.volume;
      }
      if (typeof entry.lastPlayedSongId === 'string') {
        queue.lastPlayedSongId = entry.lastPlayedSongId;
      }
      restored += 1;
    }

    fs.unlinkSync(file);
    logger.info('queue_snapshot_restored', { guilds: restored });
    return restored;
  } catch (err) {
    logger.warn('queue_snapshot_restore_failed', { error: err.message });
    return 0;
  }
}

module.exports = { save, restore, SNAPSHOT_MAX_AGE_MS };

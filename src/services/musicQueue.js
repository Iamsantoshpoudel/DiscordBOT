'use strict';

const config = require('../config/config');

/** @typedef {import('../types').SongRecord} SongRecord */
/** @typedef {import('../types').QueuedTrack} QueuedTrack */

/**
 * Fisher-Yates shuffle. Returns a new shuffled array; does not mutate input.
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
function shuffleArray(arr) {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Holds all mutable playback state for a single guild: the upcoming track
 * order, what's currently playing, volume, and the connection/player
 * references owned by voiceManager. One instance per guild, created lazily.
 */
class GuildMusicQueue {
  /** @param {string} guildId */
  constructor(guildId) {
    this.guildId = guildId;

    /** @type {QueuedTrack[]} Upcoming shuffled tracks, played front-to-back. */
    this.upcoming = [];

    /** @type {QueuedTrack|null} */
    this.nowPlaying = null;

    /** @type {string|null} Song ID of the last track that finished, to prevent immediate repeats across reshuffles. */
    this.lastPlayedSongId = null;

    /** @type {'idle'|'playing'|'paused'} */
    this.state = 'idle';

    this.volume = config.playback.defaultVolume;

    /** @type {import('@discordjs/voice').VoiceConnection|null} */
    this.connection = null;

    /** @type {import('@discordjs/voice').AudioPlayer|null} */
    this.player = null;

    /** @type {import('@discordjs/voice').AudioResource|null} */
    this.currentResource = null;

    /** @type {import('prism-media').FFmpeg|null} */
    this.currentFfmpeg = null;

    /** @type {import('stream').Readable|null} */
    this.currentOpus = null;

    /** @type {NodeJS.Timeout|null} Pending auto-join timer; only one may be active at a time. */
    this.autoJoinTimer = null;

    /** @type {number} Transient auto-join failures in the current occupancy window. */
    this.autoJoinAttempts = 0;

    /** @type {NodeJS.Timeout|null} Pending auto-leave timer. */
    this.autoLeaveTimer = null;

    this.startedAt = null;
  }

  /**
   * Rebuilds `upcoming` from a fresh library snapshot, shuffled so that the
   * first track never matches the immediately preceding track (avoiding an
   * audible "immediate repeat" when the shuffle cycles back around).
   * @param {SongRecord[]} songs
   * @param {string} [requestedBy='auto-shuffle']
   */
  fillFromLibrary(songs, requestedBy = 'auto-shuffle') {
    if (!songs || songs.length === 0) {
      this.upcoming = [];
      return;
    }

    let shuffled = shuffleArray(songs);

    if (songs.length > 1 && shuffled[0].id === this.lastPlayedSongId) {
      // Swap the immediate-repeat offender with a random later position.
      const swapIndex = 1 + Math.floor(Math.random() * (shuffled.length - 1));
      [shuffled[0], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[0]];
    }

    this.upcoming = shuffled.map((song) => ({ song, requestedBy })).slice(0, config.playback.maxQueueLength);
  }

  /**
   * Inserts a specific track at the front of the queue (used by `/play <query>`).
   * @param {SongRecord} song
   * @param {string} requestedBy
   * @returns {boolean} false if the queue is already at the cap
   */
  playNext(song, requestedBy) {
    if (this.upcoming.length >= config.playback.maxQueueLength) return false;
    this.upcoming.unshift({ song, requestedBy });
    return true;
  }

  /**
   * Pops the next track off the queue and marks it as now playing.
   * @returns {QueuedTrack|null}
   */
  advance() {
    const next = this.upcoming.shift() || null;
    this.nowPlaying = next;
    if (next) {
      this.lastPlayedSongId = next.song.id;
      this.startedAt = Date.now();
    }
    return next;
  }

  /**
   * Manually reshuffles the remaining upcoming queue (used by `/shuffle`),
   * still respecting no-immediate-repeat against whatever is currently playing.
   */
  reshuffleUpcoming() {
    if (this.upcoming.length <= 1) return;
    const songs = this.upcoming.map((t) => t.song);
    const requestedBy = this.upcoming[0]?.requestedBy || 'auto-shuffle';
    let shuffled = shuffleArray(songs);

    const currentId = this.nowPlaying?.song?.id ?? this.lastPlayedSongId;
    if (shuffled[0].id === currentId && shuffled.length > 1) {
      const swapIndex = 1 + Math.floor(Math.random() * (shuffled.length - 1));
      [shuffled[0], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[0]];
    }

    this.upcoming = shuffled.map((song) => ({ song, requestedBy }));
  }

  isEmpty() {
    return this.upcoming.length === 0;
  }

  clearAutoJoinTimer() {
    if (this.autoJoinTimer) {
      clearTimeout(this.autoJoinTimer);
      this.autoJoinTimer = null;
    }
  }

  clearAutoLeaveTimer() {
    if (this.autoLeaveTimer) {
      clearTimeout(this.autoLeaveTimer);
      this.autoLeaveTimer = null;
    }
  }

  destroyCurrentStream() {
    try {
      this.currentResource?.playStream?.destroy?.();
    } catch {
      /* ignore */
    }
    try {
      const proc = this.currentFfmpeg?.process;
      if (proc && !proc.killed) {
        proc.kill('SIGKILL');
      }
    } catch {
      try {
        this.currentFfmpeg?.process?.kill?.();
      } catch {
        /* ignore */
      }
    }
    try {
      this.currentFfmpeg?.removeAllListeners?.();
      this.currentFfmpeg?.destroy?.();
    } catch {
      /* ignore */
    }
    try {
      this.currentOpus?.removeAllListeners?.();
      this.currentOpus?.destroy?.();
    } catch {
      /* ignore */
    }
    this.currentResource = null;
    this.currentFfmpeg = null;
    this.currentOpus = null;
  }

  /** Resets playback state after the bot leaves the channel. */
  resetPlaybackState() {
    this.destroyCurrentStream();
    this.nowPlaying = null;
    this.state = 'idle';
    this.connection = null;
    this.player = null;
    this.startedAt = null;
    this.clearAutoJoinTimer();
    this.clearAutoLeaveTimer();
    this.autoJoinAttempts = 0;
  }
}

/**
 * Registry of GuildMusicQueue instances, one per guild, created on demand.
 * This is what makes the bot's playback logic scale to multiple guilds even
 * though this specific deployment is configured for a single voice channel.
 */
class QueueManager {
  constructor() {
    /** @type {Map<string, GuildMusicQueue>} */
    this.queues = new Map();
  }

  /**
   * @param {string} guildId
   * @returns {GuildMusicQueue}
   */
  getOrCreate(guildId) {
    if (!this.queues.has(guildId)) {
      this.queues.set(guildId, new GuildMusicQueue(guildId));
    }
    return this.queues.get(guildId);
  }

  /** @param {string} guildId */
  get(guildId) {
    return this.queues.get(guildId) || null;
  }

  /** @param {string} guildId */
  delete(guildId) {
    const queue = this.queues.get(guildId);
    if (queue) {
      queue.resetPlaybackState();
    }
    this.queues.delete(guildId);
  }
}

module.exports = { QueueManager, GuildMusicQueue, shuffleArray };

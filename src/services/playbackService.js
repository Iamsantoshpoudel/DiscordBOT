'use strict';

const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');
const { createAudioResource, StreamType, AudioPlayerStatus, entersState } = require('@discordjs/voice');

const supabaseService = require('./supabaseService');
const logger = require('../utils/logger').child('playbackService');
const supervisor = require('../utils/supervisor');
const { isTrustedSignedUrl, isValidSongRecord } = require('../utils/sanitize');
const config = require('../config/config');
const { isAcceptingCommands } = require('../utils/health');
const { PermanentError } = require('../utils/retry');

process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || ffmpegPath;
process.env.FFMPEG_BIN = process.env.FFMPEG_BIN || ffmpegPath;

if (ffmpegPath) {
  logger.info('ffmpeg_binary', { path: ffmpegPath });
} else {
  logger.error('ffmpeg_binary_missing', new Error('ffmpeg-static returned no path'));
}

const MAX_TRACK_RETRIES = 2;

class PlaybackService {
  /**
   * @param {import('./musicQueue').QueueManager} queueManager
   * @param {import('./voiceManager')} voiceManager
   */
  constructor(queueManager, voiceManager) {
    this.queueManager = queueManager;
    this.voiceManager = voiceManager;
    /** @type {Set<string>} guild IDs whose player already has listeners attached. */
    this._listenersAttached = new Set();
    /** @type {Map<string, number>} guildId -> retry count for the current track. */
    this._trackRetryCounts = new Map();
    /** @type {Map<string, number>} consecutive hard failures (skip after retries). */
    this._consecutiveTrackFailures = new Map();
    /** @type {Map<string, Promise<void>>} serializes playNext per guild. */
    this._playLocks = new Map();
    /** @type {Set<string>} re-entrancy for the per-guild play lock. */
    this._inPlayLock = new Set();
    /** @type {Map<string, number>} nested suppress count while swapping ffmpeg/resources. */
    this._suppressAutoAdvance = new Map();
  }

  _beginSuppress(guildId) {
    this._suppressAutoAdvance.set(guildId, (this._suppressAutoAdvance.get(guildId) || 0) + 1);
  }

  _endSuppress(guildId) {
    const next = (this._suppressAutoAdvance.get(guildId) || 1) - 1;
    if (next <= 0) this._suppressAutoAdvance.delete(guildId);
    else this._suppressAutoAdvance.set(guildId, next);
  }

  _isSuppressed(guildId) {
    return (this._suppressAutoAdvance.get(guildId) || 0) > 0;
  }

  /**
   * Ensures the bot is connected and playback is running for a guild.
   * Idempotent: safe to call even if something is already playing.
   * @param {import('discord.js').Guild} guild
   */
  async start(guild) {
    if (!isAcceptingCommands()) {
      throw new PermanentError('Bot is shutting down', 'SHUTTING_DOWN');
    }
    try {
      const { player, connection } = this.voiceManager.joinConfiguredChannel(guild);
      await this.voiceManager.waitUntilReady(connection);
      this._ensureListeners(guild, player);

      const queue = this.queueManager.getOrCreate(guild.id);
      if (queue.state !== 'playing' && !queue.nowPlaying) {
        await this.playNext(guild);
      }
      supervisor.reportSuccess('voice');
      supervisor.reportSuccess('queue');
    } catch (err) {
      logger.error('playback_start_failed', err, { guildId: guild.id });
      supervisor.reportFailure('voice', err, { guildId: guild.id });
      throw err;
    }
  }

  /**
   * Drop player-listener bookkeeping so a later re-join attaches to the new player.
   * @param {string} guildId
   */
  detachGuild(guildId) {
    this._listenersAttached.delete(guildId);
    this._trackRetryCounts.delete(guildId);
    this._consecutiveTrackFailures.delete(guildId);
    this._playLocks.delete(guildId);
    this._inPlayLock.delete(guildId);
    this._suppressAutoAdvance.delete(guildId);
  }

  /**
   * Serializes playback mutations for a guild. Re-entrant so _playTrack
   * failure recovery can run while playNext already holds the lock.
   * @param {string} guildId
   * @param {() => Promise<unknown>} fn
   */
  async _withPlayLock(guildId, fn) {
    if (this._inPlayLock.has(guildId)) {
      return fn();
    }

    const prev = this._playLocks.get(guildId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    this._playLocks.set(guildId, prev.then(() => gate, () => gate));
    await prev.catch(() => {});
    this._inPlayLock.add(guildId);
    try {
      return await fn();
    } finally {
      this._inPlayLock.delete(guildId);
      release();
    }
  }

  /**
   * Attaches AudioPlayer event listeners exactly once per guild's player
   * lifetime.
   *
   * Important: do NOT treat every Idle as "track finished". On Render, ffmpeg
   * often fails during Buffering; Idle then used to call playNext and skip
   * the whole library in seconds. Also, destroying the previous ffmpeg
   * process emits Idle — that must not start another track.
   * @param {import('discord.js').Guild} guild
   * @param {import('@discordjs/voice').AudioPlayer} player
   */
  _ensureListeners(guild, player) {
    if (this._listenersAttached.has(guild.id)) return;
    this._listenersAttached.add(guild.id);

    player.on('stateChange', (oldState, newState) => {
      if (newState.status !== AudioPlayerStatus.Idle) {
        if (newState.status === AudioPlayerStatus.Playing) {
          this._consecutiveTrackFailures.set(guild.id, 0);
        }
        return;
      }
      if (!isAcceptingCommands()) return;
      if (this._circuitOpen(guild.id)) return;
      if (this._isSuppressed(guild.id)) return;

      const queue = this.queueManager.get(guild.id);
      queue?.destroyCurrentStream();

      const cameFromPlayback =
        oldState.status === AudioPlayerStatus.Playing || oldState.status === AudioPlayerStatus.Paused;

      if (cameFromPlayback) {
        if (queue) queue.state = 'idle';
        this.playNext(guild).catch((err) => {
          logger.error('auto_advance_failed', err, { guildId: guild.id });
          supervisor.reportFailure('queue', err, { guildId: guild.id });
        });
        return;
      }

      // Buffering → Idle (or AutoPaused → Idle): stream never started.
      logger.warn('track_failed_before_playing', {
        guildId: guild.id,
        from: oldState.status,
      });
      this._handleTrackFailure(guild).catch((advanceErr) => {
        logger.error('track_failure_recovery_failed', advanceErr, { guildId: guild.id });
        supervisor.reportFailure('queue', advanceErr, { guildId: guild.id });
      });
    });

    player.on('error', (err) => {
      logger.error('audio_player_error', err, { guildId: guild.id });
      if (this._isSuppressed(guild.id)) return;
      const queue = this.queueManager.get(guild.id);
      queue?.destroyCurrentStream();
      this._handleTrackFailure(guild).catch((advanceErr) => {
        logger.error('track_failure_recovery_failed', advanceErr, { guildId: guild.id });
        supervisor.reportFailure('queue', advanceErr, { guildId: guild.id });
      });
    });
  }

  /**
   * Called when a track fails mid-playback. Retries the same track a
   * bounded number of times (handles transient network blips) before
   * giving up and skipping to the next track, so one bad file can't stall
   * the whole queue forever.
   * @param {import('discord.js').Guild} guild
   */
  async _handleTrackFailure(guild) {
    return this._withPlayLock(guild.id, () => this._handleTrackFailureExclusive(guild));
  }

  /** @param {import('discord.js').Guild} guild */
  async _handleTrackFailureExclusive(guild) {
    const queue = this.queueManager.get(guild.id);
    if (!queue?.nowPlaying) return this._playNextExclusive(guild);

    const failedTrack = queue.nowPlaying;
    const retryCount = this._trackRetryCounts.get(guild.id) || 0;

    if (retryCount < MAX_TRACK_RETRIES) {
      this._trackRetryCounts.set(guild.id, retryCount + 1);
      logger.warn('track_retry', { guildId: guild.id, songId: failedTrack.song.id, attempt: retryCount + 1 });
      this._beginSuppress(guild.id);
      try {
        return await this._playTrack(guild, failedTrack);
      } finally {
        setImmediate(() => this._endSuppress(guild.id));
      }
    }

    logger.warn('track_skipped_after_failures', { guildId: guild.id, songId: failedTrack.song.id });
    this._trackRetryCounts.delete(guild.id);
    this._bumpConsecutiveFailures(guild.id);
    if (this._circuitOpen(guild.id)) {
      return this._haltPlayback(guild, 'consecutive_track_failures');
    }
    return this._playNextExclusive(guild);
  }

  /** @param {string} guildId */
  _bumpConsecutiveFailures(guildId) {
    this._consecutiveTrackFailures.set(guildId, (this._consecutiveTrackFailures.get(guildId) || 0) + 1);
  }

  /** @param {string} guildId */
  _circuitOpen(guildId) {
    return (this._consecutiveTrackFailures.get(guildId) || 0) >= config.playback.maxConsecutiveTrackFailures;
  }

  /**
   * Stops refill loops when the whole library (or ffmpeg) is broken.
   * @param {import('discord.js').Guild} guild
   * @param {string} reason
   */
  _haltPlayback(guild, reason) {
    const count = this._consecutiveTrackFailures.get(guild.id) || 0;
    logger.critical(
      'playback_circuit_open',
      new Error(reason),
      { guildId: guild.id, consecutiveFailures: count },
      'Stopped advancing the queue after repeated track failures',
    );
    const queue = this.queueManager.get(guild.id);
    queue?.destroyCurrentStream();
    if (queue) {
      queue.state = 'idle';
      queue.nowPlaying = null;
    }
    supervisor.reportFailure('queue', new Error(reason), { guildId: guild.id, force: true });
  }

  /**
   * Advances the queue and plays the next track, refilling from the full
   * library (freshly shuffled, no immediate repeats) when the upcoming
   * queue runs dry.
   * @param {import('discord.js').Guild} guild
   */
  async playNext(guild) {
    return this._withPlayLock(guild.id, () => this._playNextExclusive(guild));
  }

  /**
   * @param {import('discord.js').Guild} guild
   */
  async _playNextExclusive(guild) {
    if (!isAcceptingCommands()) return;
    if (this._circuitOpen(guild.id)) {
      return this._haltPlayback(guild, 'consecutive_track_failures');
    }

    const queue = this.queueManager.getOrCreate(guild.id);
    this._trackRetryCounts.delete(guild.id);
    this._beginSuppress(guild.id);
    queue.destroyCurrentStream();

    try {
      if (queue.isEmpty()) {
        const songs = await supabaseService.getAllActiveSongs();
        if (!songs || songs.length === 0) {
          logger.warn('library_empty', {
            guildId: guild.id,
            hint: 'Upload an audio file (.mp3, .wav, .ogg, .m4a, .flac, .aac) to the Storage bucket and it will be picked up automatically.',
          });
          queue.state = 'idle';
          queue.nowPlaying = null;
          return;
        }
        queue.fillFromLibrary(songs);
      }

      const track = queue.advance();
      if (!track) {
        queue.state = 'idle';
        return;
      }

      await this._playTrack(guild, track);
      supervisor.reportSuccess('queue');
    } catch (err) {
      logger.error('play_next_failed', err, { guildId: guild.id });
      supervisor.reportFailure('queue', err, { guildId: guild.id });
    } finally {
      setImmediate(() => this._endSuppress(guild.id));
    }
  }

  /**
   * Builds a streaming audio resource for a track and starts playback.
   * Streams directly from a Supabase signed URL through ffmpeg -> Opus;
   * the file is never written to disk.
   * @param {import('discord.js').Guild} guild
   * @param {import('../types').QueuedTrack} track
   */
  async _playTrack(guild, track) {
    const queue = this.queueManager.getOrCreate(guild.id);

    if (!isValidSongRecord(track.song, config.supabase.bucketName)) {
      logger.warn('skipping_untrusted_song', { guildId: guild.id, songId: track.song?.id });
      this._bumpConsecutiveFailures(guild.id);
      if (this._circuitOpen(guild.id)) {
        return this._haltPlayback(guild, 'consecutive_track_failures');
      }
      return this._playNextExclusive(guild);
    }

    try {
      if (!ffmpegPath) {
        throw new PermanentError('ffmpeg-static binary is missing; cannot transcode audio.', 'FFMPEG_MISSING');
      }

      const signedUrl = await supabaseService.getSignedStreamUrl(track.song);

      if (!isTrustedSignedUrl(signedUrl, config.supabase.url)) {
        throw new PermanentError('Refusing to stream from untrusted signed URL host', 'UNTRUSTED_URL');
      }

      queue.destroyCurrentStream();
      const resource = this._buildStreamingResource(queue, signedUrl);
      resource.volume?.setVolume(queue.volume);
      queue.nowPlaying = track;
      queue.state = 'playing';

      if (!queue.player) {
        throw new Error('No audio player attached for this guild');
      }
      queue.player.play(resource);

      try {
        await entersState(queue.player, AudioPlayerStatus.Playing, 15_000);
      } catch {
        throw new Error('Audio player did not start within 15s (stream may have failed to open)');
      }

      logger.info(
        'track_started',
        {
          guildId: guild.id,
          songId: track.song.id,
          title: track.song.title,
          artist: track.song.artist,
          requestedBy: track.requestedBy,
        },
        `🎵 Now playing: "${track.song.title}" by ${track.song.artist}`,
      );

      supabaseService.logPlayHistory(guild.id, track.song).catch(() => {});
    } catch (err) {
      logger.error('play_track_failed', err, { guildId: guild.id, songId: track.song.id });
      queue.destroyCurrentStream();
      if (err instanceof PermanentError || err?.permanent) {
        return this._haltPlayback(guild, err.code || 'permanent_play_failure');
      }
      await this._handleTrackFailureExclusive(guild);
    }
  }

  /**
   * Spawns ffmpeg pointed directly at the Supabase signed URL (ffmpeg reads
   * over HTTP itself — no manual download/buffering step) and pipes the
   * transcoded PCM into an Opus encoder to build a Discord-ready
   * AudioResource. ffmpeg's own `-reconnect` flags add transient-network
   * resilience at the stream level.
   * @param {import('./musicQueue').GuildMusicQueue} queue
   * @param {string} sourceUrl
   * @returns {import('@discordjs/voice').AudioResource}
   */
  _buildStreamingResource(queue, sourceUrl) {
    const ffmpegArgs = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-analyzeduration', '2000000',
      '-probesize', '1000000',
      '-loglevel', 'error',
      '-nostdin',
      '-i', sourceUrl,
      '-vn',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
    ];

    const ffmpegProcess = new prism.FFmpeg({ args: ffmpegArgs });

    queue.currentFfmpeg = ffmpegProcess;
    queue.currentOpus = null;

    const stderrChunks = [];
    ffmpegProcess.process?.stderr?.on('data', (chunk) => {
      stderrChunks.push(chunk);
      if (stderrChunks.length > 8) stderrChunks.shift();
    });
    ffmpegProcess.process?.once?.('close', (code, signal) => {
      if (code && code !== 0 && signal !== 'SIGKILL' && signal !== 'SIGTERM') {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(-400);
        logger.warn('ffmpeg_exit', { code, signal, stderr });
      }
    });

    const fail = (err) => {
      logger.error('ffmpeg_stream_error', err);
      queue.destroyCurrentStream();
    };

    ffmpegProcess.process?.once?.('error', fail);
    ffmpegProcess.once('error', fail);

    // PCM + inlineVolume. Do not pre-encode Opus here — VolumeTransformer expects
    // s16le, and wrapping Opus with inlineVolume makes the player go Idle immediately.
    const resource = createAudioResource(ffmpegProcess, { inputType: StreamType.Raw, inlineVolume: true });
    queue.currentResource = resource;
    return resource;
  }

  /** @param {string} guildId */
  pause(guildId) {
    const queue = this.queueManager.get(guildId);
    if (!queue?.player) return false;
    const ok = queue.player.pause();
    if (ok) queue.state = 'paused';
    return ok;
  }

  /** @param {string} guildId */
  resume(guildId) {
    const queue = this.queueManager.get(guildId);
    if (!queue?.player) return false;
    const ok = queue.player.unpause();
    if (ok) queue.state = 'playing';
    return ok;
  }

  /**
   * Skips the current track. Stopping the player fires the `idle` event,
   * which naturally advances the queue via the existing listener.
   * @param {import('discord.js').Guild} guild
   */
  skip(guild) {
    const queue = this.queueManager.get(guild.id);
    if (!queue?.player || !queue.nowPlaying) return false;
    queue.player.stop(true);
    return true;
  }

  /**
   * @param {string} guildId
   * @param {number} volume0to1
   */
  setVolume(guildId, volume0to1) {
    const queue = this.queueManager.get(guildId);
    if (!queue) return false;
    queue.volume = volume0to1;
    queue.currentResource?.volume?.setVolume(volume0to1);
    return true;
  }

  /** @param {import('discord.js').Guild} guild */
  reshuffle(guild) {
    const queue = this.queueManager.get(guild.id);
    if (!queue) return false;
    queue.reshuffleUpcoming();
    return true;
  }
}

module.exports = PlaybackService;

'use strict';

const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');
const { createAudioResource, StreamType, AudioPlayerStatus } = require('@discordjs/voice');

const supabaseService = require('./supabaseService');
const { retry } = require('../utils/retry');
const logger = require('../utils/logger').child('playbackService');

// prism-media resolves the ffmpeg binary via this env var when set.
process.env.FFMPEG_PATH = process.env.FFMPEG_PATH || ffmpegPath;

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
  }

  /**
   * Ensures the bot is connected and playback is running for a guild.
   * Idempotent: safe to call even if something is already playing.
   * @param {import('discord.js').Guild} guild
   */
  async start(guild) {
    const { player } = this.voiceManager.joinConfiguredChannel(guild);
    await this.voiceManager.waitUntilReady(this.voiceManager.queueManager.getOrCreate(guild.id).connection);
    this._ensureListeners(guild, player);

    const queue = this.queueManager.getOrCreate(guild.id);
    if (queue.state !== 'playing' && !queue.nowPlaying) {
      await this.playNext(guild);
    }
  }

  /**
   * Attaches AudioPlayer event listeners exactly once per guild's player
   * lifetime. `idle` means the current resource finished -> advance the
   * queue. `error` means the stream broke mid-playback -> retry or skip.
   * @param {import('discord.js').Guild} guild
   * @param {import('@discordjs/voice').AudioPlayer} player
   */
  _ensureListeners(guild, player) {
    if (this._listenersAttached.has(guild.id)) return;
    this._listenersAttached.add(guild.id);

    player.on(AudioPlayerStatus.Idle, () => {
      const queue = this.queueManager.get(guild.id);
      if (queue) queue.state = 'idle';
      this.playNext(guild).catch((err) => {
        logger.error('auto_advance_failed', err, { guildId: guild.id });
      });
    });

    player.on('error', (err) => {
      logger.error('audio_player_error', err, { guildId: guild.id });
      this._handleTrackFailure(guild).catch((advanceErr) => {
        logger.error('track_failure_recovery_failed', advanceErr, { guildId: guild.id });
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
    const queue = this.queueManager.get(guild.id);
    if (!queue?.nowPlaying) return this.playNext(guild);

    const failedTrack = queue.nowPlaying;
    const retryCount = this._trackRetryCounts.get(guild.id) || 0;

    if (retryCount < MAX_TRACK_RETRIES) {
      this._trackRetryCounts.set(guild.id, retryCount + 1);
      logger.warn('track_retry', { guildId: guild.id, songId: failedTrack.song.id, attempt: retryCount + 1 });
      return this._playTrack(guild, failedTrack);
    }

    logger.warn('track_skipped_after_failures', { guildId: guild.id, songId: failedTrack.song.id });
    this._trackRetryCounts.delete(guild.id);
    return this.playNext(guild);
  }

  /**
   * Advances the queue and plays the next track, refilling from the full
   * library (freshly shuffled, no immediate repeats) when the upcoming
   * queue runs dry.
   * @param {import('discord.js').Guild} guild
   */
  async playNext(guild) {
    const queue = this.queueManager.getOrCreate(guild.id);
    this._trackRetryCounts.delete(guild.id);

    if (queue.isEmpty()) {
      // getAllActiveSongs() rescans the Storage bucket first (best-effort),
      // so any file uploaded since the last refill enters rotation here
      // automatically — no manual database entry required.
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

    try {
      const signedUrl = await retry(() => supabaseService.getSignedStreamUrl(track.song), {
        retries: 2,
        baseDelayMs: 500,
        onRetry: (err, attempt, delay) =>
          logger.warn('signed_url_retry', { guildId: guild.id, songId: track.song.id, attempt, delay, error: err.message }),
      });

      const resource = this._buildStreamingResource(signedUrl);
      resource.volume?.setVolume(queue.volume);
      queue.currentResource = resource;
      queue.nowPlaying = track;
      queue.state = 'playing';

      queue.player.play(resource);

      logger.info(
        'track_started',
        { guildId: guild.id, songId: track.song.id, title: track.song.title, artist: track.song.artist, requestedBy: track.requestedBy },
        `🎵 Now playing: "${track.song.title}" by ${track.song.artist}`,
      );

      supabaseService.logPlayHistory(guild.id, track.song).catch(() => {});
    } catch (err) {
      logger.error('play_track_failed', err, { guildId: guild.id, songId: track.song.id });
      await this._handleTrackFailure(guild);
    }
  }

  /**
   * Spawns ffmpeg pointed directly at the Supabase signed URL (ffmpeg reads
   * over HTTP itself — no manual download/buffering step) and pipes the
   * transcoded PCM into an Opus encoder to build a Discord-ready
   * AudioResource. ffmpeg's own `-reconnect` flags add transient-network
   * resilience at the stream level.
   * @param {string} sourceUrl
   * @returns {import('@discordjs/voice').AudioResource}
   */
  _buildStreamingResource(sourceUrl) {
    const ffmpegArgs = [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-analyzeduration', '0',
      '-loglevel', '0',
      '-i', sourceUrl,
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
    ];

    const ffmpegProcess = new prism.FFmpeg({ args: ffmpegArgs });
    const opusEncoder = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });

    const pcmStream = ffmpegProcess.pipe(opusEncoder);

    ffmpegProcess.process?.once?.('error', (err) => {
      logger.error('ffmpeg_process_error', err);
    });
    ffmpegProcess.once('error', (err) => {
      logger.error('ffmpeg_stream_error', err);
      pcmStream.destroy(err);
    });

    return createAudioResource(pcmStream, { inputType: StreamType.Opus, inlineVolume: true });
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

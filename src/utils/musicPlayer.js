const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');
const { pipeline } = require('stream');
const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');
const b2 = require('./b2Client');
const config = require('../config');

const LOOP_MODES = { OFF: 'off', TRACK: 'track', QUEUE: 'queue' };

// How many times to retry a single track after a transient stream/ffmpeg
// failure (e.g. "Premature close" from a dropped B2 connection) before
// giving up on that track and moving to the next one.
const MAX_TRACK_RETRIES = 2;
// Safety circuit breaker: if this many tracks in a row fail even after
// their retries, stop auto-advancing instead of hammering B2/ffmpeg forever
// (e.g. bucket unreachable, credentials revoked, network down).
const MAX_CONSECUTIVE_TRACK_FAILURES = 5;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

class GuildMusicSession {
  constructor(guildId) {
    this.guildId = guildId;
    this.connection = null;
    this.player = createAudioPlayer();
    this.playlist = []; // [{ key, title }]
    this.currentIndex = -1;
    this.loopMode = LOOP_MODES.QUEUE;
    this.shuffleEnabled = config.shufflePlaylist;
    this.trackHistory = [];
    this.volume = config.defaultVolume; // 0-200
    this.currentResource = null;
    this.textChannel = null; // for status messages
    this.startedAt = null;
    this._activeStreams = null; // { source, transcoder } for the in-flight track, so we can clean them up
    this._consecutiveFailures = 0;
    this._playToken = 0; // incremented on every playIndex call; guards against stale async callbacks
    this._registerPlayerEvents();
  }

  _registerPlayerEvents() {
    this.player.on(AudioPlayerStatus.Idle, () => {
      // Only treat this as "track finished cleanly" if nothing already
      // claimed this play attempt (e.g. our pipeline error handler below,
      // which reacts to the same underlying stream failure and may run
      // just before @discordjs/voice itself transitions to Idle).
      if (!this._claimSettle(this._playToken)) return;
      this._cleanupActiveStreams();
      this._consecutiveFailures = 0; // a track finishing cleanly resets the breaker
      this._advance();
    });
    this.player.on('error', (err) => {
      if (!this._claimSettle(this._playToken)) return;
      console.error(`[player:${this.guildId}] error:`, err.message);
      const state = this._settleState;
      const track = state?.track || this.currentTrack;
      const index = state?.index ?? this.currentIndex;
      const retryCount = state?.retryCount ?? MAX_TRACK_RETRIES;
      const recordHistory = state?.recordHistory ?? true;
      this._cleanupActiveStreams();
      if (track && index !== -1) {
        this._retryOrAdvance(index, track, retryCount, recordHistory).catch((e) =>
          console.error(`[player:${this.guildId}] retry/advance failed:`, e.message)
        );
      } else {
        this._advance();
      }
    });
  }

  /**
   * Ensures only one failure/completion handler acts per play attempt.
   * @discordjs/voice's AudioPlayer independently reacts to the same
   * underlying resource-stream failure that our pipeline() callback reacts
   * to; without this guard both could fire and each call _advance(),
   * skipping two tracks for one failure (or racing on the retry).
   */
  _claimSettle(token) {
    if (!this._settleState || this._settleState.token !== token) {
      this._settleState = { token, done: false };
    }
    if (this._settleState.done) return false;
    this._settleState.done = true;
    return true;
  }

  /**
   * Error handling / resource-leak fix: previously the raw S3 stream and
   * ffmpeg transcoder from a failed/replaced track were left dangling
   * (never destroyed), which leaks sockets and file descriptors and can
   * itself contribute to future connections being starved/reset by B2.
   * Always tear both down together before starting a new track.
   */
  _cleanupActiveStreams() {
    if (!this._activeStreams) return;
    const { source, transcoder } = this._activeStreams;
    for (const s of [source, transcoder]) {
      if (s && !s.destroyed) {
        try {
          s.destroy();
        } catch {
          // already gone, ignore
        }
      }
    }
    this._activeStreams = null;
  }

  async ensurePlaylist() {
    if (this.playlist.length === 0) {
      this.playlist = await b2.listPlaylist();
      if (this.shuffleEnabled) {
        this.playlist = shuffle(this.playlist);
      }
    }
    return this.playlist;
  }

  async reloadPlaylist() {
    const currentKey = this.currentTrack?.key;
    this.playlist = await b2.listPlaylist();
    if (this.shuffleEnabled) {
      this.playlist = shuffle(this.playlist);
    } else {
      this.playlist.sort((a, b) => a.title.localeCompare(b.title));
    }
    if (currentKey) {
      const idx = this.playlist.findIndex((t) => t.key === currentKey);
      if (idx !== -1) this.currentIndex = idx;
    }
    return this.playlist.length;
  }

  async setShuffle(enabled) {
    this.shuffleEnabled = enabled;
    if (this.playlist.length > 0) {
      await this.reloadPlaylist();
    }
  }

  async connect(voiceChannel) {
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      return this.connection;
    }
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      this.connection.destroy();
      this.connection = null;
      throw new Error('Could not join the voice channel in time.');
    }

    this.connection.subscribe(this.player);

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });

    return this.connection;
  }

  disconnect() {
    if (this.connection) {
      try {
        this.connection.destroy();
      } catch (e) {
        // already destroyed, ignore
      }
      this.connection = null;
    }
    this.player.stop(true);
    this._cleanupActiveStreams();
    this.currentIndex = -1;
    this.startedAt = null;
    this.currentResource = null;
    this.playlist = [];
    this.trackHistory = [];
    this._consecutiveFailures = 0;
  }

  destroy() {
    this.disconnect();
  }

  async playIndex(index, { recordHistory = true, _retryCount = 0 } = {}) {
    if (this.playlist.length === 0) await this.ensurePlaylist();
    if (this.playlist.length === 0) {
      throw new Error('No audio files found in the B2 bucket/prefix.');
    }

    if (recordHistory && this.currentIndex !== -1 && this.currentIndex !== index) {
      this.trackHistory.push(this.currentIndex);
      if (this.trackHistory.length > 50) this.trackHistory.shift();
    }

    const wrapped = ((index % this.playlist.length) + this.playlist.length) % this.playlist.length;
    this.currentIndex = wrapped;
    const track = this.playlist[wrapped];

    // Circuit breaker: if we've failed this many tracks in a row (each
    // already having exhausted its own retries), something structural is
    // wrong (bucket unreachable, bad credentials, no network) — stop
    // instead of silently looping through the whole playlist forever.
    if (this._consecutiveFailures >= MAX_CONSECUTIVE_TRACK_FAILURES) {
      const msg = `Stopped after ${this._consecutiveFailures} tracks in a row failed to stream. Check B2 connectivity/credentials.`;
      console.error(`[player:${this.guildId}] ${msg}`);
      this._consecutiveFailures = 0;
      this.currentIndex = -1;
      if (this.textChannel) {
        this.textChannel.send({ content: `⚠️ ${msg}`, allowedMentions: { parse: [] } }).catch(() => {});
      }
      throw new Error(msg);
    }

    const myToken = ++this._playToken;

    let source;
    try {
      source = await b2.getObjectStream(track.key);
    } catch (err) {
      console.error(`[player:${this.guildId}] failed to open stream for "${track.title}":`, err.message);
      if (myToken !== this._playToken) return track; // superseded by a newer playIndex call
      return this._retryOrAdvance(index, track, _retryCount, recordHistory);
    }

    const transcoder = new prism.FFmpeg({
      command: ffmpegPath,
      args: [
        '-analyzeduration', '0',
        '-probesize', '32',
        '-loglevel', 'error',
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
      ],
    });

    this._activeStreams = { source, transcoder };
    // Fresh claim-guard for this attempt. retryCount/recordHistory/index/track
    // are stashed here so the AudioPlayer's own 'error' listener (registered
    // once, in _registerPlayerEvents) can drive the same retry logic if it
    // claims the failure before our pipeline() callback does.
    this._settleState = { token: myToken, done: false, retryCount: _retryCount, recordHistory, index, track };

    // pipeline() (vs. bare .pipe()) guarantees both streams are destroyed
    // together on any error/close, so a dropped B2 connection can't leave
    // ffmpeg hanging (or vice versa) — this is what previously surfaced as
    // an unrecoverable "Premature close" ffmpeg error on every subsequent
    // track once a socket/agent got into a bad state.
    pipeline(source, transcoder, (err) => {
      if (!err) return; // null err = clean end, handled by the Idle listener instead
      if (myToken !== this._playToken) return; // superseded by a newer playIndex call, ignore
      if (!this._claimSettle(myToken)) return; // AudioPlayer's own error handler already claimed it
      console.error(`[player:${this.guildId}] stream error on "${track.title}":`, err.message);
      this._cleanupActiveStreams();
      this._retryOrAdvance(index, track, _retryCount, recordHistory).catch((e) =>
        console.error(`[player:${this.guildId}] retry/advance failed:`, e.message)
      );
    });

    const resource = createAudioResource(transcoder, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });
    resource.volume.setVolume(this.volume / 100);
    this.currentResource = resource;
    this.startedAt = Date.now();

    this.player.play(resource);
    this._consecutiveFailures = 0; // successfully started playback
    return track;
  }

  /**
   * On a transient failure, retry the SAME track a bounded number of times
   * (with backoff) before giving up and moving on — this is what actually
   * survives the "Premature close" blips instead of just logging them.
   */
  async _retryOrAdvance(index, track, retryCount, recordHistory) {
    if (this.currentIndex === -1) return; // session was stopped/disconnected in the meantime
    if (retryCount < MAX_TRACK_RETRIES) {
      const delay = 500 * 2 ** retryCount;
      console.warn(`[player:${this.guildId}] retrying "${track.title}" in ${delay}ms (attempt ${retryCount + 1}/${MAX_TRACK_RETRIES})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return this.playIndex(index, { recordHistory, _retryCount: retryCount + 1 });
    }
    this._consecutiveFailures += 1;
    console.error(`[player:${this.guildId}] giving up on "${track.title}" after ${MAX_TRACK_RETRIES} retries, skipping.`);
    return this._advance();
  }

  async playFromStart() {
    await this.ensurePlaylist();
    return this.playIndex(0);
  }

  _advance() {
    if (this.playlist.length === 0) return;

    if (this.loopMode === LOOP_MODES.TRACK) {
      this.playIndex(this.currentIndex).catch((e) => console.error('[player] replay error:', e.message));
      return;
    }

    const isLastTrack = this.currentIndex >= this.playlist.length - 1;
    if (isLastTrack && this.loopMode === LOOP_MODES.OFF) {
      // Playlist finished, no loop -> stop and stay connected (idle) until stop/disconnect.
      this.currentIndex = -1;
      return;
    }

    this.playIndex(this.currentIndex + 1).catch((e) => console.error('[player] advance error:', e.message));
  }

  skip() {
    if (this.currentIndex === -1) return false;
    this._advance();
    return true;
  }

  async previous() {
    if (this.trackHistory.length === 0) return null;
    const prevIndex = this.trackHistory.pop();
    return this.playIndex(prevIndex, { recordHistory: false });
  }

  setVolume(percent) {
    this.volume = Math.max(0, Math.min(200, percent));
    if (this.currentResource) {
      this.currentResource.volume.setVolume(this.volume / 100);
    }
  }

  setLoopMode(mode) {
    if (!Object.values(LOOP_MODES).includes(mode)) {
      throw new Error(`Invalid loop mode: ${mode}`);
    }
    this.loopMode = mode;
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  get currentTrack() {
    if (this.currentIndex === -1 || !this.playlist[this.currentIndex]) return null;
    return this.playlist[this.currentIndex];
  }

  get isPlaying() {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }

  get isPaused() {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  get isConnected() {
    return !!this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed;
  }
}

class MusicManager {
  constructor() {
    this.sessions = new Map(); // guildId -> GuildMusicSession
    this.joinTimers = new Map(); // guildId -> Timeout
  }

  getSession(guildId) {
    if (!this.sessions.has(guildId)) {
      this.sessions.set(guildId, new GuildMusicSession(guildId));
    }
    return this.sessions.get(guildId);
  }

  clearJoinTimer(guildId) {
    const t = this.joinTimers.get(guildId);
    if (t) {
      clearTimeout(t);
      this.joinTimers.delete(guildId);
    }
  }

  setJoinTimer(guildId, timeout) {
    this.clearJoinTimer(guildId);
    this.joinTimers.set(guildId, timeout);
  }

  hasJoinTimer(guildId) {
    return this.joinTimers.has(guildId);
  }
}

module.exports = {
  MusicManager,
  LOOP_MODES,
};

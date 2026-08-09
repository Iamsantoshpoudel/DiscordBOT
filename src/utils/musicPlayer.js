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
const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');
const b2 = require('./b2Client');
const config = require('../config');

const LOOP_MODES = { OFF: 'off', TRACK: 'track', QUEUE: 'queue' };

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
    this._registerPlayerEvents();
  }

  _registerPlayerEvents() {
    this.player.on(AudioPlayerStatus.Idle, () => {
      this._advance();
    });
    this.player.on('error', (err) => {
      console.error(`[player:${this.guildId}] error:`, err.message);
      this._advance();
    });
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
    this.currentIndex = -1;
    this.startedAt = null;
    this.currentResource = null;
    this.playlist = [];
    this.trackHistory = [];
  }

  destroy() {
    this.disconnect();
  }

  async playIndex(index, { recordHistory = true } = {}) {
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

    const stream = await b2.getObjectStream(track.key);

    stream.on('error', (err) => {
      console.error(`[player:${this.guildId}] stream error on "${track.title}":`, err.message);
      this.player.stop(true);
    });

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

    transcoder.on('error', (err) => {
      console.error(`[player:${this.guildId}] ffmpeg error on "${track.title}":`, err.message);
      this.player.stop(true);
    });

    const pcmStream = stream.pipe(transcoder);

    const resource = createAudioResource(pcmStream, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });
    resource.volume.setVolume(this.volume / 100);
    this.currentResource = resource;
    this.startedAt = Date.now();

    this.player.play(resource);
    return track;
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

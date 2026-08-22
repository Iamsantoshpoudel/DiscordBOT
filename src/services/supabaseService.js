'use strict';

const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config/config');
const { retry, PermanentError } = require('../utils/retry');
const { sanitizeAndEscapeQuery, isValidSongRecord, isSafeStoragePath, isTrustedSignedUrl, AUDIO_EXTENSIONS } = require('../utils/sanitize');
const logger = require('../utils/logger').child('supabaseService');
const supervisor = require('../utils/supervisor');
const { inc } = require('../utils/metrics');

/** @typedef {import('../types').SongRecord} SongRecord */

const SONG_COLUMNS = 'id, title, artist, duration_seconds, file_path, bucket_name, added_by, is_active, created_at';

/**
 * @param {string} filename
 * @returns {boolean}
 */
function isAudioFile(filename) {
  return AUDIO_EXTENSIONS.has(path.posix.extname(filename).toLowerCase());
}

/**
 * Guesses a title/artist from a filename so newly-uploaded files get
 * sensible metadata automatically. Supports the common "Artist - Title.mp3"
 * naming convention; otherwise falls back to using the whole filename as
 * the title.
 * @param {string} filename
 * @returns {{ title: string, artist: string }}
 */
function guessMetadataFromFilename(filename) {
  const nameWithoutExt = path.posix.parse(filename).name;
  const parts = nameWithoutExt.split(' - ');
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  return { artist: 'Unknown Artist', title: nameWithoutExt.trim() };
}

class SupabaseService {
  constructor() {
    this.client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'X-Client-Info': 'discord-music-bot' } },
    });
    this.table = config.supabase.songsTable;
    this.bucket = config.supabase.bucketName;
  }

  /**
   * Walks the bucket (root + nested folders) and paginates storage.list.
   * Caps total objects scanned to avoid unbounded memory on a huge bucket.
   * @returns {Promise<{ files: object[], truncated: boolean }>}
   */
  async _listStorageTree() {
    const pageSize = 100;
    const maxFiles = 2000;
    const maxDepth = 4;
    const files = [];
    let truncated = false;

    const walk = async (dir, depth) => {
      if (files.length >= maxFiles || depth > maxDepth) {
        truncated = true;
        return;
      }
      let offset = 0;
      while (files.length < maxFiles) {
        const currentDir = dir;
        const currentOffset = offset;
        const page = await this._withRetry(
          () =>
            this.client.storage.from(this.bucket).list(currentDir, {
              limit: pageSize,
              offset: currentOffset,
              sortBy: { column: 'name', order: 'asc' },
            }),
          'storage.list',
          { notifySupervisor: false },
        );
        if (!page || page.length === 0) break;
        for (const item of page) {
          if (!item?.name || item.name === '.emptyFolderPlaceholder') continue;
          const childPath = currentDir ? `${currentDir}/${item.name}` : item.name;
          const isFolder = item.id == null;
          if (isFolder) {
            await walk(childPath, depth + 1);
          } else if (isAudioFile(item.name) && isSafeStoragePath(childPath)) {
            files.push({ ...item, name: childPath });
          }
        }
        if (page.length < pageSize) break;
        offset += pageSize;
      }
    };

    await walk('', 0);
    if (files.length >= maxFiles) truncated = true;
    if (truncated) {
      logger.warn('storage_list_truncated', { maxFiles, maxDepth, bucket: this.bucket });
    }
    return { files, truncated };
  }

  /**
   * Wraps a Supabase call with retry logic for transient network failures.
   * Supabase client errors don't throw — they return `{ data, error }` — so
   * we normalize that into a thrown error for the retry helper to catch.
   * @template T
   * @param {() => Promise<{ data: T, error: any }>} fn
   * @param {string} opName
   */
  async _withRetry(fn, opName, { notifySupervisor = true } = {}) {
    try {
      const data = await retry(
        async () => {
          const { data: result, error } = await fn();
          if (error) {
            const err = new Error(error.message || `Supabase error during ${opName}`);
            err.cause = error;
            err.status = error.status || error.code;
            throw err;
          }
          return result;
        },
        {
          retries: 2,
          baseDelayMs: 400,
          onRetry: (err, attempt, delayMs) => {
            logger.warn('supabase_retry', { opName, attempt, delayMs, error: err.message });
          },
        },
      );
      if (notifySupervisor) supervisor.reportSuccess('supabase');
      return data;
    } catch (err) {
      inc('supabaseErrors');
      if (notifySupervisor) supervisor.reportFailure('supabase', err, { opName });
      throw err;
    }
  }

  /**
   * @param {unknown[]} rows
   * @returns {SongRecord[]}
   */
  _filterValidSongs(rows) {
    const valid = [];
    for (const row of rows || []) {
      if (isValidSongRecord(row, this.bucket)) {
        valid.push(row);
      } else {
        logger.warn('invalid_song_row_skipped', { id: row?.id, file_path: row?.file_path });
      }
    }
    return valid;
  }

  /**
   * Fetches every active song's metadata from the database. Automatically
   * syncs with Storage first (best-effort) so any file uploaded to the
   * bucket shows up here without needing a manual database entry.
   * @returns {Promise<SongRecord[]>}
   */
  async getAllActiveSongs() {
    await this.syncFromStorageSafe();
    const data = await this._withRetry(
      () =>
        this.client
          .from(this.table)
          .select(SONG_COLUMNS)
          .eq('is_active', true)
          .eq('bucket_name', this.bucket)
          .order('title', { ascending: true })
          .limit(config.playback.maxQueueLength),
      'getAllActiveSongs',
    );
    return this._filterValidSongs(data || []);
  }

  /**
   * Scans the storage bucket for audio files and adds any that aren't yet
   * in the `songs` table. This is what makes "just upload a file" work —
   * no manual SQL insert is required. Existing rows are never overwritten,
   * so any metadata you've manually corrected in Supabase Studio is safe.
   * Also deactivates songs whose files were deleted from the
   * bucket, so the bot won't keep trying (and failing) to play them.
   * @returns {Promise<{ added: number, deactivated: number }>}
   */
  async syncFromStorage() {
    const { files, truncated } = await this._listStorageTree();

    const audioFiles = (files || []).filter((f) => {
      if (!isAudioFile(f.name) || !isSafeStoragePath(f.name)) return false;
      const size = Number(f.metadata?.size);
      if (Number.isFinite(size) && size > config.playback.maxFileSizeBytes) {
        logger.warn('storage_file_too_large', { name: f.name, size, max: config.playback.maxFileSizeBytes });
        return false;
      }
      return true;
    });
    const currentPaths = new Set(audioFiles.map((f) => f.name));

    let added = 0;
    if (audioFiles.length > 0) {
      const rows = audioFiles.map((f) => {
        const { title, artist } = guessMetadataFromFilename(f.name);
        return {
          title,
          artist,
          file_path: f.name,
          bucket_name: this.bucket,
          is_active: true,
          added_by: 'auto-detected',
        };
      });

      const inserted = await this._withRetry(
        () =>
          this.client
            .from(this.table)
            .upsert(rows, { onConflict: 'file_path', ignoreDuplicates: true })
            .select('id'),
        'sync.upsert',
        { notifySupervisor: false },
      );
      added = inserted?.length || 0;
    }

    let deactivated = 0;
    if (truncated) {
      logger.warn('storage_sync_skip_deactivate', {
        reason: 'listing_truncated',
        hint: 'Refusing to mark songs inactive because the bucket listing did not complete.',
      });
    } else {
      const staleRows = await this._withRetry(
        () =>
          this.client
            .from(this.table)
            .select('id, file_path')
            .eq('bucket_name', this.bucket)
            .eq('is_active', true)
            .limit(2000),
        'sync.staleSelect',
        { notifySupervisor: false },
      );

      if (staleRows) {
        const missingIds = staleRows.filter((row) => !currentPaths.has(row.file_path)).map((row) => row.id);
        const chunkSize = 100;
        for (let i = 0; i < missingIds.length; i += chunkSize) {
          const chunk = missingIds.slice(i, i + chunkSize);
          await this._withRetry(
            () => this.client.from(this.table).update({ is_active: false }).in('id', chunk),
            'sync.deactivate',
            { notifySupervisor: false },
          );
        }
        deactivated = missingIds.length;
      }
    }

    return { added, deactivated };
  }

  /**
   * Same as syncFromStorage(), but never throws — sync is a nice-to-have
   * convenience feature and must never block playback if it fails.
   */
  async syncFromStorageSafe() {
    try {
      const result = await this.syncFromStorage();
      if (result.added > 0) {
        logger.info(
          'storage_sync_found_new_songs',
          { added: result.added },
          `🆕 Found ${result.added} new song${result.added === 1 ? '' : 's'} in storage — added to the library`,
        );
      }
      if (result.deactivated > 0) {
        logger.info(
          'storage_sync_removed_deleted_songs',
          { deactivated: result.deactivated },
          `🗑️  Removed ${result.deactivated} song${result.deactivated === 1 ? '' : 's'} that were deleted from storage`,
        );
      }
      return result;
    } catch (err) {
      logger.warn('storage_sync_failed', { error: err.message });
      return { added: 0, deactivated: 0 };
    }
  }

  /**
   * Searches active songs by title or artist (case-insensitive, partial match).
   * @param {string} rawQuery
   * @returns {Promise<SongRecord[]>}
   */
  async searchSongs(rawQuery) {
    const safeQuery = sanitizeAndEscapeQuery(rawQuery);
    if (!safeQuery) return [];

    const data = await this._withRetry(
      () =>
        this.client
          .from(this.table)
          .select(SONG_COLUMNS)
          .eq('is_active', true)
          .eq('bucket_name', this.bucket)
          .or(`title.ilike."%${safeQuery}%",artist.ilike."%${safeQuery}%"`)
          .limit(10),
      'searchSongs',
    );
    return this._filterValidSongs(data || []);
  }

  /**
   * Fetches a single song by ID.
   * @param {string} songId
   * @returns {Promise<SongRecord|null>}
   */
  async getSongById(songId) {
    if (typeof songId !== 'string' || !/^[0-9a-f-]{36}$/i.test(songId)) return null;
    const data = await this._withRetry(
      () =>
        this.client
          .from(this.table)
          .select(SONG_COLUMNS)
          .eq('id', songId)
          .eq('is_active', true)
          .maybeSingle(),
      'getSongById',
    );
    if (!data) return null;
    return isValidSongRecord(data, this.bucket) ? data : null;
  }

  /**
   * Generates a time-limited signed URL for streaming a song's audio file
   * directly from Supabase Storage. The bot never downloads the full file
   * to disk — this URL is fetched as a stream and piped through the
   * transcoder directly into the Discord voice connection.
   * @param {SongRecord} song
   * @returns {Promise<string>}
   */
  async getSignedStreamUrl(song) {
    if (!isValidSongRecord(song, this.bucket) || !isSafeStoragePath(song.file_path)) {
      throw new PermanentError(`Refusing to sign untrusted storage path for song ${song?.id}`, 'UNTRUSTED_PATH');
    }

    const data = await this._withRetry(
      () => this.client.storage.from(this.bucket).createSignedUrl(song.file_path, config.supabase.signedUrlExpirySeconds),
      'getSignedStreamUrl',
    );
    if (!data?.signedUrl) {
      throw new Error(`No signed URL returned for song ${song.id} (${song.file_path})`);
    }
    if (!isTrustedSignedUrl(data.signedUrl, config.supabase.url)) {
      throw new PermanentError(`Signed URL host did not match SUPABASE_URL for song ${song.id}`, 'UNTRUSTED_URL');
    }
    return data.signedUrl;
  }

  /**
   * Records a lightweight play-history entry, if a `play_history` table
   * exists. Failures here are logged but never propagate — history logging
   * must never break playback.
   * @param {string} guildId
   * @param {SongRecord} song
   */
  async logPlayHistory(guildId, song) {
    try {
      const { error } = await this.client.from('play_history').insert({
        guild_id: guildId,
        song_id: song.id,
        played_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message);
    } catch (err) {
      logger.warn('play_history_log_failed', { guildId, songId: song.id, error: err.message });
    }
  }
}

module.exports = new SupabaseService();

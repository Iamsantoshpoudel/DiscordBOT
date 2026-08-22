'use strict';

const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const config = require('../config/config');
const { retry } = require('../utils/retry');
const { sanitizeAndEscapeQuery } = require('../utils/sanitize');
const logger = require('../utils/logger').child('supabaseService');

/** @typedef {import('../types').SongRecord} SongRecord */

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus', '.webm']);

/**
 * @param {string} filename
 * @returns {boolean}
 */
function isAudioFile(filename) {
  return AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase());
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
  const nameWithoutExt = path.parse(filename).name;
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
    });
    this.table = config.supabase.songsTable;
    this.bucket = config.supabase.bucketName;
  }

  /**
   * Wraps a Supabase call with retry logic for transient network failures.
   * Supabase client errors don't throw — they return `{ data, error }` — so
   * we normalize that into a thrown error for the retry helper to catch.
   * @template T
   * @param {() => Promise<{ data: T, error: any }>} fn
   * @param {string} opName
   */
  async _withRetry(fn, opName) {
    return retry(
      async () => {
        const { data, error } = await fn();
        if (error) {
          const err = new Error(error.message || `Supabase error during ${opName}`);
          err.cause = error;
          throw err;
        }
        return data;
      },
      {
        retries: 3,
        baseDelayMs: 400,
        onRetry: (err, attempt, delayMs) => {
          logger.warn('supabase_retry', { opName, attempt, delayMs, error: err.message });
        },
      },
    );
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
      () => this.client.from(this.table).select('*').eq('is_active', true).order('title', { ascending: true }),
      'getAllActiveSongs',
    );
    return data || [];
  }

  /**
   * Scans the storage bucket for audio files and adds any that aren't yet
   * in the `songs` table. This is what makes "just upload a file" work —
   * no manual SQL insert is required. Existing rows are never overwritten,
   * so any metadata you've manually corrected in Supabase Studio is safe.
   * Also deactivates songs whose file has since been deleted from the
   * bucket, so the bot won't keep trying (and failing) to play them.
   * @returns {Promise<{ added: number, deactivated: number }>}
   */
  async syncFromStorage() {
    const { data: files, error: listError } = await this.client.storage.from(this.bucket).list('', {
      limit: 1000,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (listError) {
      // "fetch failed" from Supabase's client is a generic wrapper around a
      // lower-level network error (DNS failure, connection refused, TLS
      // issue, etc). Node attaches the real reason as `.cause` — surface it
      // so the log actually points at something actionable.
      const causeDetail = listError.cause?.message || listError.cause?.code || null;
      const detail = causeDetail ? `${listError.message} (${causeDetail})` : listError.message;
      throw new Error(`Could not list files in bucket "${this.bucket}": ${detail}`);
    }

    const audioFiles = (files || []).filter((f) => f.id && isAudioFile(f.name));
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

      // ignoreDuplicates: true means "insert only if this file_path doesn't
      // already exist" — it will never overwrite a song you've since edited.
      const { data: inserted, error: upsertError } = await this.client
        .from(this.table)
        .upsert(rows, { onConflict: 'file_path', ignoreDuplicates: true })
        .select('id');

      if (upsertError) throw new Error(`Could not save new song metadata: ${upsertError.message}`);
      added = inserted?.length || 0;
    }

    // Deactivate DB rows for files that no longer exist in the bucket, so
    // deleted songs quietly drop out of rotation instead of causing repeated
    // playback errors. This runs even when the bucket is completely empty
    // (currentPaths.size === 0) — that's exactly the case where every
    // existing song needs to be deactivated.
    let deactivated = 0;
    const { data: staleRows, error: staleError } = await this.client
      .from(this.table)
      .select('id, file_path')
      .eq('bucket_name', this.bucket)
      .eq('is_active', true);

    if (!staleError && staleRows) {
      const missingIds = staleRows.filter((row) => !currentPaths.has(row.file_path)).map((row) => row.id);
      if (missingIds.length > 0) {
        const { error: deactivateError } = await this.client
          .from(this.table)
          .update({ is_active: false })
          .in('id', missingIds);
        if (!deactivateError) deactivated = missingIds.length;
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
      const result = await retry(() => this.syncFromStorage(), { retries: 2, baseDelayMs: 400 });
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
          .select('*')
          .eq('is_active', true)
          .or(`title.ilike.%${safeQuery}%,artist.ilike.%${safeQuery}%`)
          .limit(10),
      'searchSongs',
    );
    return data || [];
  }

  /**
   * Fetches a single song by ID.
   * @param {string} songId
   * @returns {Promise<SongRecord|null>}
   */
  async getSongById(songId) {
    const data = await this._withRetry(
      () => this.client.from(this.table).select('*').eq('id', songId).eq('is_active', true).maybeSingle(),
      'getSongById',
    );
    return data || null;
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
    const bucketName = song.bucket_name || this.bucket;
    const data = await this._withRetry(
      () =>
        this.client.storage
          .from(bucketName)
          .createSignedUrl(song.file_path, config.supabase.signedUrlExpirySeconds),
      'getSignedStreamUrl',
    );
    if (!data?.signedUrl) {
      throw new Error(`No signed URL returned for song ${song.id} (${song.file_path})`);
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

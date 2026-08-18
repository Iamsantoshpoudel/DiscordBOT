const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const https = require('https');
const config = require('../config');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.opus', '.webm']);

// Root cause of the "Premature close" ffmpeg errors: the default AWS SDK v3
// HTTP handler has no explicit socket/connection timeout and does not keep
// connections alive, so on flaky networks (or when ffmpeg briefly stops
// reading due to backpressure) B2's side silently drops the socket mid
// download. The readable stream then closes before all bytes were piped
// into ffmpeg, which surfaces as ERR_STREAM_PREMATURE_CLOSE.
//
// Fixing this at the transport level: keep sockets alive, bound how long we
// wait for a connection/response, and let the SDK retry transient failures
// before we ever see them.
const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15_000,
  maxSockets: 25,
});

const s3 = new S3Client({
  endpoint: config.b2.endpoint,
  region: config.b2.region,
  credentials: {
    accessKeyId: config.b2.keyId,
    secretAccessKey: config.b2.applicationKey,
  },
  // B2's S3-compatible endpoint works with virtual-hosted-style off by default in some setups;
  // forcePathStyle avoids DNS/bucket-name issues.
  forcePathStyle: true,
  maxAttempts: 3, // built-in SDK retry on transient network/5xx errors
  requestHandler: new NodeHttpHandler({
    httpsAgent: agent,
    connectionTimeout: 10_000, // fail fast if we can't even open the socket
    requestTimeout: 0, // no ceiling on total download time (audio files can be large)
    socketTimeout: 30_000, // but kill the socket if it goes fully silent for 30s
  }),
});

function isAudioFile(key) {
  const lower = key.toLowerCase();
  for (const ext of AUDIO_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Security: B2 object keys come from our own bucket listing, but we still
 * defensively reject anything that looks like path traversal or a key
 * outside the configured prefix before ever issuing a GetObject call.
 */
function isSafeKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024) return false;
  if (key.includes('..')) return false;
  if (config.b2.prefix && !key.startsWith(config.b2.prefix)) return false;
  return true;
}

/**
 * Security: track titles are derived from filenames in the bucket and get
 * echoed back into Discord messages/embeds. Strip anything that could be
 * used for mention-injection (@everyone/@here/role or user pings) or that
 * would break Markdown formatting in embeds.
 */
function sanitizeForDiscord(text) {
  return String(text)
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .replace(/<@[!&]?\d+>/g, '')
    .replace(/[*_~`|>]/g, '')
    .slice(0, 256);
}

async function withRetry(fn, { attempts = 3, baseDelayMs = 500, label = 'operation' } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(`[b2] ${label} failed (attempt ${i}/${attempts}): ${err.message}`);
      if (i < attempts) {
        const delay = baseDelayMs * 2 ** (i - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Lists all audio object keys under the configured prefix, handling pagination.
 * Returns an array of { key, title } sorted alphabetically (or shuffled per config).
 */
async function listPlaylist() {
  const items = [];
  let continuationToken;
  let pages = 0;
  const MAX_PAGES = 1000; // safety cap so a misbehaving/huge bucket can't loop forever

  do {
    const command = new ListObjectsV2Command({
      Bucket: config.b2.bucket,
      Prefix: config.b2.prefix || undefined,
      ContinuationToken: continuationToken,
    });
    const response = await withRetry(() => s3.send(command), { label: 'listPlaylist page' });
    for (const obj of response.Contents || []) {
      if (obj.Key && isSafeKey(obj.Key) && isAudioFile(obj.Key)) {
        items.push({
          key: obj.Key,
          title: prettifyTitle(obj.Key),
        });
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    pages += 1;
    if (pages >= MAX_PAGES) {
      console.warn('[b2] listPlaylist hit MAX_PAGES safety cap, stopping pagination early.');
      break;
    }
  } while (continuationToken);

  items.sort((a, b) => a.title.localeCompare(b.title));

  return config.shufflePlaylist ? shuffle(items) : items;
}

function prettifyTitle(key) {
  const fileName = key.split('/').pop() || key;
  const raw = fileName.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim();
  return sanitizeForDiscord(raw);
}

/**
 * Returns a readable stream for the given B2 object key, ready to be piped into ffmpeg.
 * Retries transient failures (e.g. a dropped connection while opening the
 * request) before giving up — this does NOT retry mid-download failures,
 * that's handled by the caller re-invoking playIndex, since a fresh
 * GetObject call is needed to restart the byte stream from 0.
 */
async function getObjectStream(key) {
  if (!isSafeKey(key)) {
    throw new Error(`Refusing to fetch unsafe/invalid B2 key: ${key}`);
  }
  const command = new GetObjectCommand({
    Bucket: config.b2.bucket,
    Key: key,
  });
  const response = await withRetry(() => s3.send(command), { label: `getObjectStream(${key})` });
  return response.Body; // Node.js Readable stream
}

module.exports = {
  listPlaylist,
  getObjectStream,
  prettifyTitle,
  sanitizeForDiscord,
  isSafeKey,
};

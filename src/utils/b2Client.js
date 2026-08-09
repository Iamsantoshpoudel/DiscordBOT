const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const config = require('../config');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav', '.flac', '.ogg', '.opus', '.webm']);

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
});

function isAudioFile(key) {
  const lower = key.toLowerCase();
  for (const ext of AUDIO_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
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

  do {
    const command = new ListObjectsV2Command({
      Bucket: config.b2.bucket,
      Prefix: config.b2.prefix || undefined,
      ContinuationToken: continuationToken,
    });
    const response = await s3.send(command);
    for (const obj of response.Contents || []) {
      if (obj.Key && isAudioFile(obj.Key)) {
        items.push({
          key: obj.Key,
          title: prettifyTitle(obj.Key),
        });
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (continuationToken);

  items.sort((a, b) => a.title.localeCompare(b.title));

  return config.shufflePlaylist ? shuffle(items) : items;
}

function prettifyTitle(key) {
  const fileName = key.split('/').pop() || key;
  return fileName.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

/**
 * Returns a readable stream for the given B2 object key, ready to be piped into ffmpeg.
 */
async function getObjectStream(key) {
  const command = new GetObjectCommand({
    Bucket: config.b2.bucket,
    Key: key,
  });
  const response = await s3.send(command);
  return response.Body; // Node.js Readable stream
}

module.exports = {
  listPlaylist,
  getObjectStream,
  prettifyTitle,
};

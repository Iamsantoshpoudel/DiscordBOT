'use strict';

/**
 * Retries an async operation with exponential backoff + jitter. Used for
 * transient failures: Supabase network hiccups, Discord voice connection
 * blips, stream fetch errors, etc.
 *
 * @template T
 * @param {() => Promise<T>} fn - The operation to attempt.
 * @param {Object} [options]
 * @param {number} [options.retries=3] - Max retry attempts (not counting the first try).
 * @param {number} [options.baseDelayMs=500] - Initial backoff delay.
 * @param {number} [options.maxDelayMs=8000] - Backoff ceiling.
 * @param {(error: unknown, attempt: number) => boolean} [options.shouldRetry] - Return false to abort retrying.
 * @param {(error: unknown, attempt: number, delayMs: number) => void} [options.onRetry] - Called before each retry sleep.
 * @returns {Promise<T>}
 */
async function retry(fn, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    shouldRetry = () => true,
    onRetry = () => {},
  } = options;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !shouldRetry(err, attempt)) {
        throw err;
      }
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.random() * 0.3 * exponential;
      const delayMs = Math.round(exponential + jitter);
      onRetry(err, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { retry, sleep };

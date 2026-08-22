'use strict';

const { inc } = require('./metrics');

/**
 * Marks an error as configuration/user input so retries and the supervisor
 * do not treat it as a dying subsystem.
 */
class PermanentError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'PERMANENT') {
    super(message);
    this.name = 'PermanentError';
    this.code = code;
    this.permanent = true;
  }
}

/**
 * Errors that will not recover with another attempt (auth, missing resource,
 * bad input). Retrying these only delays a clean failure.
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientError(err) {
  if (err?.permanent === true || err instanceof PermanentError) return false;

  const status = err?.status ?? err?.statusCode ?? err?.cause?.status ?? err?.cause?.statusCode;
  if (status === 400 || status === 401 || status === 403 || status === 404 || status === 422) {
    return false;
  }

  const code = String(err?.code || err?.cause?.code || '');
  if (code === 'ENOENT' || code === 'EACCES' || code === 'PERMANENT' || code === 'MissingPermissions') {
    return false;
  }

  const httpStatus = Number(err?.httpStatus || err?.status);
  if (httpStatus === 429) return false; // discord.js already backs off; don't stack more retries

  const message = String(err?.message || '').toLowerCase();
  if (
    message.includes('invalid api key') ||
    message.includes('jwt expired') ||
    message.includes('row-level security') ||
    message.includes('missing access') ||
    message.includes('missing permissions')
  ) {
    return false;
  }

  return true;
}

/** Failures the supervisor should count toward a controlled restart. */
function isSupervisorFailure(err) {
  return isTransientError(err);
}

/**
 * Retries an async operation with exponential backoff + jitter.
 * Default is 3 total attempts (initial + 2 retries). After the last failure
 * the error is rethrown — callers (or the supervisor) decide whether to
 * restart the process. This helper never loops forever.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {Object} [options]
 * @param {number} [options.retries=2] - Additional attempts after the first try (3 attempts total).
 * @param {number} [options.baseDelayMs=500]
 * @param {number} [options.maxDelayMs=8000]
 * @param {(error: unknown, attempt: number) => boolean} [options.shouldRetry]
 * @param {(error: unknown, attempt: number, delayMs: number) => void} [options.onRetry]
 * @returns {Promise<T>}
 */
async function retry(fn, options = {}) {
  const {
    retries = 2,
    baseDelayMs = 500,
    maxDelayMs = 8000,
    shouldRetry = isTransientError,
    onRetry = () => {},
  } = options;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      const canRetry = attempt <= retries && shouldRetry(err, attempt);
      if (!canRetry) {
        throw err;
      }
      inc('retries');
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

module.exports = { retry, sleep, isTransientError, isSupervisorFailure, PermanentError };

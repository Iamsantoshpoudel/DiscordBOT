'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pino = require('pino');
const pretty = require('pino-pretty');
const config = require('../config/config');
const { redactSecrets } = require('./sanitize');

const useFriendlyFormat = config.ops.logFormat !== 'json';

fs.mkdirSync(config.ops.logDir, { recursive: true });

const fileDest = pino.destination({
  dest: path.join(config.ops.logDir, 'bot.log'),
  mkdir: true,
  sync: false,
});

const streams = [
  {
    level: config.ops.logLevel,
    stream: useFriendlyFormat
      ? pretty({
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname,event,module',
          singleLine: true,
        })
      : process.stdout,
  },
  {
    level: config.ops.logLevel,
    stream: fileDest,
  },
];

/**
 * Root logger. Console uses a short friendly format by default; `logs/bot.log`
 * always receives structured JSON (timestamp, event, guild/user context, stack).
 */
const baseLogger = pino(
  {
    level: config.ops.logLevel,
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['token', 'access_token', 'signedUrl', 'authorization', '*.token', '*.serviceRoleKey'],
      censor: '[redacted]',
    },
  },
  pino.multistream(streams),
);

/**
 * Turns a snake_case event code into a plain-English sentence fragment,
 * e.g. "track_started" -> "Track started". Used as a sensible default
 * message when a call site doesn't provide one of its own.
 * @param {string} event
 */
function humanize(event) {
  const spaced = event.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Thin wrapper around pino that always keeps a machine-readable `event`
 * code in the log record (useful for filtering/searching) while printing
 * a short, human-readable message by default.
 */
class Logger {
  /** @param {import('pino').Logger} instance */
  constructor(instance) {
    this.pino = instance;
  }

  /**
   * @param {string} event - snake_case event code, e.g. "track_started"
   * @param {object} [meta] - extra structured fields
   * @param {string} [message] - optional friendly override; auto-generated from `event` if omitted
   */
  info(event, meta = {}, message) {
    this.pino.info({ event, ...meta }, message || humanize(event));
  }

  /** @param {string} event @param {object} [meta] @param {string} [message] */
  warn(event, meta = {}, message) {
    this.pino.warn({ event, ...meta }, message || humanize(event));
  }

  /**
   * @param {string} event
   * @param {Error|unknown} err
   * @param {object} [meta]
   * @param {string} [message]
   */
  error(event, err, meta = {}, message) {
    const errPayload = this._errPayload(err);
    this.pino.error({ event, err: errPayload, ...meta }, message || `${humanize(event)}: ${errPayload.message}`);
  }

  _errPayload(err) {
    if (err instanceof Error) {
      return {
        message: redactSecrets(err.message),
        stack: redactSecrets(err.stack || ''),
        name: err.name,
        code: err.code,
      };
    }
    return { message: redactSecrets(String(err)) };
  }

  /**
   * Highest severity — restart loops, exhausted retries, uncaught exceptions.
   * @param {string} event
   * @param {Error|unknown} err
   * @param {object} [meta]
   * @param {string} [message]
   */
  critical(event, err, meta = {}, message) {
    const errPayload = this._errPayload(err);
    this.pino.fatal(
      { event, levelName: 'critical', err: errPayload, ...meta },
      message || `${humanize(event)}: ${errPayload.message}`,
    );
  }

  /** @param {string} event @param {object} [meta] @param {string} [message] */
  debug(event, meta = {}, message) {
    this.pino.debug({ event, ...meta }, message || humanize(event));
  }

  flush() {
    return new Promise((resolve) => {
      try {
        this.pino.flush();
        if (typeof fileDest.flushSync === 'function') fileDest.flushSync();
      } catch {
        /* ignore */
      }
      setTimeout(resolve, 50);
    });
  }

  /**
   * Creates a namespaced child logger, e.g. logger.child('voiceManager').
   * @param {string} module
   * @returns {Logger}
   */
  child(module) {
    return new Logger(this.pino.child({ module }));
  }
}

module.exports = new Logger(baseLogger);

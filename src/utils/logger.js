'use strict';

const pino = require('pino');
const config = require('../config/config');

const useFriendlyFormat = config.ops.logFormat !== 'json';

/**
 * Root logger. By default this prints short, plain-English lines to the
 * console (e.g. "Now playing: Song Title — Artist"), which is what you see
 * when running the bot locally or watching Render's log tab. Set
 * LOG_FORMAT=json in your .env if you want raw structured JSON logs
 * instead (useful for feeding into a log aggregator/dashboard).
 */
const baseLogger = pino({
  level: config.ops.logLevel,
  base: undefined, // no pid/hostname clutter in the friendly format
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: useFriendlyFormat
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname,event,module',
          singleLine: true,
        },
      }
    : undefined,
});

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
    const errPayload =
      err instanceof Error
        ? { message: err.message, stack: err.stack, name: err.name }
        : { message: String(err) };
    this.pino.error({ event, err: errPayload, ...meta }, message || `${humanize(event)}: ${errPayload.message}`);
  }

  /** @param {string} event @param {object} [meta] @param {string} [message] */
  debug(event, meta = {}, message) {
    this.pino.debug({ event, ...meta }, message || humanize(event));
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

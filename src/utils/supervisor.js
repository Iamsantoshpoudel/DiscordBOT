'use strict';

const fs = require('node:fs');
const path = require('node:path');
const config = require('../config/config');
const logger = require('./logger').child('supervisor');
const { inc } = require('./metrics');
const { isAcceptingCommands } = require('./health');
const { isSupervisorFailure } = require('./retry');

/** Distinct exit code so a process manager can tell "we chose to restart" from a crash. */
const SUPERVISOR_EXIT_CODE = 2;

const FAILURE_THRESHOLD = 3;

/**
 * Tracks consecutive failures per subsystem. Transient blips are expected;
 * three in a row of the *same* subsystem means we are no longer recovering
 * and should flush + exit so PM2 / Render / systemd can start a clean process.
 *
 * Subsystems: 'voice' | 'queue' | 'supabase' | 'command_dispatch' | 'unhandled'
 */
class Supervisor {
  constructor() {
    /** @type {Map<string, number>} */
    this.consecutiveFailures = new Map();
    this.restarting = false;
    this._flushFn = async () => {};
  }

  /**
   * @param {(reason: string) => Promise<void>} fn
   */
  setFlushHandler(fn) {
    this._flushFn = fn;
  }

  reportSuccess(subsystem) {
    this.consecutiveFailures.set(subsystem, 0);
  }

  /**
   * @param {string} subsystem
   * @param {unknown} err
   * @param {object} [context]
   * @returns {boolean} true if a restart was triggered
   */
  reportFailure(subsystem, err, context = {}) {
    if (this.restarting || !isAcceptingCommands()) return false;
    const { force, ...rest } = context;
    if (!isSupervisorFailure(err) && force !== true) {
      logger.warn(
        'subsystem_permanent_failure',
        { subsystem, error: err instanceof Error ? err.message : String(err), ...rest },
        `Subsystem "${subsystem}" hit a non-retryable error; not counting toward restart`,
      );
      return false;
    }
    const next = (this.consecutiveFailures.get(subsystem) || 0) + 1;
    this.consecutiveFailures.set(subsystem, next);

    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      'subsystem_failure',
      err instanceof Error ? err : new Error(message),
      { subsystem, consecutive: next, threshold: FAILURE_THRESHOLD, ...rest },
      `Subsystem "${subsystem}" failed (${next}/${FAILURE_THRESHOLD}): ${message}`,
    );

    if (next >= FAILURE_THRESHOLD) {
      this.triggerRestart(`${subsystem}:${message}`, { subsystem, consecutive: next, ...rest });
      return true;
    }
    return false;
  }

  /**
   * @param {string} reason
   * @param {object} [context]
   */
  triggerRestart(reason, context = {}) {
    if (this.restarting) return;
    this.restarting = true;
    inc('supervisorRestarts');

    logger.error(
      'controlled_restart',
      new Error(reason),
      { reason, exitCode: SUPERVISOR_EXIT_CODE, ...context },
      `Controlled restart: ${reason}`,
    );
    this._appendRestartLog(reason, context);

    Promise.resolve()
      .then(() => this._flushFn(reason))
      .catch((err) => {
        logger.error('supervisor_flush_failed', err, { reason });
      })
      .finally(() => {
        process.exit(SUPERVISOR_EXIT_CODE);
      });
  }

  _appendRestartLog(reason, context) {
    try {
      const file = path.join(config.ops.logDir, 'restarts.log');
      fs.mkdirSync(config.ops.logDir, { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        reason,
        pid: process.pid,
        ...context,
      });
      fs.appendFileSync(file, `${line}\n`);
    } catch (err) {
      logger.error('restart_log_write_failed', err);
    }
  }
}

module.exports = new Supervisor();
module.exports.SUPERVISOR_EXIT_CODE = SUPERVISOR_EXIT_CODE;
module.exports.FAILURE_THRESHOLD = FAILURE_THRESHOLD;

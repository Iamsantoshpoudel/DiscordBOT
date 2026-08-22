'use strict';

/**
 * Process-local counters for the health/metrics endpoint and periodic logs.
 * Not a substitute for a metrics backend — just enough to spot a restart loop
 * or a command-error spike without attaching a debugger.
 */
const metrics = {
  startedAt: Date.now(),
  commands: 0,
  commandErrors: 0,
  retries: 0,
  unhandledRejections: 0,
  uncaughtExceptions: 0,
  supervisorRestarts: 0,
  supabaseErrors: 0,
  voiceErrors: 0,
};

function inc(key, by = 1) {
  if (typeof metrics[key] === 'number') metrics[key] += by;
}

function snapshot(extra = {}) {
  return {
    uptimeSeconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
    startedAt: new Date(metrics.startedAt).toISOString(),
    commands: metrics.commands,
    commandErrors: metrics.commandErrors,
    retries: metrics.retries,
    unhandledRejections: metrics.unhandledRejections,
    uncaughtExceptions: metrics.uncaughtExceptions,
    supervisorRestarts: metrics.supervisorRestarts,
    supabaseErrors: metrics.supabaseErrors,
    voiceErrors: metrics.voiceErrors,
    commandsPerMinute:
      metrics.commands / Math.max(1, (Date.now() - metrics.startedAt) / 60_000),
    errorRate:
      metrics.commandErrors / Math.max(1, metrics.commands),
    ...extra,
  };
}

module.exports = { metrics, inc, snapshot };

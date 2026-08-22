'use strict';

const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger').child('eventLoader');

const EXCLUDED_FILES = new Set(['index.js', 'clientErrors.js']);

/**
 * Loads every standard event module (name, once, execute) and binds it to
 * the client, injecting the shared command context as the final argument.
 * @param {import('discord.js').Client} client
 * @param {import('../types').CommandContext} ctx
 */
function registerEvents(client, ctx) {
  const eventsDir = __dirname;
  const files = fs.readdirSync(eventsDir).filter((f) => f.endsWith('.js') && !EXCLUDED_FILES.has(f));

  for (const file of files) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const event = require(path.join(eventsDir, file));
      if (!event?.name || typeof event.execute !== 'function') {
        logger.warn('invalid_event_module', { file });
        continue;
      }

      const handler = (...args) => event.execute(...args, ctx);
      if (event.once) {
        client.once(event.name, handler);
      } else {
        client.on(event.name, handler);
      }
    } catch (err) {
      logger.error('event_load_failed', err, { file });
    }
  }

  logger.info('events_registered', { count: files.length });
}

module.exports = { registerEvents };

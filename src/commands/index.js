'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { Collection } = require('discord.js');
const logger = require('../utils/logger').child('commandLoader');

/**
 * Loads every command module in this directory (excluding this loader
 * itself) into a Collection keyed by command name.
 * @returns {Collection<string, import('../types').SlashCommandModule>}
 */
function loadCommands() {
  const commands = new Collection();
  const commandsDir = __dirname;
  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js') && f !== 'index.js');

  for (const file of files) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const command = require(path.join(commandsDir, file));
      if (!command?.data?.name || typeof command.execute !== 'function') {
        logger.warn('invalid_command_module', { file });
        continue;
      }
      commands.set(command.data.name, command);
    } catch (err) {
      logger.error('command_load_failed', err, { file });
    }
  }

  logger.info('commands_loaded', { count: commands.size, names: [...commands.keys()] });
  return commands;
}

module.exports = { loadCommands };

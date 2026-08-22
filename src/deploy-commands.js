'use strict';

const { REST, Routes } = require('discord.js');
const config = require('./config/config');
const { loadCommands } = require('./commands');
const logger = require('./utils/logger').child('deployCommands');
const { retry } = require('./utils/retry');

async function main() {
  const commands = loadCommands();
  const body = [...commands.values()].map((c) => c.data.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  try {
    const route = config.discord.devGuildId
      ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.devGuildId)
      : Routes.applicationCommands(config.discord.clientId);

    const result = await retry(() => rest.put(route, { body }), {
      retries: 2,
      baseDelayMs: 1000,
      onRetry: (err, attempt, delayMs) => {
        logger.warn('command_registration_retry', { attempt, delayMs, error: err.message });
      },
    });

    logger.info('commands_registered', {
      count: result.length,
      scope: config.discord.devGuildId ? `guild:${config.discord.devGuildId}` : 'global',
    });
  } catch (err) {
    logger.error('command_registration_failed', err);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  logger.error('command_registration_failed', err);
  process.exitCode = 1;
});

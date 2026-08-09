const { REST, Routes } = require('discord.js');
const config = require('../config');
const { loadCommands } = require('./loadCommands');

async function deployGuildCommands(log = console.log) {
  const commands = loadCommands();
  const body = [...commands.values()].map((c) => c.data.toJSON());

  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  log(`Registering ${body.length} slash command(s) for guild ${config.guildId}...`);

  await rest.put(
    Routes.applicationGuildCommands(config.clientId, config.guildId),
    { body }
  );

  log(`✅ Slash commands registered (${body.length} commands).`);
  return body.length;
}

module.exports = { deployGuildCommands };

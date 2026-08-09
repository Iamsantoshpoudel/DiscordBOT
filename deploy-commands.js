const { REST, Routes } = require('discord.js');
const { deployGuildCommands } = require('./src/utils/deployCommands');

deployGuildCommands().catch((err) => {
  console.error('Failed to register commands:', err);
  process.exit(1);
});

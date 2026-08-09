const fs = require('fs');
const path = require('path');

function loadCommands() {
  const commands = new Map();
  const commandsPath = path.join(__dirname, '..', 'commands');
  const files = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

  for (const file of files) {
    const command = require(path.join(commandsPath, file));
    if (command?.data?.name && typeof command.execute === 'function') {
      commands.set(command.data.name, command);
    } else {
      console.warn(`[commands] Skipping ${file}: missing "data" or "execute".`);
    }
  }
  return commands;
}

module.exports = { loadCommands };

const config = require('../config');
const { isAllowedTextChannel } = require('../utils/voiceWatcher');
const { TextContext } = require('../utils/textContext');
const { buildHelpEmbed } = require('../utils/helpContent');

module.exports = (client, commands, manager) => {
  client.on('messageCreate', async (message) => {
    if (!message.guild || message.author.bot) return;
    if (!isAllowedTextChannel(message.channel.id)) return;

    const prefix = config.commandPrefix;
    const content = message.content.trim();
    if (!content.startsWith(prefix)) return;

    const withoutPrefix = content.slice(prefix.length).trim();
    if (!withoutPrefix) return;

    const [commandName, ...args] = withoutPrefix.split(/\s+/);
    const normalized = commandName.toLowerCase();

    if (normalized === 'help' || normalized === 'commands') {
      return message.reply({ embeds: [buildHelpEmbed()] });
    }

    const command = commands.get(normalized);
    if (!command) return;

    const ctx = new TextContext(message, args);

    try {
      await command.execute(ctx, manager);
    } catch (err) {
      console.error(`[text:${normalized}]`, err);
      await message.reply('❌ Something went wrong running that command.').catch(() => {});
    }
  });
};

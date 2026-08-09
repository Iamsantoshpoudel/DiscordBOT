const { EmbedBuilder } = require('discord.js');
const config = require('../config');

function buildHelpEmbed() {
  const prefix = config.commandPrefix;

  return new EmbedBuilder()
    .setTitle('🎵 Dex Music Bot — Help')
    .setDescription(
      'Streams music from Backblaze B2. Join the configured voice channel and the bot auto-joins after **30 seconds**, then plays the playlist on loop.'
    )
    .addFields(
      {
        name: '🎮 Playback',
        value: [
          '`/play` — Join voice & start/resume playlist',
          '`/pause` / `/resume` — Pause or resume',
          '`/skip` — Next track',
          '`/previous` — Go back to the last track',
          '`/stop` — Stop and leave voice channel',
          '`/nowplaying` — Current track info',
        ].join('\n'),
      },
      {
        name: '📋 Playlist',
        value: [
          '`/queue` — Show upcoming tracks',
          '`/loop <off|track|queue>` — Repeat mode (default: queue)',
          '`/shuffle <on|off>` — Randomize playlist order',
          '`/reload` — Refresh tracks from B2 storage',
          '`/volume <0-200>` — Set volume (100 = normal)',
        ].join('\n'),
      },
      {
        name: 'ℹ️ Info & Setup',
        value: [
          '`/status` — Bot connection & playback state',
          '`/help` — Show this guide',
          '`/invite` — Invite link with required permissions',
        ].join('\n'),
      },
      {
        name: '💬 Text commands',
        value: `You can also use \`${prefix}play\`, \`${prefix}skip\`, \`${prefix}help\`, etc. in chat (requires **Message Content Intent**).`,
      },
      {
        name: '⚡ Auto-join / Auto-leave',
        value: [
          `• Join the music voice channel → bot waits **${config.autoJoinDelayMs / 1000}s** then joins & plays`,
          '• Leave when the channel is empty → bot disconnects automatically',
          '• Multiple users joining/leaving is handled automatically',
        ].join('\n'),
      }
    )
    .setColor(0x5865f2)
    .setFooter({ text: 'Tip: Type / in chat to see all slash commands' });
}

module.exports = { buildHelpEmbed };

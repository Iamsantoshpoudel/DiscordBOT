/**
 * Minimal adapter so slash command handlers can also run from plain chat messages.
 */
class TextContext {
  constructor(message, args = []) {
    this.guild = message.guild;
    this.channel = message.channel;
    this.member = message.member;
    this.user = message.author;
    this._message = message;
    this._args = args;
    this._replyMsg = null;
    this.deferred = false;
    this.replied = false;
  }

  get options() {
    const args = this._args;
    return {
      getInteger: () => {
        const n = parseInt(args[0], 10);
        return Number.isFinite(n) ? n : null;
      },
      getString: () => args[0] || null,
    };
  }

  isChatInputCommand() {
    return true;
  }

  async reply(payload) {
    if (typeof payload === 'string') payload = { content: payload };
    if (payload.ephemeral) {
      payload = { content: payload.content, embeds: payload.embeds };
    }
    this.replied = true;
    return this._message.reply(payload);
  }

  async deferReply() {
    this.deferred = true;
    this.replied = true;
    this._replyMsg = await this._message.reply('⏳ Working...');
  }

  async editReply(payload) {
    if (typeof payload === 'string') payload = { content: payload };
    if (this._replyMsg) return this._replyMsg.edit(payload);
    this.replied = true;
    return this._message.reply(payload);
  }

  async followUp(payload) {
    if (typeof payload === 'string') payload = { content: payload };
    return this._message.channel.send(payload);
  }
}

module.exports = { TextContext };

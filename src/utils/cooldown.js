'use strict';

const config = require('../config/config');

/**
 * In-memory cooldown tracker: Map<"guildId:userId:commandName", expiryTimestampMs>.
 * A single-process bot doesn't need a distributed store for this; if the bot
 * ever scales horizontally, swap this for a Redis-backed implementation
 * behind the same interface.
 */
class CooldownManager {
  constructor(defaultCooldownMs = config.playback.commandCooldownMs) {
    /** @type {Map<string, number>} */
    this.timestamps = new Map();
    this.defaultCooldownMs = defaultCooldownMs;

    // Periodic sweep so the map doesn't grow unbounded over a long-running process.
    this._sweepInterval = setInterval(() => this._sweep(), 10 * 60 * 1000).unref();
  }

  _key(guildId, userId, commandName) {
    return `${guildId}:${userId}:${commandName}`;
  }

  _sweep() {
    const now = Date.now();
    for (const [key, expiry] of this.timestamps) {
      if (expiry <= now) this.timestamps.delete(key);
    }
  }

  /**
   * Checks whether the user may run the command right now. If allowed, this
   * also starts the cooldown window.
   * @param {string} guildId
   * @param {string} userId
   * @param {string} commandName
   * @param {number} [cooldownMs]
   * @returns {{ allowed: true } | { allowed: false, retryAfterMs: number }}
   */
  consume(guildId, userId, commandName, cooldownMs = this.defaultCooldownMs) {
    const key = this._key(guildId, userId, commandName);
    const now = Date.now();
    const expiry = this.timestamps.get(key);

    if (expiry && expiry > now) {
      return { allowed: false, retryAfterMs: expiry - now };
    }

    this.timestamps.set(key, now + cooldownMs);
    return { allowed: true };
  }
}

module.exports = new CooldownManager();

# Discord B2 Music Bot

A Discord bot that watches one voice channel (e.g. `music-bot`), auto-joins and
starts playing 30 seconds after the first person enters, streams music
straight from a Backblaze B2 bucket, loops the playlist, and leaves
automatically when the channel empties.

## What it does

- Monitors **one specific voice channel** (set via `MUSIC_VOICE_CHANNEL_ID`).
- When someone joins that channel, waits **30 seconds** (configurable), then
  auto-joins and starts playing.
- Streams audio files directly from your **Backblaze B2** bucket (no local
  storage, no re-uploading to Discord).
- Loops the playlist (`queue` mode by default) — or loop a single track, or
  no loop.
- Disconnects automatically when the channel is empty; re-joins on the next
  person + 30s delay.
- Slash commands: `/play`, `/stop`, `/pause`, `/resume`, `/skip`, `/queue`,
  `/volume`, `/loop`, `/status`.

## Project structure

```
discord-music-bot/
├── index.js                 # entry point
├── deploy-commands.js        # registers slash commands with Discord
├── src/
│   ├── config.js              # env var loading + validation
│   ├── commands/               # one file per slash command
│   ├── events/
│   │   ├── interactionCreate.js  # routes slash commands
│   │   └── voiceStateUpdate.js   # the 30s auto-join / auto-leave logic
│   └── utils/
│       ├── b2Client.js          # Backblaze B2 (S3-compatible) list + stream
│       ├── musicPlayer.js       # per-guild queue/player/loop/volume state
│       └── loadCommands.js
├── package.json
├── render.yaml               # Render deployment blueprint
└── .env.example
```

## 1. Set up Backblaze B2

1. In the B2 console, create a bucket (private is fine — the bot authenticates
   with credentials, it doesn't need public URLs).
2. Upload your audio files (`.mp3`, `.m4a`, `.wav`, `.flac`, `.ogg`, `.opus`,
   `.webm` are recognized). You can put them in a "folder" like `music/` if
   you want to keep the bucket organized — set `B2_PREFIX=music/` to match.
3. Go to **App Keys** → **Add a New Application Key**. Scope it to just this
   bucket (read-only is enough). Note the **keyID** and **applicationKey** —
   the applicationKey is only shown once.
4. Find your **S3-compatible endpoint** on the bucket's details page. It
   looks like `https://s3.us-west-004.backblazeb2.com`. The region is the
   part after `s3.` (e.g. `us-west-004`).

## 2. Set up the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) →
   **New Application**.
2. Under **Bot**, click **Add Bot**. Copy the **token** (`DISCORD_TOKEN`).
3. Under **Bot** settings, enable these **Privileged Gateway Intents**:
   - Server Members Intent is NOT required.
   - **Voice State** is part of the default `GUILD_VOICE_STATES` intent — no
     privileged toggle needed for it, but double check nothing is disabled.
4. Under **OAuth2 → URL Generator**, select scopes `bot` and
   `applications.commands`, and bot permissions: `View Channel`,
   `Send Messages`, `Connect`, `Speak`, `Use Voice Activity`. Use the
   generated URL to invite the bot to your server.
5. Grab your **Application (Client) ID** (`CLIENT_ID`) from the General
   Information tab.
6. Get your **Server (Guild) ID** and the **Voice Channel ID** for your
   `music-bot` channel: enable Developer Mode in Discord (User Settings →
   Advanced), then right-click the server/channel → **Copy ID**.

## 3. Configure environment variables

Copy `.env.example` to `.env` and fill in every value:

```bash
cp .env.example .env
```

Never commit `.env` — it's already in `.gitignore`.

## 4. Install and run locally

```bash
npm install
npm run deploy-commands   # registers /play /stop /skip etc. with your server
npm start
```

Slash commands are registered **per-guild** (`GUILD_ID`) so they show up
instantly, instead of the ~1hr propagation delay for global commands.
Re-run `npm run deploy-commands` any time you add/change a command.

## 5. Deploy to Render

### Important: pick the right service type

A Discord bot needs a persistent, always-on connection. Render's **free tier
spins the service down after 15 minutes of inactivity**, which will silently
drop your bot's Discord connection — it is not suitable for "always running."
For an always-on bot, use a paid **Starter** instance (~$7/month) as a
**Background Worker**. `render.yaml` in this repo is already set up that way.

If you want to test on the free tier first, deploy as a **Web Service**
instead (the built-in `index.js` already starts a tiny Express server on
`PORT` for this) and understand the bot will go offline after ~15 min without
inbound HTTP traffic — an external uptime pinger (e.g. UptimeRobot) hitting
`/health` can somewhat mitigate this but is not fully reliable.

### Steps

1. Push this project to a GitHub repo.
2. In Render: **New → Blueprint**, point it at your repo. Render will read
   `render.yaml` and provision the worker.
3. Fill in the environment variables Render prompts for (all the `sync: false`
   ones in `render.yaml` — your Discord token, B2 credentials, channel IDs,
   etc.) in the Render dashboard.
4. Deploy. Check the logs for `✅ Logged in as <YourBot>#0000`.
5. From your local machine (or a Render shell), run
   `npm run deploy-commands` once against the same `CLIENT_ID`/`GUILD_ID` to
   register the slash commands (you only need to do this again when you add
   or change commands).

## How the auto-join logic works

`src/events/voiceStateUpdate.js` is the core of the auto-join/leave behavior:

- Someone joins the watched channel → if the bot isn't already connected and
  no countdown is already running, start a `setTimeout` for
  `AUTO_JOIN_DELAY_SECONDS` (default 30).
- When the timer fires, it re-checks the channel actually still has a
  non-bot member (in case everyone left again during the wait) before
  joining and starting playback from the top of the playlist.
- Someone leaves the watched channel → if the channel now has zero non-bot
  members, any pending countdown is cancelled and, if the bot is connected,
  it disconnects immediately.

This is all per-guild, so the bot can run in multiple servers independently
if you ever expand it (each guild gets its own `GuildMusicSession`).

## Notes & things you may want to tweak

- **Loop modes**: `off`, `track` (repeat current song), `queue` (repeat whole
  playlist — default). Set with `/loop`.
- **Volume**: `/volume 0-200` (100 = original level), applied live via
  `@discordjs/voice`'s inline volume, no re-streaming needed.
- **Playlist refresh**: the playlist is loaded from B2 once per session and
  cached; it's rebuilt the next time the bot fully disconnects and
  reconnects (e.g., channel goes empty then someone rejoins). Add/remove
  files in B2 any time — they'll show up on the next auto-join or `/stop`
  + `/play`.
- **Shuffle**: set `SHUFFLE_PLAYLIST=true` to randomize playback order per
  session load instead of alphabetical.
- **Audio format**: files are transcoded on the fly via `ffmpeg-static` +
  `prism-media`, so B2 storage format doesn't need to match Discord's Opus
  requirements — mp3/flac/wav/etc. all work.
- **CPU**: audio transcoding is real CPU work. Render's Starter plan
  (0.5 CPU) handles one guild's continuous playback fine; if you scale to
  many simultaneous servers you'll want a bigger instance.

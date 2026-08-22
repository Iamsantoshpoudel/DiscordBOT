# Discord Supabase Music Bot

A production-ready Discord music bot that streams audio **directly from Supabase Storage** (no full file downloads), backed by a Supabase Postgres table for song metadata. Built with Node.js and Discord.js v14, deployable on Render.

## Features

- **Slash commands:** `/play [song]`, `/pause`, `/resume`, `/skip`, `/shuffle`, `/volume`, `/status`
- **Per-guild queue manager** — isolated playback state per server
- **Streaming playback** — ffmpeg reads the Supabase signed URL over HTTP and transcodes on the fly into Opus; the audio file is never written to disk
- **Shuffle without immediate repeats** — every reshuffle is checked against the last-played track
- **Auto-join** — 30s (configurable) after the *first* human joins the configured voice channel; a second joiner does **not** start a second timer
- **Auto-leave** — 30s (configurable) after the *last* human leaves
- **Voice connection recovery** — distinguishes recoverable network blips from real disconnects and cleans up zombie connections
- **Retry logic** — exponential backoff for Supabase calls, signed URL generation, and ffmpeg reconnect flags for the stream itself
- **Security** — permission checks on every command, role or voice-channel-membership gating, input sanitization, cooldowns, snowflake validation
- **Structured JSON logging** — every join/leave, command invocation, bot action, and error is logged with consistent fields
- **Global error handling** — per-command try/catch, per-event try/catch, and a top-level process safety net so one failure can't crash the bot

## Project structure

```
src/
  config/        env loading + validation (fails fast if secrets are missing)
  types/         JSDoc typedefs shared across modules
  utils/         logger, retry, sanitize, cooldown, permissions, embeds
  services/
    supabaseService.js       DB queries + signed URL generation
    musicQueue.js             per-guild queue + shuffle-no-repeat logic
    voiceManager.js           connection lifecycle + recovery
    playbackService.js        ffmpeg -> Opus streaming, track retry/skip
    autoJoinLeaveManager.js   30s join/leave timers
  commands/      one file per slash command
  events/        ready, interactionCreate, voiceStateUpdate, client errors
  index.js       bootstrap, global error handlers, graceful shutdown
supabase/schema.sql   DB schema + storage bucket setup
render.yaml           one-click Render Blueprint
```

## 1. Discord setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot**, create a bot user, enable it, and copy the token → `DISCORD_TOKEN`.
3. Copy the **Application ID** → `DISCORD_CLIENT_ID`.
4. Invite the bot with the `bot` and `applications.commands` scopes, and at least these permissions: `View Channel`, `Connect`, `Speak`.
5. In Discord, right-click your target voice channel → Copy Channel ID → `VOICE_CHANNEL_ID`. Right-click its category → Copy Category ID → `CATEGORY_ID`. (Enable Developer Mode in Discord settings if you don't see this option.)

## 2. Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL editor, run `supabase/schema.sql`. This creates the `songs` and `play_history` tables, enables RLS, and creates a **private** storage bucket named `discord`.
3. Upload your audio files into that bucket — that's it, no SQL required. Supported formats: `.mp3`, `.wav`, `.ogg`, `.m4a`, `.flac`, `.aac`, `.opus`, `.webm`.
4. Copy your project URL → `SUPABASE_URL` and the **service role key** (Settings → API) → `SUPABASE_SERVICE_ROLE_KEY`. The service role key is required because it's used server-side to generate signed URLs and bypass RLS — never expose it client-side.

> The bucket is kept **private**. The bot generates short-lived signed URLs (default 1 hour) to stream each track, so the audio is never publicly accessible.

### Music is detected automatically

The bot scans the bucket on startup, every `LIBRARY_SYNC_INTERVAL_MS` (default 2 minutes), and any time it needs to refill the playback queue. Any audio file it finds that isn't already in the `songs` table gets added automatically:

- Name your file **`Artist - Title.mp3`** and the bot splits that into artist/title for you.
- Any other filename becomes the title as-is, with the artist set to "Unknown Artist".
- If you delete a file from the bucket, the bot automatically marks the matching song inactive so it stops showing up in rotation — no manual cleanup needed.
- Already-known songs are never overwritten, so if you edit a title/artist by hand in Supabase Studio later, auto-detection won't undo it.

You only need to write SQL yourself if you want to set a specific title/artist *before* the bot auto-detects the file, or you're seeding the library in bulk:

```sql
insert into public.songs (title, artist, duration_seconds, file_path, bucket_name, added_by)
values ('Song Title', 'Artist Name', 214, 'tracks/song.mp3', 'discord', '<your-discord-user-id>');
```

## 3. Local setup

```bash
cp .env.example .env
# fill in .env with your values from steps 1-2
npm install
npm run deploy-commands   # registers slash commands with Discord
npm start
```

Set `DISCORD_DEV_GUILD_ID` in `.env` during development — guild-scoped commands register instantly, whereas global commands can take up to an hour to propagate. Remove it (or leave blank) for production.

## 4. Deploy to Render

**Option A — Blueprint (recommended):**

1. Push this repo to GitHub.
2. In Render, choose **New → Blueprint** and point it at the repo. `render.yaml` provisions a Background Worker.
3. Fill in the secret env vars flagged `sync: false` in the Render dashboard (`DISCORD_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`, etc.).
4. Deploy. After the first deploy, run `npm run deploy-commands` once (locally, or via Render's shell) to register slash commands globally.

**Option B — Manual:**

1. New → Background Worker → connect your repo.
2. Build command: `npm ci`. Start command: `npm start`.
3. Add all env vars from `.env.example` in the Render dashboard.
4. Deploy.

Background Workers don't need a public port. If you instead deploy as a **Web Service**, Render will inject `PORT` automatically and the bot starts a minimal `/` health-check endpoint to satisfy Render's port-binding requirement — no extra config needed.

## Configuration reference

All configuration lives in `.env` — see `.env.example` for the full list with inline documentation. Key behavioral knobs:

| Variable | Default | Purpose |
|---|---|---|
| `AUTO_JOIN_DELAY_MS` | `30000` | Delay after first human joins before the bot connects |
| `AUTO_LEAVE_DELAY_MS` | `30000` | Delay after the last human leaves before the bot disconnects |
| `ALLOWED_ROLE_IDS` | *(empty)* | If set, only these roles may control the bot; otherwise, anyone in the voice channel can |
| `SIGNED_URL_EXPIRY_SECONDS` | `3600` | How long each streaming URL stays valid |
| `COMMAND_COOLDOWN_MS` | `3000` | Per-user, per-command cooldown |
| `LIBRARY_SYNC_INTERVAL_MS` | `120000` | How often the bot rescans the Storage bucket for new/deleted files |
| `LOG_FORMAT` | `friendly` | `friendly` prints plain-English log lines; `json` prints raw structured logs |

## How streaming works (no full downloads)

`/play` resolves a track's storage path to a **signed URL** via `supabaseService.getSignedStreamUrl()`. `playbackService` hands that URL directly to `ffmpeg -i <url>` (with `-reconnect` flags for transient network resilience), which transcodes to raw PCM on the fly. That PCM is piped into an Opus encoder and streamed straight into the Discord voice connection. At no point is the audio file written to disk — the only things ever in memory are small, transient buffered chunks of the stream.

## Extending

- **Multi-guild, per-guild channel config:** currently the voice channel is a single global env var by design (per the spec this bot was built for). To support different channels per guild, add a `guild_settings` table and look up `voiceChannelId` per `guild.id` instead of from `config.discord`.
- **Adding songs via command:** not included by default (metadata is expected to be seeded via SQL/Supabase Studio), but you could add an admin-only `/addsong` command that inserts into `songs` after an upload.

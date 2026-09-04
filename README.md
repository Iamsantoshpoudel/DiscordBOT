# Discord Supabase Music Bot

A production-ready Discord music bot that streams audio **directly from Supabase Storage** (no full file downloads), backed by a Supabase Postgres table for song metadata. Built with Node.js and Discord.js v14, deployable via npm, Docker, or Render.

## Features

- **Slash commands:** `/play [song]`, `/pause`, `/resume`, `/skip`, `/shuffle`, `/volume`, `/status`
- **Per-guild queue manager** — isolated playback state per server
- **Streaming playback** — ffmpeg reads a Supabase signed URL over HTTP and transcodes on the fly into Opus; the audio file is never written to disk
- **Shuffle without immediate repeats** — every reshuffle is checked against the last-played track
- **Auto-join** — connects a set delay after the first human joins the configured voice channel; a second joiner does **not** restart the timer
- **Auto-leave** — disconnects a set delay after the last human leaves
- **Voice connection recovery** — distinguishes recoverable network blips from real disconnects and cleans up zombie connections
- **Retry logic** — exponential backoff for Supabase calls and signed URL generation, plus ffmpeg reconnect flags for the stream itself
- **Security** — permission checks on every command, role or voice-channel-membership gating, input sanitization, cooldowns, snowflake validation
- **Structured logging** — every join/leave, command invocation, bot action, and error is logged with consistent fields
- **Global error handling** — per-command try/catch, per-event try/catch, and a top-level process safety net so one failure can't crash the bot
- **Self-healing** — repeated failures of the same subsystem trigger a controlled restart instead of a silent hang or crash loop
- **Health / metrics endpoints** — heartbeat file plus optional `GET /health` and `GET /metrics`

See [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) for process-manager setup, RLS, Discord invite scopes, and restart behavior in more depth.

---

## How it works

Music lives in a **private Supabase Storage bucket**. When someone plays a track, the bot asks Supabase for a short-lived signed URL, hands that URL straight to ffmpeg, and streams the transcoded audio into the Discord voice channel — the file is never downloaded to disk, only small buffered chunks pass through memory.

```
src/
  config/        env loading + validation (fails fast if secrets are missing)
  services/
    supabaseService.js       DB queries + signed URL generation
    musicQueue.js             per-guild queue + shuffle-no-repeat logic
    voiceManager.js           connection lifecycle + recovery
    playbackService.js        ffmpeg -> Opus streaming, track retry/skip
    autoJoinLeaveManager.js   join/leave timers
  commands/      one file per slash command
  events/        ready, interactionCreate, voiceStateUpdate, client errors
  index.js       bootstrap, global error handlers, graceful shutdown
supabase/schema.sql   DB schema + storage bucket setup
Dockerfile             container build for VPS/Docker deployment
render.yaml            one-click Render Blueprint
```

---

## What you'll need before starting

1. A **Discord bot application** (Discord Developer Portal) — free.
2. A **Supabase project** (supabase.com) — free tier works fine for personal use.
3. **Node.js 20+** if running locally, or **Docker** if running in a container.

---

## 1. Discord setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Bot**, create a bot user, enable it, and copy the token. This becomes `DISCORD_TOKEN`.
3. Copy the **Application ID** from the General Information page. This becomes `DISCORD_CLIENT_ID`.
4. Invite the bot to your server with the `bot` and `applications.commands` scopes, and at minimum these permissions: `View Channel`, `Connect`, `Speak`.
5. In Discord, enable **Developer Mode** (User Settings → Advanced), then right-click your target voice channel → **Copy Channel ID** → this becomes `VOICE_CHANNEL_ID`. Right-click its category → **Copy Category ID** → this becomes `CATEGORY_ID`.

## 2. Supabase setup

1. Create a project at [supabase.com](https://supabase.com).
2. In the SQL editor, run `supabase/schema.sql`. This creates the `songs` and `play_history` tables, enables Row Level Security, and creates a **private** storage bucket named `discord`.
3. Upload your audio files into that bucket — that's it, no SQL required for basic use. Supported formats: `.mp3`, `.wav`, `.ogg`, `.m4a`, `.flac`, `.aac`, `.opus`, `.webm`.
4. Go to **Settings → API** and copy:
   - Your project URL → `SUPABASE_URL`
   - The **service role key** (not the anon/public key) → `SUPABASE_SERVICE_ROLE_KEY`

> ⚠️ The service role key bypasses Row Level Security and must only ever be used server-side (in this bot's environment variables). Never commit it to git, never expose it to a browser/client, never paste it somewhere public.

The bucket stays **private**. The bot generates short-lived signed URLs (1 hour by default) to stream each track, so your music is never publicly accessible.

### Music is detected automatically

The bot scans the bucket on startup and periodically afterward. Any audio file it finds that isn't already in the `songs` table gets added automatically:

- Name your file **`Artist - Title.mp3`** and the bot splits that into artist/title for you.
- Any other filename becomes the title as-is, with the artist set to "Unknown Artist".
- Delete a file from the bucket and the bot marks the matching song inactive automatically — no manual cleanup needed.
- Already-known songs are never overwritten, so if you hand-edit a title/artist in Supabase Studio later, auto-detection won't undo it.

You only need to write SQL if you want to set a specific title/artist *before* auto-detection runs, or you're seeding a library in bulk:

```sql
insert into public.songs (title, artist, duration_seconds, file_path, bucket_name, added_by)
values ('Song Title', 'Artist Name', 214, 'tracks/song.mp3', 'discord', '<your-discord-user-id>');
```

---

## 3. Credentials & configuration reference

Copy `.env.example` to `.env` and fill in the values below. **Everything in the "Required" table must be set** or the bot will fail to start (it validates env vars on boot and fails fast rather than starting half-configured).

### Required

| Variable | Where to get it |
|---|---|
| `DISCORD_TOKEN` | Discord Developer Portal → your app → Bot → Token |
| `DISCORD_CLIENT_ID` | Discord Developer Portal → your app → General Information → Application ID |
| `VOICE_CHANNEL_ID` | Right-click the voice channel in Discord → Copy Channel ID |
| `CATEGORY_ID` | Right-click that channel's category in Discord → Copy Category ID |
| `SUPABASE_URL` | Supabase project → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase project → Settings → API → `service_role` key (**secret**, never expose) |

### Optional — Discord & access control

| Variable | Default | Purpose |
|---|---|---|
| `DISCORD_DEV_GUILD_ID` | *(empty)* | Set during development for instant command registration in one guild. Global commands (leave blank) can take up to an hour to propagate — set this locally, leave it blank in production. |
| `ALLOWED_ROLE_IDS` | *(empty)* | Comma-separated role IDs allowed to control the bot. Leave empty to allow anyone currently in the configured voice channel. |

### Optional — Supabase

| Variable | Default | Purpose |
|---|---|---|
| `SUPABASE_BUCKET_NAME` | `discord` | Storage bucket name |
| `SUPABASE_SONGS_TABLE` | `songs` | Table name for song metadata |
| `SIGNED_URL_EXPIRY_SECONDS` | `3600` | How long each streaming URL stays valid |
| `LIBRARY_SYNC_INTERVAL_MS` | `120000` | How often the bot rescans the Storage bucket for new/deleted files |

### Optional — Playback behavior

| Variable | Default | Purpose |
|---|---|---|
| `AUTO_JOIN_DELAY_MS` | `30000` | Delay after the first human joins before the bot connects |
| `AUTO_LEAVE_DELAY_MS` | `30000` | Delay after the last human leaves before the bot disconnects |
| `DEFAULT_VOLUME` | `0.5` | Starting playback volume (0–1) |
| `COMMAND_COOLDOWN_MS` | `3000` | Per-user, per-command cooldown |
| `GUILD_COMMAND_COOLDOWN_MS` | `1000` | Per-guild, per-command ceiling (anti-spam / quota protection) |
| `MAX_QUEUE_LENGTH` | `200` | Caps queue size to bound memory |
| `MAX_VOICE_CONNECTIONS` | `5` | Caps concurrent voice connections |
| `MAX_FILE_SIZE_BYTES` | `52428800` (50 MB) | Rejects audio files larger than this |
| `MAX_CONSECUTIVE_TRACK_FAILURES` | `5` | Stops auto-advancing (and signals for a supervised restart) after this many tracks fail in a row, so a broken library can't loop forever |

### Optional — Ops, logging & health

| Variable | Default | Purpose |
|---|---|---|
| `LOG_LEVEL` | `info` | Logging verbosity |
| `LOG_FORMAT` | `friendly` | `friendly` prints short plain-English lines like "Track started"; `json` prints raw structured logs for aggregators/dashboards |
| `LOG_DIR` | `./logs` | Directory for `bot.log`, `restarts.log`, and `heartbeat.json` (created automatically) |
| `HEARTBEAT_PATH` | *(auto)* | Override the heartbeat file location |
| `HEARTBEAT_INTERVAL_MS` | `15000` | How often the heartbeat file updates |
| `METRICS_INTERVAL_MS` | `120000` | How often metrics are logged |
| `NODE_ENV` | `production` | Standard Node environment flag |
| `PORT` | *(empty)* | Set automatically by Render if deployed as a Web Service; starts the health server |
| `HEALTH_PORT` | *(empty)* | Use instead of `PORT` on a VPS/Docker deployment to enable `GET /health`, `GET /ready`, `GET /metrics` |
| `HEALTH_BIND` | *(auto)* | Bind address for the health server — `0.0.0.0` when `PORT` is set, otherwise `127.0.0.1`. Override to `0.0.0.0` if a remote probe needs to reach `HEALTH_PORT` |
| `HEALTH_TOKEN` | *(empty)* | If set, `GET /metrics` requires an `Authorization: Bearer <token>` or `X-Health-Token` header. `GET /health` always stays unauthenticated (liveness only) |

Your finished `.env` should look like this (values obviously replaced with your real ones):

```dotenv
DISCORD_TOKEN=your-bot-token-here
DISCORD_CLIENT_ID=your-application-client-id
DISCORD_DEV_GUILD_ID=
VOICE_CHANNEL_ID=your-voice-channel-id
CATEGORY_ID=your-category-id
ALLOWED_ROLE_IDS=

SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_BUCKET_NAME=discord
SUPABASE_SONGS_TABLE=songs

AUTO_JOIN_DELAY_MS=30000
AUTO_LEAVE_DELAY_MS=30000
DEFAULT_VOLUME=0.5
COMMAND_COOLDOWN_MS=3000
GUILD_COMMAND_COOLDOWN_MS=1000
SIGNED_URL_EXPIRY_SECONDS=3600
LIBRARY_SYNC_INTERVAL_MS=120000
MAX_QUEUE_LENGTH=200
MAX_VOICE_CONNECTIONS=5
MAX_FILE_SIZE_BYTES=52428800
MAX_CONSECUTIVE_TRACK_FAILURES=5

LOG_LEVEL=info
LOG_FORMAT=friendly
LOG_DIR=./logs
HEARTBEAT_PATH=
HEARTBEAT_INTERVAL_MS=15000
METRICS_INTERVAL_MS=120000
NODE_ENV=production
PORT=
HEALTH_PORT=
HEALTH_BIND=
HEALTH_TOKEN=
```

The full commented version with inline explanations lives in `.env.example` — copy that as your starting point rather than retyping the above by hand.

---

## 4. Running the bot

Pick whichever matches your setup. All three read configuration from the same `.env` file.

### Option A — npm (local machine)

Requires **Node.js 20 or newer**.

```bash
# 1. Clone and enter the project
git clone <your-repo-url>
cd DiscordBOT

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
# edit .env with the values from section 3 above

# 4. Register slash commands with Discord (one-time, or after changing commands)
npm run deploy-commands

# 5. Start the bot
npm start
```

For active development with auto-restart on file changes:
```bash
npm run dev
```

### Option B — Docker (recommended for VPS / self-hosting)

Requires **Docker** installed and running.

```bash
# 1. Clone and enter the project
git clone <your-repo-url>
cd DiscordBOT

# 2. Configure
cp .env.example .env
# edit .env with the values from section 3 above

# 3. Build the image
docker build -t discord-music-bot .

# 4. Run it
docker run -d \
  --name discord-music-bot \
  --env-file .env \
  --restart unless-stopped \
  discord-music-bot

# 5. Check it's running
docker logs -f discord-music-bot
```

Register slash commands once before or after your first run (from your local machine, using the same `.env`):
```bash
npm run deploy-commands
```

Common day-to-day commands:
```bash
docker ps                          # check status/health
docker logs -f discord-music-bot   # tail logs
docker stop discord-music-bot      # stop
docker start discord-music-bot     # start again
docker exec -it discord-music-bot sh   # shell into the container for debugging
```

To rebuild after pulling code changes:
```bash
docker stop discord-music-bot
docker rm discord-music-bot
docker build -t discord-music-bot .
docker run -d --name discord-music-bot --env-file .env --restart unless-stopped discord-music-bot
```

> Don't run PM2 inside this container — Docker's `--restart unless-stopped` already handles process supervision. Running both is redundant and can mask restart signals.

### Option C — Render (managed hosting, no server to maintain)

**Blueprint (recommended):**
1. Push this repo to your own GitHub account.
2. In Render, choose **New → Blueprint** and point it at your repo. `render.yaml` provisions a Background Worker automatically.
3. Fill in the secret env vars flagged `sync: false` in the Render dashboard using the values from section 3.
4. Deploy. After the first successful deploy, run `npm run deploy-commands` once (locally, using the same `.env`) to register slash commands globally.

**Manual:**
1. New → Background Worker → connect your repo.
2. Build command: `npm ci`. Start command: `npm start`.
3. Add every variable from section 3 in the Render dashboard's Environment tab.
4. Deploy.

Background Workers don't need a public port. If you deploy as a **Web Service** instead, Render injects `PORT` automatically and the bot exposes `GET /health` (liveness), `GET /ready` (Discord session status), and `GET /metrics`. Point Render's health check at `/health`, not `/ready`.

---

## Extending

- **Multi-guild, per-guild channel config:** currently the voice channel is a single global setting by design. To support a different channel per server, add a `guild_settings` table and look up the channel per `guild.id` instead of from the global config.
- **Adding songs via command:** not included by default (metadata is expected to be seeded by uploading to the bucket or via SQL/Supabase Studio), but you could add an admin-only `/addsong` command that inserts into `songs` after an upload.

For deeper operational detail — process-manager setup, Row Level Security policy specifics, restart/self-healing behavior, and Discord invite-scope requirements — see [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md).
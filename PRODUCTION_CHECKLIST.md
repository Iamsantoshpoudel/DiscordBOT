# Production checklist

This bot is designed to run as a **single Node.js process**. Discord voice
connections and in-memory queues are not shared across processes — never run
more than one instance against the same bot token.

## Process manager (pick one)

The repo currently targets **Render** (`render.yaml` Background Worker). Render
restarts the worker when the process exits non-zero. For a VPS, use **PM2**.
For containers, use Docker `restart: unless-stopped`.

Do not stack them (e.g. PM2 inside a Docker container that also has
`restart: always`) unless you know how the restart loops interact.

### Render (current `render.yaml`)

- Type: Background Worker (no public HTTP port required).
- Restart: platform restarts on crash / exit code `1` (uncaught exception) or
  `2` (supervisor: 3 consecutive subsystem failures).
- Heartbeat file: `logs/heartbeat.json` (written every 15s). Render does not
  poll it; it is there for SSH/debug.
- To add an HTTP health check, switch the service to a **Web Service** and set
  `PORT` (Render injects this). Endpoints: `GET /health` (liveness, always 200
  while the process is up), `GET /ready` (503 until Discord is logged in),
  `GET /metrics`. The server binds `0.0.0.0` when `PORT` is set. Set
  `HEALTH_TOKEN` so `/metrics` is not world-readable; `/health` stays a
  liveness probe. Do **not** point Render's health check at `/ready` unless
  you accept 503s during the Discord login window.

### PM2 (VPS / bare metal)

```bash
npm ci --omit=dev
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

`ecosystem.config.cjs` sets:

| Setting | Value | Why |
|---|---|---|
| `max_restarts` | 10 | Stop a tight crash loop |
| `min_uptime` | 10s | Crashes faster than this count as failed starts |
| `exp_backoff_restart_delay` | 1000 | Back off between restarts |
| `kill_timeout` | 20s | Time for SIGINT/SIGTERM graceful leave |

Health: set `HEALTH_PORT=8080` and point a load balancer or systemd watchdog
at `http://127.0.0.1:8080/health`. Heartbeat file: `logs/heartbeat.json`.

### systemd (alternative to PM2)

```ini
[Service]
ExecStart=/usr/bin/node /opt/discord-music-bot/src/index.js
Restart=on-failure
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20
EnvironmentFile=/opt/discord-music-bot/.env
```

### Docker

```bash
docker build -t discord-music-bot .
docker run --env-file .env --restart unless-stopped --name discord-music-bot discord-music-bot
```

```yaml
restart: unless-stopped
```

Add a healthcheck if `HEALTH_PORT` is published:

```yaml
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/health"]
  interval: 30s
  timeout: 5s
  retries: 3
```

Do not run PM2 inside this image. The container restart policy is the supervisor.

**ffmpeg in this image:** the Dockerfile installs `ffmpeg` via `apt` and
removes the bundled `node_modules/ffmpeg-static` binary at build time. This is
required — do not revert it. See "Known issue: resolved" below for why.
`npm run dev` outside Docker still uses `ffmpeg-static` normally; this only
affects the container image.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Graceful SIGINT/SIGTERM |
| 1 | Uncaught exception or Discord login failure |
| 2 | Supervisor: 3 consecutive failures of the same subsystem (`voice`, `queue`, `supabase`, `command_dispatch`, `unhandled`) |

Restart reasons are appended as JSON lines to `logs/restarts.log` (timestamp,
pid, reason) in addition to `logs/bot.log`.

## Environment

Copy `.env.example` to `.env`. Required secrets (never commit real values):

- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- `VOICE_CHANNEL_ID`
- `CATEGORY_ID`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The service role key is **server-side only**. It is never sent to Discord
users or logged in full.

See the main [README](./README.md) for the full variable reference (required
vs. optional, defaults, and what each one does).

## Discord least privilege

Invite scopes: `bot`, `applications.commands`.

Bot permissions (no Administrator):

- View Channel
- Connect
- Speak
- Send Messages (slash-command replies)
- Embed Links

Do **not** enable Message Content, Presence, or Guild Members privileged
intents. The code only requests `Guilds` and `GuildVoiceStates`.

Optional: set `ALLOWED_ROLE_IDS` so only specific roles can run playback
commands. If empty, any member **in the configured voice channel** can control
playback; `/status` remains available to the rest of the guild.

## Supabase RLS and storage

Re-run `supabase/schema.sql` (or the RLS/storage sections) in the SQL editor
after pulling these changes.

Expected state:

1. Tables `songs` and `play_history` have **RLS enabled**.
2. There is **no** anon/authenticated SELECT/INSERT/UPDATE/DELETE policy on
   those tables (service role bypasses RLS; the bot is the only client).
3. Storage bucket `discord` (or `SUPABASE_BUCKET_NAME`) is **private**
   (`public = false`).
4. Policies on `storage.objects` deny anon/authenticated access to that bucket.
   The bot streams via **signed URLs** (`SIGNED_URL_EXPIRY_SECONDS`, default 1
   hour), not public object URLs.

If you build a public catalog UI later, add a narrow `SELECT` policy on
`songs` (`is_active = true`) rather than making the bucket public.

## Monitoring

| Signal | Where |
|---|---|
| Structured logs | stdout + `logs/bot.log` |
| Restarts | `logs/restarts.log` |
| Heartbeat | `logs/heartbeat.json` |
| HTTP | `GET /health` (liveness), `GET /ready` (Discord session), `GET /metrics` when `PORT` or `HEALTH_PORT` is set |
| Periodic metrics | log event `metrics_snapshot` (uptime, commands, errors, voice connections) |
| ffmpeg binary in use | log event `ffmpeg_resolved` at boot (`command`, `version`) — confirm this says `ffmpeg`, not a path containing `ffmpeg-static`, in any Docker/container deploy |

Watch for `controlled_restart`, `subsystem_failure`, `supabase_retry`,
`voice_connection_unrecoverable`, `playback_circuit_open`,
`unhandled_rejection`, and `track_failed_before_playing` (see known issue
below — a burst of these with `elapsedMs` under ~500ms means ffmpeg is
crashing immediately, not a real playback failure).

## Operational notes

- After 3 consecutive failures of the **same** recoverable subsystem, the
  process flushes (leaves voice, stops accepting commands, writes logs) and
  exits `2`. Config/permission/missing-channel errors are **not** counted.
- After `MAX_CONSECUTIVE_TRACK_FAILURES` (default 5) tracks fail in a row,
  queue advance stops so a broken library cannot refill-and-retry forever.
  That also counts as a `queue` subsystem failure.
- Transient Discord 429s are handled by discord.js; they are logged as
  `discord_rate_limited` and are not retried by application code.
- ffmpeg child processes and Opus streams are killed on skip, error, leave,
  and shutdown.
- Caps: `MAX_QUEUE_LENGTH`, `MAX_VOICE_CONNECTIONS`, `MAX_FILE_SIZE_BYTES`.
- Queue snapshot: on SIGTERM/supervisor restart the upcoming queue is written
  to `logs/queue-snapshot.json` and restored on the next ready (max age 10
  minutes) so a controlled restart does not throw away the playlist.
- Storage sync walks nested folders (depth 4). If the listing is truncated,
  the bot **will not** mark missing files inactive (avoids wiping the library).
- `CATEGORY_ID` is required at boot. A mismatch with the voice channel's
  parent is **logged** (`voice_category_mismatch`) but does not refuse join,
  so a stale category ID cannot take playback offline. Tighten this to a
  hard fail if you want that extra check.
- `npm audit` was last clean (0 vulnerabilities) at the time of this
  hardening pass. Re-run it before each deploy; `package-lock.json` pins
  transitive versions.

## Known issue: resolved — ffmpeg-static segfault in Docker (auto-shuffle loop)

**Symptom:** in Docker/Render only (never with `npm run dev` locally), the bot
would join voice and then cycle through the entire library in seconds — logs
showed a new `"Now playing"` line roughly every 0.5–1s, tagged
`requestedBy: "auto-shuffle"`, with no crash and no visible error.

**Root cause:** `prism-media`'s internal ffmpeg locator (`FFmpeg.getInfo()`)
always tries the bundled `ffmpeg-static` binary first, validating it with a
harmless `<binary> -h` call. That call succeeded in the affected container
images, so `prism-media` cached `ffmpeg-static` as "the working ffmpeg" and
never fell back to system ffmpeg. The bundled `ffmpeg-static` binary then
**segfaulted** the instant it was given a real `https://` input (its TLS code
path is incompatible with that container environment) — producing
`elapsedMs` in the ~130ms range and `outputBytes: 0` on every attempt. A
segfault bypasses Node's normal error handling entirely, so nothing was ever
logged as an error; the `Idle` handler saw the player go idle almost
instantly and correctly (but incorrectly, given the real cause) advanced the
queue, over and over.

Setting `process.env.FFMPEG_PATH` did **not** fix this — `prism-media` never
reads that variable; it was dead code.

**Fix (already applied in this repo):**
1. Dockerfile installs system `ffmpeg` via `apt-get`.
2. Dockerfile removes `node_modules/ffmpeg-static` after `npm ci`, so
   `prism-media`'s `getInfo()` check on it fails and it correctly falls
   through to the system `ffmpeg` on `PATH`.
3. `playbackService.js` now calls `prism.FFmpeg.getInfo()` explicitly at
   startup and logs `ffmpeg_resolved` with the resolved `command` and
   `version`, so which binary is actually in use is visible in the boot log
   going forward instead of assumed silently.
4. `ffmpeg-static` remains in `package.json` for local development
   (`npm run dev`) — only the Docker image strips it.

**If this symptom reappears:** check the `ffmpeg_resolved` boot log line
first. If `command` is anything other than `ffmpeg` (system), that's the bug
again — confirm the Dockerfile's `rm -rf node_modules/ffmpeg-static` step
actually ran (rebuild with `--no-cache` if in doubt) and that `ffmpeg` is
still being installed via `apt`.

## Decisions already taken (do not re-guess)

- **Process manager:** Render worker is the current deploy target; PM2
  (`ecosystem.config.cjs`) is configured for VPS. Do not run both.
- **Storage:** private bucket + signed URLs (not a public bucket).
- **Health bind:** loopback for `HEALTH_PORT`, all interfaces when Render
  sets `PORT`. Override with `HEALTH_BIND`.
- **ffmpeg in Docker:** system `ffmpeg` via `apt`, with `ffmpeg-static`
  stripped from the image at build time. Do not reintroduce `ffmpeg-static`
  as the runtime binary in containers — see "Known issue: resolved" above.

## Vulnerability / crash-risk register

| Severity | Issue | Change |
|---|---|---|
| Critical | Unhandled rejections / uncaught exceptions could kill the process | Global handlers log full context; uncaught still flushes then exits `1` so the process manager restarts cleanly |
| Critical | Bot token / service role in env only; never hardcoded | Boot fails if required secrets missing; `.env` gitignored; logs redact JWTs and signed-URL tokens |
| Critical | `ffmpeg-static` segfaults on real playback inside Docker, silently looping the entire queue (see "Known issue: resolved") | System `ffmpeg` installed via apt; `ffmpeg-static` stripped from the Docker image; boot now logs which binary resolved |
| High | Public storage or anon writes | Bucket forced private; RLS on `songs` / `play_history`; anon/authenticated revoked; signed URLs with expiry |
| High | ffmpeg could follow redirects to `file://` or unexpected protocols | Stream URL host-checked against `SUPABASE_URL`; `-protocol_whitelist` limited to http(s)/tcp/tls |
| High | Truncated storage listing marked real songs inactive | Nested listing + skip deactivate when truncated |
| High | `/health` returned 503 before Discord login (orchestrator kill loop) | `/health` is liveness (200); `/ready` is session readiness |
| High | Voice drop left the bot idle until a later voice event | Unrecoverable disconnect schedules a 2s rejoin if humans remain |
| Medium | Auto-join failed once and never retried | Up to 3 attempts with exponential backoff; permanent errors not retried |
| Medium | Broken library skipped forever / refill loop | Consecutive-track circuit breaker + supervisor `queue` failure |
| Medium | Command spam / quota burn | Per-user and per-guild cooldowns; server-side permission checks |
| Medium | PostgREST `.or()` injection via search | Query sanitize + escape of filter metacharacters; quoted `ilike` values |
| Medium | Memory: ffmpeg/opus listeners, unbounded queues | Stream destroy on skip/error/leave; queue/voice/file caps; cooldown sweep |
| Medium | Missing ffmpeg / untrusted URL retried across the whole library | `PermanentError` halts playback instead of skip-storm |
| Low | Privileged `GuildMembers` fetch on ready | Removed; reconcile uses voice-state cache only |
| Low | Embed markdown from filenames | Titles/artists escaped in slash-command replies |
| Low | Slash commands usable in DMs | `setDMPermission(false)` at load time |
| Info | `npm audit` | 0 vulnerabilities on production deps (re-run before each deploy) |

Git history was not scanned: this workspace is not a git repository from the tool's perspective. After you `git init`, run `git log -p --all -S DISCORD_TOKEN` (and the same for `SUPABASE_SERVICE_ROLE_KEY`) before the first public push.

## Functionality confirmation

Existing slash commands (`/play`, `/pause`, `/resume`, `/skip`, `/shuffle`, `/volume`, `/status`) are unchanged in name and behavior. Guards wrap them; they still start playback, mutate the same per-guild queue, skip via `AudioPlayer.stop`, and disconnect through auto-leave / shutdown. Re-run `npm run deploy-commands` after pull so Discord picks up `dm_permission: false`.
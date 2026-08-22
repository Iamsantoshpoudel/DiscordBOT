-- ============================================================================
-- Discord Music Bot — Supabase schema
-- Run this in the Supabase SQL editor (or via `supabase db push`).
-- ============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- songs: metadata for every track. The actual audio file lives in Storage;
-- this table is the source of truth the bot queries and shuffles from.
-- ----------------------------------------------------------------------------
create table if not exists public.songs (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  artist          text not null default 'Unknown',
  duration_seconds integer,
  file_path       text not null unique,           -- path of the object inside the bucket, e.g. "tracks/song1.mp3"
  bucket_name     text not null default 'discord',
  added_by        text,                           -- Discord user ID
  is_active       boolean not null default true,  -- soft-delete flag; inactive songs are excluded from shuffling
  created_at      timestamptz not null default now()
);

create index if not exists songs_is_active_idx on public.songs (is_active);
create index if not exists songs_title_idx on public.songs using gin (to_tsvector('simple', title));
create index if not exists songs_artist_idx on public.songs using gin (to_tsvector('simple', artist));

-- ----------------------------------------------------------------------------
-- play_history: optional lightweight log of what played and when.
-- Failures writing to this table never block playback (see supabaseService.js).
-- ----------------------------------------------------------------------------
create table if not exists public.play_history (
  id          bigint generated always as identity primary key,
  guild_id    text not null,
  song_id     uuid references public.songs (id) on delete set null,
  played_at   timestamptz not null default now()
);

create index if not exists play_history_guild_idx on public.play_history (guild_id, played_at desc);

-- ----------------------------------------------------------------------------
-- Row Level Security. The bot authenticates with the SERVICE ROLE key,
-- which bypasses RLS entirely — these policies protect the data from any
-- client using the anon/public key (e.g. if you build a companion web UI).
-- ----------------------------------------------------------------------------
alter table public.songs enable row level security;
alter table public.play_history enable row level security;

drop policy if exists "songs_read_active_public" on public.songs;
create policy "songs_read_active_public"
  on public.songs for select
  using (is_active = true);

-- No insert/update/delete policies are defined for the anon role, so only
-- the service role (used exclusively by the bot's backend) can modify data.

-- ----------------------------------------------------------------------------
-- Storage bucket: create a bucket named "discord" (or match SUPABASE_BUCKET_NAME)
-- and keep it PRIVATE. The bot streams audio via short-lived signed URLs
-- generated with the service role key — it never needs the bucket to be public.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('discord', 'discord', false)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- Auto-detection: you do NOT need to manually insert a row for every song.
-- The bot scans the bucket on startup and every LIBRARY_SYNC_INTERVAL_MS,
-- and automatically adds any audio file it finds that isn't in this table
-- yet (title is derived from the filename, e.g. "my_song.mp3" -> "my song").
-- Manual inserts are only needed if you want to set a specific title/artist
-- yourself instead of the auto-generated one — do that BEFORE uploading the
-- file, or edit the row afterwards; auto-detection never overwrites a row
-- that already exists for that file_path.
--
-- insert into public.songs (title, artist, duration_seconds, file_path, bucket_name, added_by)
-- values ('Example Track', 'Example Artist', 214, 'tracks/example.mp3', 'discord', '123456789012345678');

-- If you already ran an earlier version of this schema (without the unique
-- constraint above), apply it retroactively with:
--
-- alter table public.songs add constraint songs_file_path_key unique (file_path);

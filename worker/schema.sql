-- MONK — D1 schema.
--
-- Four small tables. D1 (not KV) because the free KV tier allows only 1,000
-- writes/day and a thousand players doing three daily tasks is ~6,000 writes
-- before anyone touches X or referrals. D1 free allows 100,000 row-writes/day
-- and 5M row-reads/day, which is roughly 15,000 daily-active monks with room
-- to spare — and it costs nothing.
--
-- Apply with:
--   npx wrangler d1 execute monk --remote --file=./schema.sql

-- ── players ────────────────────────────────────────────────────────────────
-- One row per wallet. Monks are soulbound, so a wallet is a player for good
-- and this row is the whole of their standing.
--
-- `devotion` is a MONOTONIC CUMULATIVE counter of BASE devotion — the rate a
-- single monk earns. It only ever goes up. Never decrement it: every monk's
-- score is derived from it by subtraction (see below), so lowering it would
-- retroactively re-price every habit in the wallet.
--
-- TOTAL devotion — the leaderboard number — is derived, never stored:
--
--     total = monk_count * devotion - bind_sum
--
-- because a monk minted when the counter stood at B has earned exactly
-- (devotion - B) since, and summing that over n monks gives the identity
-- above. `bind_sum` is the running sum of those mint-time watermarks. Both
-- move only at mint, so earning stays ONE update on ONE row no matter whether
-- a wallet holds one monk or twenty.
CREATE TABLE IF NOT EXISTS players (
  wallet        TEXT PRIMARY KEY,       -- lowercase 0x-address
  devotion      INTEGER NOT NULL DEFAULT 0,  -- cumulative BASE (per-monk) devotion
  monk_count    INTEGER NOT NULL DEFAULT 0,
  bind_sum      INTEGER NOT NULL DEFAULT 0,  -- Σ of each monk's mint-time watermark
  streak        INTEGER NOT NULL DEFAULT 0,
  best_streak   INTEGER NOT NULL DEFAULT 0,
  last_full_day INTEGER,                -- last game-day all three tasks were done
  task_day      INTEGER,                -- game-day `tasks_mask` refers to
  tasks_mask    INTEGER NOT NULL DEFAULT 0,  -- bit 1 confess · 2 pray · 4 candles
  x_handle      TEXT,                   -- verified X handle, lowercase, no @
  x_pending     TEXT,                   -- handle awaiting code verification
  x_code        TEXT,                   -- the code that verifies x_pending
  ref_bonus     INTEGER NOT NULL DEFAULT 0,  -- devotion earned from referrals
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS players_devotion ON players (devotion DESC);
-- the leaderboard sorts on the derived total, so index its components
CREATE INDEX IF NOT EXISTS players_total ON players (monk_count, devotion);
CREATE UNIQUE INDEX IF NOT EXISTS players_x_handle ON players (x_handle) WHERE x_handle IS NOT NULL;

-- ── monks ──────────────────────────────────────────────────────────────────
-- Written ONCE, at mint, and never again — monks are soulbound, so there is
-- no transfer to settle and no owner to update. This table exists only so the
-- game can list a wallet's habits and show what each one has earned; the
-- scoring maths never reads it.
CREATE TABLE IF NOT EXISTS monks (
  token_id  INTEGER PRIMARY KEY,
  wallet    TEXT NOT NULL,             -- the minter, forever
  bind_mark INTEGER NOT NULL DEFAULT 0,-- players.devotion at the moment it was minted
  minted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS monks_wallet ON monks (wallet);

-- ── events ─────────────────────────────────────────────────────────────────
-- Append-only ledger. `uniq` is what makes every credit idempotent: a replayed
-- chain log, a double-tapped button and a re-ingested X batch all collide on
-- it and credit exactly once.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uniq       TEXT NOT NULL UNIQUE,
  wallet     TEXT NOT NULL,
  kind       TEXT NOT NULL,             -- task | x | referral | admin
  detail     TEXT,
  base       INTEGER NOT NULL,          -- devotion before the streak multiplier
  mult_bp    INTEGER NOT NULL,          -- multiplier in basis points (10000 = 1x)
  amount     INTEGER NOT NULL,          -- devotion actually credited
  day        INTEGER NOT NULL,          -- game-day index, 0-based
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_wallet ON events (wallet, id DESC);

-- ── meta ───────────────────────────────────────────────────────────────────
-- Key/value scratch: chain sync cursor, kill switches.
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

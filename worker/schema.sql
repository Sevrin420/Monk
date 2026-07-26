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
-- One row per wallet. `devotion` is a MONOTONIC CUMULATIVE counter: it only
-- ever goes up, and it is the accumulator that per-token devotion is derived
-- from (see `monks`). Never decrement it — doing so would silently re-price
-- every token bound to this wallet.
CREATE TABLE IF NOT EXISTS players (
  wallet        TEXT PRIMARY KEY,       -- lowercase 0x-address
  devotion      INTEGER NOT NULL DEFAULT 0,
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
CREATE UNIQUE INDEX IF NOT EXISTS players_x_handle ON players (x_handle) WHERE x_handle IS NOT NULL;

-- ── monks ──────────────────────────────────────────────────────────────────
-- Per-token devotion without per-token writes.
--
-- A monk earns everything its holder's wallet earns while it sits in that
-- wallet. Writing that literally would mean 20 row-updates for a wallet with
-- 20 monks on every single task. Instead each token stores a WATERMARK into
-- its holder's cumulative counter:
--
--   live devotion = accrued + (players.devotion - bind_mark)
--
-- Earning is then O(1) no matter how many monks a wallet holds — one UPDATE on
-- `players`. Only a TRANSFER touches this table: settle `accrued` against the
-- old holder, then re-watermark against the new one.
CREATE TABLE IF NOT EXISTS monks (
  token_id   INTEGER PRIMARY KEY,
  wallet     TEXT NOT NULL,             -- current holder, lowercase
  bind_mark  INTEGER NOT NULL DEFAULT 0,-- players.devotion when it entered this wallet
  accrued    INTEGER NOT NULL DEFAULT 0,-- devotion banked under previous holders
  updated_at INTEGER NOT NULL
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
-- Key/value scratch: chain sync cursor, cached leaderboards, kill switches.
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

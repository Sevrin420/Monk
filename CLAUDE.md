# CLAUDE.md — Monk

---

## !!!!! CRITICAL: CONTRACT DEPLOYMENT !!!!!

**NEVER run scripts that deploy contracts. NEVER. Always ASK the user before
deploying ANY contract. The user must explicitly confirm before any deploy
script is executed. This includes testnets. No exceptions.**

---

## !!!!! SECURITY: CONTENT SECURITY POLICY !!!!!

**Every HTML page MUST carry a CSP meta tag immediately after `<meta charset>`.**
It blocks injected scripts from building malicious transactions. When you add a
new backend origin, add it to `connect-src` or the browser will silently block
the call:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; connect-src 'self' https://rpc.mainnet.chain.robinhood.com https://monk.severin20.workers.dev; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-src 'none'; object-src 'none'; base-uri 'self';">
```

---

## User Context

The user **cannot code or run code locally**. Every script, deployment and
command must be:

1. written into a file by Claude,
2. committed to the repo,
3. executed via a **GitHub Actions workflow**.

Never tell the user to "run this command" — put it in a workflow and push it.

---

## Working Rules

- Small, atomic steps: one file, one function, one fix per response.
- Do NOT rewrite large sections or refactor unrelated code unless asked.
- If something is unclear, ask ONE precise question instead of guessing.
- Keep responses short.

### Asset paths
Project assets live in **`assets/monk/`**. Never guess another location.

---

## Project Overview

**Monk** is a 60-day devotion game set in an abbey in 1200 AD. Players mint a
Monk NFT (0.01 ETH, max 20 per wallet), keep three daily offices, build streaks
for multipliers, and earn extra devotion from X engagement and referrals.

It reuses the **Club Nile engine and console shell**: a 240×240 canvas at a 2x
supersampled backing store, half-pixel sprite cells, a fixed handheld frame with
a hand-built ON/OFF slide switch, and a d-pad + A/B driving everything including
the menus.

**Stack:** vanilla JS + canvas, ethers v5 (UMD), Solidity 0.8.26 + OpenZeppelin
v5, Cloudflare Workers + D1.

### Chain — Robinhood Chain

| | |
|---|---|
| Mainnet chain ID | **4663** (`0x1237`) |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` (Blockscout) |
| Gas token | ETH — so `MINT_PRICE = 0.01 ether` means what it says |
| Stack | Arbitrum Orbit / Nitro L2, blobs to Ethereum |

Two consequences that bite if forgotten:

- **`evmVersion` must be `cancun`** (set in `hardhat.config.js`). OpenZeppelin
  5.x uses `mcopy`, which needs it; the default target fails to compile.
  Nitro has supported Cancun opcodes since ArbOS 32, so this is fine on any
  recently launched Orbit chain — but it is the first thing to check if a
  deploy reverts on a call rather than failing to send.
- **Blocks are fast** (Orbit defaults to ~250ms), so `START_BLOCK` matters far
  more than on a 2s chain. Set it to the contract's deploy block or the first
  cron pass will crawl from genesis for days. Run
  `.github/workflows/preflight.yml` to read the current head before deploying.

The public RPC is free but rate limited. The Worker uses roughly 3 requests per
five-minute tick (~900/day), which is nowhere near any published limit — but it
is the design's single external dependency.

---

## Architecture — read this before touching the Worker

Three invariants carry the whole design. Breaking any of them silently corrupts
scores rather than throwing, so be careful here.

### 0. MONKS ARE SOULBOUND

The contract reverts on transfer, burn and approval — the only `Transfer` it
can emit is a mint out of the zero address. This is a **game rule** first:
devotion is earned by a wallet and every monk in it shares that wallet's
streak, so tradeable monks would let a player grind a 28-day streak with one
monk and then buy up cheap habits from lapsed players, applying 3x to tokens
that were earning nothing. It also deletes a whole class of backend work.

**Never add a transfer path.** If ownership can change, every identity below
breaks.

### 1. THERE IS ONE SCORE, AND IT IS CALLED DEVOTION

`players.devotion` is a single monotonic cumulative counter. The level bar
fills from it and from nothing else, and the one leaderboard ranks it.
**Never decrement it.** Do not add a second score.

### 2. MONKS MULTIPLY AT THE MOMENT OF EARNING

```
payout = floor(base × mult_bp / 10000) × monk_count
```

Each monk adds a whole office: 10 with one monk, 20 with two, 200 with twenty.
The per-monk value is rounded **before** multiplying, so the number on screen
is always a whole multiple of the office.

Applying the count at earning time is what makes it forward-only for free —
minting speeds up everything afterwards and cannot reach devotion already
banked. There is no watermark, no settlement, and earning stays one UPDATE on
one row however many monks are held.

`recordMint()` is the only writer of `monks`, and its `ON CONFLICT DO NOTHING`
is load-bearing — without it a re-scanned block range would inflate
`monk_count`, and every future office would overpay forever.

**Only offices multiply by monks.** X engagement takes the streak but passes
`monks: 1` — a repost is one repost however many habits are held, and twenty
monks must not turn a single like into forty devotion. Referrals are flat in
both (20 per monk brought in, no streak either) — recruiting is not practice.

### Idempotency

Every credit goes through `credit()` with a `uniq` key:

| kind | key |
|---|---|
| task | `task:{wallet}:{day}:{office}` |
| X | `x:{tweetId}:{action}:{handle}` |
| referral | `ref:{txHash}:{logIndex}` |

The INSERT either takes or is ignored, and only a fresh insert moves the
counter. Replayed chain logs, double-tapped buttons and re-ingested X batches
are all safe. **Any new devotion source needs a `uniq` key of its own.**

### Chain sync

`scheduled()` → `syncChain()` runs every 5 minutes. One `eth_getLogs` per
800-block chunk pulls `Transfer` and `Referral` together (both topics in one
`topics[0]` array), ordered by block and log index. Only mints (`from == 0x0`)
are acted on; any other `Transfer` means the deployed contract is not the one
in this repo, and is ignored rather than trusted. The cursor lives in
`meta.last_block`.

There is no indexer and no paid RPC, on purpose.

---

## Game rules (single source of truth: `worker/monk-worker.js`)

The client **never** computes devotion or levels — it renders what `/state`
returns. A tampered client can lie to its own screen and nowhere else.

- Daily offices (the three tasks): `confess` 1, `pray` 2, `candles` 4 — a bitmask
  in `players.tasks_mask`.
  **Never reorder those bits**, they are persisted.
- 10 devotion per office **per monk held**; all three in a day advances the streak.
- Streak tiers: 7d ×1.5, 14d ×2, 21d ×2.5, 28d ×3.
- `streakForDay()` counts **today** as part of the run being built, so the
  multiplier is fixed for the whole day rather than changing between the first
  and third office.
- X: like 2, comment 3, repost 5 — multiplied by the streak **only**. Engagement
  does NOT scale with monks: a repost is one repost however many habits are held.
  Offices are the only thing holdings multiply.
- Referrals: 20 per monk brought in, **flat** (no multiplier of any kind).
- Levels: devotion to reach level L is `15·L·(L−1)`. Ranks are one per level,
  Postulant → Abbot (level 16). A **one-monk** perfect 60-day run banks 4,410:
  Abbot on day 51, finishing at level 17. Holding more monks fills the bar
  proportionally faster and reaches Abbot sooner, with the rank pinned there
  while the level keeps counting for the leaderboard's sake.
  The curve constant (15) is what makes one full solo day exactly level 2 —
  changing it to land Abbot on day 60 would cost that day-one level-up, which
  is the more valuable of the two properties.
- A wallet must hold ≥1 monk to keep offices.
- Monks are minted from the abbey only, max 20/wallet, and cannot be traded.

---

## Free-tier budget

Keep it inside these or the design breaks:

| Resource | Free limit | Monk's usage |
|---|---|---|
| Worker requests | 100k/day | ~10/player/day |
| D1 rows written | 100k/day | ~6/player/day |
| D1 rows read | 5M/day | small |
| Cron | — | 288 runs/day |

That is roughly 10–15k daily-active players for £0. **D1, never KV, for
anything write-heavy** — KV free allows only 1,000 writes/day.

---

## Pushing Changes

Development happens on feature branches. Use `git push -u origin <branch>`.
Do not force-push shared branches.

---

## Testing

```bash
cd worker && npm test          # devotion maths + signature recovery
```

The end-to-end suite (`worker/test/e2e.mjs`) needs a running `wrangler dev`; it
walks a wallet through sign-in, the three offices, replay rejection, X linking
and a mid-game mint, asserting the new monk earns at full rate at once and
collects nothing retroactively.

`npx hardhat test` covers the contract, including that every route out of a
token reverts. All three suites run in CI on push (`.github/workflows/test.yml`).

Note: do NOT shell out to `wrangler d1 execute --local` while `wrangler dev` is
running — it makes the dev server reload and drop in-flight connections. The
e2e suite writes to miniflare's SQLite file directly instead.

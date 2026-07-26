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
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; connect-src 'self' https://mainnet.base.org https://monk.severin20.workers.dev; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-src 'none'; object-src 'none'; base-uri 'self';">
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

**Monk** is a 56-day devotion game set in an abbey in 1200 AD. Players mint a
Monk NFT (0.01 ETH, max 20 per wallet), keep three daily offices, build streaks
for multipliers, and earn extra devotion from X engagement and referrals.

It reuses the **Club Nile engine and console shell**: a 240×240 canvas at a 2x
supersampled backing store, half-pixel sprite cells, a fixed handheld frame with
a hand-built ON/OFF slide switch, and a d-pad + A/B driving everything including
the menus.

**Stack:** vanilla JS + canvas, ethers v5 (UMD), Solidity 0.8.26 + OpenZeppelin
v5, Cloudflare Workers + D1.

---

## Architecture — read this before touching the Worker

Two invariants carry the whole design. Breaking either one silently corrupts
scores rather than throwing, so be careful here.

### 1. `players.devotion` is a MONOTONIC CUMULATIVE counter

It only ever goes up. It is not "the player's current score to display" — it is
the accumulator that **per-monk** devotion is derived from:

```
monk devotion = monks.accrued + (players.devotion − monks.bind_mark)
```

**Never decrement `players.devotion`.** Doing so retroactively re-prices every
monk bound to that wallet. If you ever need to take devotion away, do it by
adjusting `monks.accrued`, not the accumulator.

This is why earning is O(1): one UPDATE on `players`, no matter whether the
wallet holds one monk or twenty.

### 2. Only a TRANSFER writes to `monks`

`moveMonk()` is the single writer. It settles what the monk earned under the old
holder into `accrued`, then re-watermarks `bind_mark` against the new holder's
current counter. Nothing on the earning path may touch this table.

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
`topics[0]` array), ordered by block and log index. The cursor lives in
`meta.last_block`.

There is no indexer and no paid RPC, on purpose.

---

## Game rules (single source of truth: `worker/monk-worker.js`)

The client **never** computes devotion or levels — it renders what `/state`
returns. A tampered client can lie to its own screen and nowhere else.

- Offices: `confess` 1, `pray` 2, `candles` 4 — a bitmask in `players.tasks_mask`.
  **Never reorder those bits**, they are persisted.
- 10 devotion per office; all three in a day advances the streak.
- Streak tiers: 7d ×1.5, 14d ×2, 21d ×2.5, 28d ×3.
- `streakForDay()` counts **today** as part of the run being built, so the
  multiplier is fixed for the whole day rather than changing between the first
  and third office.
- X: like 2, comment 3, repost 5 — multiplied by the streak.
- Referrals: 20 per monk, **flat** (no multiplier).
- Levels: devotion to reach level L is `15·L·(L−1)`. Ranks are one per level,
  Postulant → Abbot, tuned so a perfect 56-day run lands on exactly level 16.
- A wallet must hold ≥1 monk to keep offices.

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
and a secondary sale, and asserts the watermark accounting survives the sale.

Note: do NOT shell out to `wrangler d1 execute --local` while `wrangler dev` is
running — it makes the dev server reload and drop in-flight connections. The
e2e suite writes to miniflare's SQLite file directly instead.

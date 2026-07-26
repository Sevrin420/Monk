# MONK

An abbey, 1200 AD. Mint a Monk, keep the three daily offices for fifty-six
days, and see how much devotion you can carry before the book closes.

Same engine and the same handheld console as Club Nile — flip the switch on
the front, wait for the title card, press A, and you are in the cloister.

---

## The game in one paragraph

Three offices a day — **Confess**, **Pray**, **Light Candles** — 10 devotion
each. Keep all three and the day counts toward a streak, and streaks multiply
everything you earn afterwards. Engaging with the Monk X account pays too.
Every Monk NFT in your wallet earns the full devotion that wallet earns, so
holding twenty is twenty times the yield with no extra clicking. The game runs
56 days and you can join at any point before it ends.

| | |
|---|---|
| Chain | Robinhood Chain (4663) — Arbitrum Orbit L2, ETH for gas |
| Mint | 0.01 ETH, max 20 per wallet — **from the abbey only** |
| Offices | 3/day × 10 devotion |
| Streaks | 7d ×1.5 · 14d ×2 · 21d ×2.5 · 28d ×3 |
| X engagement | like 2 · comment 3 · repost 5 |
| Referrals | 20 devotion per Monk minted through your link |
| Length | 56 days |

---

## Monks are soulbound

A habit is given, never sold on. Once minted, a Monk cannot be transferred,
approved or burned.

That is a game rule before it is a technical one. Devotion is earned by a
**wallet**, and every Monk in it shares that wallet's streak — so if monks were
tradeable, the dominant move would be to grind a 28-day streak with one monk
and then buy up cheap habits from lapsed players, instantly applying a 3× multiplier
to tokens that were earning nothing. Soulbinding closes that arbitrage
completely, and it means the only way to hold more monks is to mint them.

A monk minted mid-game **picks up your streak immediately** — it multiplies
everything you earn from that moment — but collects nothing retroactively.

---

## Why the backend is this small

The whole backend is **one Cloudflare Worker, one D1 database and one cron
trigger**, sized to hold a few thousand daily players inside the free tier.
Three decisions make that possible.

**There is no ownership to track.** Soulbinding means a token's owner is fixed
at mint. No transfer settlement, no re-binding, no reconciliation pass — the
Worker only ever needs to learn that a mint happened.

**Total devotion is derived, not stored.** `players.devotion` is a monotonic
cumulative counter of *base* devotion — the rate one monk earns. A monk minted
when that counter stood at `B` has since earned `devotion − B`, so summing over
a wallet's monks collapses to arithmetic:

```
total = monk_count × devotion − bind_sum
```

Both components move **only at mint**, so earning is one `UPDATE` on one row
whether the wallet holds one monk or twenty. The `monks` table is written once
per token and never read by the scoring maths at all.

**Mints come from logs, not polling.** A cron pass every five minutes replays
`Transfer` out of the zero address and `Referral` with a single `eth_getLogs`
per chunk against a free public RPC.

D1 rather than KV because the free KV tier allows only 1,000 writes/day — a
thousand players doing three offices is already 6,000. D1 free allows 100,000
row-writes and 5M row-reads per day, which is roughly 15,000 daily-active
monks with room to spare.

Every credit carries an idempotency key, so a replayed chain log, a
double-tapped button and a re-ingested X batch all credit exactly once.

---

## Layout

```
index.html            the game — console shell, engine, abbey, HUD
js/config.js          the only file to edit to point at live infrastructure
assets/monk/          console frame art
contracts/Monk.sol    ERC-721: 0.01 ETH, max 20/wallet, emits Referral
worker/
  monk-worker.js      the entire backend
  schema.sql          four tables
  wrangler.toml       bindings, vars, the cron
  test/rules.test.mjs signature recovery + the devotion maths
  test/e2e.mjs        full loop against a running `wrangler dev`
```

---

## The chain

Robinhood Chain — an Arbitrum Orbit (Nitro) rollup that uses **ETH for gas**, so
a 0.01 ETH mint means what it says.

| | |
|---|---|
| Mainnet chain ID | 4663 (`0x1237`) |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` |

Deployment is permissionless — no allowlist, no approval needed.

Two things about this chain shape the code:

- **`evmVersion` is pinned to `cancun`** in `hardhat.config.js`. OpenZeppelin
  5.x compiles `mcopy`, which needs it. Nitro has supported Cancun opcodes
  since ArbOS 32, so this is fine on a recently launched Orbit chain — the
  preflight workflow probes for it rather than assuming.
- **Blocks are ~250ms**, so `START_BLOCK` matters far more than on a 2s chain.
  Set it to the contract's deploy block or the first cron pass will crawl from
  genesis for days.

**Before deploying, run `.github/workflows/preflight.yml`** from the Actions
tab. It deploys nothing and needs no key; it confirms the chain id, measures
the real block time against the sync budget, checks that `eth_getLogs` serves
the 800-block range the Worker uses, and probes MCOPY.

---

## Running it

### Backend

```bash
cd worker
npm install

npx wrangler d1 create monk                 # paste the id into wrangler.toml
npx wrangler d1 execute monk --remote --file=./schema.sql

npx wrangler secret put SESSION_SECRET      # any long random string
npx wrangler secret put ADMIN_KEY           # bearer token for /admin/*

npx wrangler deploy
```

Then set `GAME_START`, `CONTRACT_ADDRESS` and `START_BLOCK` in
`wrangler.toml`. `START_BLOCK` should be the block the contract was deployed
in — getting it right saves the first cron pass a very long crawl.

### Tests

```bash
cd worker
npm test                                    # rules + signature recovery

# end-to-end, against a local worker:
npx wrangler d1 execute monk --local --file=./schema.sql
npx wrangler dev --port 8787 --local --var GAME_START:$(( $(date +%s) - 259200 ))
node test/e2e.mjs
```

### Frontend

Static — any host will do, including GitHub Pages. Point `js/config.js` at the
deployed Worker and the contract, and make sure the Worker's origin appears in
the `connect-src` of the CSP meta tag in `index.html`, or the browser will
block it.

---

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /state?wallet=` | — | everything the HUD draws, in one call |
| `POST /auth/nonce` | — | mint a sign-in message |
| `POST /auth/verify` | — | signature → 7-day session token |
| `POST /task` | session | keep an office |
| `POST /x/link` | session | claim an X handle, get a verification code |
| `GET /leaderboard?by=total\|practice` | — | top 100, cached 60s at the edge |
| `GET /monk/:id` | — | one habit's standing |
| `POST /admin/x/ingest` | admin | batch X engagement |
| `POST /admin/x/verify` | admin | confirm a handle link by hand |
| `POST /admin/sync` | admin | force a chain sync |
| `GET /admin/stats` | admin | health |

### X engagement

The Worker deliberately holds no X credentials — that is what keeps it free.
Feed `/admin/x/ingest` from a scheduled script that does hold them:

```json
{ "events": [
  { "handle": "someone", "tweetId": "1234", "action": "like" },
  { "handle": "someone", "tweetId": "1234", "action": "comment", "text": "amen MONK-A1B2C3" }
]}
```

Handle linking needs no API access either. A player asks for a code in THE
BOOK, replies to a Monk post with it, and the next ingest batch that carries
that reply confirms the link.

---

## Levels and the two scores

The game keeps two numbers apart on purpose:

- **Devotion (practice)** — what one monk earns. Drives your level and rank.
- **Total** — that practice across every habit you hold. Drives the leaderboard.

Devotion to reach level L is `15·L·(L−1)`. One full day of offices (30) is
exactly level 2. Ranks run Postulant → Abbot, one per level, and the ladder is
tuned against the clock: keeping all three offices every single day for 56 days
lands on **exactly level 16**, so a perfect run — or a shorter one paid for
with X engagement and referrals — dies an Abbot.

Because rank follows practice rather than total, holding twenty monks multiplies
your yield without buying you a rank. Taking more habits is a yield decision,
not a status one.

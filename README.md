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
56 days and you can join at any point before it ends, by minting or by buying
a Monk on a secondary market.

| | |
|---|---|
| Mint | 0.01 ETH, max 20 per wallet |
| Offices | 3/day × 10 devotion |
| Streaks | 7d ×1.5 · 14d ×2 · 21d ×2.5 · 28d ×3 |
| X engagement | like 2 · comment 3 · repost 5 |
| Referrals | 20 devotion per Monk minted through your link |
| Length | 56 days |

---

## Why the backend is this small

The whole backend is **one Cloudflare Worker, one D1 database and one cron
trigger**. It is designed to hold a few thousand daily players inside the free
tier, and two decisions are what make that possible.

**Devotion is an accumulator, not a per-monk ledger.** A monk earns whatever
its holder earns while it sits in that wallet. Written literally, a wallet with
twenty monks would cost twenty row-updates on every single task. Instead
`players.devotion` is a monotonic cumulative counter and each monk stores a
watermark into it:

```
monk devotion = accrued + (holder.devotion − bind_mark)
```

Earning is therefore **one UPDATE regardless of how many monks you hold**, and
only a *transfer* ever touches the monks table — where it settles what the monk
earned under the old holder and re-watermarks it against the new one. This is
the staking-index trick, applied to devotion.

**Ownership comes from logs, not from polling.** A cron pass every five minutes
replays `Transfer` and `Referral` from the Monk contract with a single
`eth_getLogs` per chunk against a free public RPC. Mints, transfers and
secondary sales all arrive through that one path, so a monk bought on a
marketplace starts earning within a tick without anyone reporting the sale.

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
| `GET /leaderboard?by=wallet\|monk` | — | top 100, cached 60s at the edge |
| `GET /monk/:id` | — | one monk's standing, for marketplace listings |
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

## Levels

Devotion to reach level L is `15·L·(L−1)`. One full day of offices (30) is
exactly level 2. Ranks run Postulant → Abbot, one per level, and the ladder is
tuned against the clock: keeping all three offices every single day for 56 days
lands on **exactly level 16**, so a perfect run — or a shorter one paid for
with X engagement and referrals — dies an Abbot.

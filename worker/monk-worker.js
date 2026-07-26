/**
 * MONK — the entire backend.
 *
 * One Cloudflare Worker, one D1 database, one cron trigger. No Durable
 * Objects, no queues, no indexer, no paid RPC. It is built to sit inside the
 * free tier at a few thousand daily players, and the two design choices that
 * make that true are worth stating up front:
 *
 *   1. DEVOTION IS AN ACCUMULATOR, NOT A LEDGER PER MONK.
 *      A monk earns whatever its holder earns while it sits in that wallet.
 *      Done naively, a wallet with 20 monks costs 20 row-writes per task. So
 *      `players.devotion` is a monotonic cumulative counter, and each monk
 *      stores a watermark into it (`bind_mark`). A monk's real devotion is
 *      `accrued + (holder.devotion - bind_mark)`. Earning is one UPDATE
 *      regardless of how many monks you hold; only a TRANSFER touches the
 *      monks table. This is the staking-index trick, applied to devotion.
 *
 *   2. OWNERSHIP COMES FROM LOGS, NOT FROM POLLING.
 *      A cron pass replays `Transfer` and `Referral` from the Monk contract
 *      with a single `eth_getLogs` per chunk against a public RPC. Secondary
 *      sales, transfers and mints all land through the same path, so a monk
 *      bought on a marketplace starts earning within one cron tick without
 *      anyone telling us about it.
 *
 * Bindings (wrangler.toml):
 *   DB               D1 database
 * Vars:
 *   GAME_START       unix seconds, day 0 begins here
 *   CONTRACT_ADDRESS Monk ERC-721
 *   READ_RPC         public JSON-RPC endpoint
 *   START_BLOCK      block the contract was deployed in
 * Secrets (wrangler secret put ...):
 *   SESSION_SECRET   HMAC key for sign-in nonces and session tokens
 *   ADMIN_KEY        bearer token for /admin/*
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

/* ────────────────────────────── game rules ────────────────────────────── */

const GAME_DAYS = 56;
const DAY = 86400;

/** The three daily offices. Bit positions matter — they are stored in
 *  `players.tasks_mask`, so never reorder them. */
const TASKS = { confess: 1, pray: 2, candles: 4 };
const ALL_TASKS = 7;
const TASK_DEVOTION = 10;

/** Streak length → multiplier in basis points (10000 = 1.0x). */
const STREAK_TIERS = [
  [28, 30000],
  [21, 25000],
  [14, 20000],
  [7,  15000],
];
function multiplierFor(streak) {
  for (const [days, bp] of STREAK_TIERS) if (streak >= days) return bp;
  return 10000;
}

/** X engagement, credited from an ingest batch. */
const X_DEVOTION = { like: 2, comment: 3, retweet: 5 };

/** Paid to the referrer, per monk minted through their link. Flat — the
 *  streak multiplier rewards showing up, not recruiting. */
const REFERRAL_DEVOTION = 20;

/** Levels: devotion to REACH level L is 15·L·(L-1). One full day of offices
 *  (30) is exactly level 2, which makes the first session feel like progress;
 *  a task-only player finishes the 56 days around level 17. */
function levelFor(devotion) {
  return Math.floor((15 + Math.sqrt(225 + 60 * Math.max(0, devotion))) / 30);
}
function levelFloor(level) {
  return 15 * level * (level - 1);
}

const RANKS = [
  'Postulant', 'Novice', 'Oblate', 'Acolyte', 'Lay Brother', 'Brother',
  'Cantor', 'Sacristan', 'Almoner', 'Cellarer', 'Infirmarian', 'Scribe',
  'Precentor', 'Sub-Prior', 'Prior', 'Abbot',
];
/** One rank per level, topping out at Abbot. This is deliberately tuned
 *  against the 56-day clock: keeping all three offices every single day
 *  lands on exactly level 16, so a perfect run — and only a perfect run,
 *  or a shorter one paid for with X engagement and referrals — dies an
 *  Abbot. Levels keep climbing past 16 for the leaderboard's sake. */
function rankFor(level) {
  return RANKS[Math.min(RANKS.length - 1, Math.max(0, level - 1))];
}

/** Everything the HUD needs, derived from one player row. Kept in one place
 *  so the client never has to re-implement the curve. */
function progressFor(devotion) {
  const level = levelFor(devotion);
  const floor = levelFloor(level);
  const next = levelFloor(level + 1);
  return {
    devotion,
    level,
    rank: rankFor(level),
    levelFloor: floor,
    levelCeil: next,
    intoLevel: devotion - floor,
    levelSpan: next - floor,
    toNextLevel: next - devotion,
  };
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra },
  });
}
const fail = (msg, status = 400) => json({ error: msg }, status);

const now = () => Math.floor(Date.now() / 1000);

function gameStart(env) {
  return parseInt(env.GAME_START || '0', 10);
}
/** Game-day index, 0-based. Negative before the bell, >= GAME_DAYS after. */
function gameDay(env, at = now()) {
  return Math.floor((at - gameStart(env)) / DAY);
}
function dayState(env, at = now()) {
  const day = gameDay(env, at);
  const start = gameStart(env);
  return {
    day,
    totalDays: GAME_DAYS,
    started: day >= 0,
    ended: day >= GAME_DAYS,
    startsAt: start,
    endsAt: start + GAME_DAYS * DAY,
    nextDayAt: start + (day + 1) * DAY,
  };
}

const isAddress = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const norm = (a) => String(a).toLowerCase();

function hex(bytes) {
  return '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function unhex(s) {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
const utf8 = (s) => new TextEncoder().encode(s);

function keccakHex(input) {
  return hex(keccak_256(typeof input === 'string' ? utf8(input) : input));
}

/* ───────────────────────────── crypto / auth ───────────────────────────── */

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, utf8(msg));
  return hex(new Uint8Array(sig)).slice(2);
}

/** Constant-time-ish string compare. Both inputs are hex of equal length in
 *  every call site, so length leakage is not meaningful here. */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Recover the signer of an EIP-191 `personal_sign` signature. */
function recoverSigner(message, signature) {
  const sig = unhex(signature);
  if (sig.length !== 65) throw new Error('bad signature length');
  let v = sig[64];
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error('bad recovery id');

  const msg = utf8(message);
  const prefix = utf8(`\x19Ethereum Signed Message:\n${msg.length}`);
  const payload = new Uint8Array(prefix.length + msg.length);
  payload.set(prefix, 0);
  payload.set(msg, prefix.length);
  const digest = keccak_256(payload);

  const point = secp256k1.Signature
    .fromCompact(sig.slice(0, 64))
    .addRecoveryBit(v)
    .recoverPublicKey(digest);
  const pub = point.toRawBytes(false).slice(1); // drop the 0x04 tag
  return '0x' + hex(keccak_256(pub)).slice(-40);
}

const NONCE_TTL = 600;      // 10 minutes to sign
const SESSION_TTL = 7 * DAY;

/** Stateless nonce: an HMAC over wallet+timestamp. Nothing to store, nothing
 *  to clean up, and it still cannot be forged. */
async function signInMessage(env, wallet, ts) {
  const tag = (await hmac(env.SESSION_SECRET, `nonce:${wallet}:${ts}`)).slice(0, 24);
  return [
    'Monk Abbey — enter the cloister',
    '',
    `Wallet: ${wallet}`,
    `Issued: ${new Date(ts * 1000).toISOString()}`,
    `Nonce: ${tag}`,
    '',
    'Signing costs nothing and grants no spending permission.',
  ].join('\n');
}

async function issueSession(env, wallet) {
  const exp = now() + SESSION_TTL;
  const body = `${wallet}.${exp}`;
  return `${body}.${await hmac(env.SESSION_SECRET, `session:${body}`)}`;
}

async function readSession(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [wallet, exp, mac] = parts;
  if (!isAddress(wallet) || parseInt(exp, 10) < now()) return null;
  const want = await hmac(env.SESSION_SECRET, `session:${wallet}.${exp}`);
  return safeEqual(mac, want) ? norm(wallet) : null;
}

function isAdmin(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return !!env.ADMIN_KEY && safeEqual(key, env.ADMIN_KEY);
}

/* ────────────────────────────── data access ────────────────────────────── */

async function ensurePlayer(env, wallet) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO players (wallet, created_at, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(wallet) DO NOTHING`,
  ).bind(wallet, t, t).run();
  return getPlayer(env, wallet);
}

function getPlayer(env, wallet) {
  return env.DB.prepare('SELECT * FROM players WHERE wallet = ?').bind(wallet).first();
}

function countMonks(env, wallet) {
  return env.DB.prepare('SELECT COUNT(*) AS n FROM monks WHERE wallet = ?')
    .bind(wallet).first().then((r) => (r ? r.n : 0));
}

/**
 * The streak a given day belongs to, counting today as part of the run you
 * are building. Today's multiplier is therefore fixed the moment you wake up
 * and does not change between your first and third office — on your seventh
 * consecutive day all three offices pay 1.5x, not just the last one.
 */
function streakForDay(player, day) {
  if (player.last_full_day === day) return player.streak;
  if (player.last_full_day === day - 1) return player.streak + 1;
  return 1;
}

/**
 * Credit devotion once and once only.
 *
 * `uniq` is the idempotency key. The INSERT either takes (first time) or is
 * ignored (replay), and only a fresh insert moves the counter — so a retried
 * request, a re-ingested X batch and a re-scanned block range are all safe.
 * Two concurrent callers race on the INSERT, and exactly one wins.
 */
async function credit(env, { wallet, kind, detail, base, multBp, uniq, day }) {
  const amount = Math.floor((base * multBp) / 10000);
  const t = now();
  const row = await env.DB.prepare(
    `INSERT INTO events (uniq, wallet, kind, detail, base, mult_bp, amount, day, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(uniq) DO NOTHING
     RETURNING id`,
  ).bind(uniq, wallet, kind, detail || null, base, multBp, amount, day, t).first();

  if (!row) return { credited: false, amount: 0 };

  const refDelta = kind === 'referral' ? amount : 0;
  await env.DB.prepare(
    `UPDATE players SET devotion = devotion + ?, ref_bonus = ref_bonus + ?, updated_at = ?
     WHERE wallet = ?`,
  ).bind(amount, refDelta, t, wallet).run();

  return { credited: true, amount, multBp };
}

/** A monk's live devotion, given its row and its holder's cumulative counter. */
const monkDevotion = (m, holderDevotion) => m.accrued + (holderDevotion - m.bind_mark);

/* ───────────────────────────── chain syncing ───────────────────────────── */

const TOPIC_TRANSFER = keccakHex('Transfer(address,address,uint256)');
const TOPIC_REFERRAL = keccakHex('Referral(address,address,uint256)');

/** Most public RPCs cap `eth_getLogs` at 1,000 blocks. Stay under it. */
const LOG_CHUNK = 800;
/** Chunks per cron pass. At a 2s block time this is ~50x more headroom than
 *  a 5-minute tick needs, so a cold or long-stalled worker catches up fast. */
const MAX_CHUNKS = 12;

async function rpc(env, method, params) {
  const res = await fetch(env.READ_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`rpc ${method} http ${res.status}`);
  const out = await res.json();
  if (out.error) throw new Error(`rpc ${method}: ${out.error.message}`);
  return out.result;
}

function getMeta(env, k) {
  return env.DB.prepare('SELECT v FROM meta WHERE k = ?').bind(k).first()
    .then((r) => (r ? r.v : null));
}
function setMeta(env, k, v) {
  return env.DB.prepare(
    'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  ).bind(k, String(v)).run();
}

const addrFromTopic = (topic) => '0x' + topic.slice(-40);
const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Move a monk between wallets, settling what it earned under the old holder
 * and re-watermarking it against the new one. This is the ONLY place the
 * monks table is written, which is why holding 20 monks costs nothing extra
 * on the earning path.
 */
async function moveMonk(env, tokenId, to) {
  const t = now();
  await ensurePlayer(env, to);
  const [monk, toPlayer] = await Promise.all([
    env.DB.prepare('SELECT * FROM monks WHERE token_id = ?').bind(tokenId).first(),
    getPlayer(env, to),
  ]);
  const toDevotion = toPlayer ? toPlayer.devotion : 0;

  if (!monk) {
    await env.DB.prepare(
      'INSERT INTO monks (token_id, wallet, bind_mark, accrued, updated_at) VALUES (?, ?, ?, 0, ?)',
    ).bind(tokenId, to, toDevotion, t).run();
    return;
  }
  if (monk.wallet === to) return;

  const from = await getPlayer(env, monk.wallet);
  const earnedHere = Math.max(0, (from ? from.devotion : 0) - monk.bind_mark);
  await env.DB.prepare(
    'UPDATE monks SET wallet = ?, bind_mark = ?, accrued = accrued + ?, updated_at = ? WHERE token_id = ?',
  ).bind(to, toDevotion, earnedHere, t, tokenId).run();
}

/**
 * Replay Transfer + Referral logs from the last synced block. Both topics come
 * back in one `eth_getLogs` call, already ordered by block and log index, so
 * a mint, a sale and a referral in the same block apply in the order they
 * happened on chain.
 */
async function syncChain(env) {
  if (!env.CONTRACT_ADDRESS || !env.READ_RPC) return { skipped: 'not configured' };

  const head = parseInt(await rpc(env, 'eth_blockNumber', []), 16);
  const stored = await getMeta(env, 'last_block');
  let from = stored ? parseInt(stored, 10) + 1 : parseInt(env.START_BLOCK || '0', 10);
  if (from > head) return { head, scanned: 0, logs: 0 };

  let logsSeen = 0, chunks = 0;
  while (from <= head && chunks < MAX_CHUNKS) {
    const to = Math.min(head, from + LOG_CHUNK - 1);
    const logs = await rpc(env, 'eth_getLogs', [{
      address: env.CONTRACT_ADDRESS,
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
      topics: [[TOPIC_TRANSFER, TOPIC_REFERRAL]],
    }]);

    for (const log of logs) {
      if (log.topics[0] === TOPIC_TRANSFER) {
        const owner = norm(addrFromTopic(log.topics[2]));
        const tokenId = parseInt(log.topics[3], 16);
        if (owner === ZERO) {
          // Burn: settle it where it stands and leave it out of the tally.
          await env.DB.prepare('DELETE FROM monks WHERE token_id = ?').bind(tokenId).run();
        } else {
          await moveMonk(env, tokenId, owner);
        }
      } else {
        const referrer = norm(addrFromTopic(log.topics[1]));
        const minter = norm(addrFromTopic(log.topics[2]));
        const quantity = parseInt(log.data, 16) || 0;
        if (referrer !== ZERO && quantity > 0) {
          await ensurePlayer(env, referrer);
          await credit(env, {
            wallet: referrer,
            kind: 'referral',
            detail: `${quantity} via ${minter}`,
            base: REFERRAL_DEVOTION * quantity,
            multBp: 10000,
            uniq: `ref:${log.transactionHash}:${log.logIndex}`,
            day: Math.max(0, gameDay(env)),
          });
        }
      }
      logsSeen++;
    }

    await setMeta(env, 'last_block', to);
    from = to + 1;
    chunks++;
  }
  await setMeta(env, 'last_sync', now());
  return { head, syncedTo: from - 1, logs: logsSeen, caughtUp: from > head };
}

/* ──────────────────────────────── routes ──────────────────────────────── */

/** GET /state?wallet=0x… — everything the HUD draws, in one call. */
async function routeState(env, url) {
  const q = url.searchParams.get('wallet');
  const wallet = isAddress(q) ? norm(q) : null;
  const clock = dayState(env);

  const out = {
    clock,
    rules: {
      taskDevotion: TASK_DEVOTION,
      tasks: Object.keys(TASKS),
      xDevotion: X_DEVOTION,
      referralDevotion: REFERRAL_DEVOTION,
      streakTiers: STREAK_TIERS.map(([days, bp]) => ({ days, multiplier: bp / 10000 })),
      maxPerWallet: 20,
      mintPrice: '0.01',
    },
  };
  if (!wallet) return json(out);

  const player = await getPlayer(env, wallet);
  if (!player) {
    out.player = {
      wallet, ...progressFor(0), streak: 0, bestStreak: 0, multiplier: 1,
      tasksToday: [], tasksDone: 0, monks: 0, monkDevotion: [], xHandle: null, refBonus: 0,
    };
    return json(out);
  }

  const monks = await env.DB.prepare(
    'SELECT token_id, bind_mark, accrued FROM monks WHERE wallet = ? ORDER BY token_id',
  ).bind(wallet).all();

  const mask = player.task_day === clock.day ? player.tasks_mask : 0;
  const streak = streakForDay(player, clock.day);

  out.player = {
    wallet,
    ...progressFor(player.devotion),
    streak: player.streak,
    pendingStreak: streak,
    bestStreak: player.best_streak,
    multiplier: multiplierFor(streak) / 10000,
    tasksToday: Object.keys(TASKS).filter((t) => mask & TASKS[t]),
    tasksDone: Object.keys(TASKS).filter((t) => mask & TASKS[t]).length,
    monks: monks.results.length,
    monkDevotion: monks.results.map((m) => ({
      tokenId: m.token_id,
      devotion: monkDevotion(m, player.devotion),
    })),
    xHandle: player.x_handle,
    xPending: player.x_pending,
    refBonus: player.ref_bonus,
  };
  return json(out);
}

/** POST /auth/nonce { wallet } */
async function routeNonce(env, body) {
  if (!isAddress(body.wallet)) return fail('bad wallet');
  const wallet = norm(body.wallet);
  const ts = now();
  return json({ message: await signInMessage(env, wallet, ts), issuedAt: ts });
}

/** POST /auth/verify { wallet, issuedAt, signature } */
async function routeVerify(env, body) {
  const { wallet: raw, issuedAt, signature } = body;
  if (!isAddress(raw) || !issuedAt || !signature) return fail('missing fields');
  const wallet = norm(raw);
  const ts = parseInt(issuedAt, 10);
  if (!Number.isFinite(ts) || Math.abs(now() - ts) > NONCE_TTL) return fail('nonce expired', 401);

  let signer;
  try {
    signer = norm(recoverSigner(await signInMessage(env, wallet, ts), signature));
  } catch {
    return fail('bad signature', 401);
  }
  if (signer !== wallet) return fail('signature does not match wallet', 401);

  await ensurePlayer(env, wallet);
  return json({ token: await issueSession(env, wallet), wallet });
}

/**
 * POST /task { task } — an office in the abbey. Ten devotion, once per day
 * per office, multiplied by today's streak tier.
 */
async function routeTask(env, wallet, body) {
  const task = String(body.task || '').toLowerCase();
  const bit = TASKS[task];
  if (!bit) return fail('unknown office');

  const clock = dayState(env);
  if (!clock.started) return fail('the abbey has not opened', 403);
  if (clock.ended) return fail('the abbey is closed', 403);

  const held = await countMonks(env, wallet);
  if (held === 0) return fail('you must hold a monk to keep the offices', 403);

  const t = now();
  // One atomic statement does the day-rollover and the claim: the mask resets
  // if it belongs to an earlier day, and the WHERE clause rejects a repeat.
  const claim = await env.DB.prepare(
    `UPDATE players
        SET tasks_mask = (CASE WHEN task_day = ?1 THEN tasks_mask ELSE 0 END) | ?2,
            task_day = ?1,
            updated_at = ?3
      WHERE wallet = ?4
        AND (task_day IS NOT ?1 OR (tasks_mask & ?2) = 0)`,
  ).bind(clock.day, bit, t, wallet).run();

  if (!claim.meta.changes) return fail('that office is already kept today', 409);

  let player = await getPlayer(env, wallet);
  const streak = streakForDay(player, clock.day);

  // Completing all three offices is what advances the streak.
  if (player.tasks_mask === ALL_TASKS && player.last_full_day !== clock.day) {
    await env.DB.prepare(
      `UPDATE players SET streak = ?, best_streak = MAX(best_streak, ?), last_full_day = ?, updated_at = ?
        WHERE wallet = ?`,
    ).bind(streak, streak, clock.day, t, wallet).run();
  }

  const multBp = multiplierFor(streak);
  const result = await credit(env, {
    wallet, kind: 'task', detail: task,
    base: TASK_DEVOTION, multBp,
    uniq: `task:${wallet}:${clock.day}:${task}`,
    day: clock.day,
  });

  player = await getPlayer(env, wallet);
  return json({
    ok: true,
    task,
    gained: result.amount,
    multiplier: multBp / 10000,
    streak: player.streak,
    dayComplete: player.tasks_mask === ALL_TASKS,
    tasksToday: Object.keys(TASKS).filter((k) => player.tasks_mask & TASKS[k]),
    ...progressFor(player.devotion),
  });
}

/**
 * POST /x/link { handle } — claim an X handle.
 *
 * Verification is free and needs no X API key on our side: we hand back a
 * code, the player posts it as a reply to the Monk account, and the next
 * ingest batch that carries a reply from that handle containing the code
 * confirms the link. Admins can also confirm one by hand.
 */
async function routeXLink(env, wallet, body) {
  const handle = String(body.handle || '').replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) return fail('bad handle');

  const taken = await env.DB.prepare(
    'SELECT wallet FROM players WHERE x_handle = ? AND wallet != ?',
  ).bind(handle, wallet).first();
  if (taken) return fail('that handle is already linked to another wallet', 409);

  const code = 'MONK-' + (await hmac(env.SESSION_SECRET, `xcode:${wallet}:${handle}`))
    .slice(0, 6).toUpperCase();
  await env.DB.prepare(
    'UPDATE players SET x_pending = ?, x_code = ?, updated_at = ? WHERE wallet = ?',
  ).bind(handle, code, now(), wallet).run();

  return json({
    ok: true, handle, code,
    instructions: `Reply to any Monk post with ${code} — the link confirms on the next sweep.`,
  });
}

/** GET /leaderboard?by=wallet|monk&limit=100 — cached at the edge for a minute. */
async function routeLeaderboard(env, url) {
  const by = url.searchParams.get('by') === 'monk' ? 'monk' : 'wallet';
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10)));

  if (by === 'wallet') {
    const rows = await env.DB.prepare(
      `SELECT p.wallet, p.devotion, p.streak, p.best_streak,
              (SELECT COUNT(*) FROM monks m WHERE m.wallet = p.wallet) AS monks
         FROM players p
        WHERE p.devotion > 0
        ORDER BY p.devotion DESC, p.wallet ASC
        LIMIT ?`,
    ).bind(limit).all();
    return json({
      by,
      entries: rows.results.map((r, i) => ({
        rank: i + 1, wallet: r.wallet, devotion: r.devotion,
        streak: r.streak, bestStreak: r.best_streak, monks: r.monks,
        ...progressFor(r.devotion),
      })),
    });
  }

  // Per-monk: the watermark maths lives in SQL so we never load every token.
  const rows = await env.DB.prepare(
    `SELECT m.token_id, m.wallet, (m.accrued + p.devotion - m.bind_mark) AS devotion
       FROM monks m JOIN players p ON p.wallet = m.wallet
      ORDER BY devotion DESC, m.token_id ASC
      LIMIT ?`,
  ).bind(limit).all();
  return json({
    by,
    entries: rows.results.map((r, i) => ({
      rank: i + 1, tokenId: r.token_id, wallet: r.wallet, devotion: r.devotion,
    })),
  });
}

/** GET /monk/:id — one monk's standing, for marketplace listings. */
async function routeMonk(env, tokenId) {
  const row = await env.DB.prepare(
    `SELECT m.token_id, m.wallet, (m.accrued + p.devotion - m.bind_mark) AS devotion
       FROM monks m JOIN players p ON p.wallet = m.wallet
      WHERE m.token_id = ?`,
  ).bind(tokenId).first();
  if (!row) return fail('unknown monk', 404);
  return json({ tokenId: row.token_id, wallet: row.wallet, devotion: row.devotion });
}

/**
 * POST /admin/x/ingest { events: [{ handle, tweetId, action, text?, at? }] }
 *
 * The one endpoint that needs feeding from outside — by a scheduled script
 * holding X credentials, or by hand. Keeping X out of the Worker is what
 * keeps the Worker free: no API tier, no token refresh, no rate-limit budget.
 */
async function routeXIngest(env, body) {
  const events = Array.isArray(body.events) ? body.events : [];
  if (!events.length) return fail('no events');

  const clock = dayState(env);
  let credited = 0, skipped = 0, linked = 0, total = 0;

  for (const e of events) {
    const handle = String(e.handle || '').replace(/^@/, '').toLowerCase();
    const action = String(e.action || '').toLowerCase();
    const tweetId = String(e.tweetId || '').replace(/[^0-9a-zA-Z_-]/g, '');
    const base = X_DEVOTION[action];
    if (!handle || !tweetId || !base) { skipped++; continue; }

    // A reply carrying a pending code confirms the wallet↔handle link.
    if (e.text) {
      const pending = await env.DB.prepare(
        'SELECT wallet, x_code FROM players WHERE x_pending = ? AND x_handle IS NULL',
      ).bind(handle).first();
      if (pending && String(e.text).toUpperCase().includes(pending.x_code)) {
        await env.DB.prepare(
          'UPDATE players SET x_handle = ?, x_pending = NULL, x_code = NULL, updated_at = ? WHERE wallet = ?',
        ).bind(handle, now(), pending.wallet).run();
        linked++;
      }
    }

    const player = await env.DB.prepare('SELECT * FROM players WHERE x_handle = ?')
      .bind(handle).first();
    if (!player) { skipped++; continue; }

    const at = e.at ? parseInt(e.at, 10) : now();
    const day = Math.max(0, Math.min(GAME_DAYS - 1, gameDay(env, at)));
    if (!clock.started || clock.ended) { skipped++; continue; }

    const res = await credit(env, {
      wallet: player.wallet, kind: 'x', detail: `${action} ${tweetId}`,
      base, multBp: multiplierFor(streakForDay(player, clock.day)),
      uniq: `x:${tweetId}:${action}:${handle}`,
      day,
    });
    if (res.credited) { credited++; total += res.amount; } else { skipped++; }
  }
  return json({ ok: true, credited, skipped, linked, devotion: total });
}

/** POST /admin/x/verify { wallet, handle } — confirm a link by hand. */
async function routeXVerify(env, body) {
  if (!isAddress(body.wallet)) return fail('bad wallet');
  const handle = String(body.handle || '').replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(handle)) return fail('bad handle');
  await env.DB.prepare(
    'UPDATE players SET x_handle = ?, x_pending = NULL, x_code = NULL, updated_at = ? WHERE wallet = ?',
  ).bind(handle, now(), norm(body.wallet)).run();
  return json({ ok: true, wallet: norm(body.wallet), handle });
}

/** GET /admin/stats — is the abbey healthy? */
async function routeStats(env) {
  const [players, monks, events, lastBlock, lastSync] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n, SUM(devotion) AS d FROM players').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM monks').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM events').first(),
    getMeta(env, 'last_block'),
    getMeta(env, 'last_sync'),
  ]);
  return json({
    clock: dayState(env),
    players: players.n, devotion: players.d || 0,
    monks: monks.n, events: events.n,
    lastBlock: lastBlock ? parseInt(lastBlock, 10) : null,
    lastSync: lastSync ? parseInt(lastSync, 10) : null,
  });
}

/* ───────────────────────────────── entry ───────────────────────────────── */

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let body = {};
    if (request.method === 'POST') {
      try { body = await request.json(); } catch { body = {}; }
    }

    try {
      // ── public reads ──
      if (path === '/' || path === '/state') return routeState(env, url);
      if (path === '/leaderboard') {
        const cache = caches.default;
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await routeLeaderboard(env, url);
        const cached = new Response(res.body, res);
        cached.headers.set('Cache-Control', 'public, max-age=60');
        ctx.waitUntil(cache.put(request, cached.clone()));
        return cached;
      }
      if (path.startsWith('/monk/')) {
        const id = parseInt(path.slice(6), 10);
        return Number.isFinite(id) ? routeMonk(env, id) : fail('bad token id');
      }

      // ── sign-in ──
      if (path === '/auth/nonce' && request.method === 'POST') return routeNonce(env, body);
      if (path === '/auth/verify' && request.method === 'POST') return routeVerify(env, body);

      // ── admin ──
      if (path.startsWith('/admin/')) {
        if (!isAdmin(env, request)) return fail('unauthorized', 401);
        if (path === '/admin/x/ingest') return routeXIngest(env, body);
        if (path === '/admin/x/verify') return routeXVerify(env, body);
        if (path === '/admin/sync') return json(await syncChain(env));
        if (path === '/admin/stats') return routeStats(env);
        return fail('not found', 404);
      }

      // ── signed-in player ──
      const wallet = await readSession(env, request);
      if (!wallet) return fail('sign in first', 401);
      if (path === '/task' && request.method === 'POST') return routeTask(env, wallet, body);
      if (path === '/x/link' && request.method === 'POST') return routeXLink(env, wallet, body);
      if (path === '/me') return routeState(env, new URL(`${url.origin}/state?wallet=${wallet}`));

      return fail('not found', 404);
    } catch (err) {
      return fail(`abbey error: ${err.message}`, 500);
    }
  },

  /** Cron: the only thing that watches the chain. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncChain(env).catch((e) => console.error('sync failed', e.message)));
  },
};

export { levelFor, levelFloor, multiplierFor, streakForDay, progressFor, recoverSigner, rankFor };

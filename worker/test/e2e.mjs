/**
 * End-to-end smoke test against a running `wrangler dev`.
 *
 *   npx wrangler d1 execute monk --local --file=./schema.sql
 *   npx wrangler dev --port 8787 --local --var GAME_START:$(( $(date +%s) - 259200 ))
 *   node test/e2e.mjs
 *
 * Walks a wallet through the whole loop: sign in, keep the three offices,
 * fail to keep them twice, link an X handle, get credited for engagement,
 * and confirm that a monk minted mid-game picks up the streak immediately
 * without collecting anything backwards.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { DatabaseSync } from 'node:sqlite';
import { globSync } from 'node:fs';

const BASE = process.env.MONK_URL || 'http://localhost:8787';
const ADMIN = process.env.ADMIN_KEY || 'local-admin-key';

const hex = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const priv = (seed) => keccak_256(new TextEncoder().encode(seed));
const addressFor = (p) => '0x' + hex(keccak_256(secp256k1.getPublicKey(p, false).slice(1))).slice(-40);

function personalSign(p, message) {
  const msg = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const payload = new Uint8Array(prefix.length + msg.length);
  payload.set(prefix, 0);
  payload.set(msg, prefix.length);
  const sig = secp256k1.sign(keccak_256(payload), p);
  return hex(new Uint8Array([...sig.toCompactRawBytes(), sig.recovery + 27]));
}

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Stand in for the chain sync by writing to miniflare's D1 file directly.
 * Shelling out to `wrangler d1 execute --local` would work too, but it makes
 * the running dev server reload and drop in-flight connections mid-test.
 */
const D1_FILE = globSync('.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite')[0];
if (!D1_FILE) throw new Error('no local D1 file — run the schema step first');
const db = new DatabaseSync(D1_FILE);
const sql = (statement) => db.exec(statement);

/** Exactly what recordMint() does when the cron sees a mint log. */
function mintMonk(tokenId, wallet) {
  sql(`INSERT INTO players (wallet, created_at, updated_at) VALUES ('${wallet}',0,0)
       ON CONFLICT(wallet) DO NOTHING`);
  sql(`INSERT INTO monks (token_id, wallet, bind_mark, minted_at)
       SELECT ${tokenId}, '${wallet}', devotion, 0 FROM players WHERE wallet='${wallet}'`);
  sql(`UPDATE players
          SET monk_count = monk_count + 1,
              bind_sum = bind_sum + (SELECT bind_mark FROM monks WHERE token_id=${tokenId})
        WHERE wallet='${wallet}'`);
}

let failures = 0;
function check(label, cond, detail) {
  const mark = cond ? 'ok  ' : 'FAIL';
  if (!cond) failures++;
  console.log(`${mark} ${label}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}

async function signIn(seed) {
  const p = priv(seed);
  const wallet = addressFor(p);
  const { body: n } = await api('/auth/nonce', { method: 'POST', body: { wallet } });
  const { status, body } = await api('/auth/verify', {
    method: 'POST',
    body: { wallet, issuedAt: n.issuedAt, signature: personalSign(p, n.message) },
  });
  if (status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(body)}`);
  return { wallet, token: body.token };
}

const alice = await signIn('alice the devout');
const bob = await signIn('bob the buyer');
check('wallet signs in', !!alice.token);

// A forged signature must not get a session.
{
  const { body: n } = await api('/auth/nonce', { method: 'POST', body: { wallet: alice.wallet } });
  const { status } = await api('/auth/verify', {
    method: 'POST',
    body: { wallet: alice.wallet, issuedAt: n.issuedAt, signature: personalSign(priv('mallory'), n.message) },
  });
  check('a signature from the wrong key is rejected', status === 401, status);
}

// Tasks are gated on holding a monk.
{
  const { status } = await api('/task', { method: 'POST', token: alice.token, body: { task: 'pray' } });
  check('no monk, no offices', status === 403, status);
}

// Give alice two monks and bob none (standing in for the chain sync).
mintMonk(1, alice.wallet);
mintMonk(2, alice.wallet);

let last;
for (const task of ['confess', 'pray', 'candles']) {
  const { status, body } = await api('/task', { method: 'POST', token: alice.token, body: { task } });
  check(`office kept: ${task}`, status === 200 && body.gained === 10, body);
  last = body;
}
check('three offices complete the day', last.dayComplete === true, last);
check('30 devotion for a full day', last.devotion === 30, last.devotion);
check('two monks make the day worth 60', last.total === 60, last.total);
check('a full day is level 2', last.level === 2 && last.rank === 'Novice', last);
check('streak advanced to 1', last.streak === 1, last.streak);

{
  const { status } = await api('/task', { method: 'POST', token: alice.token, body: { task: 'pray' } });
  check('an office cannot be kept twice in a day', status === 409, status);
}
{
  const { status } = await api('/task', { method: 'POST', token: alice.token, body: { task: 'sing' } });
  check('unknown offices are refused', status === 400, status);
}

// X linking, then engagement credited through the ingest path.
{
  const { body } = await api('/x/link', { method: 'POST', token: alice.token, body: { handle: '@Alice_x' } });
  check('X link issues a code', /^MONK-[A-F0-9]{6}$/.test(body.code), body);

  const r1 = await api('/admin/x/ingest', {
    method: 'POST', token: ADMIN,
    body: { events: [{ handle: 'alice_x', tweetId: '111', action: 'comment', text: `amen ${body.code}` }] },
  });
  check('the verifying reply links the handle and pays', r1.body.linked === 1 && r1.body.credited === 1, r1.body);

  const r2 = await api('/admin/x/ingest', {
    method: 'POST', token: ADMIN,
    body: { events: [
      { handle: 'alice_x', tweetId: '111', action: 'comment' },   // replay
      { handle: 'alice_x', tweetId: '111', action: 'retweet' },
      { handle: 'alice_x', tweetId: '111', action: 'like' },
    ] },
  });
  check('a replayed X action pays nothing', r2.body.skipped === 1, r2.body);
  check('retweet + like pay 5 + 2', r2.body.devotion === 7, r2.body);
}

{
  const { status } = await api('/admin/x/ingest', { method: 'POST', body: { events: [] } });
  check('admin routes need the key', status === 401, status);
}

// 30 offices + 3 comment + 5 retweet + 2 like = 40
const { body: state } = await api(`/state?wallet=${alice.wallet}`);
check('devotion totals 40', state.player.devotion === 40, state.player.devotion);
check('both monks are counted', state.player.monks === 2, state.player.monks);
check('each monk earns the full wallet devotion',
  state.player.monkDevotion.every((m) => m.devotion === 40), state.player.monkDevotion);

// ── minting mid-game ──
// A monk minted now must pick up the streak IMMEDIATELY, but must not
// collect anything the wallet earned before it existed. This is the whole
// reason monks are soulbound rather than tradeable.
{
  mintMonk(3, alice.wallet);

  const { body: s } = await api(`/state?wallet=${alice.wallet}`);
  check('the new monk is counted', s.player.monks === 3, s.player.monks);
  check('minting adds nothing backwards', s.player.total === 80, s.player.total);

  const { body: m3 } = await api('/monk/3');
  check('a freshly minted monk starts at zero', m3.devotion === 0, m3);

  // Everything earned from here is worth 3x what one monk would earn.
  sql(`UPDATE players SET devotion = devotion + 100 WHERE wallet='${alice.wallet}'`);
  const { body: after } = await api(`/state?wallet=${alice.wallet}`);
  check('the new monk earns at the full rate at once', after.player.total === 380, after.player.total);

  const { body: m1 } = await api('/monk/1');
  const { body: m3b } = await api('/monk/3');
  check('the old monk holds its full history', m1.devotion === 140, m1);
  check('the new monk holds only what came after it', m3b.devotion === 100, m3b);
  check('the derived total equals the sum of its monks',
    after.player.total === after.player.monkDevotion.reduce((a, m) => a + m.devotion, 0),
    { total: after.player.total, monks: after.player.monkDevotion });
}

// A monk cannot be moved — nothing in the API exposes a transfer, and the
// contract reverts on one. Bob, who minted nothing, stays empty.
{
  const { body: b } = await api(`/state?wallet=${bob.wallet}`);
  check('a wallet that never minted holds nothing', b.player.monks === 0 && b.player.total === 0, b.player);
  const { status } = await api('/task', { method: 'POST', token: bob.token, body: { task: 'pray' } });
  check('and still cannot keep the offices', status === 403, status);
}

// Leaderboards.
{
  const { body } = await api('/leaderboard?by=total');
  check('total leaderboard ranks alice first', body.entries[0].wallet === alice.wallet, body.entries[0]);
  check('total leaderboard reports the multiplied score', body.entries[0].total === 380, body.entries[0]);
  const { body: pr } = await api('/leaderboard?by=practice');
  check('practice leaderboard reports the per-monk rate', pr.entries[0].devotion === 140, pr.entries[0]);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

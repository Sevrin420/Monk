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
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    // wrangler serves an HTML error page while it is reloading — say so
    // plainly rather than dying on a JSON parse error 40 frames deep
    throw new Error(`${method} ${path} returned ${res.status}, not JSON:\n`
      + text.slice(0, 300));
  }
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
  sql(`INSERT INTO monks (token_id, wallet, minted_at) VALUES (${tokenId}, '${wallet}', 0)`);
  sql(`UPDATE players SET monk_count = monk_count + 1 WHERE wallet='${wallet}'`);
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
const levelUps = [];
for (const task of ['confess', 'pray', 'candles']) {
  const { status, body } = await api('/task', { method: 'POST', token: alice.token, body: { task } });
  // two monks held, so each office pays 10 x 2
  check(`office kept: ${task} pays 20 with two monks`, status === 200 && body.gained === 20, body);
  check(`  and reports 10 per monk`, body.perMonk === 10, body.perMonk);
  if (body.levelledUp) levelUps.push(body.level);
  last = body;
}
check('three offices complete the day', last.dayComplete === true, last);
check('a full day with two monks is 60 devotion', last.devotion === 60, last.devotion);
// level 2 starts at 30 devotion, so the bar fills during the second office
check('the bar filled and levelled once on the way', levelUps.length === 1 && levelUps[0] === 2, levelUps);
check('60 devotion sits inside level 2', last.level === 2 && last.intoLevel === 30, last);
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
  // X does NOT scale with monks: a repost is one repost, so 5 + 2 flat
  check('retweet + like pay 5 + 2 flat, not per monk', r2.body.devotion === 7, r2.body);
}

{
  const { status } = await api('/admin/x/ingest', { method: 'POST', body: { events: [] } });
  check('admin routes need the key', status === 401, status);
}

// offices scale with monks, X does not:
//   3 offices x 10 x 2 monks = 60, plus comment 3 + retweet 5 + like 2 = 10
const { body: state } = await api(`/state?wallet=${alice.wallet}`);
check('devotion is one number, totalling 70', state.player.devotion === 70, state.player.devotion);
check('both monks are counted', state.player.monks === 2, state.player.monks);
check('the token ids are listed', JSON.stringify(state.player.tokens) === '[1,2]', state.player.tokens);
check('the next office is priced with monks included',
  state.player.perOffice === 20, state.player.perOffice);

// ── minting mid-game ──
// A new monk must raise what EVERY LATER office pays, and change nothing
// about the devotion already banked.
{
  mintMonk(3, alice.wallet);
  mintMonk(4, alice.wallet);

  const { body: s } = await api(`/state?wallet=${alice.wallet}`);
  check('the new monks are counted', s.player.monks === 4, s.player.monks);
  check('minting adds nothing backwards', s.player.devotion === 70, s.player.devotion);
  check('but the next office is now worth twice as much',
    s.player.perOffice === 40, s.player.perOffice);

  // Alice has kept all three offices today, so she cannot demonstrate the new
  // rate until tomorrow — and winding her day back would only prove the
  // idempotency key stops a replay. A fresh wallet holding four shows it now.
  const carol = await signIn('carol with four habits');
  for (const id of [5, 6, 7, 8]) mintMonk(id, carol.wallet);

  const { body: t } = await api('/task', { method: 'POST', token: carol.token, body: { task: 'pray' } });
  check('an office with four monks pays 40', t.gained === 40, t.gained);
  check('  still 10 per monk', t.perMonk === 10, t.perMonk);
  check('  and lands as one number', t.devotion === 40, t.devotion);
}

// The idempotency key is what really stops a replayed day, not the task mask.
{
  sql(`UPDATE players SET tasks_mask = 0 WHERE wallet='${alice.wallet}'`);
  const { status, body } = await api('/task', { method: 'POST', token: alice.token, body: { task: 'pray' } });
  check('an office already paid today cannot be re-earned by clearing the mask',
    body.gained === 0 || status !== 200, { status, gained: body.gained });
  const { body: s } = await api(`/state?wallet=${alice.wallet}`);
  check('  and devotion did not move', s.player.devotion === 70, s.player.devotion);
}

// A monk cannot be moved — nothing in the API exposes a transfer, and the
// contract reverts on one. Bob, who minted nothing, stays empty.
{
  const { body: b } = await api(`/state?wallet=${bob.wallet}`);
  check('a wallet that never minted holds nothing',
    b.player.monks === 0 && b.player.devotion === 0, b.player);
  const { status } = await api('/task', { method: 'POST', token: bob.token, body: { task: 'pray' } });
  check('and still cannot keep the offices', status === 403, status);
}

// One leaderboard, on the one score.
{
  const { body } = await api('/leaderboard');
  check('leaderboard ranks alice first', body.entries[0].wallet === alice.wallet, body.entries[0]);
  check('leaderboard reports the one score and monks held',
    body.entries[0].devotion === 70 && body.entries[0].monks === 4, body.entries[0]);
  check('and carol is behind her on 40',
    body.entries[1] && body.entries[1].devotion === 40, body.entries[1]);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

/**
 * End-to-end smoke test against a running `wrangler dev`.
 *
 *   npx wrangler d1 execute monk --local --file=./schema.sql
 *   npx wrangler dev --port 8787 --local --var GAME_START:$(( $(date +%s) - 259200 ))
 *   node test/e2e.mjs
 *
 * Walks a wallet through the whole loop: sign in, keep the three offices,
 * fail to keep them twice, link an X handle, get credited for engagement,
 * and confirm the per-monk watermark survives a transfer.
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
sql(`INSERT INTO monks (token_id, wallet, bind_mark, accrued, updated_at)
     VALUES (1,'${alice.wallet}',0,0,0),(2,'${alice.wallet}',0,0,0)`);

let last;
for (const task of ['confess', 'pray', 'candles']) {
  const { status, body } = await api('/task', { method: 'POST', token: alice.token, body: { task } });
  check(`office kept: ${task}`, status === 200 && body.gained === 10, body);
  last = body;
}
check('three offices complete the day', last.dayComplete === true, last);
check('30 devotion for a full day', last.devotion === 30, last.devotion);
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

// The transfer path: monk #2 goes to bob, who has earned nothing yet.
// It must keep the 40 it earned under alice and earn nothing retroactively.
{
  const { body: before } = await api('/monk/2');
  check('monk 2 holds 40 before the sale', before.devotion === 40, before);

  sql(`UPDATE monks SET wallet='${bob.wallet}', accrued=accrued+40, bind_mark=0 WHERE token_id=2`);
  sql(`INSERT INTO players (wallet, created_at, updated_at) VALUES ('${bob.wallet}',0,0)
       ON CONFLICT(wallet) DO NOTHING`);

  const { body: after } = await api('/monk/2');
  check('a sold monk keeps what it earned', after.devotion === 40 && after.wallet === bob.wallet, after);

  // Alice earns more; her remaining monk gains, the sold one does not.
  sql(`UPDATE players SET devotion = devotion + 100 WHERE wallet='${alice.wallet}'`);
  const { body: m1 } = await api('/monk/1');
  const { body: m2 } = await api('/monk/2');
  check('the kept monk gains', m1.devotion === 140, m1);
  check('the sold monk does not gain from its old wallet', m2.devotion === 40, m2);
}

// Leaderboards.
{
  const { body } = await api('/leaderboard?by=wallet');
  check('wallet leaderboard ranks alice first', body.entries[0].wallet === alice.wallet, body.entries[0]);
  const { body: m } = await api('/leaderboard?by=monk');
  check('monk leaderboard ranks monk 1 first', m.entries[0].tokenId === 1, m.entries[0]);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

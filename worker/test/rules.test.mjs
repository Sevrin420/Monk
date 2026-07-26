/**
 * The parts of the Worker worth pinning down: signature recovery (a bug here
 * lets anyone sign in as anyone) and the devotion maths (a bug here silently
 * mis-scores the whole 60 days).
 *
 *   cd worker && npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

import {
  levelFor, levelFloor, multiplierFor, streakForDay, progressFor, recoverSigner, rankFor,
  payout,
} from '../monk-worker.js';

const hex = (b) => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

function addressFor(priv) {
  const pub = secp256k1.getPublicKey(priv, false).slice(1);
  return '0x' + hex(keccak_256(pub)).slice(-40);
}

/** Sign exactly the way a wallet's `personal_sign` does. */
function personalSign(priv, message) {
  const msg = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const payload = new Uint8Array(prefix.length + msg.length);
  payload.set(prefix, 0);
  payload.set(msg, prefix.length);
  const sig = secp256k1.sign(keccak_256(payload), priv);
  return hex(new Uint8Array([...sig.toCompactRawBytes(), sig.recovery + 27]));
}

test('recoverSigner returns the signing address', () => {
  const priv = keccak_256(new TextEncoder().encode('brother anselm'));
  const addr = addressFor(priv);
  const message = 'Monk Abbey — enter the cloister\n\nWallet: ' + addr;
  assert.equal(recoverSigner(message, personalSign(priv, message)).toLowerCase(), addr);
});

test('recoverSigner rejects a signature over a different message', () => {
  const priv = keccak_256(new TextEncoder().encode('brother anselm'));
  const addr = addressFor(priv);
  const sig = personalSign(priv, 'one message');
  assert.notEqual(recoverSigner('another message', sig).toLowerCase(), addr);
});

test('recoverSigner rejects malformed signatures', () => {
  assert.throws(() => recoverSigner('x', '0x1234'), /bad signature length/);
});

test('streak multipliers step at 7 / 14 / 21 / 28', () => {
  const expect = [[0, 1], [6, 1], [7, 1.5], [13, 1.5], [14, 2], [20, 2],
                  [21, 2.5], [27, 2.5], [28, 3], [56, 3]];
  for (const [streak, mult] of expect) {
    assert.equal(multiplierFor(streak) / 10000, mult, `streak ${streak}`);
  }
});

test('a full day of offices is exactly one level', () => {
  assert.equal(levelFor(0), 1);
  assert.equal(levelFor(29), 1);
  assert.equal(levelFor(30), 2);      // 3 offices x 10 devotion
  assert.equal(levelFor(90), 3);
  assert.equal(levelFloor(2), 30);
});

test('level curve never goes backwards and matches its own floors', () => {
  let prev = 1;
  for (let d = 0; d <= 20000; d += 7) {
    const l = levelFor(d);
    assert.ok(l >= prev, `level dipped at ${d}`);
    assert.ok(d >= levelFloor(l), `${d} below floor of level ${l}`);
    assert.ok(d < levelFloor(l + 1), `${d} at or above floor of level ${l + 1}`);
    prev = l;
  }
});

test('progress reports a bar that always has width', () => {
  for (const d of [0, 1, 30, 500, 3960, 12345]) {
    const p = progressFor(d);
    assert.ok(p.levelSpan > 0);
    assert.ok(p.intoLevel >= 0 && p.intoLevel < p.levelSpan);
    assert.equal(p.toNextLevel, p.levelCeil - d);
    assert.equal(p.rank, rankFor(p.level));
  }
});

test('today counts toward the run you are building', () => {
  // Nothing yet today, six days behind it: today is day seven → 1.5x all day.
  assert.equal(streakForDay({ last_full_day: 9, streak: 6 }, 10), 7);
  // Already finished today: the streak is settled, do not double-count.
  assert.equal(streakForDay({ last_full_day: 10, streak: 7 }, 10), 7);
  // Missed yesterday: the run restarts at one.
  assert.equal(streakForDay({ last_full_day: 8, streak: 20 }, 10), 1);
  // Never played.
  assert.equal(streakForDay({ last_full_day: null, streak: 0 }, 3), 1);
});

/* ── the one thing every score in the game is built from ── */

test('each monk adds a whole office to the payout', () => {
  // The rule as the player is told it: light candles with one monk = 10,
  // with two = 20, and so on.
  assert.equal(payout(10, 10000, 1), 10);
  assert.equal(payout(10, 10000, 2), 20);
  assert.equal(payout(10, 10000, 5), 50);
  assert.equal(payout(10, 10000, 20), 200);
});

test('streak and monks stack on an office', () => {
  assert.equal(payout(10, 15000, 1), 15);      // 1.5x, one monk
  assert.equal(payout(10, 15000, 2), 30);      // 1.5x, two monks
  assert.equal(payout(10, 30000, 20), 600);    // 3x, a full house
});

test('X engagement takes the streak but NOT the monk count', () => {
  // A repost is one repost however many habits you keep — the ingest path
  // always passes monks: 1, so a full wallet must not turn 5 into 100.
  assert.equal(payout(5, 10000, 1), 5);
  assert.equal(payout(5, 20000, 1), 10);       // 2x streak still applies
  assert.notEqual(payout(5, 20000, 1), payout(5, 20000, 20));
});

test('a wallet holding nothing is never paid less than one monk', () => {
  // Offices are gated on holding a monk, so this only guards against a zero
  // slipping in and silently zeroing someone's earnings.
  assert.equal(payout(10, 10000, 0), 10);
});

test('the per-monk value is rounded before multiplying, not after', () => {
  // Otherwise 3 monks at a 1.5x streak would pay a fractional amount each,
  // and the number on screen would not be a whole multiple of the office.
  const each = payout(10, 15000, 1);
  assert.equal(payout(10, 15000, 3), each * 3);
});

test('minting mid-game changes what comes next, never what came before', () => {
  // Devotion already banked is a number; raising monk_count cannot reach it.
  let devotion = 500;
  devotion += payout(10, 10000, 1);            // one monk
  assert.equal(devotion, 510);
  devotion += payout(10, 10000, 4);            // three more minted
  assert.equal(devotion, 550);                 // the 500 is untouched
});

test('a perfect 60 days lands where the curve intends', () => {
  // 6 days at 1x, then 7 each at 1.5x / 2x / 2.5x, then days 28-60 at 3x.
  // One monk, so 30 base a day.
  const run = (days) => {
    let devotion = 0;
    for (let day = 0; day < days; day++) {
      devotion += Math.floor((30 * multiplierFor(day + 1)) / 10000);
    }
    return devotion;
  };
  assert.equal(run(60), 4410);
  assert.equal(levelFor(4410), 17);

  // Abbot is reached with time to spare rather than on the final bell.
  let abbotDay = null;
  for (let d = 1; d <= 60 && abbotDay === null; d++) {
    if (rankFor(levelFor(run(d))) === 'Abbot') abbotDay = d;
  }
  assert.equal(abbotDay, 51);
});

test('holding monks fills the same bar faster', () => {
  // Four monks reach in a day what one monk needs four days for.
  const oneMonkDay = payout(10, 10000, 1) * 3;
  const fourMonkDay = payout(10, 10000, 4) * 3;
  assert.equal(fourMonkDay, oneMonkDay * 4);
  assert.equal(levelFor(fourMonkDay), levelFor(oneMonkDay * 4));
});

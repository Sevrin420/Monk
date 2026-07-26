/**
 * The parts of the Worker worth pinning down: signature recovery (a bug here
 * lets anyone sign in as anyone) and the devotion maths (a bug here silently
 * mis-scores the whole 56 days).
 *
 *   cd worker && npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

import {
  levelFor, levelFloor, multiplierFor, streakForDay, progressFor, recoverSigner, rankFor,
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

test('a perfect 56 days lands where the curve intends', () => {
  // 6 days at 1x, then 7 each at 1.5x / 2x / 2.5x, then days 28-56 at 3x.
  let devotion = 0;
  for (let day = 0; day < 56; day++) {
    const streak = day + 1;
    devotion += Math.floor((30 * multiplierFor(streak)) / 10000);
  }
  assert.equal(devotion, 4050);
  // Offices alone carry a player to Abbot's doorstep; X and referrals are
  // what push the last few levels.
  assert.equal(levelFor(devotion), 16);
  assert.equal(rankFor(levelFor(devotion)), 'Abbot');
});

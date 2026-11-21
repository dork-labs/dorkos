/** Deterministic checks for the Node half of the Windows-only transcript. */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createOwnerAttemptPeer } from '../../../src/run-custody/windows/owner-attempt.mjs';

const scopeId = '11'.repeat(16);
const attemptId = '22'.repeat(16);
const mainKey = Buffer.alloc(32, 0x33);
const workerKey = Buffer.alloc(32, 0x44);
const frame = ({
  phase = 1,
  role = 1,
  kind = 1,
  scope = scopeId,
  attempt = attemptId,
  nonce = 0x55,
  key = mainKey,
} = {}) => {
  const payload = Buffer.concat([
    Buffer.from([1, phase, role, kind]),
    Buffer.from(scope + attempt, 'hex'),
    Buffer.alloc(32, nonce),
  ]);
  return Buffer.concat([payload, createHmac('sha256', key).update(payload).digest()]);
};

const peer = (role = 'main', capability = mainKey) =>
  createOwnerAttemptPeer({ scopeId, attemptId, role, capability });

test('the two owners answer distinct roles and confirm a second fresh challenge exactly once', () => {
  for (const [name, role, key] of [
    ['main', 1, mainKey],
    ['scope', 2, workerKey],
  ]) {
    const owner = peer(name, key);
    assert.deepEqual(owner.accept(frame({ role, key })), {
      kind: 'response',
      frame: frame({ role, key, kind: 2 }),
    });
    assert.deepEqual(owner.accept(frame({ role, key, kind: 3 })), { kind: 'admitted' });
    assert.deepEqual(owner.accept(frame({ role, key, phase: 2, nonce: 0x66 })), {
      kind: 'response',
      frame: frame({ role, key, phase: 2, kind: 2, nonce: 0x66 }),
    });
    assert.deepEqual(owner.accept(frame({ role, key, phase: 2, kind: 3, nonce: 0x66 })), {
      kind: 'confirmed',
    });
    assert.throws(
      () => owner.accept(frame({ role, key, phase: 2, nonce: 0x77 })),
      /active attempt/
    );
  }
});

for (const [label, invalid] of [
  ['wrong role', frame({ role: 2 })],
  ['different scope', frame({ scope: 'aa'.repeat(16) })],
  ['stale attempt', frame({ attempt: 'bb'.repeat(16) })],
  ['wrong capability', frame({ key: workerKey })],
  ['reflected response', frame({ kind: 2 })],
  ['premature confirmation', frame({ phase: 2 })],
  ['truncated frame', frame().subarray(0, 99)],
  ['oversized frame', Buffer.concat([frame(), Buffer.alloc(1)])],
]) {
  test(`rejects ${label} and retires that peer`, () => {
    const owner = peer();
    assert.throws(() => owner.accept(invalid), /active attempt/);
    assert.throws(() => owner.accept(frame()), /active attempt/);
  });
}

test('rejects a duplicate challenge while awaiting acknowledgement', () => {
  const owner = peer();
  owner.accept(frame());
  assert.throws(() => owner.accept(frame()), /active attempt/);
  assert.throws(() => owner.accept(frame({ kind: 3 })), /active attempt/);
});

test('refuses an acknowledgement for a different nonce', () => {
  const owner = peer();
  owner.accept(frame());
  assert.throws(() => owner.accept(frame({ kind: 3, nonce: 0x66 })), /active attempt/);
});

test('refuses an already admitted nonce reused for confirmation', () => {
  const owner = peer();
  owner.accept(frame());
  owner.accept(frame({ kind: 3 }));
  assert.throws(() => owner.accept(frame({ phase: 2 })), /active attempt/);
});

test('does not accept an otherwise valid frame once the owner closes', () => {
  const owner = peer();
  owner.dispose();
  assert.throws(() => owner.accept(frame()), /active attempt/);
});

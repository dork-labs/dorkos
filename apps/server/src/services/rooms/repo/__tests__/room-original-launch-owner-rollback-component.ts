import assert from 'node:assert/strict';
import { createRoomLaunchOwnerRollback } from '../../turn/room-launch-owner-rollback.js';

/** Actual production rollback decision, with ordinary rows and no private issuer. */
export function runOriginalLaunchOwnerRollbackComponent(): void {
  const rows = new Set<string>();
  const persisted: string[] = [];
  const forgotten: string[] = [];
  const refused = createRoomLaunchOwnerRollback();
  if (refused.take()) forgotten.push('not-started');
  assert.deepEqual([...persisted], []);
  assert.deepEqual([...forgotten], []);
  const failure = new Error('runtime is down');
  const minted = createRoomLaunchOwnerRollback();
  let caught: unknown;
  try {
    rows.add('minted');
    persisted.push('minted');
    minted.record(true, true);
    throw failure;
  } catch (cause) {
    caught = cause;
    if (minted.take()) {
      rows.delete('minted');
      forgotten.push('minted');
    }
  }
  assert.equal(caught, failure);
  assert.deepEqual(forgotten, ['minted']);
  assert.equal(rows.has('minted'), false);
  assert.equal(minted.take(), false);
  const conversation = createRoomLaunchOwnerRollback();
  rows.add('room-held');
  persisted.push('room-held');
  conversation.record(true, false);
  try {
    throw failure;
  } catch (cause) {
    assert.equal(cause, failure);
    if (conversation.take()) {
      rows.delete('room-held');
      forgotten.push('room-held');
    }
  }
  assert.equal(rows.has('room-held'), true);
  assert.deepEqual(forgotten, ['minted']);
}

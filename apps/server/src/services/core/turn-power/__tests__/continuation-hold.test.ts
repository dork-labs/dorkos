/**
 * Whether a chat's latest turn was held, kept on its row (DOR-3037): written
 * by every turn, read by every turn that picks the chat up on its own, held
 * when nothing is recorded, and read the same after a restart.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  ceilingForContinuation,
  lastTurnHeld,
  noteTurnHold,
  setContinuationHoldDb,
} from '../continuation-hold.js';

afterEach(() => setContinuationHoldDb(undefined));

describe('the continuation hold', () => {
  it('reads as held when nothing is recorded, or with no database', () => {
    expect(lastTurnHeld('never-ran')).toBe(true);
    setContinuationHoldDb(createTestDb());
    expect(ceilingForContinuation('never-ran')).toEqual({ permissionCeiling: 'runtime-default' });
  });

  it('follows the latest turn, and survives a restart', () => {
    const db = createTestDb();
    setContinuationHoldDb(db);
    noteTurnHold('chat-1', true);
    noteTurnHold('chat-2', false);
    // A new process: the same rows, nothing in memory.
    setContinuationHoldDb(db);
    expect(lastTurnHeld('chat-1')).toBe(true);
    expect(ceilingForContinuation('chat-2')).toEqual({});
    noteTurnHold('chat-1', false);
    setContinuationHoldDb(db);
    expect(lastTurnHeld('chat-1')).toBe(false);
  });
});

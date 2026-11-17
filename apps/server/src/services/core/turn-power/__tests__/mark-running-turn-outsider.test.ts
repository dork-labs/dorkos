/**
 * Marking a running turn as one that read outside text (DOR-3969) keeps it after a restart: the
 * chat's stored hold and its bridged-sender record say so, so a turn that picks the chat up on its
 * own (an approval's answer, a resume) is held, and the chat hands on outside words. A chat with no
 * recorded turn is still marked, through the outside-words note.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import {
  bridgedSenderVouched,
  ceilingForContinuation,
  lastTurnHeld,
  setContinuationHoldDb,
} from '../continuation-hold.js';
import { markRunningTurnOutsider, marksOf } from '../turn-levels.js';
import { turnReadOutsideWords } from '../outsider-turn.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';

let db: Db;
let counter = 0;
const fresh = () => `mark-running-${(counter += 1)}`;

beforeEach(() => {
  db = createTestDb();
  setContinuationHoldDb(db);
  resetLiveOutsiderTurns();
});
afterEach(() => {
  setContinuationHoldDb(undefined);
  resetLiveOutsiderTurns();
});

describe('a running turn marked as having read outside text', () => {
  it('is held after a restart, for a turn that picks the chat up on its own', () => {
    const chat = fresh();
    markRunningTurnOutsider(chat, '/agents/wren');
    setContinuationHoldDb(db); // a restart: this process's caches are gone
    expect(lastTurnHeld(chat)).toBe(true);
    expect(ceilingForContinuation(chat)).toEqual({
      permissionCeiling: 'runtime-default',
      continuationHold: true,
    });
    expect(bridgedSenderVouched(chat)).toBe(false);
  });

  it('is marked even when no turn was recorded under its id', () => {
    const chat = fresh();
    markRunningTurnOutsider(chat);
    expect(turnReadOutsideWords(chat, undefined)).toBe(true);
  });

  it("marks the agent's turns for a caller that names no chat", () => {
    const chat = fresh();
    markRunningTurnOutsider(chat, '/agents/wren');
    expect(marksOf(undefined, '/agents/wren').outsider).toBe(true);
  });
});

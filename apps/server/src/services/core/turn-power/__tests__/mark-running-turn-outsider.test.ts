/**
 * Marking a running turn as one that read outside text (DOR-3969) keeps it after a restart, through
 * the chat's stored hold, so a turn that picks the chat up on its own is held. It never writes the
 * bridged-sender latch (DOR-4593): one inbox read in the owner's own linked Telegram chat must not
 * make that chat a stranger's for good. A stranger's message on the bridge still does.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { runtimeRegistry } from '../../runtime-registry.js';
import {
  ceilingForContinuation,
  lastTurnHeld,
  setContinuationHoldDb,
} from '../continuation-hold.js';
import { markRunningTurnOutsider, marksOf, recordTurnLevels } from '../turn-levels.js';
import { turnReadOutsideWords } from '../outsider-turn.js';
import { chatReadOutsideWords } from '../chat-outside-words.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { resetChosenTurns } from '../full-autonomy.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';

const WREN = '/agents/wren';
let db: Db;
let counter = 0;
const fresh = () => `mark-running-${(counter += 1)}`;

/** Run one turn on `sessionId` through the real turn recorder. */
async function turn(sessionId: string, opts?: MessageOpts) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

beforeEach(() => {
  db = createTestDb();
  setContinuationHoldDb(db);
  resetLiveOutsiderTurns();
  resetChosenTurns();
  registerTestHomes([WREN]);
});
afterEach(() => {
  setContinuationHoldDb(undefined);
  resetLiveOutsiderTurns();
  resetChosenTurns();
  clearTestHomes();
  vi.restoreAllMocks();
});

describe('a running turn marked as having read outside text', () => {
  it('is held after a restart, for a turn that picks the chat up on its own', () => {
    const chat = fresh();
    markRunningTurnOutsider(chat, WREN);
    setContinuationHoldDb(db); // a restart: this process's caches are gone
    expect(lastTurnHeld(chat)).toBe(true);
    expect(ceilingForContinuation(chat)).toEqual({
      permissionCeiling: 'runtime-default',
      continuationHold: true,
    });
  });

  it('is marked even when no turn was recorded under its id', () => {
    const chat = fresh();
    markRunningTurnOutsider(chat);
    expect(turnReadOutsideWords(chat, undefined)).toBe(true);
  });

  it("marks the agent's turns for a caller that names no chat", () => {
    markRunningTurnOutsider(fresh(), WREN);
    expect(marksOf(undefined, WREN).outsider).toBe(true);
  });

  it('marks no other agent when its own home cannot be resolved', () => {
    markRunningTurnOutsider(fresh(), '/agents/nobody-registered');
    expect(marksOf(undefined, WREN).outsider).not.toBe(true);
  });
});

describe("the owner's own linked Telegram chat", () => {
  const vouched: MessageOpts = { turnStarter: 'telegram' };

  beforeEach(() => {
    vi.spyOn(runtimeRegistry, 'getSessionLaunchOrigin').mockReturnValue('relay-binding');
  });

  it('hands on clean words on its next turn after an inbox read', async () => {
    const chat = fresh();
    await turn(chat, vouched);
    markRunningTurnOutsider(chat, WREN);
    await turn(chat, vouched);
    setContinuationHoldDb(db);
    expect(chatReadOutsideWords(chat, WREN, true)).toBe(false);
  });

  it("carries once a stranger's message runs on it", async () => {
    const chat = fresh();
    await turn(chat, vouched);
    markRunningTurnOutsider(chat, WREN);
    await turn(chat, { turnStarter: 'telegram', carriedMarks: { outsider: true } });
    await turn(chat, vouched);
    setContinuationHoldDb(db);
    expect(chatReadOutsideWords(chat, WREN, true)).toBe(true);
  });
});

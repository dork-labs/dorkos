/**
 * Marking a running turn as one that read outside text (DOR-3969) keeps it after a restart, through
 * the chat's stored hold, so a turn that picks the chat up on its own is held. It never writes the
 * bridged-sender latch (DOR-4593): one inbox read in the owner's own linked Telegram chat must not
 * make that chat a stranger's for good. A stranger's message on the bridge still does.
 *
 * Each mark also records where its text came from, in memory only (DOR-4794), so the gate can tell
 * a turn that read only one app from one that read anything else.
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
import {
  carryTurnLevel,
  markRunningTurnOutsider,
  marksOf,
  recordTurnLevels,
} from '../turn-levels.js';
import { turnReadOutsideWords } from '../outsider-turn.js';
import { chatReadOutsideWords } from '../chat-outside-words.js';
import {
  endReadMark,
  readSourcesOf,
  resetLiveOutsiderTurns,
  UNKNOWN_READ_SOURCE,
} from '../live-outsider-turns.js';
import {
  linkSessionId,
  resetSessionKeys,
} from '../../../session/resolution/session-key-registry.js';
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
  resetSessionKeys();
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

  // DOR-4515 (Security, Nov 19): only the owner's own clean send in the app clears a chat that read
  // outside words. A bridged turn says who started it by a label any caller can set, so it does
  // not; letting the owner's own linked 1:1 chat clear it from the binding's record comes later.
  it('keeps the inbox read through its next bridged turn', async () => {
    const chat = fresh();
    await turn(chat, vouched);
    markRunningTurnOutsider(chat, WREN);
    await turn(chat, vouched);
    setContinuationHoldDb(db);
    expect(chatReadOutsideWords(chat, WREN, true)).toBe(true);
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

describe('where a mark came from (DOR-4794)', () => {
  const tracker = { kind: 'connector', connectionId: 'connection-tracker' } as const;
  const mail = { kind: 'connector', connectionId: 'connection-mail' } as const;

  it("records the app a read came from under the chat's first id", () => {
    const born = fresh();
    const renamed = `${born}-sdk`;
    linkSessionId(born, renamed);
    markRunningTurnOutsider(renamed, WREN, tracker);
    expect(readSourcesOf(born)).toEqual([tracker]);
  });

  // Red if the source were noted after the read record's early return: the second read would
  // vanish, and a turn that also read mail would pass for the tracker's alone.
  it('keeps every later source, not only the first', () => {
    const chat = fresh();
    markRunningTurnOutsider(chat, WREN, tracker);
    markRunningTurnOutsider(chat, WREN, mail);
    markRunningTurnOutsider(chat, WREN, { kind: 'room' });
    expect(readSourcesOf(chat)).toEqual([tracker, mail, { kind: 'room' }]);
  });

  it('keeps a source read twice once', () => {
    const chat = fresh();
    markRunningTurnOutsider(chat, WREN, tracker);
    markRunningTurnOutsider(chat, WREN, { ...tracker });
    expect(readSourcesOf(chat)).toEqual([tracker]);
  });

  // Red if a caller that names nothing were recorded as nothing: it must never read as one app's.
  it('records a read that names no source as unknown', () => {
    const chat = fresh();
    markRunningTurnOutsider(chat, WREN);
    expect(readSourcesOf(chat)).toEqual([UNKNOWN_READ_SOURCE]);
  });

  it('forgets them when the read record ends', () => {
    const chat = fresh();
    markRunningTurnOutsider(chat, WREN, tracker);
    endReadMark(chat);
    expect(readSourcesOf(chat)).toEqual([]);
  });

  // Red without the turn-start reset: the next turn would inherit the tracker as its only source
  // while it still carries words the earlier turn read.
  it("starts the chat's next turn with an unknown source while the earlier read still marks it", async () => {
    const chat = fresh();
    await turn(chat);
    markRunningTurnOutsider(chat, WREN, tracker);
    await turn(chat);
    expect(readSourcesOf(chat)).toEqual([UNKNOWN_READ_SOURCE]);
    expect(marksOf(chat, WREN).outsider).toBe(true);
  });

  it('keeps no source a restart could carry: the stored hold is a bare flag', () => {
    const chat = fresh();
    markRunningTurnOutsider(chat, WREN, tracker);
    resetLiveOutsiderTurns(); // what a restart leaves of the in-memory record
    setContinuationHoldDb(db);
    expect(lastTurnHeld(chat)).toBe(true);
    expect(readSourcesOf(chat)).toEqual([]);
  });

  // Security's ruling (a): a mark carried from another conversation is explained by no read. Red
  // if the carry recorded nothing, or if the next turn's start washed the unknown source out.
  it('records a mark carried from another conversation as unknown, through the next turn start', async () => {
    const from = fresh();
    const chat = fresh();
    await turn(from, { carriedMarks: { outsider: true } });
    await turn(chat);
    carryTurnLevel(from, chat);
    expect(readSourcesOf(chat)).toEqual([UNKNOWN_READ_SOURCE]);
    await turn(chat);
    expect(readSourcesOf(chat)).toEqual([UNKNOWN_READ_SOURCE]);
  });
});

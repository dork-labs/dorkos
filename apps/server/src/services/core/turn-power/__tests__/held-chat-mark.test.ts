/**
 * A chat that took in a stranger's words stays marked until the owner's own clean turn (DOR-4515):
 * a later scheduled run, heartbeat or chat message in it carries the outsider mark, and waiting
 * never clears it. Only the dispatcher's verdict for a message it launched counts as the owner's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, sessionMetadata, type Db } from '@dorkos/db';
import {
  linkSessionId,
  resetSessionKeys,
} from '../../../session/resolution/session-key-registry.js';
import { rekeySessionMetadata } from '../../../session/recovery/rekey-metadata.js';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { lastTurnLevelOf, recordTurnLevels } from '../turn-levels.js';
import { lastTurnHeld, noteTurnHold, setContinuationHoldDb } from '../continuation-hold.js';
import {
  forgetOwnersCleanSend,
  noteOwnersCleanSend,
  resetHeldChatMarks,
} from '../held-chat-mark.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';

let counter = 0;
const fresh = () => `held-chat-${(counter += 1)}`;

/** What the runtime under the seam was handed, per turn. */
let received: Array<MessageOpts | undefined>;

/** A runtime that records each send's options, wrapped the way the registry wraps it. */
function wrapped(): AgentRuntime {
  const runtime = {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async *sendMessage(
      _id: string,
      _content: string,
      opts?: MessageOpts
    ): AsyncGenerator<StreamEvent> {
      received.push(opts);
      yield { type: 'done', data: {} } as StreamEvent;
    },
  } as unknown as AgentRuntime;
  return recordTurnLevels(runtime, () => 'bypassPermissions');
}

async function send(runtime: AgentRuntime, sessionId: string, opts?: MessageOpts) {
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

/** A stranger's turn in the chat: a Telegram sender nobody vouched for, held to the default. */
const STRANGER: MessageOpts = { permissionCeiling: 'runtime-default', turnStarter: 'telegram' };
/** A scheduled run in the same chat: unattended, carrying no mark of its own. */
const SCHEDULED: MessageOpts = { unattended: true };

let db: Db;

beforeEach(() => {
  received = [];
  db = createTestDb();
  setContinuationHoldDb(db);
  resetHeldChatMarks();
  resetLiveOutsiderTurns();
});
afterEach(() => {
  setContinuationHoldDb(undefined);
  resetHeldChatMarks();
  resetLiveOutsiderTurns();
});

describe('a chat that took in a stranger’s words', () => {
  it('marks a later scheduled run in it, and keeps the chat held', async () => {
    const runtime = wrapped();
    const chat = fresh();
    await send(runtime, chat, STRANGER);
    await send(runtime, chat, SCHEDULED);
    expect(received[1]?.carriedMarks).toEqual({ outsider: true });
    expect(lastTurnLevelOf(chat)?.outsider).toBe(true);
    expect(lastTurnHeld(chat)).toBe(true);
  });

  it('stays marked however many turns nobody newly asked for follow', async () => {
    const runtime = wrapped();
    const chat = fresh();
    await send(runtime, chat, STRANGER);
    await send(runtime, chat, SCHEDULED);
    await send(runtime, chat, { turnStarter: 'agent-message' });
    await send(runtime, chat, SCHEDULED);
    expect(received.slice(1).map((opts) => opts?.carriedMarks)).toEqual([
      { outsider: true },
      { outsider: true },
      { outsider: true },
    ]);
  });

  it('is cleared by the owner’s own clean send, and the next scheduled run is unmarked', async () => {
    const runtime = wrapped();
    const chat = fresh();
    await send(runtime, chat, STRANGER);
    noteOwnersCleanSend('owner-message-1', chat);
    await send(runtime, chat, { turnStarter: 'person', messageId: 'owner-message-1' });
    expect(received[1]?.carriedMarks).toBeUndefined();
    expect(lastTurnHeld(chat)).toBe(false);
    await send(runtime, chat, SCHEDULED);
    expect(received[2]?.carriedMarks).toBeUndefined();
  });

  it('ignores a caller that only says it is the person, under a message id the dispatcher never vouched for', async () => {
    const runtime = wrapped();
    const chat = fresh();
    await send(runtime, chat, STRANGER);
    await send(runtime, chat, { ...SCHEDULED, turnStarter: 'person', messageId: 'made-up-id' });
    await send(runtime, chat, { turnStarter: 'person' });
    expect(received[1]?.carriedMarks).toEqual({ outsider: true });
    expect(received[2]?.carriedMarks).toEqual({ outsider: true });
    expect(lastTurnHeld(chat)).toBe(true);
  });

  it('counts a vouched send once: a second turn under the same id is not the owner’s', async () => {
    const runtime = wrapped();
    const chat = fresh();
    await send(runtime, chat, STRANGER);
    noteOwnersCleanSend('owner-message-2', chat);
    await send(runtime, chat, { messageId: 'owner-message-2' });
    await send(runtime, chat, STRANGER);
    await send(runtime, chat, { ...SCHEDULED, messageId: 'owner-message-2' });
    expect(received[3]?.carriedMarks).toEqual({ outsider: true });
  });

  it('counts a vouched send only in the chat it was found for', async () => {
    const runtime = wrapped();
    const chat = fresh();
    const other = fresh();
    await send(runtime, chat, STRANGER);
    await send(runtime, other, STRANGER);
    noteOwnersCleanSend('owner-message-3', chat);
    await send(runtime, other, { turnStarter: 'person', messageId: 'owner-message-3' });
    expect(received[2]?.carriedMarks).toEqual({ outsider: true });
    expect(lastTurnHeld(other)).toBe(true);
  });

  it('counts nothing once the dispatcher forgot the verdict for a later launch', async () => {
    const runtime = wrapped();
    const chat = fresh();
    await send(runtime, chat, STRANGER);
    noteOwnersCleanSend('owner-message-4', chat);
    forgetOwnersCleanSend('owner-message-4');
    await send(runtime, chat, { turnStarter: 'person', messageId: 'owner-message-4' });
    expect(received[1]?.carriedMarks).toEqual({ outsider: true });
    expect(lastTurnHeld(chat)).toBe(true);
  });

  // Security M1 on DOR-4515: a renamed chat's row moves to its newer id, and a restart forgets the
  // link, so the hold has to be kept under every id the chat answers to.
  it('stays held after a rename and a restart, for a turn sent under the newer id', async () => {
    const runtime = wrapped();
    const born = fresh();
    const renamed = `${born}-renamed`;
    await send(runtime, born, { turnStarter: 'person' });
    noteTurnHold(born, false);
    const row = db.select().from(sessionMetadata).where(eq(sessionMetadata.sessionId, born)).get()!;
    rekeySessionMetadata(db, born, renamed, row, undefined);
    linkSessionId(born, renamed);
    await send(runtime, renamed, STRANGER);
    // What a restart leaves: the rows on disk, nothing in memory.
    setContinuationHoldDb(db);
    resetSessionKeys();
    resetHeldChatMarks();
    resetLiveOutsiderTurns();
    await send(wrapped(), renamed, SCHEDULED);
    expect(received[2]?.carriedMarks).toEqual({ outsider: true });
  });

  it('leaves a chat no stranger reached alone', async () => {
    const runtime = wrapped();
    const chat = fresh();
    await send(runtime, chat, SCHEDULED);
    await send(runtime, chat, SCHEDULED);
    expect(received.map((opts) => opts?.carriedMarks)).toEqual([undefined, undefined]);
  });
});

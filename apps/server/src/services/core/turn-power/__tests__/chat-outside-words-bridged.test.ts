/**
 * A bridged Telegram or Slack chat hands on outside words unless it is known to hold only a
 * vouched sender's words (DOR-4593). The record of whose words a bridged chat holds is one-way:
 * any marked turn, or any bridged turn while stranger marking is off, makes it a stranger's for
 * good, and only an unmarked bridged turn with marking on can make a chat with no record vouched.
 * So the owner's own linked chat hops unasked, while a stranger's chat keeps counting whatever
 * turns land on it after, and a chat not known to be vouched counts too.
 *
 * Turns are recorded through the real turn recorder, and every reading is taken the way a
 * restarted server takes it: from the database, with this process's caches cleared.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, type Db } from '@dorkos/db';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { RuntimeRegistry, runtimeRegistry } from '../../runtime-registry.js';
import { chatReadOutsideWords } from '../chat-outside-words.js';
import { noteBridgedSender, setContinuationHoldDb } from '../continuation-hold.js';
import { recordTurnLevels } from '../turn-levels.js';
import { resetChosenTurns } from '../full-autonomy.js';

let db: Db;
let counter = 0;
const origins = new Map<string, string>();

/** A chat a Telegram binding started. */
function bridgedChat(label: string): string {
  const id = `bridged-${label}-${(counter += 1)}`;
  origins.set(id, 'relay-binding');
  return id;
}

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

/** A Telegram message from a sender the binding vouched for (an approver, one-to-one). */
const vouched: MessageOpts = { turnStarter: 'telegram' };
/** A Telegram message the binding marked: a group, or a sender not on the approver list. */
const stranger: MessageOpts = { turnStarter: 'telegram', carriedMarks: { outsider: true } };
/** A continuation: an approval's answer delivered, a resume, a wake. */
const continuation: MessageOpts = { permissionCeiling: 'runtime-default', continuationHold: true };

/** Whether the chat's words carry outside words on, read as after a restart. */
function carries(sessionId: string, markStrangerTurns = true): boolean {
  setContinuationHoldDb(db);
  return chatReadOutsideWords(sessionId, undefined, markStrangerTurns);
}

beforeEach(() => {
  db = createTestDb();
  setContinuationHoldDb(db);
  resetChosenTurns();
  origins.clear();
  vi.spyOn(runtimeRegistry, 'getSessionLaunchOrigin').mockImplementation(
    (id: string) => origins.get(id) ?? null
  );
});
afterEach(() => {
  setContinuationHoldDb(undefined);
  resetChosenTurns();
  vi.restoreAllMocks();
});

describe('a bridged chat, with stranger marking on', () => {
  it("the owner's own linked chat, with no stranger ever, hands on clean words", async () => {
    const chat = bridgedChat('owner');
    await turn(chat, vouched);
    await turn(chat, continuation);
    await turn(chat, vouched);
    expect(carries(chat)).toBe(false);
  });

  it("a stranger's chat carries, and a continuation changes nothing", async () => {
    const chat = bridgedChat('stranger');
    await turn(chat, stranger);
    await turn(chat, continuation);
    expect(carries(chat)).toBe(true);
  });

  it("a stranger's chat still carries after a clean turn the owner typed in the app", async () => {
    const chat = bridgedChat('stranger-then-owner');
    await turn(chat, stranger);
    await turn(chat); // the owner, in the app: unmarked, not bridged
    expect(carries(chat)).toBe(true);
  });

  it('a chat that held a stranger stays a stranger’s after a vouched sender writes (shared per-user)', async () => {
    const chat = bridgedChat('group-then-dm');
    await turn(chat, stranger); // a group turn in a per-user session
    await turn(chat, vouched); // the owner's own DM, same session
    expect(carries(chat)).toBe(true);
  });

  it('a chat with no record carries', () => {
    expect(carries(bridgedChat('no-row'))).toBe(true);
  });

  it('a chat the owner only ever typed into in the app carries: nothing vouched for it', async () => {
    const chat = bridgedChat('app-only');
    await turn(chat);
    expect(carries(chat)).toBe(true);
  });

  it('a chat whose bridged turn ran with marking off carries, and stays so once it is on', async () => {
    const chat = bridgedChat('flag-off');
    await turn(chat, vouched);
    noteBridgedSender(chat, { marked: false, bridged: true }, false);
    expect(carries(chat)).toBe(true);
    await turn(chat, vouched);
    expect(carries(chat)).toBe(true);
  });
});

describe('a bridged chat, with stranger marking off', () => {
  it("counts, since nothing tells the owner's chat from a stranger's", async () => {
    const chat = bridgedChat('owner');
    await turn(chat, vouched);
    expect(carries(chat, false)).toBe(true);
  });
});

describe('a renamed bridged chat', () => {
  /** A registry over the same database, renaming a row as the Claude runtime does. */
  async function rename(fromId: string, toId: string) {
    const registry = new RuntimeRegistry();
    registry.setDb(db);
    await registry.rekeySessionSettings(fromId, toId);
  }

  /** Seed a bound row under `id`, as a launch leaves it. */
  function seed(id: string) {
    db.insert(sessionMetadata)
      .values({
        sessionId: id,
        runtime: 'claude-code',
        launchOrigin: 'relay-binding',
        createdAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
    origins.set(id, 'relay-binding');
  }

  it("keeps a stranger's record when it merges into a vouched row", async () => {
    seed('old-id');
    seed('new-id');
    await turn('old-id', stranger);
    await turn('new-id', vouched);
    await rename('old-id', 'new-id');
    expect(carries('new-id')).toBe(true);
  });

  it('keeps a vouched record only when both rows were vouched', async () => {
    seed('old-v');
    seed('new-v');
    await turn('old-v', vouched);
    await turn('new-v', vouched);
    await rename('old-v', 'new-v');
    expect(carries('new-v')).toBe(false);
  });

  it('reads as a stranger’s when one row was not known', async () => {
    seed('old-u');
    seed('new-u');
    await turn('new-u', vouched);
    await rename('old-u', 'new-u');
    expect(carries('new-u')).toBe(true);
  });
});

describe('the other outside origins', () => {
  it.each(['outside-sender', 'connector-event'])('%s counts whatever the flag says', (o) => {
    const chat = `chat-${o}`;
    origins.set(chat, o);
    expect(carries(chat, true)).toBe(true);
    expect(carries(chat, false)).toBe(true);
  });

  it("the owner's own chat does not count", async () => {
    origins.set('mine', 'interactive');
    await turn('mine');
    expect(carries('mine')).toBe(false);
  });
});

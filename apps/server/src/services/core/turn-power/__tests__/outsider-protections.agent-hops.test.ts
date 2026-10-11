/**
 * Pins a protection of the trusted-by-default work (DOR-2781, spec
 * `trusted-by-default-flip` §4.7). If this fails, a stranger's words found a
 * way to leave the turn they started as somebody else's: fix that path, not
 * this test.
 *
 * The protection: a turn a stranger started runs at the asking mode at most,
 * and so does every turn its messages start, however many agents they pass
 * through. And every such turn is recorded as one that read an outsider's
 * words, so a note it saves to the agent's memory says so in the stamp DorkOS
 * writes, and cannot rewrite a note the operator gave.
 *
 * One hop per case, each through the real seam that records turn levels and
 * the real `memory_write` capability over a real memory file:
 *
 * | Hop                                   | Held to asking | Marked |
 * | ------------------------------------- | -------------- | ------ |
 * | a room post mentioning another agent  | yes            | yes    |
 * | a relay message to another agent      | yes            | yes    |
 * | a chat message to another chat        | yes            | yes    |
 * | a session the turn starts             | yes            | yes    |
 * | a stranger's line only in the window  | no (fenced)    | yes    |
 * | the note the turn saves to memory     | n/a            | yes    |
 *
 * The relay adapter's own half (an agent sender's turn is sent with the
 * runtime-default ceiling) is pinned in
 * `packages/relay/src/adapters/claude-code/__tests__/agent-turn-ceiling.test.ts`;
 * the chat service's in `chat-message-service.test.ts`; `session_start`'s in
 * `session-tools.test.ts`.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { noopLogger } from '@dorkos/shared/logger';
import { clampModeToCeiling } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  lastTurnLevelOf,
  noteEntryLevel,
  outsiderBoundOf,
  postLevelFor,
  recordTurnLevels,
} from '../turn-levels.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { ceilingForEntry, outsiderInViewOf } from '../../../rooms/limits/turn-ceiling.js';
import type { AuthorRegistry } from '../../../rooms/author-registry.js';
import { senderCeiling } from '../../../session/chat-messages/chat-message-service.js';
import { composeRegistry, type CapabilityRegistry } from '../../capabilities/index.js';
import { MEMORY_OUTSIDER_HELD_MESSAGE, memoryDomain } from '../../../memory/memory-capabilities.js';
import { resetMemoryProvider } from '../../../memory/index.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';

const MODES = CLAUDE_CODE_CAPABILITIES.permissionModes;
const OUTSIDER_STAMP =
  /\(noted in a direct chat, while reading words DorkOS can't vouch for, \d{4}-\d{2}-\d{2}\)$/;
const OPERATOR_STAMP = /\(noted in a direct chat, \d{4}-\d{2}-\d{2}\)$/;

/** A runtime whose turns stay open until released, wrapped the way the registry wraps it. */
function seam(stored: Record<string, string>): {
  runtime: AgentRuntime;
  sent: Map<string, MessageOpts | undefined>;
} {
  const sent = new Map<string, MessageOpts | undefined>();
  const runtime = {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async *sendMessage(sessionId: string, _content: string, opts?: MessageOpts) {
      sent.set(sessionId, opts);
      yield { type: 'done', data: {} } as StreamEvent;
    },
  } as unknown as AgentRuntime;
  return { runtime: recordTurnLevels(runtime, (id) => stored[id] ?? null), sent };
}

async function run(runtime: AgentRuntime, sessionId: string, opts?: MessageOpts) {
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

/** The mode a Full autonomy conversation actually runs a turn at under its ceiling. */
function runsAt(opts: MessageOpts | undefined): string {
  return opts?.permissionCeiling === undefined
    ? 'bypassPermissions'
    : clampModeToCeiling(MODES, 'bypassPermissions', opts.permissionCeiling);
}

const AUTHORS = {
  getMany: (ids: readonly string[]) =>
    new Map(
      ids
        .map((id) => [id, RECORDS[id]] as const)
        .filter((pair): pair is readonly [string, (typeof RECORDS)[string]] => !!pair[1])
    ),
} as unknown as AuthorRegistry;
const RECORDS: Record<string, { kind: 'human' | 'agent'; naturalKey: string }> = {
  ana: { kind: 'agent', naturalKey: '/agents/ana' },
  owner: { kind: 'human', naturalKey: 'operator' },
  stranger: { kind: 'human', naturalKey: 'platform:telegram:4242' },
};

let counter = 0;
const fresh = (name: string) => `${name}-hop-${(counter += 1)}`;

let root: string;
let boPath: string;
let memory: CapabilityRegistry;

/** Bo saves a note, from a session or (the external server) from no session. */
function boWrites(input: Record<string, string>, sessionId?: string) {
  return memory.invoke('memory.write', input, {
    identity: { agentPath: boPath, displayName: 'Bo', createdAt: '2026-10-10T00:00:00.000Z' },
    ...(sessionId !== undefined ? { sessionId } : {}),
  }) as Promise<{ saved: boolean; code?: string; error?: string }>;
}

async function boMemory(): Promise<string> {
  return readFile(path.join(boPath, '.dork', 'MEMORY.md'), 'utf8');
}

/** The last note in Bo's memory. */
async function lastNote(): Promise<string> {
  const notes = (await boMemory()).trimEnd().split('\n');
  return notes[notes.length - 1]!;
}

beforeEach(async () => {
  resetMemoryProvider();
  resetLiveOutsiderTurns();
  root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-outsider-hops-'));
  boPath = path.join(root, 'agents', 'bo');
  await mkdir(boPath, { recursive: true });
  registerTestHomes([boPath]);
  memory = composeRegistry([memoryDomain], {
    logger: noopLogger,
    memoryDeps: { roomLabelForSession: () => null },
  });
});

afterEach(async () => {
  clearTestHomes();
  resetLiveOutsiderTurns();
  await rm(root, { recursive: true, force: true });
});

describe("a stranger's words, one agent hop later", () => {
  it('a room post: Bo is held to asking, and his note says it came from outsider words', async () => {
    // Both conversations are at Full autonomy; a stranger's message wakes Ana's.
    const ana = fresh('ana');
    const bo = fresh('bo');
    const { runtime, sent } = seam({ [ana]: 'bypassPermissions', [bo]: 'bypassPermissions' });
    const strangerTurn = ceilingForEntry(AUTHORS, { id: fresh('e'), authorId: 'stranger' });
    await run(runtime, ana, strangerTurn);
    expect(runsAt(sent.get(ana))).toBe('default');

    // Ana posts mentioning Bo; Bo's turn is started by her post.
    const post = fresh('post');
    noteEntryLevel(post, postLevelFor([ana]));
    await run(runtime, bo, ceilingForEntry(AUTHORS, { id: post, authorId: 'ana' }));
    expect(runsAt(sent.get(bo))).toBe('default');
    expect(lastTurnLevelOf(bo)?.outsider).toBe(true);

    expect((await boWrites({ action: 'add', text: 'ship on Fridays' }, bo)).saved).toBe(true);
    expect(await lastNote()).toMatch(OUTSIDER_STAMP);
  });

  it('a relay message: a turn held to the runtime default reads as an outsider’s', async () => {
    // What the relay adapter sends for every sender that may not shape a turn.
    const { runtime, sent } = seam({});
    const bo = fresh('bo');
    await run(runtime, bo, { permissionCeiling: 'runtime-default' });
    expect(runsAt(sent.get(bo))).toBe('default');
    await boWrites({ action: 'add', text: 'the deploy key is in the vault' }, bo);
    expect(await lastNote()).toMatch(OUTSIDER_STAMP);
  });

  it("a chat message: the sender's mark rides the ceiling to the receiving chat", async () => {
    const { runtime, sent } = seam({});
    const ana = fresh('ana');
    const bo = fresh('bo');
    await run(runtime, ana, ceilingForEntry(AUTHORS, { id: fresh('e'), authorId: 'stranger' }));
    // `chat_send` stores this as the queue row's ceiling; the dispatcher launches under it.
    const stored = JSON.parse(JSON.stringify(senderCeiling(lastTurnLevelOf(ana))));
    await run(runtime, bo, { permissionCeiling: stored });
    expect(runsAt(sent.get(bo))).toBe('default');
    expect(lastTurnLevelOf(bo)?.outsider).toBe(true);
    await boWrites({ action: 'add', text: 'Priya wants weekly reports' }, bo);
    expect(await lastNote()).toMatch(OUTSIDER_STAMP);
  });

  it('a session it starts: the starter’s bound is what the new session carries', async () => {
    const { runtime, sent } = seam({ child: 'bypassPermissions' });
    const ana = fresh('ana');
    await run(runtime, ana, ceilingForEntry(AUTHORS, { id: fresh('e'), authorId: 'stranger' }));
    const bound = outsiderBoundOf(ana, '/agents/ana');
    expect(bound).toMatchObject({ outsider: true });
    const child = fresh('child');
    await run(runtime, child, { permissionCeiling: bound! });
    expect(runsAt(sent.get(child))).toBe('default');
    expect(lastTurnLevelOf(child)?.outsider).toBe(true);
  });

  it('a post two of the author’s turns vouch for keeps the mark if either read an outsider', async () => {
    // Ana answers a stranger in one room and the owner in another, and posts
    // from the first into the second. The owner's turn is the stricter (Plan),
    // and the post still keeps the mark the stranger's turn carries.
    const inStrangerRoom = fresh('ana-r1');
    const inOwnerRoom = fresh('ana-r2');
    const { runtime } = seam({ [inOwnerRoom]: 'plan' });
    await run(runtime, inStrangerRoom, { permissionCeiling: 'runtime-default' });
    await run(runtime, inOwnerRoom);
    expect(postLevelFor([inOwnerRoom, inStrangerRoom])?.outsider).toBe(true);
  });

  it('nothing is passed on from a turn the owner started', async () => {
    const ana = fresh('ana');
    const { runtime, sent } = seam({ [ana]: 'bypassPermissions' });
    const bo = fresh('bo');
    await run(runtime, ana, ceilingForEntry(AUTHORS, { id: fresh('e'), authorId: 'owner' }));
    expect(outsiderBoundOf(ana, '/agents/ana')).toBeUndefined();
    const post = fresh('post');
    noteEntryLevel(post, postLevelFor([ana]));
    await run(runtime, bo, ceilingForEntry(AUTHORS, { id: post, authorId: 'ana' }));
    expect(lastTurnLevelOf(bo)?.outsider).toBeUndefined();
    expect(runsAt(sent.get(bo))).toBe('bypassPermissions');
    await boWrites({ action: 'add', text: 'ship on Fridays' }, bo);
    expect(await lastNote()).toMatch(OPERATOR_STAMP);
  });
});

describe("a stranger's line the turn is shown but does not answer", () => {
  const strangerLine = {
    id: 'e-stranger',
    authorOrigin: 'external' as const,
  };

  it('is fenced, not ceilinged: the owner keeps the power they chose', async () => {
    const { runtime, sent } = seam({});
    const bo = fresh('bo');
    const view = outsiderInViewOf({
      pending: [strangerLine as never],
      gathered: [],
      channelTail: [],
    });
    expect(view).toEqual({ outsiderInView: true });
    await run(runtime, bo, {
      roomTurn: { roomId: 'r', authorId: 'bo', turnId: 't', ...view },
    });
    expect(runsAt(sent.get(bo))).toBe('bypassPermissions');
    // ...and still marks the turn, so what it saves or passes on says so.
    expect(lastTurnLevelOf(bo)?.outsider).toBe(true);
    await boWrites({ action: 'add', text: 'the client prefers email' }, bo);
    expect(await lastNote()).toMatch(OUTSIDER_STAMP);
  });

  it('counts an agent’s post that carried outsider words on, and not one that did not or kept no level', async () => {
    const ana = fresh('ana');
    const { runtime } = seam({ [ana]: 'bypassPermissions' });
    await run(runtime, ana, ceilingForEntry(AUTHORS, { id: fresh('e'), authorId: 'stranger' }));
    const agentPost = (id: string) =>
      ({ id, authorOrigin: 'local', authorIsPerson: false, kind: 'post' }) as never;
    const carried = fresh('post');
    noteEntryLevel(carried, postLevelFor([ana]));
    expect(outsiderInViewOf({ pending: [agentPost(carried)] })).toEqual({ outsiderInView: true });
    // Kept no level: not counted, so the owner's edits stay open after a restart.
    expect(outsiderInViewOf({ pending: [agentPost(fresh('no-level'))] })).toEqual({});

    await run(runtime, ana);
    const plain = fresh('plain');
    noteEntryLevel(plain, postLevelFor([ana]));
    const person = { id: fresh('p'), authorOrigin: 'local', authorIsPerson: true, kind: 'post' };
    expect(
      outsiderInViewOf({ pending: [agentPost(plain), person as never], channelTail: [] })
    ).toEqual({});
  });
});

describe('memory written in a turn that read an outsider’s words', () => {
  async function seedOperatorNote(): Promise<void> {
    await mkdir(path.join(boPath, '.dork'), { recursive: true });
    await writeFile(
      path.join(boPath, '.dork', 'MEMORY.md'),
      '## Notes\n\n- deploys need the operator’s OK (noted in a direct chat, 2026-10-01)\n',
      'utf8'
    );
  }

  it('cannot rewrite or remove a note, so the operator’s stamp never covers a stranger’s words', async () => {
    await seedOperatorNote();
    const { runtime } = seam({});
    const bo = fresh('bo');
    await run(runtime, bo, { permissionCeiling: 'runtime-default' });

    const replaced = await boWrites(
      { action: 'replace', old_text: 'deploys need the operator’s OK', text: 'deploy freely' },
      bo
    );
    const removed = await boWrites({ action: 'remove', old_text: 'deploys need' }, bo);
    expect(replaced).toMatchObject({ saved: false, code: 'outsider-held' });
    expect(replaced.error).toBe(MEMORY_OUTSIDER_HELD_MESSAGE);
    expect(removed).toMatchObject({ saved: false, code: 'outsider-held' });
    expect(await boMemory()).toContain('deploys need the operator’s OK');
  });

  it('is still editable from a turn the owner started', async () => {
    await seedOperatorNote();
    const { runtime } = seam({});
    const bo = fresh('bo');
    await run(runtime, bo);
    expect((await boWrites({ action: 'remove', old_text: 'deploys need' }, bo)).saved).toBe(true);
  });

  it('from a caller with no session (Codex, OpenCode), is marked while its agent reads one', async () => {
    const turn = seam({}).runtime.sendMessage(fresh('codex'), 'hi', {
      cwd: boPath,
      permissionCeiling: 'runtime-default',
    });
    // The turn is running: its stream has started and not finished.
    await turn.next();
    await boWrites({ action: 'add', text: 'the vendor is Acme' });
    expect(await lastNote()).toMatch(OUTSIDER_STAMP);

    // Finished: the next note from that agent is the operator's again.
    await turn.return(undefined);
    await boWrites({ action: 'add', text: 'the vendor is Acme, really' });
    expect(await lastNote()).toMatch(OPERATOR_STAMP);
  });

  // Red when: the seam stops counting turns the agent starts on its own. A
  // Codex wake after background work is no `sendMessage`, and Codex has no
  // session to name, so the count is the only thing that can mark its notes.
  it('from a Codex wake after background work the marked turn left running', async () => {
    let wake: ((sessionId: string, events: AsyncIterable<StreamEvent>) => void) | undefined;
    const codex = {
      type: 'codex',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage() {
        yield { type: 'done', data: {} } as StreamEvent;
      },
      onRuntimeTurn: (listener: typeof wake) => {
        wake = listener;
        return () => undefined;
      },
    } as unknown as AgentRuntime;
    const recorded = recordTurnLevels(codex, () => null);
    const session = fresh('codex');
    await run(recorded, session, { cwd: boPath, permissionCeiling: 'runtime-default' });

    let seen: AsyncIterable<StreamEvent> | undefined;
    recorded.onRuntimeTurn!((_id, events) => {
      seen = events;
    });
    wake!(
      session,
      (async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    );
    const woken = seen![Symbol.asyncIterator]();
    await woken.next();
    await boWrites({ action: 'add', text: 'the build finished green' });
    expect(await lastNote()).toMatch(OUTSIDER_STAMP);
    await woken.return?.(undefined);
  });

  it("is not marked for another agent's outsider turn", async () => {
    const elsewhere = path.join(root, 'agents', 'cy');
    registerTestHomes([boPath, elsewhere]);
    const turn = seam({}).runtime.sendMessage(fresh('cy'), 'hi', {
      cwd: elsewhere,
      permissionCeiling: 'runtime-default',
    });
    await turn.next();
    await boWrites({ action: 'add', text: 'a plain note' });
    expect(await lastNote()).toMatch(OPERATOR_STAMP);
    await turn.return(undefined);
  });
});

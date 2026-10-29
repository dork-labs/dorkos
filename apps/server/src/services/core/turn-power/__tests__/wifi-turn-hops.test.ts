/**
 * A turn started from Wi-Fi runs at the runtime's default at most (DOR-3037),
 * and everything it causes is marked: one test per path, through the real seam
 * that records turn levels. What our own agent passes on one hop later is
 * marked and gated, not held (DOR-3390, Security 2026-10-29): its shell asks,
 * it saves no standing rule, and its risky actions ask.
 *
 * | Path                                         | Held to Default    |
 * | -------------------------------------------- | ------------------ |
 * | the turn itself, on a Full autonomy agent    | yes                |
 * | a room post from Wi-Fi                       | yes                |
 * | a mention after it, or a `chat_send`         | no: marked, gated  |
 * | a `session_start` spin-off                   | yes                |
 * | a schedule it makes (`tasks_create`)         | parks for a person |
 *
 * The routes that put the hold on are pinned beside them
 * (`routes/__tests__/wifi-chat-turns.test.ts` and its neighbours).
 *
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { clampModeToCeiling, levelOfMode } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  lastTurnLevelOf,
  noteEntryHeldToDefault,
  noteEntryLevel,
  markedBoundOf,
  marksOf,
  passedOnLevelOf,
  postLevelFor,
  recordTurnLevels,
  setEntryMarksStore,
} from '../turn-levels.js';
import {
  carriesOutsiderMark,
  heldForOutsider,
} from '../../../runtimes/claude-code/turn-permission.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { ceilingForEntry } from '../../../rooms/limits/turn-ceiling.js';
import type { AuthorRegistry } from '../../../rooms/author-registry.js';
import {
  parseCeiling,
  senderCeilingJson,
} from '../../../session/chat-messages/chat-message-ceiling.js';
import { WIFI_TURN_CEILING } from '../../auth/sessions/wifi-turn-ceiling.js';

const created = vi.hoisted(() => [] as Array<{ callerIsOurAgent?: boolean }>);
vi.mock('../../../tasks/lifecycle/create-task.js', () => ({
  createScheduledTask: vi.fn(async (_deps: unknown, options: { callerIsOurAgent?: boolean }) => {
    created.push(options);
    return {
      ok: true,
      task: { id: 't1', name: 'nightly', displayName: null, status: 'pending_approval' },
    };
  }),
}));

import { createCreateScheduleHandler } from '../../../runtimes/claude-code/mcp-tools/task-tools.js';

const MODES = CLAUDE_CODE_CAPABILITIES.permissionModes;
const WIFI: MessageOpts = { permissionCeiling: WIFI_TURN_CEILING };

/** A runtime wrapped the way the registry wraps it, recording what each turn was sent with. */
function seam(stored: Record<string, string>) {
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

/** The mode a Full autonomy conversation runs a turn at under what it was sent with. */
function runsAt(opts: MessageOpts | undefined): string {
  return opts?.permissionCeiling === undefined
    ? 'bypassPermissions'
    : clampModeToCeiling(MODES, 'bypassPermissions', opts.permissionCeiling);
}

const AUTHORS = {
  getMany: (ids: readonly string[]) =>
    new Map(ids.filter((id) => RECORDS[id]).map((id) => [id, RECORDS[id]!] as const)),
} as unknown as AuthorRegistry;
const RECORDS: Record<string, { kind: 'human' | 'agent'; naturalKey: string }> = {
  ana: { kind: 'agent', naturalKey: '/agents/ana' },
  owner: { kind: 'human', naturalKey: 'operator' },
};

let counter = 0;
const fresh = (name: string) => `${name}-wifi-${(counter += 1)}`;

beforeEach(() => {
  resetLiveOutsiderTurns();
  created.length = 0;
});

describe('a turn started from Wi-Fi', () => {
  it('runs a Full autonomy agent at Default, marked', async () => {
    const ana = fresh('ana');
    const { runtime, sent } = seam({ [ana]: 'bypassPermissions' });
    await run(runtime, ana, WIFI);
    expect(runsAt(sent.get(ana))).toBe('default');
    expect(lastTurnLevelOf(ana)).toMatchObject({ asks: 'always', outsider: true });
  });

  it('a room post from Wi-Fi holds its turn, and Ana’s mention holds the next', async () => {
    const ana = fresh('ana');
    const bo = fresh('bo');
    const { runtime, sent } = seam({ [ana]: 'bypassPermissions', [bo]: 'bypassPermissions' });
    const wifiPost = fresh('post');
    noteEntryHeldToDefault(wifiPost);
    await run(runtime, ana, ceilingForEntry(AUTHORS, { id: wifiPost, authorId: 'owner' }));
    expect(runsAt(sent.get(ana))).toBe('default');

    // DOR-3390 (Security's Must 3): the next agent is marked and gated, at its own level. Its
    // shell asks, it saves no standing rule, a schedule it makes parks, and it passes the mark on.
    const mention = fresh('post');
    noteEntryLevel(mention, postLevelFor([ana]));
    // In the owner's own circle: outside it Bo would be held (Security's M-B).
    await run(
      runtime,
      bo,
      ceilingForEntry(AUTHORS, { id: mention, authorId: 'ana' }, false, '', { ownCircle: true })
    );
    expect(runsAt(sent.get(bo))).toBe('bypassPermissions');
    expect(lastTurnLevelOf(bo)?.outsider).toBe(true);
    const session = {
      permissionMode: 'bypassPermissions' as const,
      turnPermissionCeiling: sent.get(bo)!.permissionCeiling!,
    };
    expect(carriesOutsiderMark(session)).toBe(true);
    expect(heldForOutsider(session)).toBe(false);
    expect(marksOf(bo, '/agents/bo')).toEqual({ outsider: true });
    expect(passedOnLevelOf(bo)?.outsider).toBe(true);
  });

  it('a mark from Wi-Fi never raises the next agent past the sender’s person-set level', async () => {
    // Security's Must 1: Ana is set to Act (acceptEdits) by a person; Bo is at Full.
    const ana = fresh('ana');
    const bo = fresh('bo');
    const { runtime, sent } = seam({ [ana]: 'acceptEdits', [bo]: 'bypassPermissions' });
    const wifiPost = fresh('post');
    noteEntryHeldToDefault(wifiPost);
    await run(runtime, ana, ceilingForEntry(AUTHORS, { id: wifiPost, authorId: 'owner' }));
    const mention = fresh('post');
    noteEntryLevel(mention, postLevelFor([ana]));
    const act = levelOfMode(MODES, 'acceptEdits')!;
    await run(
      runtime,
      bo,
      ceilingForEntry(AUTHORS, { id: mention, authorId: 'ana' }, false, 'r', {
        ownCircle: true,
        posterCap: () => act,
      })
    );
    expect(runsAt(sent.get(bo))).toBe('acceptEdits');
    expect(lastTurnLevelOf(bo)?.outsider).toBe(true);
  });

  it('a post whose writer’s turn this process did not record still holds its reader', async () => {
    // Security's Must 2: after a restart only the row's marks are left, and they hold.
    const bo = fresh('bo');
    const { runtime, sent } = seam({ [bo]: 'bypassPermissions' });
    const rowOnly = fresh('post');
    setEntryMarksStore({ write: () => {}, read: () => ({ outsider: true }) });
    try {
      await run(
        runtime,
        bo,
        ceilingForEntry(AUTHORS, { id: rowOnly, authorId: 'ana' }, false, 'r', { ownCircle: true })
      );
    } finally {
      setEntryMarksStore(null);
    }
    expect(runsAt(sent.get(bo))).toBe('default');
  });

  it('a chat_send carries the mark to the receiving chat, at its own level', async () => {
    const ana = fresh('ana');
    const bo = fresh('bo');
    const { runtime, sent } = seam({ [ana]: 'bypassPermissions', [bo]: 'bypassPermissions' });
    await run(runtime, ana, WIFI);
    // `chat_send` stores this as the queue row's ceiling; the dispatcher launches under it.
    // Even with the sender's own agent set to Full autonomy (DOR-3107's own-circle
    // rule), the hold's mark rides on: Wi-Fi only lowers.
    const full = levelOfMode(MODES, 'bypassPermissions')!;
    const stored = parseCeiling(
      await senderCeilingJson(
        { turnLevelOf: passedOnLevelOf, ownLevelOf: async () => full },
        { sessionId: ana, agentPath: '/agents/ana' }
      )
    );
    await run(runtime, bo, { permissionCeiling: stored });
    expect(runsAt(sent.get(bo))).toBe('bypassPermissions');
    expect(lastTurnLevelOf(bo)?.outsider).toBe(true);
  });

  it('a session_start spin-off carries the hold', async () => {
    const ana = fresh('ana');
    const child = fresh('child');
    const { runtime, sent } = seam({ [ana]: 'bypassPermissions', [child]: 'bypassPermissions' });
    await run(runtime, ana, WIFI);
    const bound = markedBoundOf(ana, '/agents/ana');
    expect(bound).toEqual([expect.objectContaining({ outsider: true }), 'runtime-default']);
    await run(runtime, child, { permissionCeiling: bound! });
    expect(runsAt(sent.get(child))).toBe('default');
  });

  it('a schedule it makes parks for a person instead of arming', async () => {
    const ana = fresh('ana');
    const { runtime } = seam({ [ana]: 'bypassPermissions' });
    await run(runtime, ana, WIFI);
    const handler = createCreateScheduleHandler({ taskStore: {} } as never, () => ({
      sessionId: ana,
      agentPath: '/agents/ana',
    }));
    await handler({
      name: 'nightly',
      prompt: 'sweep it',
      cron: '0 3 * * *',
      reason: 'asked from the phone',
      target: 'global',
    });
    expect(created[0]!.callerIsOurAgent).toBe(false);
  });

  it('a schedule a turn at this computer makes is still one of ours', async () => {
    const ana = fresh('ana');
    const { runtime } = seam({ [ana]: 'bypassPermissions' });
    await run(runtime, ana);
    const handler = createCreateScheduleHandler({ taskStore: {} } as never, () => ({
      sessionId: ana,
      agentPath: '/agents/ana',
    }));
    await handler({
      name: 'nightly',
      prompt: 'sweep it',
      cron: '0 3 * * *',
      reason: 'asked here',
      target: 'global',
    });
    expect(created[0]!.callerIsOurAgent).toBe(true);
  });
});

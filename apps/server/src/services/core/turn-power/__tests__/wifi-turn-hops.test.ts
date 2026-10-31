/**
 * A turn started from Wi-Fi runs at the runtime's default at most, marked
 * (DOR-3037): one test per path, through the real seam that records turn levels.
 * The hold and its mark stay on that turn (DOR-3440).
 *
 * | Path                                         | Held to Default    |
 * | -------------------------------------------- | ------------------ |
 * | the turn itself, on a Full autonomy agent    | yes                |
 * | a room post from Wi-Fi                       | yes                |
 * | a mention after it, or a `chat_send`         | no                 |
 * | a `session_start` spin-off                   | no                 |
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
import { clampModeToCeiling } from '@dorkos/shared/permission-semantics';
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
} from '../turn-levels.js';
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

  it('a room post from Wi-Fi holds its turn, and Ana’s mention after it holds nothing', async () => {
    const ana = fresh('ana');
    const bo = fresh('bo');
    const { runtime, sent } = seam({ [ana]: 'bypassPermissions', [bo]: 'bypassPermissions' });
    const wifiPost = fresh('post');
    noteEntryHeldToDefault(wifiPost);
    await run(runtime, ana, ceilingForEntry(AUTHORS, { id: wifiPost, authorId: 'owner' }));
    expect(runsAt(sent.get(ana))).toBe('default');

    // The hold stays on that turn (DOR-3440): the next agent runs at its own level, unmarked.
    const mention = fresh('post');
    noteEntryLevel(mention, postLevelFor([ana]));
    await run(runtime, bo, ceilingForEntry(AUTHORS, { id: mention, authorId: 'ana' }));
    expect(runsAt(sent.get(bo))).toBe('bypassPermissions');
    expect(marksOf(bo, '/agents/bo')).toEqual({});
  });

  it('a chat_send from it stores no bound, and the receiving chat runs at its own level', async () => {
    const ana = fresh('ana');
    const bo = fresh('bo');
    const { runtime, sent } = seam({ [ana]: 'bypassPermissions', [bo]: 'bypassPermissions' });
    await run(runtime, ana, WIFI);
    // `chat_send` stores this as the queue row's ceiling; the dispatcher launches under it.
    const stored = parseCeiling(
      senderCeilingJson(
        { turnLevelOf: passedOnLevelOf },
        { sessionId: ana, agentPath: '/agents/ana' }
      )
    );
    expect(stored).toBeUndefined();
    await run(runtime, bo, stored === undefined ? undefined : { permissionCeiling: stored });
    expect(runsAt(sent.get(bo))).toBe('bypassPermissions');
    expect(lastTurnLevelOf(bo)?.outsider).toBeUndefined();
  });

  it('a session_start spin-off carries no bound from it', async () => {
    const ana = fresh('ana');
    const { runtime } = seam({ [ana]: 'bypassPermissions' });
    await run(runtime, ana, WIFI);
    expect(markedBoundOf(ana, '/agents/ana')).toBeUndefined();
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

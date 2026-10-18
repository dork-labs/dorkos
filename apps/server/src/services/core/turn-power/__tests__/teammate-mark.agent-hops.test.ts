/**
 * Reproduces the teammate tier laundering (DOR-3036) on every path a turn passes work on by,
 * past the room mention (that one, through the real room service, is
 * `rooms/__tests__/room-teammate-hop.test.ts`).
 *
 * A teammate's turn itself cannot reach these paths: the teammate tier refuses `chat_send`,
 * `session_start`, `tasks_create` and `memory_write` (`teammate-tier.ts`), pinned below as the
 * part that is already safe. But one mention later the teammate is gone. Ana's teammate turn
 * posts `@bo`; Bo's turn answers Ana, so it is no teammate turn, and every path is open to him:
 *
 * | Path from Bo's turn            | Carries today                      | Teammate mark |
 * | ------------------------------ | ---------------------------------- | ------------- |
 * | `chat_send` to another chat    | his level, read-only + outsider    | lost          |
 * | `session_start` spin-off       | his bound, read-only + outsider    | lost          |
 * | a schedule he creates          | nothing at all                     | lost          |
 *
 * "Carries" is read through the real level-recording seam and the real teammate meter, wrapped
 * the way the runtime registry wraps every runtime. Each `it.fails` is the bug: the downstream
 * turn should be held to the teammate tier and counted against the teammate's monthly limit.
 * {@link teammateMarkOf} is the one line the fix aligns with the mark's final shape.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { READ_ONLY_LEVEL } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  lastTurnLevelOf,
  noteEntryLevel,
  outsiderBoundOf,
  postLevelFor,
  recordTurnLevels,
} from '../turn-levels.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import {
  meterTeammateTurns,
  setTeammateTurnCostSink,
  type TeammateTurnCost,
} from '../teammate-turn-cost.js';
import { TEAMMATE_TIER_DENIAL, teammateTierRefusal } from '../teammate-tier.js';
import { ceilingForEntry } from '../../../rooms/limits/turn-ceiling.js';
import { teammateOf } from '../../../rooms/limits/space-teammates.js';
import type { AuthorRegistry } from '../../../rooms/author-registry.js';
import { senderCeiling } from '../../../session/chat-messages/chat-message-service.js';
import { initBoundary } from '../../../../lib/boundary.js';
import {
  singleRuntimeSource,
  TaskSchedulerService,
  type SchedulerAgentManager,
} from '../../../tasks/task-scheduler-service.js';
import { TaskStore } from '../../../tasks/task-store.js';

vi.mock('../../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => false) }));

const SPACE_ROOM = 'space-room';
const TURN_COST = 0.25;

const RECORDS: Record<string, { kind: 'human' | 'agent'; naturalKey: string }> = {
  ana: { kind: 'agent', naturalKey: '/agents/ana' },
  priya: { kind: 'human', naturalKey: 'platform:community:remote_team_space:remote-priya' },
};
const AUTHORS = {
  getMany: (ids: readonly string[]) =>
    new Map(ids.filter((id) => RECORDS[id]).map((id) => [id, RECORDS[id]!] as const)),
} as unknown as AuthorRegistry;

let counter = 0;
const fresh = (name: string) => `${name}-teammate-hop-${(counter += 1)}`;

/**
 * The teammate mark a recorded level carries, however the fix spells it. Today a level knows only
 * `outsider`; the fix adds the teammate kind (with who and which space) beside it.
 */
function teammateMarkOf(level: unknown): unknown {
  const shaped = level as { marks?: { teammate?: unknown }; teammate?: unknown } | undefined;
  return shaped?.marks?.teammate ?? shaped?.teammate;
}

/** A runtime that reports one turn cost, wrapped the way the registry wraps every runtime. */
function decorated(extra: Record<string, unknown> = {}): {
  runtime: AgentRuntime;
  sent: Map<string, MessageOpts | undefined>;
} {
  const sent = new Map<string, MessageOpts | undefined>();
  const fake = {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async *sendMessage(sessionId: string, _content: string, opts?: MessageOpts) {
      sent.set(sessionId, opts);
      yield { type: 'session_status', data: { turnCostUsd: TURN_COST } } as unknown as StreamEvent;
      yield { type: 'done', data: {} } as StreamEvent;
    },
    ...extra,
  } as unknown as AgentRuntime;
  return {
    runtime: meterTeammateTurns(recordTurnLevels(fake, () => 'bypassPermissions')),
    sent,
  };
}

async function run(runtime: AgentRuntime, sessionId: string, opts?: MessageOpts): Promise<void> {
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

/**
 * Priya, a teammate, wakes Ana in the space's room; Ana's post wakes Bo. Returns Bo's session,
 * with both turns recorded through the seam exactly as the room runner sends them.
 */
async function teammateThenMention(runtime: AgentRuntime): Promise<string> {
  const ana = fresh('ana');
  const priyaEntry = { id: fresh('priya-post'), authorId: 'priya' };
  const anaTeammate = teammateOf(AUTHORS, [priyaEntry]);
  expect(anaTeammate).toEqual({ teammate: true });
  await run(runtime, ana, {
    ...ceilingForEntry(AUTHORS, priyaEntry),
    unattended: true,
    roomTurn: { roomId: SPACE_ROOM, authorId: 'ana', turnId: 't-ana', ...anaTeammate },
  });

  const post = fresh('ana-post');
  noteEntryLevel(post, postLevelFor([ana]));
  const anaEntry = { id: post, authorId: 'ana' };
  const bo = fresh('bo');
  await run(runtime, bo, {
    ...ceilingForEntry(AUTHORS, anaEntry),
    roomTurn: {
      roomId: SPACE_ROOM,
      authorId: 'bo',
      turnId: 't-bo',
      ...teammateOf(AUTHORS, [anaEntry]),
    },
  });
  return bo;
}

let sink: Mock<(turn: TeammateTurnCost) => void>;

beforeEach(() => {
  resetLiveOutsiderTurns();
  sink = vi.fn<(turn: TeammateTurnCost) => void>();
  setTeammateTurnCostSink(sink);
});

afterEach(() => {
  setTeammateTurnCostSink(null);
  resetLiveOutsiderTurns();
});

describe('already safe: a teammate’s own turn cannot pass work on', () => {
  it.each(['chat_send', 'session_start', 'tasks_create', 'memory_write'])(
    'the teammate tier refuses %s',
    (name) => {
      expect(
        teammateTierRefusal(
          { roomId: SPACE_ROOM },
          { source: 'dorkos', name, input: { roomId: SPACE_ROOM } }
        )
      ).toBe(TEAMMATE_TIER_DENIAL);
    }
  );

  it('Bo, one mention later, is already held to read access and marked outsider', async () => {
    const { runtime } = decorated();
    const bo = await teammateThenMention(runtime);
    expect(lastTurnLevelOf(bo)).toMatchObject({ reach: READ_ONLY_LEVEL.reach, outsider: true });
    // ...but nothing says a teammate started this chain, and nothing counted Bo's turn.
    expect(teammateMarkOf(lastTurnLevelOf(bo))).toBeUndefined();
    expect(sink).toHaveBeenCalledTimes(1);
  });
});

describe('one mention later, the teammate mark is lost (DOR-3036)', () => {
  // DOR-3036: flips to it() when the turn mark carries.
  it.fails('chat_send: the chat Bo writes to runs as the teammate’s, and is counted', async () => {
    const { runtime } = decorated();
    const bo = await teammateThenMention(runtime);
    sink.mockClear();
    // What `chat_send` stores as the queue row's ceiling; the dispatcher launches under it.
    const stored = JSON.parse(JSON.stringify(senderCeiling(lastTurnLevelOf(bo))));
    const cy = fresh('cy');
    await run(runtime, cy, { permissionCeiling: stored });

    expect(teammateMarkOf(lastTurnLevelOf(cy))).toBeDefined();
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ costUsd: TURN_COST }));
  });

  // DOR-3036: flips to it() when the turn mark carries.
  it.fails(
    'session_start: the chat Bo spins off runs as the teammate’s, and is counted',
    async () => {
      const { runtime } = decorated();
      const bo = await teammateThenMention(runtime);
      sink.mockClear();
      // What `session_start` sends as the new chat's first-turn ceiling (`outsiderStartCeiling`).
      const bound = outsiderBoundOf(bo, '/agents/bo');
      expect(bound).toBeDefined();
      const child = fresh('child');
      await run(runtime, child, { permissionCeiling: bound! });

      expect(teammateMarkOf(lastTurnLevelOf(child))).toBeDefined();
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({ costUsd: TURN_COST }));
    }
  );

  // DOR-3036: flips to it() when the turn mark carries.
  it.fails('a schedule Bo creates: its runs are the teammate’s, and are counted', async () => {
    await initBoundary('/');
    const { runtime, sent } = decorated({
      ensureSession: vi.fn(),
      interruptQuery: vi.fn().mockResolvedValue({ outcome: 'not-running' }),
      getInternalSessionId: vi.fn(() => undefined),
      acquireLock: vi.fn(() => true),
      releaseLock: vi.fn(),
    });
    await teammateThenMention(runtime);
    sink.mockClear();
    const before = new Set(sent.keys());

    // Bo's `tasks_create` lands here; nothing about the turn that wrote it reaches the row.
    const store = new TaskStore(createTestDb());
    const task = store.createTask({
      name: 'Nightly build check',
      description: 'created in Bo’s turn',
      prompt: 'check the build',
      cron: '0 3 * * *',
      filePath: '/tmp/tasks/nightly-build-check/SKILL.md',
    });
    const scheduler = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(runtime as unknown as SchedulerAgentManager),
      config: { maxConcurrentRuns: 1, retentionCount: 10, mayFire: true, firingReason: 'test' },
    });
    try {
      // Run now, which starts the same stored run a timer fire does, without a clock to fake.
      await scheduler.triggerManualRun(task.id);
      await vi.waitFor(() => expect(sent.size).toBe(before.size + 1));
      const runSession = [...sent.keys()].find((id) => !before.has(id));

      expect(teammateMarkOf(lastTurnLevelOf(runSession!))).toBeDefined();
      expect(sink).toHaveBeenCalledWith(expect.objectContaining({ costUsd: TURN_COST }));
    } finally {
      await scheduler.stop();
    }
  });
});

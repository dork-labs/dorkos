/**
 * The teammate's mark follows every path a turn passes work on by (DOR-3036), past the room
 * mention (that one, through the real room service, is `rooms/__tests__/room-teammate-hop.test.ts`).
 *
 * The mark is a record for the space's monthly limit and lowers nothing (DOR-3440). So one mention
 * later, and past it, each next turn stays counted, at its agent's own level:
 *
 * | Path from Bo's turn            | What the next turn gets                       |
 * | ------------------------------ | --------------------------------------------- |
 * | `chat_send` to another chat    | the mark and the space's monthly limit        |
 * | `session_start` spin-off       | the mark and the space's monthly limit        |
 * | a schedule he creates or edits | no park: it settles as any other schedule does |
 *
 * Read through the real level-recording seam and the real teammate meter, wrapped the way the
 * runtime registry wraps every runtime, and the real in-session task tools over a real store.
 *
 * @vitest-environment node
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  lastTurnLevelOf,
  noteEntryLevel,
  markedBoundOf,
  postLevelFor,
  recordTurnLevels,
} from '../turn-levels.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import {
  meterTeammateTurns,
  setTeammateTurnCostSink,
  type TeammateTurnCost,
} from '../teammate-turn-cost.js';
import { ceilingForEntry } from '../../../rooms/limits/turn-ceiling.js';
import { teammateOf } from '../../../rooms/limits/space-teammates.js';
import type { AuthorRegistry } from '../../../rooms/author-registry.js';
import {
  parseCeiling,
  senderCeilingJson,
} from '../../../session/chat-messages/chat-message-ceiling.js';
import { TaskStore } from '../../../tasks/task-store.js';
import {
  createCreateScheduleHandler,
  createUpdateScheduleHandler,
} from '../../../runtimes/claude-code/mcp-tools/task-tools.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';

/** A real, empty data directory: `tasks_create` writes a SKILL.md before the row. */
const tasksHome = mkdtempSync(path.join(os.tmpdir(), 'dorkos-teammate-mark-tasks-'));

/** What the in-session task tools need, over a real store. */
function scheduleDeps(store: TaskStore): McpToolDeps {
  return {
    transcriptReader: { listSessions: async () => [] },
    defaultCwd: tasksHome,
    dorkHome: tasksHome,
    taskStore: store,
  } as unknown as McpToolDeps;
}

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
    ...ceilingForEntry(AUTHORS, priyaEntry, false, SPACE_ROOM),
    unattended: true,
    roomTurn: { roomId: SPACE_ROOM, authorId: 'ana', turnId: 't-ana', ...anaTeammate },
  });

  const post = fresh('ana-post');
  noteEntryLevel(post, postLevelFor([ana]));
  const anaEntry = { id: post, authorId: 'ana' };
  const bo = fresh('bo');
  await run(runtime, bo, {
    ...ceilingForEntry(AUTHORS, anaEntry, false, SPACE_ROOM),
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

describe('one mention later, nothing is lowered', () => {
  it('Bo runs at full reach and still carries the teammate’s mark', async () => {
    const { runtime } = decorated();
    const bo = await teammateThenMention(runtime);
    expect(lastTurnLevelOf(bo)).toMatchObject({ asks: 'never', reach: 'everything' });
    expect(lastTurnLevelOf(bo)?.outsider).toBeUndefined();
    expect(teammateMarkOf(lastTurnLevelOf(bo))).toEqual([
      { roomId: SPACE_ROOM, authorId: 'priya' },
    ]);
    // Ana's turn and Bo's, each counted against the space.
    expect(sink).toHaveBeenCalledTimes(2);
  });
});

describe('one mention later, the teammate mark still carries (DOR-3036)', () => {
  it('chat_send: the chat Bo writes to runs as the teammate’s, and is counted', async () => {
    const { runtime } = decorated();
    const bo = await teammateThenMention(runtime);
    sink.mockClear();
    // What `chat_send` stores as the queue row's ceiling; the dispatcher launches under it.
    const stored = parseCeiling(
      senderCeilingJson(
        { turnLevelOf: lastTurnLevelOf },
        { sessionId: bo, agentPath: '/agents/bo' }
      )
    );
    const cy = fresh('cy');
    await run(runtime, cy, { permissionCeiling: stored! });

    expect(teammateMarkOf(lastTurnLevelOf(cy))).toBeDefined();
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ costUsd: TURN_COST }));
  });

  it('session_start: the chat Bo spins off runs as the teammate’s, and is counted', async () => {
    const { runtime } = decorated();
    const bo = await teammateThenMention(runtime);
    sink.mockClear();
    // What `session_start` sends as the new chat's first-turn ceiling (`outsiderStartCeiling`).
    const bound = markedBoundOf(bo, '/agents/bo');
    expect(bound).toBeDefined();
    const child = fresh('child');
    await run(runtime, child, { permissionCeiling: bound! });

    expect(teammateMarkOf(lastTurnLevelOf(child))).toBeDefined();
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ costUsd: TURN_COST }));
  });

  it('a schedule Bo creates does not park for the mark, and keeps none', async () => {
    const { runtime } = decorated();
    const bo = await teammateThenMention(runtime);
    const store = new TaskStore(createTestDb());
    const create = createCreateScheduleHandler(scheduleDeps(store), () => ({
      sessionId: bo,
      agentPath: '/agents/bo',
    }));

    const reply = JSON.parse(
      (
        await create({
          name: 'Nightly build check',
          prompt: 'check the build',
          cron: '0 3 * * *',
          target: 'global',
          reason: 'Priya asked for a nightly check.',
        })
      ).content[0]!.text
    ) as { schedule: { id: string } };
    const made = store.getTask(reply.schedule.id)!;
    // An unread preset is Trusted, which arms it: only a mark that holds could park it here.
    expect(made.status).toBe('active');
    expect(made.originMarks).toBeNull();
  });

  it('an edit from a marked turn leaves an armed schedule armed', async () => {
    const { runtime } = decorated();
    const bo = await teammateThenMention(runtime);
    const store = new TaskStore(createTestDb());
    const armed = store.createTask({
      name: 'nightly-build-check',
      description: 'armed by the owner',
      prompt: 'check the build',
      cron: '0 3 * * *',
      filePath: path.join(tasksHome, 'nightly-build-check', 'SKILL.md'),
    });
    expect(store.getTask(armed.id)!.status).toBe('active');
    const update = createUpdateScheduleHandler(scheduleDeps(store), () => ({
      sessionId: bo,
      agentPath: '/agents/bo',
    }));
    const reply = JSON.parse((await update({ id: armed.id, enabled: true })).content[0]!.text) as {
      needsReapproval?: boolean;
    };
    expect(reply.needsReapproval).toBeUndefined();
    expect(store.getTask(armed.id)).toMatchObject({ status: 'active', originMarks: null });
  });
});

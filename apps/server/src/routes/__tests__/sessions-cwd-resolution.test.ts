/**
 * @vitest-environment node
 *
 * Which directory `POST /api/sessions/:id/messages` runs a turn in.
 *
 * Asserted at the seam that decides it: the `cwd` on the `MessageOpts` the
 * runtime's `sendMessage` was handed. Everything upstream of that is the
 * precedence chain's own business and is covered by
 * `services/workspace/__tests__/resolve-session-cwd.test.ts`; what this file
 * pins is the WIRING — that the route asks the chain, that a caller who already
 * named a directory is untouched by it, and that a turn with no opinion still
 * acquires none.
 *
 * The last of those is the migration guarantee, and it is the row most likely to
 * regress: `effectiveCwd` is also what stamps `projector.cwd`, so a chain that
 * answered `DEFAULT_CWD` instead of staying silent would pin an agent-less
 * session's liveness to the wrong directory. Those rows assert the ABSENCE of
 * the key rather than an `undefined` value — `toBeUndefined()` passes just as
 * happily on `{ cwd: undefined }`, which is a different thing to hand a runtime.
 *
 * The last describe holds the behavioral half of the subagent invariant (spec
 * §3.4). Its structural half — the import-graph guard — is
 * `services/workspace/__tests__/resolve-session-cwd.subagent.test.ts`, whose
 * header explains why the invariant needs both.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AgentManifest, AgentWorkspaceBinding } from '@dorkos/shared/mesh-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

/** Shared between the `vi.mock` factories and the test body (see sessions.test.ts). */
let fakeRuntime: FakeAgentRuntime;
/** What the manifest reader answers for the agent directory under test. */
let manifestBinding: AgentWorkspaceBinding | null = null;
/** What `session_metadata.agent_path` says this session was bound with. */
let sessionAgentPath: string | null = null;
/** What `WorkspaceManager.ensure` returns for a `managed` binding. */
let ensuredWorkspacePath = '/mock/home/workspaces/dorkos/agent-api-bot';
/** When set, `ensure` throws it instead of answering — the provisioning-failure rows. */
let ensureFailure: Error | null = null;

/**
 * The one `WorkspaceManager.ensure` spy, hoisted so a test can COUNT it.
 *
 * Built here rather than inside the `getWorkspaceManager` factory because a
 * fresh `vi.fn()` per call cannot answer "was this provisioned once and reused,
 * or provisioned twice?" — which is the whole managed-reuse row.
 */
const { ensureSpy, resolveSpy } = vi.hoisted(() => ({
  ensureSpy: vi.fn(),
  /** Counts entries into the cwd chain — the subagent invariant's counter. */
  resolveSpy: vi.fn(),
}));

// Wraps the REAL resolver rather than replacing it: every row below still
// exercises the actual precedence chain, and `resolveSpy` only counts the
// entries. A stub would turn this whole file into a test of its own fixture.
vi.mock('../../services/workspace/resolve-session-cwd.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/workspace/resolve-session-cwd.js')>();
  return {
    ...actual,
    resolveSessionCwd: (...args: Parameters<typeof actual.resolveSessionCwd>) => {
      resolveSpy(...args);
      return actual.resolveSessionCwd(...args);
    },
  };
});

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    listRuntimes: vi.fn(() => [fakeRuntime]),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'claude-code'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'claude-code'),
    persistSessionRuntime: vi.fn(async () => true),
    getSessionAgentPath: vi.fn(async () => sessionAgentPath),
    has: vi.fn(() => true),
    getSessionSettings: vi.fn(async () => null),
    saveSessionSettings: vi.fn(async () => {}),
    getSessionSettingsMany: vi.fn(() => new Map()),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(async (): Promise<AgentManifest | null> =>
    manifestBinding
      ? ({
          id: '01HV7KJZZZ0000000000000000',
          name: 'api-bot',
          description: '',
          runtime: 'claude-code',
          capabilities: [],
          behavior: { responseMode: 'always' },
          registeredAt: '2026-08-27T00:00:00.000Z',
          registeredBy: 'test',
          personaEnabled: true,
          isSystem: false,
          enabledToolGroups: {},
          mcpServers: [],
          workspace: manifestBinding,
        } as AgentManifest)
      : null
  ),
}));

vi.mock('../../services/workspace/index.js', () => ({
  getWorkspaceManager: vi.fn(() => ({ ensure: ensureSpy })),
}));

import { createServer } from 'node:http';
import { once } from 'node:events';
import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import { disposeProjector } from '../../services/session/session-state-projector.js';
import { logger } from '../../lib/logger.js';
import type { AuthorRecord } from '../../services/rooms/author-registry.js';
import type { RoomWorktreeManager } from '../../services/rooms/repo/room-worktree-manager.js';
import { RoomError } from '../../services/rooms/room-errors.js';
import { roomSessionPlace } from '../../services/rooms/repo/room-worktree-cwd.js';

const app = createApp();
finalizeApp(app);
const server = createServer(app);

const S1 = '00000000-0000-4000-8000-0000000000c1';
const S2 = '00000000-0000-4000-8000-0000000000c2';
const AGENT = '/mock/home/agents/api-bot';
const CHECKOUT = '/mock/home/workspaces/dorkos/agent-api-bot';
const WORKTREE = '/mock/home/rooms/room-1/worktrees/api-bot-1a2b3c4d';

/** The `(room, agent)` binding the ledger answers with, or `undefined` for none. */
let roomBinding: { roomId: string; authorId: string; sessionId: string } | undefined;
/** The author row `authorId` resolves to — the room's own label for the agent. */
let roomAuthor: AuthorRecord | null = null;
/** What the worktree manager does when the room rung asks it for a working copy. */
let ensureWorktree: (agentName: string) => Promise<{ path: string }> = () =>
  Promise.resolve({ path: WORKTREE });

/** An agent author row, minus the render fields nothing here reads. */
function agentAuthor(displayName: string): AuthorRecord {
  return {
    id: 'author-1',
    kind: 'agent',
    naturalKey: AGENT,
    displayName,
    handle: null,
    emoji: null,
    color: null,
    imageUrl: null,
    mintedForManifestId: null,
    retiredAt: null,
  } as AuthorRecord;
}

beforeAll(async () => {
  server.listen(0);
  await once(server, 'listening');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** POST one message, without waiting for the detached turn. */
async function send(
  body: Record<string, unknown> = {},
  sessionId = S1
): Promise<{ status: number }> {
  const res = await request(server)
    .post(`/api/sessions/${sessionId}/messages`)
    .send({ content: 'hi', ...body });
  return { status: res.status };
}

/**
 * Post one message and return the `MessageOpts` the runtime was handed.
 *
 * The route answers `202` before the turn runs (ADR-0264), so an assertion made
 * the instant the response lands would read an empty spy and pass for the wrong
 * reason. `vi.waitFor` is what makes "the runtime was never told" distinguishable
 * from "the runtime has not been told YET".
 *
 * @param body - The request body, minus `content`.
 */
async function sendAndCapture(
  body: Record<string, unknown> = {}
): Promise<MessageOpts | undefined> {
  await send(body);
  await vi.waitFor(() => expect(fakeRuntime.sendMessage).toHaveBeenCalled());
  return fakeRuntime.sendMessage.mock.calls[0]?.[2];
}

beforeEach(() => {
  fakeRuntime = new FakeAgentRuntime('claude-code');
  manifestBinding = null;
  sessionAgentPath = null;
  ensuredWorkspacePath = CHECKOUT;
  ensureFailure = null;
  vi.clearAllMocks();
  ensureSpy.mockImplementation(async () => {
    if (ensureFailure) throw ensureFailure;
    return { id: 'ws_1', path: ensuredWorkspacePath };
  });
  fakeRuntime.acquireLock.mockReturnValue(true);
  roomBinding = undefined;
  roomAuthor = agentAuthor('API Bot');
  ensureWorktree = () => Promise.resolve({ path: WORKTREE });
  // The REAL port, over fake reads — so the lookup, the author-kind guard and
  // the `NOT_A_PROJECT_ROOM` translation are the shipped ones and only the
  // database and git are stood in for.
  app.locals.roomSessionPlace = roomSessionPlace({
    bindings: { bindingForSession: () => roomBinding },
    authors: { getById: () => roomAuthor },
    worktrees: () =>
      ({
        ensureWorktree: (_roomId: string, _agentPath: string, agentName: string) =>
          ensureWorktree(agentName),
      }) as unknown as RoomWorktreeManager,
  });
  disposeProjector(S1);
  disposeProjector(S2);
});

describe('POST /:id/messages — where the turn runs', () => {
  it('a caller that names a cwd runs there, whatever the binding says', async () => {
    manifestBinding = { mode: 'managed', source: '/repos/dorkos' };

    const opts = await sendAndCapture({ cwd: '/work/thing', agentPath: AGENT });

    expect(opts?.cwd).toBe('/work/thing');
  });

  // The migration guarantee. The KEY must be absent, not merely undefined:
  // every runtime falls back to `DEFAULT_CWD` on an absent cwd, and staying
  // silent is what keeps an agent-less session's projector unstamped.
  it('a caller with no cwd and no agent says nothing about the directory', async () => {
    const opts = await sendAndCapture();

    expect(opts).not.toHaveProperty('cwd');
  });

  it('an agent with the default binding runs in its own folder', async () => {
    manifestBinding = { mode: 'home' };

    const opts = await sendAndCapture({ agentPath: AGENT });

    expect(opts?.cwd).toBe(AGENT);
  });

  it('an agent with a managed binding runs in its checkout', async () => {
    manifestBinding = { mode: 'managed', source: '/repos/dorkos' };

    const opts = await sendAndCapture({ agentPath: AGENT });

    expect(opts?.cwd).toBe(CHECKOUT);
  });

  it('an agent that asked for no binding leaves the directory unspoken', async () => {
    manifestBinding = { mode: 'none' };

    const opts = await sendAndCapture({ agentPath: AGENT });

    expect(opts).not.toHaveProperty('cwd');
  });

  it('falls back to the directory the session was bound with', async () => {
    manifestBinding = { mode: 'home' };
    sessionAgentPath = AGENT;

    const opts = await sendAndCapture();

    expect(opts?.cwd).toBe(AGENT);
  });

  // `workspaceKey` is a per-turn statement about this piece of work, which is
  // strictly more specific than a standing per-agent preference.
  it('a workspaceKey still overrides the agent binding', async () => {
    manifestBinding = { mode: 'home' };
    ensuredWorkspacePath = '/mock/home/workspaces/dorkos/DOR-1';

    const opts = await sendAndCapture({
      cwd: '/repos/dorkos',
      workspaceKey: 'DOR-1',
      agentPath: AGENT,
    });

    expect(opts?.cwd).toBe('/mock/home/workspaces/dorkos/DOR-1');
  });

  it('a turn whose binding cannot be honored still runs, in the agent folder', async () => {
    // No manifest at all — the directory is claimed as an agent's and reads as
    // one anyway, because that is what an absent `workspace` field means.
    manifestBinding = null;

    const opts = await sendAndCapture({ agentPath: AGENT });

    expect(opts?.cwd).toBe(AGENT);
  });
});

describe('POST /:id/messages — a managed binding across turns', () => {
  // Spec `agent-workspace-binding` §3.5: `ensure` is idempotent on
  // `(projectKey, key)`, so a second turn asks again and gets the same tree
  // back. What must NOT happen is a second turn deriving a different key.
  it('provisions on the first turn and reuses on the second', async () => {
    manifestBinding = { mode: 'managed', source: '/repos/dorkos' };

    await send({ agentPath: AGENT }, S1);
    await vi.waitFor(() => expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(1));
    await send({ agentPath: AGENT }, S2);
    await vi.waitFor(() => expect(fakeRuntime.sendMessage).toHaveBeenCalledTimes(2));

    expect(ensureSpy).toHaveBeenCalledTimes(2);
    // Same `(projectKey, key)` both times — one workspace, asked for twice.
    expect(ensureSpy.mock.calls[0]?.[0]).toEqual(ensureSpy.mock.calls[1]?.[0]);
    expect(fakeRuntime.sendMessage.mock.calls[0]?.[2]?.cwd).toBe(CHECKOUT);
    expect(fakeRuntime.sendMessage.mock.calls[1]?.[2]?.cwd).toBe(CHECKOUT);
  });

  // Failure never fails the turn (spec §3.3). A port pool with nothing free, a
  // git failure, a source repo that has moved — the turn still has to run.
  it('a provisioning failure is a 202 in the agent folder, never a 500', async () => {
    manifestBinding = { mode: 'managed', source: '/repos/dorkos' };
    ensureFailure = new Error('no free port block');

    const res = await send({ agentPath: AGENT });
    await vi.waitFor(() => expect(fakeRuntime.sendMessage).toHaveBeenCalled());

    expect(res.status).toBe(202);
    expect(fakeRuntime.sendMessage.mock.calls[0]?.[2]?.cwd).toBe(AGENT);
  });

  // Observability is a deliverable here, not a nicety: a precedence chain that
  // cannot be interrogated is worse than the one-rung chain it replaced, and
  // "why is my agent writing there" is the question this line exists to answer.
  it('names the winning rung in the log', async () => {
    const info = vi.spyOn(logger, 'info');
    manifestBinding = { mode: 'home' };

    await sendAndCapture({ agentPath: AGENT });

    const line = info.mock.calls.find(([msg]) => msg === '[cwd] resolved');
    expect(line?.[1]).toMatchObject({ rung: 'agent-home', cwd: AGENT, sessionId: S1 });
    info.mockRestore();
  });
});

/**
 * A room conversation picked up in the app (DOR-1624).
 *
 * The defect these rows close: the same conversation has two turn boundaries —
 * the room's own dispatcher and this route — and only the first offered the
 * chain a `room`. So an operator resuming a project-room conversation here ran
 * in the agent's own folder while every room turn ran in the room's worktree,
 * and the agent's uncommitted work was on disk and invisible.
 *
 * The rows below are the four cases that decide whether the two paths agree,
 * and the second is the one most likely to break: a person who names a
 * directory still outranks the room.
 */
describe('POST /:id/messages — a room-bound session', () => {
  it('resumes in the room worktree, not the agent folder', async () => {
    manifestBinding = { mode: 'home' };
    sessionAgentPath = AGENT;
    roomBinding = { roomId: 'room-1', authorId: 'author-1', sessionId: S1 };

    const opts = await sendAndCapture();

    expect(opts?.cwd).toBe(WORKTREE);
  });

  it('still yields to a caller that names a directory', async () => {
    manifestBinding = { mode: 'home' };
    sessionAgentPath = AGENT;
    roomBinding = { roomId: 'room-1', authorId: 'author-1', sessionId: S1 };

    const opts = await sendAndCapture({ cwd: '/work/thing' });

    expect(opts?.cwd).toBe('/work/thing');
  });

  // A room with no files of its own is the ordinary case, and the manager says
  // so by throwing. Nothing relocates: the turn runs where it ran before this
  // rung existed.
  it('runs in the agent folder when the room has no files of its own', async () => {
    manifestBinding = { mode: 'home' };
    sessionAgentPath = AGENT;
    roomBinding = { roomId: 'room-1', authorId: 'author-1', sessionId: S1 };
    ensureWorktree = () =>
      Promise.reject(
        new RoomError('NOT_A_PROJECT_ROOM', 'This room does not have files of its own.')
      );

    const opts = await sendAndCapture();

    expect(opts?.cwd).toBe(AGENT);
  });

  // The label is the readable half of the worktree's directory name, so the two
  // paths have to read it from the same place. This row is what would fail if
  // this one started deriving it from the manifest instead of the author row.
  it('asks for the working copy under the label the room shows', async () => {
    const asked = vi.fn(() => Promise.resolve({ path: WORKTREE }));
    manifestBinding = { mode: 'home' };
    sessionAgentPath = AGENT;
    roomAuthor = agentAuthor('Ana the Reviewer');
    roomBinding = { roomId: 'room-1', authorId: 'author-1', sessionId: S1 };
    ensureWorktree = asked;

    await sendAndCapture();

    expect(asked).toHaveBeenCalledWith('Ana the Reviewer');
  });

  it('leaves a session no room answers with exactly as it was', async () => {
    manifestBinding = { mode: 'home' };
    sessionAgentPath = AGENT;

    const opts = await sendAndCapture();

    expect(opts?.cwd).toBe(AGENT);
  });
});

describe('the subagent invariant — a turn resolves its directory once (spec §3.4)', () => {
  /**
   * A turn that delegates to a subagent: a `Task` tool call wrapping a sidechain
   * that runs its own tools and reports back.
   *
   * A claude-code subagent is an SDK sidechain inside the parent's `query` and
   * inherits the parent process's cwd by construction — nothing in the path
   * re-enters session creation. This scenario is what makes that claim testable
   * rather than merely asserted: if a future "resolve per tool call" convenience
   * were added, these events are what would trigger the second resolution.
   *
   * @param done - Called after the terminal event, so the test can await the
   *   whole sidechain rather than racing it.
   */
  function taskSidechain(done: () => void) {
    return async function* (): AsyncGenerator<StreamEvent> {
      const ev = (type: string, data: unknown): StreamEvent => ({ type, data }) as StreamEvent;
      // The parent opens a Task tool call...
      yield ev('tool_call', {
        toolCallId: 'tc-task',
        toolName: 'Task',
        input: JSON.stringify({ subagent_type: 'general-purpose', prompt: 'look around' }),
        status: 'running',
      });
      yield ev('background_task_started', {
        taskId: 'bt-1',
        taskType: 'subagent',
        startedAt: Date.now(),
        toolUseId: 'tc-task',
        description: 'look around',
      });
      // ...the sidechain does its own work, on the parent's cwd by construction...
      yield ev('subagent_text_delta', { parentToolUseId: 'tc-task', text: 'reading' });
      yield ev('tool_call', {
        toolCallId: 'tc-read',
        toolName: 'Read',
        result: 'file contents',
        status: 'complete',
      });
      yield ev('background_task_done', {
        taskId: 'bt-1',
        status: 'completed',
        toolUses: 1,
        summary: 'had a look',
      });
      // ...and the parent's Task call closes over it.
      yield ev('tool_call', {
        toolCallId: 'tc-task',
        toolName: 'Task',
        result: 'had a look',
        status: 'complete',
      });
      yield ev('text_delta', { text: 'done' });
      yield ev('done', {});
      done();
    };
  }

  it('resolves exactly once across a turn containing a Task sidechain', async () => {
    manifestBinding = { mode: 'home' };
    let finished!: () => void;
    const turnOver = new Promise<void>((resolve) => {
      finished = resolve;
    });
    fakeRuntime.withScenarios([taskSidechain(finished)]);

    await send({ agentPath: AGENT });
    await turnOver;

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    // And the sidechain really did run — otherwise "resolved once" would be
    // true of a turn that never delegated, and the row would prove nothing.
    expect(fakeRuntime.sendMessage.mock.calls[0]?.[2]?.cwd).toBe(AGENT);
  });

  it('resolves exactly once for a turn that already names its directory', async () => {
    let finished!: () => void;
    const turnOver = new Promise<void>((resolve) => {
      finished = resolve;
    });
    fakeRuntime.withScenarios([taskSidechain(finished)]);

    await send({ cwd: '/work/thing' });
    await turnOver;

    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  // The route writes `effectiveCwd` from two mutually exclusive branches — the
  // `workspaceKey` block and the chain. A refactor that let both run would
  // resolve twice, and this is the row that would say so.
  it('resolves at most once when a workspaceKey is also supplied', async () => {
    manifestBinding = { mode: 'home' };

    await sendAndCapture({ cwd: '/repos/dorkos', workspaceKey: 'DOR-1', agentPath: AGENT });

    expect(resolveSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

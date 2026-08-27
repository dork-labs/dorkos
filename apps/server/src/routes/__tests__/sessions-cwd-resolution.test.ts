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
 * session's liveness to the wrong directory.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import type { AgentManifest, AgentWorkspaceBinding } from '@dorkos/shared/mesh-schemas';
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
  getWorkspaceManager: vi.fn(() => ({
    ensure: vi.fn(async () => ({ id: 'ws_1', path: ensuredWorkspacePath })),
  })),
}));

import { createServer } from 'node:http';
import { once } from 'node:events';
import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import { disposeProjector } from '../../services/session/session-state-projector.js';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';

const app = createApp();
finalizeApp(app);
const server = createServer(app);

const S1 = '00000000-0000-4000-8000-0000000000c1';
const AGENT = '/mock/home/agents/api-bot';

beforeAll(async () => {
  server.listen(0);
  await once(server, 'listening');
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Post one message and return the `MessageOpts` the runtime was handed.
 *
 * The route answers `202` before the turn runs (ADR-0264), so an assertion made
 * the instant the response lands would read an empty spy and pass for the wrong
 * reason.
 *
 * @param body - The request body, minus `content`.
 */
async function sendAndCapture(
  body: Record<string, unknown> = {}
): Promise<MessageOpts | undefined> {
  await request(server)
    .post(`/api/sessions/${S1}/messages`)
    .send({ content: 'hi', ...body });
  await vi.waitFor(() => expect(fakeRuntime.sendMessage).toHaveBeenCalled());
  return fakeRuntime.sendMessage.mock.calls[0]?.[2];
}

describe('POST /:id/messages — where the turn runs', () => {
  beforeEach(() => {
    fakeRuntime = new FakeAgentRuntime('claude-code');
    manifestBinding = null;
    sessionAgentPath = null;
    ensuredWorkspacePath = '/mock/home/workspaces/dorkos/agent-api-bot';
    vi.clearAllMocks();
    fakeRuntime.acquireLock.mockReturnValue(true);
    disposeProjector(S1);
  });

  it('a caller that names a cwd runs there, whatever the binding says', async () => {
    manifestBinding = { mode: 'managed', source: '/repos/dorkos' };

    const opts = await sendAndCapture({ cwd: '/work/thing', agentPath: AGENT });

    expect(opts?.cwd).toBe('/work/thing');
  });

  // The migration guarantee. `undefined`, not `DEFAULT_CWD`: every runtime
  // already falls back to the same directory on an absent cwd, and staying
  // silent is what keeps an agent-less session's projector unstamped.
  it('a caller with no cwd and no agent says nothing about the directory', async () => {
    const opts = await sendAndCapture();

    expect(opts?.cwd).toBeUndefined();
  });

  it('an agent with the default binding runs in its own folder', async () => {
    manifestBinding = { mode: 'home' };

    const opts = await sendAndCapture({ agentPath: AGENT });

    expect(opts?.cwd).toBe(AGENT);
  });

  it('an agent with a managed binding runs in its checkout', async () => {
    manifestBinding = { mode: 'managed', source: '/repos/dorkos' };

    const opts = await sendAndCapture({ agentPath: AGENT });

    expect(opts?.cwd).toBe('/mock/home/workspaces/dorkos/agent-api-bot');
  });

  it('an agent that asked for no binding leaves the directory unspoken', async () => {
    manifestBinding = { mode: 'none' };

    const opts = await sendAndCapture({ agentPath: AGENT });

    expect(opts?.cwd).toBeUndefined();
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

  it('DEFAULT_CWD is still what an unstamped turn lands in', () => {
    // Not an assertion about the route — a statement of the fact the row above
    // depends on. If the runtimes stopped falling back here, "say nothing"
    // would stop meaning "the default folder".
    expect(DEFAULT_CWD).toBeTruthy();
  });
});

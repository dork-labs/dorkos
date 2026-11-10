/**
 * @vitest-environment node
 *
 * Who a chat started over HTTP runs as (DOR-3644, Security's review
 * `agent-identity-extension-calls`). A turn's identity comes from the folder
 * it stands in, so `POST /api/sessions/:id/messages` and `POST /:id/fork` ask
 * the same question `session_start` asks: an agent may start work only in its
 * own home (or a workspace or worktree of it) or a folder no agent owns, never
 * in another agent's folder or chat; a caller DorkOS cannot name may use no
 * agent's folder at all; a person is unchanged.
 *
 * The launch service runs for real. Only the dispatcher, the runtime registry
 * and the folder resolution chain are stubbed, so "refused" means nothing was
 * dispatched.
 */
import { execFileSync } from 'node:child_process';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';
import {
  PROTECTED_DEFAULT_FOLDER_MESSAGE,
  PROTECTED_FOLDER_MESSAGE,
} from '../../services/session/launch/launch-caller.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { MeshCore } from '@dorkos/mesh';

const owner = vi.hoisted(() => ({ current: { id: 'user_owner' } as { id: string } | null }));

vi.mock('../../lib/boundary.js', () => ({
  // The protected-folder rule finds the home folder through this (DOR-4060).
  expandTilde: (p: string) => (p === '~' ? (process.env.HOME ?? '/') : p),
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/'),
  initBoundary: vi.fn().mockResolvedValue('/'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code = 'OUTSIDE_BOUNDARY';
  },
}));

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    getNativeSessionCwd: vi.fn(() => null),
    get: vi.fn(() => fakeRuntime),
    getDefault: vi.fn(() => fakeRuntime),
    getDefaultType: vi.fn(() => 'fake'),
    has: vi.fn(() => true),
    persistSessionRuntime: vi.fn(async () => true),
    resolveForSession: vi.fn(async () => fakeRuntime),
    resolveForSessionWithOwnership: vi.fn(async () => ({ runtime: fakeRuntime, bound: false })),
    resolveSessionRuntime: vi.fn(async () => ({ type: 'fake', bound: false })),
    getSessionAgentPath: vi.fn(async () => null),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));
// A plain factory, not `importOriginal`: the gate policy imports this module
// back, and spreading the original hands it the real lookup, not this one.
vi.mock('../../services/core/auth/index.js', () => ({
  readOwnerAccount: () => owner.current,
  hasAnyUser: () => owner.current !== null,
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => null) }));
vi.mock('../../services/core/usage-reporter.js', () => ({ reportUsageEvent: vi.fn() }));
vi.mock('../../services/session/launch/session-exists.js', () => ({
  sessionExists: vi.fn(async () => true),
}));
vi.mock('../../services/workspace/room-session-place.js', () => ({
  resolveSessionCwdWithRoom: vi.fn(async (request: { cwd?: string }) =>
    request.cwd !== undefined ? { cwd: request.cwd, rung: 'explicit' } : { rung: 'default' }
  ),
}));
vi.mock('../../services/session/session-state-projector.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/session/session-state-projector.js')>()),
  getOrCreateProjector: vi.fn(() => ({ cwd: undefined })),
}));
vi.mock('../../services/session/message-dispatcher.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/session/message-dispatcher.js')>()),
  dispatchMessage: vi.fn(async () => ({
    accepted: true,
    canonicalId: 'canon-1',
    outcome: { messageId: 'm-1', requested: 'queue', applied: 'queue' },
    queued: false,
    queuePosition: 0,
  })),
}));

import { Hono } from 'hono';
import type { ApiEnv } from '../../http/api-chain.js';
import { createSessionRoutes } from '../sessions.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { dispatchMessage } from '../../services/session/message-dispatcher.js';
import type { AgentIdentity } from '../../services/core/agent-identity/agent-identity-service.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import {
  initSessionVisibility,
  resetSessionVisibility,
} from '../../services/audit/session-visibility.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../services/core/agent-identity/__tests__/agent-home-fixture.js';
import {
  countWhileRunning,
  resetLiveOutsiderTurns,
} from '../../services/core/turn-power/live-outsider-turns.js';

const SESSION = '00000000-0000-4000-8000-0000000036a4';

let scratch: string;
let homeA: string;
let homeB: string;
let freeFolder: string;
let treeA: string;
let workspaceA: string;

/** Run git with a fixed identity and no host-injected config. */
function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'].concat(
      args
    ),
    { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_COUNT: '0' } }
  );
}

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launch-identity-')));
  homeA = path.join(scratch, 'agent-a');
  homeB = path.join(scratch, 'agent-b');
  freeFolder = path.join(scratch, 'project');
  workspaceA = path.join(scratch, 'workspaces', 'a-feature');
  treeA = path.join(scratch, 'trees', 'a-fix');
  for (const dir of [homeA, homeB, freeFolder, workspaceA]) fs.mkdirSync(dir, { recursive: true });
  git(homeA, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(homeA, 'README.md'), 'a\n');
  git(homeA, 'add', '-A');
  git(homeA, 'commit', '-q', '-m', 'init');
  git(homeA, 'worktree', 'add', '-q', '-b', 'fix', treeA);
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

/** Mesh that knows A and B. */
function mesh(): MeshCore {
  return {
    listWithPaths: () => [
      { id: 'agent-a-id', projectPath: homeA },
      { id: 'agent-b-id', projectPath: homeB },
    ],
  } as unknown as MeshCore;
}

/** The identity A's token resolves to. */
function identityA(): AgentIdentity {
  return { agentPath: homeA, displayName: 'Agent A', createdAt: '2026-11-01T00:00:00.000Z' };
}

interface Caller {
  identity?: AgentIdentity;
  user?: RequestUser;
  headers?: Record<string, string>;
}

/** The session routes behind a stand-in for the chain's identity steps. */
function post(pathAndQuery: string, body: unknown, caller: Caller = {}, method = 'POST') {
  const router = createSessionRoutes({ meshCore: mesh() });
  const app = new Hono<ApiEnv>()
    .use('*', async (c, next) => {
      if (caller.identity) c.set('agentIdentity', caller.identity);
      if (caller.user) c.set('user', caller.user);
      // The chain's body step, which this stand-in replaces.
      c.set('body', body);
      await next();
    })
    .route('/api/sessions', router);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // At this computer: a loopback peer and a loopback Host.
    host: 'localhost:4242',
    ...(caller.identity ? { 'x-dorkos-agent': 'token-a' } : {}),
    ...caller.headers,
  };
  const incoming = { headers, socket: { remoteAddress: '127.0.0.1' } };
  return app.request(
    `/api/sessions/${SESSION}${pathAndQuery}`,
    { method, headers, ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }) },
    { incoming, outgoing: { headersSent: false } } as never
  );
}

const AS_A: Caller = {
  get identity() {
    return identityA();
  },
};
const PERSON: Caller = { user: { userId: 'user_owner', credential: 'cookie' } };

beforeEach(() => {
  vi.clearAllMocks();
  owner.current = { id: 'user_owner' };
  fakeRuntime = new FakeAgentRuntime('fake');
  initSessionVisibility((ids) => new Map(ids.map((id) => [id, 'space'] as const)));
  registerTestHomes([homeA, homeB], { managed: { [workspaceA]: homeA } });
  vi.mocked(runtimeRegistry.resolveForSessionWithOwnership).mockResolvedValue({
    runtime: fakeRuntime as never,
    bound: false,
  });
  vi.mocked(runtimeRegistry.getSessionAgentPath).mockResolvedValue(null);
});

afterEach(() => {
  clearTestHomes();
  resetSessionVisibility();
  resetLiveOutsiderTurns();
});

async function codeOf(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { code?: string }).code;
}

describe('POST /:id/messages from an agent', () => {
  it("refuses A starting a chat in B's home, and dispatches nothing", async () => {
    const res = await post('/messages', { content: 'x', create: true, cwd: homeB }, AS_A);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('DESK_NOT_OWN');
    expect(dispatchMessage).not.toHaveBeenCalled();
    expect(runtimeRegistry.persistSessionRuntime).not.toHaveBeenCalled();
  });

  it("refuses A naming B's home as the chat's agent", async () => {
    const res = await post('/messages', { content: 'x', create: true, agentPath: homeB }, AS_A);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('DESK_NOT_OWN');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['its home', () => homeA],
    ['a worktree of its home', () => treeA],
    ['its managed workspace', () => workspaceA],
    ['a folder no agent owns', () => freeFolder],
  ])('lets A start a chat in %s', async (_name, cwd) => {
    const res = await post('/messages', { content: 'x', create: true, cwd: cwd() }, AS_A);
    expect(res.status).toBe(202);
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('records who launched it on the binding', async () => {
    await post('/messages', { content: 'x', create: true, cwd: homeA }, AS_A);
    expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(
      SESSION,
      'fake',
      { kind: 'agent-launch', launchedBy: 'agent-a-id' },
      homeA
    );
  });

  it('refuses A posting into a chat that runs as B, whatever cwd it names', async () => {
    vi.mocked(runtimeRegistry.resolveForSessionWithOwnership).mockResolvedValue({
      runtime: fakeRuntime as never,
      bound: true,
    });
    fakeRuntime.getSessionCwd = vi.fn(() => freeFolder);
    vi.mocked(runtimeRegistry.getSessionAgentPath).mockResolvedValue(homeB);

    const res = await post('/messages', { content: 'do it as B' }, AS_A);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('DESK_NOT_OWN');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it("refuses A posting into a chat that stands in B's home", async () => {
    vi.mocked(runtimeRegistry.resolveForSessionWithOwnership).mockResolvedValue({
      runtime: fakeRuntime as never,
      bound: true,
    });
    fakeRuntime.getSessionCwd = vi.fn(() => homeB);

    const res = await post('/messages', { content: 'x' }, AS_A);
    expect(res.status).toBe(403);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it("carries A's outsider mark onto the turn it launches", async () => {
    const turn = countWhileRunning(
      { forAgent: homeA },
      { outsider: true },
      (async function* () {
        await new Promise(() => undefined);
      })()
    );
    void turn.next();

    const res = await post('/messages', { content: 'x', create: true, cwd: homeA }, AS_A);
    expect(res.status).toBe(202);
    // The hold rides as a mark, never a ceiling (DOR-3561): the launched turn
    // keeps its level and is refused raises, exactly as `session_start`'s is.
    const sent = vi.mocked(dispatchMessage).mock.calls[0]![0];
    expect(sent.carriedMarks).toEqual({ outsider: true });
    expect(sent.permissionCeiling).toBeUndefined();
  });

  it('carries nothing when none of its turns is marked', async () => {
    await post('/messages', { content: 'x', create: true, cwd: homeA }, AS_A);
    const sent = vi.mocked(dispatchMessage).mock.calls[0]![0];
    expect(sent.permissionCeiling).toBeUndefined();
    expect(sent.carriedMarks).toBeUndefined();
  });
});

describe('POST /:id/messages from a caller DorkOS cannot name', () => {
  it("refuses a token-less caller starting a chat in an agent's home", async () => {
    const res = await post('/messages', { content: 'x', create: true, cwd: homeB });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('DESK_NOT_OWN');
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('refuses one naming any agent as the chat`s agent', async () => {
    const res = await post('/messages', { content: 'x', create: true, agentPath: homeA });
    expect(res.status).toBe(403);
  });

  it('lets it start a chat in a folder no agent owns', async () => {
    const res = await post('/messages', { content: 'x', create: true, cwd: freeFolder });
    expect(res.status).toBe(202);
    expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(
      SESSION,
      'fake',
      { kind: 'agent-launch', launchedBy: 'unidentified' },
      undefined
    );
  });

  it('treats a revoked token as unidentified', async () => {
    const revoked = { ...identityA(), inactive: 'revoked' as const };
    const res = await post(
      '/messages',
      { content: 'x', create: true, cwd: homeA },
      { identity: revoked }
    );
    expect(res.status).toBe(403);
  });
});

describe('POST /:id/messages from a person', () => {
  it("is unchanged: the owner's session may start a chat in any agent's home", async () => {
    const res = await post('/messages', { content: 'x', create: true, cwd: homeB }, PERSON);
    expect(res.status).toBe(202);
    expect(runtimeRegistry.persistSessionRuntime).toHaveBeenCalledWith(
      SESSION,
      'fake',
      { kind: 'interactive' },
      undefined
    );
  });

  it('is unchanged with no owner yet, at this computer', async () => {
    owner.current = null;
    const res = await post('/messages', { content: 'x', create: true, cwd: homeB });
    expect(res.status).toBe(202);
  });
});

describe('POST /:id/fork', () => {
  beforeEach(() => {
    fakeRuntime.forkSession.mockResolvedValue({ id: 'forked' } as never);
    fakeRuntime.getInternalSessionId.mockReturnValue(undefined);
  });

  it("refuses A forking a chat into B's home", async () => {
    const res = await post(`/fork?cwd=${encodeURIComponent(homeB)}`, {}, AS_A);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('DESK_NOT_OWN');
    expect(fakeRuntime.forkSession).not.toHaveBeenCalled();
  });

  it('lets A fork into its own home', async () => {
    const res = await post(`/fork?cwd=${encodeURIComponent(homeA)}`, {}, AS_A);
    expect(res.status).toBe(201);
  });

  it("a fork from A that names no folder runs in A's own home, never the default (DOR-4060)", async () => {
    const res = await post('/fork', {}, AS_A);
    expect(res.status).toBe(201);
    expect(fakeRuntime.forkSession).toHaveBeenCalledWith(
      homeA,
      expect.anything(),
      expect.anything()
    );
  });

  it("lets a person fork into any agent's home", async () => {
    const res = await post(`/fork?cwd=${encodeURIComponent(homeB)}`, {}, PERSON);
    expect(res.status).toBe(201);
  });
});

describe('a message waiting in a chat (DOR-3644 S1)', () => {
  beforeEach(() => {
    vi.mocked(runtimeRegistry.getSessionAgentPath).mockResolvedValue(homeB);
  });

  it("refuses A rewording or moving one in B's chat", async () => {
    const res = await post('/queue/m-1', { content: 'now as B' }, AS_A, 'PATCH');
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('DESK_NOT_OWN');
  });

  it("refuses A removing one from B's chat", async () => {
    const res = await post('/queue/m-1', {}, AS_A, 'DELETE');
    expect(res.status).toBe(403);
  });

  it('lets a person through to the queue, as before', async () => {
    const res = await post('/queue/m-1', { content: 'mine' }, PERSON, 'PATCH');
    // Past the place rule: this queue simply has no such message.
    expect(res.status).toBe(404);
  });
});

describe('UI-action person stamp', () => {
  it.each([
    ['owner app', PERSON, 'person'],
    ['agent tool', AS_A, 'agent'],
  ] as const)('names the %s caller on the dispatched turn', async (_label, caller, turnStarter) => {
    fakeRuntime.hasSession.mockReturnValue(true);
    const res = await post('/ui-action', { actionId: 'sample-action' }, caller);
    expect(res.status).toBe(202);
    expect(dispatchMessage).toHaveBeenCalledWith(expect.objectContaining({ turnStarter }));
  });
});

/**
 * No folder named, and the server's default is the home folder (DOR-4060): the
 * default folder stands in for home here, and nothing is written to it.
 */
describe('a launch or fork that names no folder, when the default is home (DOR-4060)', () => {
  beforeEach(() => {
    vi.stubEnv('HOME', DEFAULT_CWD);
    vi.stubEnv('DORK_HOME', `${DEFAULT_CWD}/.dork-fixture-4060`);
    vi.stubEnv('CLAUDE_CONFIG_DIR', `${DEFAULT_CWD}/.claude-fixture-4060`);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('refuses a token-less new chat with PROTECTED_FOLDER and says to name a folder', async () => {
    const res = await post('/messages', { content: 'x', create: true });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe('PROTECTED_FOLDER');
    expect(body.error).toBe(PROTECTED_DEFAULT_FOLDER_MESSAGE);
    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('refuses a token-less fork the same way', async () => {
    const res = await post('/fork', {});
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe('PROTECTED_FOLDER');
    expect(body.error).toBe(PROTECTED_DEFAULT_FOLDER_MESSAGE);
    expect(fakeRuntime.forkSession).not.toHaveBeenCalled();
  });

  it("lets A's fork land in A's own home", async () => {
    fakeRuntime.forkSession.mockResolvedValue({ id: 'forked' } as never);
    const res = await post('/fork', {}, AS_A);
    expect(res.status).toBe(201);
    expect(fakeRuntime.forkSession).toHaveBeenCalledWith(
      homeA,
      expect.anything(),
      expect.anything()
    );
  });

  it('names the plain refusal, not the hint, when a folder was named', async () => {
    const res = await post('/messages', { content: 'x', create: true, cwd: DEFAULT_CWD });
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe('PROTECTED_FOLDER');
    expect(body.error).toBe(PROTECTED_FOLDER_MESSAGE);
  });
});

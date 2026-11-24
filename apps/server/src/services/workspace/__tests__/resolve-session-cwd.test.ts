/**
 * The precedence chain as a table: {cwd present/absent} × {agentPath given /
 * from session metadata / absent} × {home / managed / none / unreadable}.
 *
 * Every row must be able to fail. The `explicit`-wins rows are the ones that
 * catch a regression in the migration guarantee — they are why a turn that
 * already names its directory is untouched by any of this.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentManifest, AgentWorkspaceBinding } from '@dorkos/shared/mesh-schemas';
import type { Workspace } from '@dorkos/shared/workspace';
import {
  resolveSessionCwd,
  agentWorkspaceKey,
  type ResolveSessionCwdDeps,
} from '../resolve-session-cwd.js';

const DEFAULT = '/vault';
const AGENT = '/vault/agents/api-bot';

function manifest(workspace: AgentWorkspaceBinding, name = 'api-bot'): AgentManifest {
  return {
    id: '01HV7KJZZZ0000000000000000',
    name,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-08-27T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    isSystem: false,
    mcpServers: [],
    workspace,
  };
}

function workspaceRow(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws_1',
    projectKey: 'dorkos',
    key: 'agent-api-bot-deadbeef',
    path: '/vault/workspaces/dorkos/agent-api-bot-deadbeef',
    source: '/vault/dorkos',
    branch: 'dork/agent-api-bot-deadbeef',
    provider: 'worktree',
    status: 'ready',
    portBase: 4250,
    portBlockSize: 10,
    hostname: null,
    url: null,
    pinned: false,
    owner: { kind: 'agent', ref: AGENT },
    createdAt: '2026-08-27T00:00:00.000Z',
    lastUsedAt: '2026-08-27T00:00:00.000Z',
    ...over,
  };
}

function makeDeps(over: Partial<ResolveSessionCwdDeps> = {}): ResolveSessionCwdDeps {
  return {
    readManifest: vi.fn(async () => manifest({ mode: 'home' })),
    ensureWorkspace: vi.fn(async () => workspaceRow()),
    sessionAgentPath: vi.fn(async () => null),
    // The real validators canonicalize; the fakes are identity so a test row
    // fails for the reason it is about, never for a temp-dir realpath.
    validateAgentHome: vi.fn(async (p: string) => p),
    validateManagedCheckout: vi.fn(async (p: string) => p),
    // Identity by default; the canonicalization rows below inject a fake that
    // actually collapses, so every OTHER row fails for its own reason.
    canonicalize: vi.fn(async (p: string) => p),
    defaultCwd: DEFAULT,
    ...over,
  };
}

describe('resolveSessionCwd — rung 1, explicit', () => {
  it('an explicit cwd wins over every binding, and nothing else is read', async () => {
    const deps = makeDeps({ readManifest: vi.fn(async () => manifest({ mode: 'none' })) });

    const result = await resolveSessionCwd(
      { cwd: '/somewhere/else', agentPath: AGENT, sessionId: 'ses-1' },
      deps
    );

    expect(result).toEqual({ cwd: '/somewhere/else', rung: 'explicit' });
    expect(deps.readManifest).not.toHaveBeenCalled();
    expect(deps.sessionAgentPath).not.toHaveBeenCalled();
  });

  it('an explicit cwd is passed through untouched, not boundary-rewritten', async () => {
    const deps = makeDeps({
      validateAgentHome: vi.fn(async () => '/canonical'),
      validateManagedCheckout: vi.fn(async () => '/canonical'),
    });

    const result = await resolveSessionCwd({ cwd: '/raw/../raw/path' }, deps);

    expect(result.cwd).toBe('/raw/../raw/path');
    expect(deps.validateAgentHome).not.toHaveBeenCalled();
  });
});

describe('resolveSessionCwd — rung 3, the agent binding', () => {
  it('home resolves to the agent directory', async () => {
    const deps = makeDeps();

    const result = await resolveSessionCwd({ agentPath: AGENT }, deps);

    expect(result).toEqual({ cwd: AGENT, rung: 'agent-home' });
    expect(deps.validateAgentHome).toHaveBeenCalledWith(AGENT);
  });

  it('managed provisions from the binding source and answers with the checkout', async () => {
    const deps = makeDeps({
      readManifest: vi.fn(async () =>
        manifest({ mode: 'managed', source: '/vault/dorkos', provider: 'clone' })
      ),
    });

    const result = await resolveSessionCwd({ agentPath: AGENT }, deps);

    expect(result).toEqual({
      cwd: '/vault/workspaces/dorkos/agent-api-bot-deadbeef',
      rung: 'agent-managed',
      workspaceId: 'ws_1',
    });
    // The second argument is the turn's chat, so a chat set to Full is made without limits.
    expect(deps.ensureWorkspace).toHaveBeenCalledWith(
      {
        projectKey: 'dorkos',
        key: agentWorkspaceKey('api-bot', AGENT, '/vault/dorkos').key,
        source: '/vault/dorkos',
        provider: 'clone',
        owner: { kind: 'agent', ref: AGENT },
      },
      undefined
    );
  });
});

describe('resolveSessionCwd — rung 4, and never failing the turn', () => {
  // Degradation goes ONE rung, to the agent's own folder. Reaching here means
  // the caller already knows where the agent lives, so answering `DEFAULT_CWD`
  // would move its work into the shared tree over an unreadable file — the
  // collision the whole chain exists to stop.
  it('an unreadable manifest reads as home, saying why', async () => {
    const deps = makeDeps({ readManifest: vi.fn(async () => null) });

    const result = await resolveSessionCwd({ agentPath: AGENT }, deps);

    expect(result.rung).toBe('agent-home');
    expect(result.cwd).toBe(AGENT);
    expect(result.degraded).toMatch(/no readable agent manifest/);
  });

  it('an agent home outside the boundary is refused, not used', async () => {
    const deps = makeDeps({
      validateAgentHome: vi.fn(async () => {
        throw new Error('Access denied: path outside directory boundary');
      }),
    });

    const result = await resolveSessionCwd({ agentPath: '/etc' }, deps);

    expect(result.cwd).toBe(DEFAULT);
    expect(result.rung).toBe('default');
    expect(result.degraded).toMatch(/out of bounds/);
  });

  it('a managed binding whose provisioning throws falls back to the agent folder', async () => {
    const deps = makeDeps({
      readManifest: vi.fn(async () => manifest({ mode: 'managed', source: '/vault/dorkos' })),
      ensureWorkspace: vi.fn(async () => {
        throw new Error('no free port block');
      }),
    });

    const result = await resolveSessionCwd({ agentPath: AGENT }, deps);

    expect(result).toEqual({
      cwd: AGENT,
      rung: 'agent-home',
      degraded: expect.stringMatching(/no free port block/) as unknown as string,
    });
  });

  it('a managed checkout outside the boundary is refused, not used', async () => {
    const deps = makeDeps({
      readManifest: vi.fn(async () => manifest({ mode: 'managed', source: '/vault/dorkos' })),
      validateManagedCheckout: vi.fn(async () => {
        throw new Error('Access denied: path outside directory boundary');
      }),
    });

    const result = await resolveSessionCwd({ agentPath: AGENT }, deps);

    expect(result.rung).toBe('agent-home');
    expect(result.degraded).toMatch(/outside directory boundary/);
    // The whole managed branch shares one `try`, so "degraded with a
    // boundary-shaped message" is also what a checkout that was never validated
    // at all would look like if `ensureWorkspace` threw the same words. Assert
    // the check RAN, on the path that was resolved.
    expect(deps.validateManagedCheckout).toHaveBeenCalledWith(workspaceRow().path);
  });
});

describe('agentWorkspaceKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('separates two agents sharing a slug in different directories', () => {
    const a = agentWorkspaceKey('api-bot', '/vault/agents/a/api-bot', '/vault/dorkos');
    const b = agentWorkspaceKey('api-bot', '/vault/agents/b/api-bot', '/vault/dorkos');

    expect(a.projectKey).toBe(b.projectKey);
    expect(a.key).not.toBe(b.key);
  });

  it('files the checkout under the source repo, not a reserved project key', () => {
    expect(agentWorkspaceKey('api-bot', AGENT, '/vault/some-other-repo').projectKey).toBe(
      'some-other-repo'
    );
  });
});

describe('one spelling per directory', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    for (const dir of tempRoots.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  /**
   * A real agent directory plus a symlink pointing at it, both absolute.
   *
   * Real filesystem rather than a stubbed `canonicalize`, because the bug being
   * guarded is precisely that `realpath` and the raw spelling disagree — a fake
   * that "collapses" whatever it is told to collapse would prove nothing about
   * whether the production one is wired in.
   */
  async function realAndSymlinked(): Promise<{ real: string; link: string }> {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-canon-')));
    tempRoots.push(root);
    const real = join(root, 'real-agent');
    const link = join(root, 'linked-agent');
    await mkdir(real, { recursive: true });
    await symlink(real, link, 'dir');
    return { real, link };
  }

  it('a symlinked agent directory derives the same workspace key as the real one', async () => {
    const { real, link } = await realAndSymlinked();
    const managed = manifest({ mode: 'managed', source: '/vault/dorkos' });

    // The REAL `realpath`, not the identity stub every other row uses: the bug
    // guarded here is exactly that the two spellings disagree.
    const viaReal = makeDeps({
      readManifest: vi.fn(async () => managed),
      canonicalize: (p) => realpath(p),
    });
    const viaLink = makeDeps({
      readManifest: vi.fn(async () => managed),
      canonicalize: (p) => realpath(p),
    });

    await resolveSessionCwd({ agentPath: real }, viaReal);
    await resolveSessionCwd({ agentPath: link }, viaLink);

    const keyFromReal = vi.mocked(viaReal.ensureWorkspace).mock.calls[0]?.[0];
    const keyFromLink = vi.mocked(viaLink.ensureWorkspace).mock.calls[0]?.[0];
    expect(keyFromLink?.key).toBe(keyFromReal?.key);
    // And the OWNER records one directory, not two — otherwise the sweep
    // exemption protects at most one of an agent's two identities.
    expect(keyFromLink?.owner).toEqual(keyFromReal?.owner);
    expect(keyFromLink?.owner).toEqual({ kind: 'agent', ref: real });
  });
});

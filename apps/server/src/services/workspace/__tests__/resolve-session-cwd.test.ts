/**
 * The precedence chain as a table: {cwd present/absent} × {agentPath given /
 * from session metadata / absent} × {home / managed / none / unreadable}.
 *
 * Every row must be able to fail. The `explicit`-wins rows are the ones that
 * catch a regression in the migration guarantee — they are why a turn that
 * already names its directory is untouched by any of this.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    enabledToolGroups: {},
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

  it('an absent workspace field reads as home — the migration guarantee', async () => {
    const legacy = manifest({ mode: 'home' });
    // Exactly what a pre-change `agent.json` parses to once the schema default
    // has filled the missing key.
    const deps = makeDeps({ readManifest: vi.fn(async () => legacy) });

    expect((await resolveSessionCwd({ agentPath: AGENT }, deps)).rung).toBe('agent-home');
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
    expect(deps.ensureWorkspace).toHaveBeenCalledWith({
      projectKey: 'dorkos',
      key: agentWorkspaceKey('api-bot', AGENT, '/vault/dorkos').key,
      source: '/vault/dorkos',
      provider: 'clone',
      owner: { kind: 'agent', ref: AGENT },
    });
  });

  it('none falls to the default with no degradation — it is a choice, not a failure', async () => {
    const deps = makeDeps({ readManifest: vi.fn(async () => manifest({ mode: 'none' })) });

    const result = await resolveSessionCwd({ agentPath: AGENT }, deps);

    expect(result).toEqual({ cwd: DEFAULT, rung: 'default' });
    expect(result.degraded).toBeUndefined();
  });

  it('reads the session binding when the caller names no agent', async () => {
    const deps = makeDeps({ sessionAgentPath: vi.fn(async () => AGENT) });

    const result = await resolveSessionCwd({ sessionId: 'ses-1' }, deps);

    expect(result).toEqual({ cwd: AGENT, rung: 'agent-home' });
    expect(deps.sessionAgentPath).toHaveBeenCalledWith('ses-1');
  });

  it('prefers the caller-supplied agentPath over the session binding', async () => {
    const deps = makeDeps({ sessionAgentPath: vi.fn(async () => '/vault/agents/somebody-else') });

    const result = await resolveSessionCwd({ agentPath: AGENT, sessionId: 'ses-1' }, deps);

    expect(result.cwd).toBe(AGENT);
    expect(deps.sessionAgentPath).not.toHaveBeenCalled();
  });
});

describe('resolveSessionCwd — rung 4, and never failing the turn', () => {
  it('no cwd and no agent is the default, plainly', async () => {
    expect(await resolveSessionCwd({}, makeDeps())).toEqual({ cwd: DEFAULT, rung: 'default' });
  });

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

  it('a manifest read that throws degrades rather than propagating', async () => {
    const deps = makeDeps({
      readManifest: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    });

    const result = await resolveSessionCwd({ agentPath: AGENT }, deps);

    expect(result.rung).toBe('agent-home');
    expect(result.cwd).toBe(AGENT);
    expect(result.degraded).toMatch(/EACCES/);
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
  });

  // The only route to `DEFAULT_CWD` on this rung: the agent's own folder is
  // itself out of bounds, so there is nothing nearer left to fall back to.
  it('an unreadable manifest AND an out-of-bounds folder reaches the default, carrying both reasons', async () => {
    const deps = makeDeps({
      readManifest: vi.fn(async () => null),
      validateAgentHome: vi.fn(async () => {
        throw new Error('Access denied: path outside directory boundary');
      }),
    });

    const result = await resolveSessionCwd({ agentPath: '/etc' }, deps);

    expect(result.cwd).toBe(DEFAULT);
    expect(result.rung).toBe('default');
    expect(result.degraded).toMatch(/no readable agent manifest/);
    expect(result.degraded).toMatch(/out of bounds/);
  });

  it('a session-binding read that throws leaves the chain to fall through', async () => {
    const deps = makeDeps({
      sessionAgentPath: vi.fn(async () => {
        throw new Error('db closed');
      }),
    });

    expect(await resolveSessionCwd({ sessionId: 'ses-1' }, deps)).toEqual({
      cwd: DEFAULT,
      rung: 'default',
    });
  });
});

describe('agentWorkspaceKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is stable for the same agent', () => {
    expect(agentWorkspaceKey('api-bot', AGENT, '/vault/dorkos')).toEqual(
      agentWorkspaceKey('api-bot', AGENT, '/vault/dorkos')
    );
  });

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

  it('sanitizes a name that would otherwise be an illegal key', () => {
    const { key } = agentWorkspaceKey('api bot/v2', AGENT, '/vault/dorkos');
    expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

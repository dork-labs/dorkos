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
import { join, resolve as resolvePath } from 'node:path';
import type { AgentManifest, AgentWorkspaceBinding } from '@dorkos/shared/mesh-schemas';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
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
    // Identity by default; the canonicalization rows below inject a fake that
    // actually collapses, so every OTHER row fails for its own reason.
    canonicalize: vi.fn(async (p: string) => p),
    // No room-repo machinery by default, which is every non-room turn and every
    // install that has never given a room files. The rung-2 rows below inject
    // their own.
    ensureRoomWorktree: vi.fn(async () => null),
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

  // The migration guarantee, and it has to go through the SCHEMA to mean
  // anything. Handing the resolver an already-defaulted `{ mode: 'home' }`
  // would assert only that `home` resolves to `home`, and would stay green with
  // the schema's `.default()` deleted — which is the thing under test.
  it('a pre-change manifest with no workspace key at all reads as home', async () => {
    const { workspace: _absent, ...legacy } = manifest({ mode: 'home' });
    const parsed = AgentManifestSchema.parse(legacy);
    expect(parsed.workspace).toEqual({ mode: 'home' });

    const deps = makeDeps({ readManifest: vi.fn(async () => parsed) });

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
    // The whole managed branch shares one `try`, so "degraded with a
    // boundary-shaped message" is also what a checkout that was never validated
    // at all would look like if `ensureWorkspace` threw the same words. Assert
    // the check RAN, on the path that was resolved.
    expect(deps.validateManagedCheckout).toHaveBeenCalledWith(workspaceRow().path);
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

  it('a trailing slash and a dot segment are the same agent', async () => {
    const deps = makeDeps({
      readManifest: vi.fn(async () => manifest({ mode: 'managed', source: '/vault/dorkos' })),
      canonicalize: (p) => Promise.resolve(resolvePath(p)),
    });

    await resolveSessionCwd({ agentPath: '/vault/agents/api-bot/' }, deps);
    await resolveSessionCwd({ agentPath: '/vault/agents/./api-bot' }, deps);

    const [first, second] = vi.mocked(deps.ensureWorkspace).mock.calls;
    expect(second?.[0].key).toBe(first?.[0].key);
    expect(second?.[0].owner).toEqual(first?.[0].owner);
  });

  it('a directory that does not resolve still answers one stable spelling', async () => {
    const deps = makeDeps({
      readManifest: vi.fn(async () => manifest({ mode: 'managed', source: '/vault/dorkos' })),
      // The production fallback: `realpath` throws, `path.resolve` answers.
      canonicalize: (p) => Promise.resolve(resolvePath(p)),
    });

    await resolveSessionCwd({ agentPath: '/nope/gone/' }, deps);

    expect(vi.mocked(deps.ensureWorkspace).mock.calls[0]?.[0].owner).toEqual({
      kind: 'agent',
      ref: '/nope/gone',
    });
  });
});

describe('rung 2 — the room worktree', () => {
  const ROOM = { roomId: 'room-1', agentName: 'Ana' };
  const WORKTREE = '/dork/rooms/room-1/worktrees/ana-abcd1234';

  it('runs a project room’s turn in that agent’s own working copy', async () => {
    const deps = makeDeps({ ensureRoomWorktree: vi.fn(async () => WORKTREE) });

    await expect(resolveSessionCwd({ agentPath: AGENT, room: ROOM }, deps)).resolves.toEqual({
      cwd: WORKTREE,
      rung: 'room-worktree',
    });
    // The agent's own directory is its identity anchor and reaches the seam
    // unchanged; the display name is only the readable half of the directory.
    expect(deps.ensureRoomWorktree).toHaveBeenCalledWith('room-1', AGENT, 'Ana');
  });

  it('leaves a room with no files of its own on the agent’s own directory', async () => {
    // The regression pin, and the reason rung 2 short-circuits rungs 3 and 4.
    // `null` is the ordinary case — not a degradation, so no reason is recorded.
    const deps = makeDeps({ ensureRoomWorktree: vi.fn(async () => null) });

    await expect(resolveSessionCwd({ agentPath: AGENT, room: ROOM }, deps)).resolves.toEqual({
      cwd: AGENT,
      rung: 'agent-home',
    });
  });

  it('never consults the agent binding for a room turn', async () => {
    // A room turn has never followed a `managed` binding and has never been
    // boundary-validated. Reaching rung 3 would move a repo-less room turn into
    // a checkout nothing asked for — the change DOR-1597 deliberately does not
    // make. Proved by "was it even asked", not by the answer.
    const deps = makeDeps({
      ensureRoomWorktree: vi.fn(async () => null),
      readManifest: vi.fn(async () => manifest({ mode: 'managed', source: '/vault/dorkos' })),
    });

    const resolved = await resolveSessionCwd({ agentPath: AGENT, room: ROOM }, deps);

    expect(resolved).toEqual({ cwd: AGENT, rung: 'agent-home' });
    expect(deps.readManifest).not.toHaveBeenCalled();
    expect(deps.ensureWorkspace).not.toHaveBeenCalled();
    expect(deps.validateAgentHome).not.toHaveBeenCalled();
  });

  it('a `none` binding cannot send a room turn to the shared default either', async () => {
    // The other half of the same guarantee, and the sharper one: `none` resolves
    // to `DEFAULT_CWD`, which is the tree every other agent also writes in —
    // the DOR-500 interleaving the chain exists to prevent.
    const deps = makeDeps({
      ensureRoomWorktree: vi.fn(async () => null),
      readManifest: vi.fn(async () => manifest({ mode: 'none' })),
    });

    const resolved = await resolveSessionCwd({ agentPath: AGENT, room: ROOM }, deps);

    expect(resolved.cwd).toBe(AGENT);
    expect(resolved.cwd).not.toBe(DEFAULT);
  });

  it('an explicit cwd still wins outright over a room worktree', async () => {
    const deps = makeDeps({ ensureRoomWorktree: vi.fn(async () => WORKTREE) });

    await expect(
      resolveSessionCwd({ cwd: '/somewhere/named', agentPath: AGENT, room: ROOM }, deps)
    ).resolves.toEqual({ cwd: '/somewhere/named', rung: 'explicit' });
    expect(deps.ensureRoomWorktree).not.toHaveBeenCalled();
  });

  it('degrades to the agent’s own directory rather than failing the turn', async () => {
    // Git missing, a disk error, a worktree that cannot be built. A room that
    // stops answering is far worse than an agent answering from its own folder,
    // so the turn still runs and the reason is carried out loud.
    const deps = makeDeps({
      ensureRoomWorktree: vi.fn(async () => {
        throw new Error('git is not installed');
      }),
    });

    const resolved = await resolveSessionCwd({ agentPath: AGENT, room: ROOM }, deps);

    expect(resolved.cwd).toBe(AGENT);
    expect(resolved.rung).toBe('agent-home');
    expect(resolved.degraded).toContain('git is not installed');
  });
});

/**
 * @vitest-environment node
 *
 * Every identity reader answers with the agent's HOME, never the `.dork/` a
 * worktree of its repo carries (spec `agent-home-desk` §3.2, invariants I1 and
 * I2, DOR-2355).
 *
 * The fixture is real git: Ana's home repo committed one `.dork/` (the BRANCH
 * values), a linked worktree was cut from that commit, and the home then moved
 * on (the HOME values). The worktree's committed copy is exactly the stale
 * identity a coding session in it used to be handed. Each reader is asked about
 * the WORKTREE and must answer with the home's values.
 *
 * Rows 1 and 3 (the claude-code launch's account pin and persona) are
 * driven through the real `resolveLaunch`; rows 4 and 5 (codex, opencode) call
 * the same builder as row 2 and can pass it nothing but an `AgentHome`, which
 * the typecheck enforces. Rows 9-11 have their own cases beside their routes
 * and services; this file keeps the ones that read a manifest.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env.js', () => ({ env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined } }));
vi.mock('../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/config-manager.js')>()),
  configManager: { get: () => undefined, set: () => {} },
}));
vi.mock('../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));
// The account ladder's last rung reads the machine's accounts; the pin is the
// part under test, so the root names the account it was handed.
vi.mock('../runtimes/claude-code/claude-config-dir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtimes/claude-code/claude-config-dir.js')>()),
  resolveLaunchAccountRoot: (opts: { agentAccountId?: string } = {}) => ({
    ok: true,
    root: `/accounts/${opts.agentAccountId ?? 'default'}`,
    accountId: opts.agentAccountId ?? 'default',
  }),
  claudeConfigDirEnv: (root: string) => ({ CLAUDE_CONFIG_DIR: root }),
}));

import { writeManifest } from '@dorkos/shared/manifest';
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import { renderBlockedAreaLines } from '../runtimes/shared/permission-tool-filter.js';
import {
  initPermissionGate,
  readAgentPermissionsFromManifest,
} from '../core/capabilities/permission-enforcement.js';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { homeOf, readHomeManifest, resolveAgentHome } from '../core/agent-identity/index.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../core/agent-identity/__tests__/agent-home-fixture.js';
import { buildAgentContextAppend } from '../runtimes/shared/agent-context.js';
import { buildOpenCodeTurnContext } from '../runtimes/opencode/messaging/turn-context.js';
import { resolveLaunch } from '../runtimes/claude-code/messaging/launch-resolver.js';
import type { AgentSession } from '../runtimes/claude-code/agent-types.js';
import { createGetAgentHandler } from '../runtimes/claude-code/mcp-tools/core-tools.js';
import type { McpToolDeps } from '../runtimes/claude-code/mcp-tools/types.js';
import { resolveSubjectLabel } from '../relay/subject-resolver.js';
import { _resolveRuntimeTypeForNewSession } from '../session/launch/launch-session.js';
import { runtimeRegistry } from '../core/runtime-registry.js';

/** One side of the fixture: what `.dork/` says. */
interface Identity {
  name: string;
  runtime: AgentManifest['runtime'];
  account: string;
  /** Permission areas this side's manifest blocks. */
  blocked: readonly PermissionAreaId[];
  soul: string;
  nope: string;
}

const BRANCH: Identity = {
  name: 'ana-branch-copy',
  runtime: 'opencode',
  account: 'acct-branch',
  blocked: [],
  soul: 'BRANCH-SOUL-MARKER',
  nope: 'BRANCH-NOPE-MARKER',
};
const HOME: Identity = {
  name: 'ana',
  runtime: 'codex',
  account: 'acct-home',
  blocked: ['tasks'],
  soul: 'HOME-SOUL-MARKER',
  nope: 'HOME-NOPE-MARKER',
};

let scratch: string;
let home: string;
let tree: string;

beforeAll(async () => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'identity-from-home-')));
  home = path.join(scratch, 'ana');
  tree = path.join(scratch, 'trees', 'ana-feature');
  fs.mkdirSync(home, { recursive: true });
  git(home, 'init', '-q', '-b', 'main');
  await writeIdentity(home, BRANCH);
  git(home, 'add', '-A');
  git(home, 'commit', '-q', '-m', 'the identity a branch will carry');
  git(home, 'worktree', 'add', '-q', '-b', 'feature', tree);
  // The home moves on; the worktree keeps the committed copy.
  await writeIdentity(home, HOME);
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  registerTestHomes([home]);
  // One Tasks action on the gate's list, so a Blocked Tasks area has something
  // to hide, and the real reader of an agent's overrides off its manifest.
  initPermissionGate({
    readAgentPermissions: readAgentPermissionsFromManifest,
    listActions: () => [
      { id: 'tasks.create', tier: 'act', area: 'tasks', toolName: 'tasks_create' },
    ],
  });
});

afterEach(() => {
  clearTestHomes();
  initPermissionGate({});
});

describe('a worktree of a home repo reads the HOME identity', () => {
  it('the fixture is what it claims: the worktree carries the stale copy', () => {
    expect(fs.readFileSync(path.join(tree, '.dork', 'SOUL.md'), 'utf8')).toContain(BRANCH.soul);
    expect(homeOf(resolveAgentHome(tree))).toBe(home);
  });

  it('row 2 (and 4, 5): the context append carries the home persona and boundaries', async () => {
    const worktreeHome = homeOf(resolveAgentHome(tree));
    const { text } = await buildAgentContextAppend(worktreeHome, tree);
    expect(text).toContain(HOME.soul);
    expect(text).toContain(HOME.nope);
    expect(text).not.toContain(BRANCH.soul);
    expect(text).not.toContain(BRANCH.nope);
    // Where the turn stands is still the worktree.
    expect(text).toContain(`Working directory: ${tree}`);

    const opencode = await buildOpenCodeTurnContext(tree, false, worktreeHome);
    expect(opencode).toContain(HOME.soul);
    expect(opencode).not.toContain(BRANCH.soul);
  });

  it('rows 1 and 3: a claude-code launch takes its account, persona and blocked areas from home', async () => {
    const session: AgentSession = {
      sdkSessionId: 'sdk-1',
      lastActivity: Date.now(),
      permissionMode: 'default',
      hasStarted: false,
      pendingInteractions: new Map(),
      eventQueue: [],
      cwd: tree,
    };

    const resolved = await resolveLaunch({
      sessionId: 'worktree-session',
      content: 'hello',
      session,
      opts: { cwd: tree, onSdkSessionRebind: async () => {} },
      messageOpts: { cwd: tree },
      effectiveCwd: tree,
    });

    expect((resolved.sdkOptions.env as Record<string, string>).CLAUDE_CONFIG_DIR).toBe(
      `/accounts/${HOME.account}`
    );
    const append = (resolved.sdkOptions.systemPrompt as { append: string }).append;
    expect(append).toContain(HOME.soul);
    expect(append).not.toContain(BRANCH.soul);
    // What the agent's permissions hide follows the HOME too: the home blocks
    // Tasks, the worktree's committed copy blocks nothing. The blocked-area
    // line and the tool-doc gate both come from the home's manifest.
    expect(append).toContain(renderBlockedAreaLines(HOME.blocked));
    expect(renderBlockedAreaLines(HOME.blocked)).not.toBe('');
  });

  it('row 6: a new session in the worktree runs on the home runtime', async () => {
    const has = vi.spyOn(runtimeRegistry, 'has').mockReturnValue(true);
    try {
      expect(await _resolveRuntimeTypeForNewSession({ cwd: tree })).toBe(HOME.runtime);
    } finally {
      has.mockRestore();
    }
  });

  it('row 7: a relay subject is labelled with the home name', async () => {
    const label = await resolveSubjectLabel('relay.agent.session-1', {
      getSession: async () => ({ cwd: tree }),
      readManifest: readHomeManifest,
    });
    expect(label.label).toBe(HOME.name);
  });

  it('row 8: get_agent about the worktree answers with the home manifest', async () => {
    const result = await createGetAgentHandler({} as McpToolDeps)({ cwd: tree });
    const agent = agentIn(result);
    expect(agent?.name).toBe(HOME.name);
    expect(agent?.account).toBe(HOME.account);
  });

  it('keeps answering with the home once the worktree`s `.dork/` is deleted', async () => {
    const bare = path.join(scratch, 'trees', 'no-dork');
    git(home, 'worktree', 'add', '-q', '-b', 'no-dork', bare);
    fs.rmSync(path.join(bare, '.dork'), { recursive: true, force: true });

    const { text } = await buildAgentContextAppend(homeOf(resolveAgentHome(bare)), bare);
    expect(text).toContain(HOME.soul);
    const result = await createGetAgentHandler({} as McpToolDeps)({ cwd: bare });
    expect(agentIn(result)?.name).toBe(HOME.name);
  });

  it('reads nothing at all for a folder that is no agent`s home, whatever `.dork/` it carries', async () => {
    clearTestHomes();
    registerTestHomes([]);

    expect(await buildAgentContextAppend(homeOf(resolveAgentHome(tree)), tree)).toMatchObject({
      memory: '',
    });
    expect((await buildAgentContextAppend(undefined, tree)).text).not.toContain(BRANCH.soul);
    const result = await createGetAgentHandler({} as McpToolDeps)({ cwd: tree });
    expect(agentIn(result)).toBeNull();
  });
});

/** The manifest a `get_agent` reply carries, or `null` when it names no agent. */
function agentIn(result: Awaited<ReturnType<ReturnType<typeof createGetAgentHandler>>>) {
  return 'structuredContent' in result
    ? ((result.structuredContent as { agent: AgentManifest | null }).agent ?? null)
    : null;
}

/** Run git in `cwd` with a fixed identity, so commits work on any machine. */
function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, stdio: 'pipe' }
  );
}

/** Write one side of the fixture's `.dork/`: manifest, SOUL.md and NOPE.md. */
async function writeIdentity(dir: string, identity: Identity): Promise<void> {
  const manifest: AgentManifest = {
    id: '01JANAHOMEAGENT0000000000',
    name: identity.name,
    description: '',
    runtime: identity.runtime,
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-01-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    account: identity.account,
    ...(identity.blocked.length > 0
      ? { permissions: { areas: Object.fromEntries(identity.blocked.map((a) => [a, 'blocked'])) } }
      : {}),
  } as unknown as AgentManifest;
  await writeManifest(dir, manifest);
  fs.writeFileSync(path.join(dir, '.dork', 'SOUL.md'), `${identity.soul}\n`);
  fs.writeFileSync(path.join(dir, '.dork', 'NOPE.md'), `${identity.nope}\n`);
}

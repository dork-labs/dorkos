/**
 * Whose permission-mode vocabulary a NEW schedule's trust stop is read in
 * (DOR-1615 review): the request's runtime, then the TARGET AGENT's. The shipped
 * runtimes spell their modes alike, so the cases discriminate on the config
 * section instead: Codex's own stop `ask` against a global stop `autonomy`.
 *
 * @module services/tasks/lifecycle/__tests__/create-task-runtime-power
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { TaskStore } from '../../task-store.js';
import { createScheduledTask } from '../create-task.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../core/capabilities/permission-enforcement.js';

/** The stored `runtimes` block these cases resolve against. */
const state = vi.hoisted(() => ({ runtimes: undefined as UserConfig['runtimes'] | undefined }));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'runtimes' ? state.runtimes : undefined),
  },
}));

vi.mock('../../../core/runtime-registry.js', async () => {
  const { CLAUDE_CODE_CAPABILITIES } =
    await import('../../../runtimes/claude-code/runtime-constants.js');
  const { CODEX_CAPABILITIES } = await import('../../../runtimes/codex/runtime-constants.js');
  const registered: Record<string, unknown> = {
    'claude-code': CLAUDE_CODE_CAPABILITIES,
    codex: CODEX_CAPABILITIES,
  };
  return {
    runtimeRegistry: {
      computerRuntimeForAgentPath: () => undefined,
      getNativeSessionCwd: vi.fn(() => null),
      getAllCapabilities: () => registered,
      getDefaultType: () => 'claude-code',
      has: (type: string) => Object.hasOwn(registered, type),
    },
  };
});

let db: Db;
let store: TaskStore;
let root: string;
let dorkHome: string;
let agentProject: string;

beforeEach(async () => {
  // Global stop: full autonomy. Codex's OWN section stops earlier — which is the
  // whole discriminator, since the two runtimes spell their modes alike.
  state.runtimes = {
    ...USER_CONFIG_DEFAULTS.runtimes,
    defaultTrustStop: 'autonomy',
    codex: { ...USER_CONFIG_DEFAULTS.runtimes.codex, defaultTrustStop: 'ask' },
  };
  db = createTestDb();
  store = new TaskStore(db);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'create-task-power-'));
  dorkHome = path.join(root, 'dork');
  agentProject = path.join(root, 'agent');
  await fs.mkdir(dorkHome, { recursive: true });
  await fs.mkdir(agentProject, { recursive: true });
});

afterEach(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

/**
 * Give the agent project a manifest pinned to `runtime`.
 *
 * @param runtime - What the agent runs on.
 */
async function pinAgentTo(runtime: string): Promise<void> {
  await writeManifest(agentProject, {
    workspace: { mode: 'home' },
    id: 'pinned-agent',
    name: 'pinned-agent',
    description: '',
    runtime,
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: new Date().toISOString(),
    registeredBy: 'test',
    personaEnabled: true,
    mcpServers: [],
  } as AgentManifest);
}

/**
 * Create a task through the shared lifecycle, as a trusted caller.
 *
 * Trusted so the resolved mode reaches the row unclamped — the clamp is a
 * separate rule and would hide the very difference these cases are about.
 *
 * @param input - What the caller asked for.
 */
async function create(input: Record<string, unknown>) {
  return createScheduledTask(
    {
      store,
      registrar: null,
      defaultTimezone: () => 'UTC',
      dorkHome,
      meshCore: { getProjectPath: () => agentProject } as never,
    },
    { input: input as never, trusted: true }
  );
}

const BASE = { name: 'nightly', description: 'sweep', prompt: 'sweep it', cron: '0 3 * * *' };

describe('the trust stop is read in the runtime the schedule will RUN on', () => {
  it("uses the TARGET AGENT's runtime when the request names none", async () => {
    // Before the fix this read the registry default's GLOBAL autonomy stop.
    await pinAgentTo('codex');

    const outcome = await create({ ...BASE, target: 'pinned-agent' });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.task.permissionMode).toBe('default');
  });

  it('uses the runtime the REQUEST names, over the agent it is filed under', async () => {
    await pinAgentTo('codex');

    const outcome = await create({ ...BASE, target: 'pinned-agent', runtime: 'claude-code' });

    expect(outcome.ok && outcome.task.permissionMode).toBe('bypassPermissions');
  });

  it('still creates the task when the agent has no readable manifest', async () => {
    // Tolerant like every other manifest read: no opinion, never a refused
    // create. The agent directory here exists but holds no `.dork/agent.json`.
    const outcome = await create({ ...BASE, target: 'pinned-agent' });

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.task.permissionMode).toBe('bypassPermissions');
  });
});

// DOR-3107 (PM): each schedule runs at its own saved mode. An agent raised to
// Full autonomy does not raise a schedule created for it, nor any it has.
describe("an agent's own Files & commands stop", () => {
  afterEach(() => resetPermissionGate());

  it('never sets the mode of a schedule created for it', async () => {
    state.runtimes = { ...USER_CONFIG_DEFAULTS.runtimes, defaultTrustStop: 'ask' };
    await pinAgentTo('claude-code');
    const before = await create({ ...BASE, name: 'before', target: 'pinned-agent' });

    initPermissionGate({ readAgentPermissions: async () => ({ filesAndCommands: 'autonomy' }) });
    const after = await create({ ...BASE, name: 'after', target: 'pinned-agent' });

    expect(after.ok && after.task.permissionMode).not.toBe('bypassPermissions');
    expect(after.ok && after.task.permissionMode).toBe(before.ok && before.task.permissionMode);
    // And the schedule made before the raise keeps its own saved mode.
    expect(before.ok && store.getTask(before.task.id)?.permissionMode).toBe(
      before.ok && before.task.permissionMode
    );
  });
});

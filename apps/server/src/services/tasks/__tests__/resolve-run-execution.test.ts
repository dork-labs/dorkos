/**
 * The ladder a scheduled run walks to decide what it executes on (DOR-1615,
 * DOR-1347).
 *
 * The registry is a three-function stand-in and the agent manifests are real
 * files, because that is exactly the split the resolver has: it OWNS the two
 * schedule-only tiers (the `schedule:` block, and the skill file's top-level
 * Claude-Code-dialect keys) and DELEGATES the rest to
 * `resolveUnattendedSessionDefaults`. Faking the delegate would make every
 * assertion about the delegation itself vacuous — the exact failure that let two
 * unattended surfaces disagree about an agent's settings before (DOR-1344) — so
 * the shared ladder runs for real here, off real manifests and the real shipped
 * capability profiles.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Task } from '@dorkos/shared/types';
import { createMockSchedule } from '@dorkos/test-utils/mock-factories';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../runtimes/codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../../runtimes/opencode/runtime-constants.js';
import {
  resolveRunExecution,
  TaskRuntimeUnavailableError,
  type RunExecutionRuntimes,
} from '../resolve-run-execution.js';

// The server's per-runtime default tier reads the stored config through this
// singleton, which is undefined until the server boots. Mocked so the tier can
// be given a value on purpose — an unmocked test would silently never exercise
// it and would still pass.
const storedRuntimes = vi.hoisted(() => ({ current: undefined as UserConfig['runtimes'] | undefined }));
vi.mock('../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'runtimes' ? storedRuntimes.current : undefined),
  },
}));

/** The shipped profiles, keyed the way `runtimeRegistry.getAllCapabilities()` keys them. */
const SHIPPED: Record<string, RuntimeCapabilities> = {
  'claude-code': CLAUDE_CODE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
  opencode: OPENCODE_CAPABILITIES,
};

/**
 * A registry stand-in over an explicit set of registered runtimes.
 *
 * @param registered - The types that are turned on, first one the default.
 */
function registry(registered: string[]): RunExecutionRuntimes {
  return {
    has: (type) => registered.includes(type),
    getDefaultType: () => registered[0] ?? 'claude-code',
    getAllCapabilities: () =>
      Object.fromEntries(registered.filter((t) => SHIPPED[t]).map((t) => [t, SHIPPED[t]!])),
  };
}

/** The least manifest that validates. */
const BASE_MANIFEST: AgentManifest = {
  workspace: { mode: 'home' },
  id: 'run-execution-fixture',
  name: 'run-execution-fixture',
  description: '',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  registeredAt: new Date().toISOString(),
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
  mcpServers: [],
};

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'resolve-run-execution-'));
  storedRuntimes.current = undefined;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Write an agent whose manifest carries the given execution defaults.
 *
 * @param overrides - The manifest fields this case is about.
 * @returns The agent directory to hand the resolver.
 */
async function agentDir(overrides: Partial<AgentManifest> = {}): Promise<string> {
  const dir = path.join(root, `agent-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  await writeManifest(dir, { ...BASE_MANIFEST, ...overrides } as AgentManifest);
  return dir;
}

/**
 * Write a SKILL.md carrying top-level Claude-Code-dialect frontmatter.
 *
 * The frontmatter `name` is the DIRECTORY name, because the parser refuses a
 * file where the two disagree — which is how a real task's SKILL.md is laid out
 * (`<skills-root>/<slug>/SKILL.md`), and a fixture that ignored it would have
 * this whole tier silently reading nothing.
 *
 * @param frontmatter - The `model:`/`effort:` lines to write, verbatim.
 * @returns The file path to put on the task.
 */
async function skillFile(frontmatter: string): Promise<string> {
  const name = `skill-${Math.random().toString(36).slice(2)}`;
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: Sweep the backlog.\n${frontmatter}---\n\nSweep it.\n`,
    'utf-8'
  );
  return file;
}

/** A task with the fields this suite varies, and defaults for the rest. */
function task(overrides: Partial<Task> = {}): Task {
  return createMockSchedule({ filePath: '', ...overrides });
}

/** The stored `runtimes` block, with one section replaced. */
function runtimes(overrides: Partial<UserConfig['runtimes']> = {}): UserConfig['runtimes'] {
  return { ...USER_CONFIG_DEFAULTS.runtimes, ...overrides };
}

describe('resolveRunExecution — which runtime', () => {
  it("takes the task's own runtime over everything else (tier 1)", async () => {
    // The whole point of DOR-1615: before it, this field did not exist and the
    // answer was always the one runtime bound at boot.
    const agentPath = await agentDir({ runtime: 'claude-code' });
    const resolved = await resolveRunExecution(task({ runtime: 'codex' }), {
      runtimes: registry(['claude-code', 'codex']),
      agentPath,
    });
    expect(resolved.runtimeType).toBe('codex');
  });

  it("falls to the agent's manifest runtime when the task names none (tier 2)", async () => {
    const agentPath = await agentDir({ runtime: 'codex' });
    const resolved = await resolveRunExecution(task(), {
      runtimes: registry(['claude-code', 'codex']),
      agentPath,
    });
    expect(resolved.runtimeType).toBe('codex');
  });

  it('falls to the registry default when the task has no agent (tier 3)', async () => {
    const resolved = await resolveRunExecution(task(), {
      runtimes: registry(['opencode', 'claude-code']),
    });
    expect(resolved.runtimeType).toBe('opencode');
  });

  it('falls PAST an agent pinned to a runtime this build cannot run, rather than failing', async () => {
    // The agent did not ask for this run, and the packaged desktop app bundles
    // only the claude-code SDK — so an agent pinned to Codex there must not fail
    // every schedule filed under it. The same tolerance `resolveForAgent` has.
    const agentPath = await agentDir({ runtime: 'codex' });
    const resolved = await resolveRunExecution(task(), {
      runtimes: registry(['claude-code']),
      agentPath,
    });
    expect(resolved.runtimeType).toBe('claude-code');
  });

  it('carries the resolved runtime’s capability profile, not the default’s', async () => {
    const resolved = await resolveRunExecution(task({ runtime: 'opencode' }), {
      runtimes: registry(['claude-code', 'opencode']),
    });
    expect(resolved.capabilities).toBe(OPENCODE_CAPABILITIES);
  });
});

describe('resolveRunExecution — a runtime that is not turned on (decision 9)', () => {
  it('FAILS the run loudly when the task names a runtime that is not registered', async () => {
    // Never a silent fall back: a task set to run on Codex that quietly ran on
    // Claude Code would be a different task, billed to a different account, with
    // a different tool vocabulary, and nothing on screen to say so.
    const attempt = resolveRunExecution(task({ runtime: 'codex' }), {
      runtimes: registry(['claude-code']),
    });
    await expect(attempt).rejects.toBeInstanceOf(TaskRuntimeUnavailableError);
    await expect(attempt).rejects.toThrow(/set to run on codex/);
    await expect(attempt).rejects.toThrow(/did not start/);
  });

  it('says WHICH runtime and where it came from, so the fix is findable', async () => {
    /**
     * Run the resolver and hand back the error it raised.
     *
     * @param opts - What to resolve.
     */
    async function refusal(
      opts: Parameters<typeof resolveRunExecution>[1],
      t = task({ runtime: 'codex' })
    ): Promise<TaskRuntimeUnavailableError> {
      try {
        await resolveRunExecution(t, opts);
      } catch (err) {
        return err as TaskRuntimeUnavailableError;
      }
      throw new Error('expected the resolver to refuse');
    }

    const fromTask = await refusal({ runtimes: registry(['claude-code']) });
    expect(fromTask.runtime).toBe('codex');
    expect(fromTask.source).toBe('task');

    // Nothing registered at all is a different problem with a different fix, and
    // the message must not tell the person to go and edit the task.
    const fromDefault = await refusal({ runtimes: registry([]) }, task());
    expect(fromDefault.source).toBe('default');
    expect(fromDefault.message).not.toContain('change the task');
  });

  it('still runs a registered runtime that publishes no capability profile', async () => {
    // Registration is the whole availability question. A profile is a separate,
    // richer fact, and refusing over a missing one would fail a task the machine
    // can perfectly well run.
    const resolved = await resolveRunExecution(task({ runtime: 'some-future-runtime' }), {
      runtimes: {
        has: (type) => type === 'some-future-runtime',
        getDefaultType: () => 'some-future-runtime',
        getAllCapabilities: () => ({}),
      },
    });
    expect(resolved.runtimeType).toBe('some-future-runtime');
    expect(resolved.capabilities).toBeUndefined();
  });
});

describe('resolveRunExecution — which model and effort', () => {
  it("takes the schedule block's own model and effort over everything (tier 1)", async () => {
    const agentPath = await agentDir({ runtime: 'claude-code', model: 'haiku', effort: 'low' });
    storedRuntimes.current = runtimes({
      claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultModel: 'opus' },
    });
    const filePath = await skillFile('model: sonnet\n');

    const resolved = await resolveRunExecution(
      task({ model: 'claude-opus-4-6', effort: 'xhigh', filePath }),
      { runtimes: registry(['claude-code']), agentPath }
    );
    expect(resolved.settings).toEqual({ model: 'claude-opus-4-6', effort: 'xhigh' });
  });

  it("honours the skill file's TOP-LEVEL model on claude-code (tier 2)", async () => {
    // "This skill runs on haiku" stays true whichever way the skill was started.
    const filePath = await skillFile('model: haiku\n');
    const resolved = await resolveRunExecution(task({ filePath }), {
      runtimes: registry(['claude-code']),
    });
    expect(resolved.settings.model).toBe('haiku');
  });

  it('IGNORES that top-level model when the run resolves onto another runtime', async () => {
    // Those keys are the Claude Code dialect. Handing `haiku` to Codex would not
    // be honouring the author's intent, it would be another provider's id.
    const filePath = await skillFile('model: haiku\n');
    const resolved = await resolveRunExecution(task({ runtime: 'codex', filePath }), {
      runtimes: registry(['claude-code', 'codex']),
    });
    expect(resolved.settings.model).toBeUndefined();
  });

  it("falls to the agent manifest's model when nothing above names one (tier 3)", async () => {
    const agentPath = await agentDir({ runtime: 'claude-code', model: 'haiku', effort: 'low' });
    const resolved = await resolveRunExecution(task(), {
      runtimes: registry(['claude-code']),
      agentPath,
    });
    expect(resolved.settings).toEqual({ model: 'haiku', effort: 'low' });
  });

  it("DROPS the agent's model when the run lands on a different runtime — but keeps its effort", async () => {
    // A model id lives in one runtime's namespace; "think harder" is the same
    // request on any runtime that can hear it. This is the shared ladder's rule,
    // and this test is what proves the resolver actually delegates to it.
    const agentPath = await agentDir({ runtime: 'claude-code', model: 'haiku', effort: 'low' });
    const resolved = await resolveRunExecution(task({ runtime: 'codex' }), {
      runtimes: registry(['claude-code', 'codex']),
      agentPath,
    });
    expect(resolved.settings.model).toBeUndefined();
    expect(resolved.settings.effort).toBe('low');
  });

  it("falls to the server's per-runtime default (tier 4)", async () => {
    storedRuntimes.current = runtimes({
      codex: {
        ...USER_CONFIG_DEFAULTS.runtimes.codex,
        defaultModel: 'gpt-5.5',
        defaultEffort: 'high',
      },
    });
    const resolved = await resolveRunExecution(task({ runtime: 'codex' }), {
      runtimes: registry(['claude-code', 'codex']),
    });
    expect(resolved.settings).toEqual({ model: 'gpt-5.5', effort: 'high' });
  });

  it('leaves both unset when no tier answers, so the runtime decides', async () => {
    const resolved = await resolveRunExecution(task(), { runtimes: registry(['claude-code']) });
    expect(resolved.settings).toEqual({});
  });

  it('drops an effort on a runtime whose API has none, however high the tier that set it', async () => {
    // "Not supported by OpenCode" is only true if nothing here quietly supplies
    // one anyway — including the schedule block, which outranks the shared
    // ladder and therefore cannot be dropped inside it.
    const resolved = await resolveRunExecution(
      task({ runtime: 'opencode', effort: 'xhigh', model: 'anthropic/claude-sonnet-4-5' }),
      { runtimes: registry(['claude-code', 'opencode']) }
    );
    expect(resolved.settings.effort).toBeUndefined();
    expect(resolved.settings.model).toBe('anthropic/claude-sonnet-4-5');
  });

  it('starts the run anyway when the skill file is gone or unreadable', async () => {
    // A fallback tier must never be a reason to refuse a turn: the schedule that
    // opened this run was read from that file minutes ago, and if it has since
    // gone, the reconciler is what notices.
    const resolved = await resolveRunExecution(
      task({ filePath: path.join(root, 'no', 'such', 'SKILL.md') }),
      { runtimes: registry(['claude-code']) }
    );
    expect(resolved.runtimeType).toBe('claude-code');
    expect(resolved.settings.model).toBeUndefined();
  });
});

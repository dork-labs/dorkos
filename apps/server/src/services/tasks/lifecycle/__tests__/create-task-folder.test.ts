/** Agent-created schedules keep a registered, safe run home (DOR-4067). */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeshCore } from '@dorkos/mesh';
import type { CreateTaskInput } from '@dorkos/shared/schemas';
import { createTestDb } from '@dorkos/test-utils/db';
import { TaskStore } from '../../task-store.js';
import { createScheduledTask } from '../create-task.js';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { readScheduleFromSkill } from '../../skills-root-discovery.js';

let root: string;
let home: string;
let dorkHome: string;
let agentPath: string;
let store: TaskStore;
let agents: { id: string; projectPath: string }[];
const syncTask = vi.fn();
const mesh = {
  listWithPaths: () => agents,
  getProjectPath: (id: string) => agents.find((agent) => agent.id === id)?.projectPath,
} as unknown as MeshCore;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-folder-')));
  home = path.join(root, 'home');
  dorkHome = path.join(home, '.dork');
  agentPath = path.join(dorkHome, 'agents', 'scout');
  await fs.mkdir(agentPath, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('DORK_HOME', dorkHome);
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'));
  vi.stubEnv('DORKOS_TEST_RUNTIME', 'true');
  agents = [{ id: 'scout', projectPath: agentPath }];
  store = new TaskStore(createTestDb());
  syncTask.mockClear();
});

afterEach(async () => {
  store.close();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function create({
  target = 'global',
  caller = agentPath,
  trusted = false,
  runtime = 'claude-code',
  permissionMode = 'acceptEdits',
}: {
  target?: string | null;
  caller?: string | null;
  trusted?: boolean;
  runtime?: string;
  permissionMode?: string;
} = {}) {
  return createScheduledTask(
    {
      store,
      registrar: { syncTask } as never,
      dorkHome,
      defaultTimezone: () => 'UTC',
      meshCore: mesh,
    },
    {
      input: {
        name: 'Nightly sweep',
        description: 'Sweep',
        prompt: 'Sweep.',
        cron: '0 3 * * *',
        ...(target !== null ? { target } : {}),
        runtime,
        permissionMode,
        reason: 'The backlog needs sweeping.',
      } as CreateTaskInput,
      trusted,
      callerIsOurAgent: !trusted,
      modeGranted: true,
      ...(caller !== null ? { callerAgentPath: caller } : {}),
      proposal: { sessionId: 'fixture-session', agentPath: caller },
    }
  );
}

async function expectNothingWritten() {
  expect(store.getTasks()).toEqual([]);
  expect(syncTask).not.toHaveBeenCalled();
  // Check every potential file destination, including an unsafe registered home.
  for (const dir of [home, dorkHome, agentPath, ...agents.map((agent) => agent.projectPath)]) {
    await expect(
      fs.access(path.join(dir, '.agents', 'skills', 'nightly-sweep', 'SKILL.md'))
    ).rejects.toThrow();
  }
  await expect(
    fs.access(path.join(dorkHome, 'skills', 'nightly-sweep', 'SKILL.md'))
  ).rejects.toThrow();
}

describe.each(['claude-code', 'codex'])('%s schedule folder hardening', (runtime) => {
  describe.each(['acceptEdits', 'bypassPermissions'])('at %s', (permissionMode) => {
    it.each([
      ['home', 'global'],
      ['data', 'global'],
      ['home', 'scout'],
      ['data', 'scout'],
    ])(
      'refuses protected %s execution through target %s before any write',
      async (folder, target) => {
        const unsafe = folder === 'home' ? home : dorkHome;
        agents = [{ id: 'scout', projectPath: unsafe }];
        const outcome = await create({ target, caller: unsafe, runtime, permissionMode });
        expect(outcome).toMatchObject({ ok: false, status: 403, code: 'PROTECTED_FOLDER' });
        await expectNothingWritten();
      }
    );

    it('refuses a symlink alias of the data folder before any write', async () => {
      const alias = path.join(root, 'data-link');
      await fs.symlink(dorkHome, alias);
      agents = [{ id: 'scout', projectPath: alias }];
      const outcome = await create({ caller: alias, runtime, permissionMode });
      expect(outcome).toMatchObject({ ok: false, status: 403, code: 'PROTECTED_FOLDER' });
      await expectNothingWritten();
    });

    it.each([null, 'global'])(
      'keeps target %s in the caller home through file reconciliation',
      async (target) => {
        const outcome = await create({ target, runtime, permissionMode });
        expect(outcome.ok).toBe(true);
        if (!outcome.ok) return;
        expect(outcome.parked).toBe(true);
        expect(outcome.task.agentId).toBe('scout');
        expect(outcome.task.filePath).toBe(
          path.join(agentPath, '.agents', 'skills', 'nightly-sweep', 'SKILL.md')
        );
        const parsed = parseSkillFile(
          outcome.task.filePath,
          await fs.readFile(outcome.task.filePath, 'utf8'),
          SkillFrontmatterSchema
        );
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        const found = readScheduleFromSkill(parsed.definition, {
          resolvedPath: outcome.task.filePath,
          scope: 'project',
          projectPath: agentPath,
        });
        expect(found).not.toBeNull();
        if (!found) return;
        const synced = store.fileSync.upsertFromFile(found.def, 'scout');
        expect(synced.agentId).toBe('scout');
      }
    );
  });
});

it('refuses global fallback when the caller has no registered home', async () => {
  agents = [];
  expect(await create()).toMatchObject({ ok: false, status: 403 });
  await expectNothingWritten();
});

it('parks a global proposal from a caller it cannot identify, as before', async () => {
  // No agent to bind to: a person decides, and an agent-less run gets a fresh folder.
  const outcome = await create({ caller: null });
  expect(outcome.ok && outcome.task.agentId).toBe(null);
  expect(outcome.ok && outcome.parked).toBe(true);
});

it.each(['protected', 'unknown'] as const)(
  'names the project-folder fix when refusing an agent home that is %s',
  async (reason) => {
    agents = reason === 'protected' ? [{ id: 'scout', projectPath: home }] : [];
    const outcome = await create({ caller: reason === 'protected' ? home : agentPath });
    expect(outcome).toMatchObject({
      ok: false,
      status: 403,
      error:
        reason === 'protected'
          ? 'Schedules use your own folder by default. Give this agent a separate project folder.'
          : 'Schedules use your own folder by default. Choose an agent with a project folder.',
    });
    await expectNothingWritten();
  }
);

it('keeps a person-made global schedule global', async () => {
  const outcome = await create({ trusted: true });
  expect(outcome.ok && outcome.task.agentId).toBe(null);
  expect(outcome.ok && outcome.task.filePath).toBe(
    path.join(dorkHome, 'skills', 'nightly-sweep', 'SKILL.md')
  );
  expect(outcome.ok && outcome.parked).toBe(false);
});

it('keeps a person-made schedule under the agent they chose', async () => {
  agents = [{ id: 'scout', projectPath: home }];
  const outcome = await create({ target: 'scout', trusted: true });
  expect(outcome.ok && outcome.task.agentId).toBe('scout');
  expect(outcome.ok && outcome.parked).toBe(false);
});

it('still requires a target for a person-made schedule', async () => {
  expect(await create({ target: null, trusted: true })).toMatchObject({ ok: false, status: 400 });
  await expectNothingWritten();
});

it('allows an agent project that contains its development data folder', async () => {
  agentPath = path.join(home, 'project');
  dorkHome = path.join(agentPath, '.temp', 'data');
  await fs.mkdir(dorkHome, { recursive: true });
  vi.stubEnv('DORK_HOME', dorkHome);
  agents = [{ id: 'scout', projectPath: agentPath }];
  const outcome = await create();
  expect(outcome.ok).toBe(true);
  expect(outcome.ok && outcome.task.agentId).toBe('scout');
});

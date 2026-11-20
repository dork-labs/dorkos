/**
 * A task that says it reads outside text (DOR-3969): every run starts with the outsider mark and
 * runs in this process (the relay's payload carries no marks), its file's `true` reaches DorkOS's
 * own record so editing the file back cannot clear it, and an agent may turn it on but never off.
 * Driven through the real scheduler, store and file sync.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import type { MeshCore } from '@dorkos/mesh';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import { DeclaredReaders, setDeclaredReaders } from '../../core/turn-power/declared-readers.js';
import { refuseOperatorOnlyTaskFields } from '../../runtimes/claude-code/mcp-tools/tasks/task-tool-parts.js';
import type { TaskFileSync } from '../sync/task-file-sync.js';
import { runMarked } from '../approvals/run-marks.js';
import {
  describeOperatorOnlyTaskRefusal,
  findOperatorOnlyTaskFields,
} from '../task-write-policy.js';
import { fileBackedChanges, planTaskFileUpdate } from '../task-file-update.js';
import {
  TaskSchedulerService,
  singleRuntimeSource,
  type SchedulerAgentManager,
} from '../task-scheduler-service.js';
import { TaskStore } from '../task-store.js';

const HOME = '/home/u/agents/wren';
const agents = [{ id: 'agent-w', name: 'wren', projectPath: HOME }];
const mesh = {
  listWithPaths: () => agents,
  getProjectPath: (id: string) => agents.find((a) => a.id === id)?.projectPath,
  get: (id: string) => agents.find((a) => a.id === id),
} as unknown as MeshCore;

/** A parsed SKILL.md for a schedule that may say it reads outside text. */
function definition(filePath: string, readsOutsideText?: boolean, name = 'inbox-sweep') {
  return {
    name,
    meta: {
      name,
      description: 'Reads the club inbox through a mail tool.',
      schedule: {
        timezone: 'UTC',
        enabled: true,
        sticky: false,
        permissions: 'acceptEdits',
        ...(readsOutsideText !== undefined ? { readsOutsideText } : {}),
      },
    },
    body: 'Sort the inbox.',
    filePath,
    dirPath: filePath.replace(`/${SKILL_FILENAME}`, ''),
    scope: 'global',
  } as Parameters<TaskFileSync['upsertFromFile']>[0];
}

let dir: string;
let file: string;
let store: TaskStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'declared-tasks-'));
  file = path.join(dir, 'declared-outside-readers.json');
  setDeclaredReaders(new DeclaredReaders({ file, logger: { warn: vi.fn() } }));
  store = new TaskStore(createTestDb());
});

afterEach(async () => {
  store.close();
  setDeclaredReaders(null);
  await rm(dir, { recursive: true, force: true });
});

describe('a task file that says it reads outside text', () => {
  it('is declared, and stays declared after the file is edited back to false', () => {
    const filePath = '/tmp/tasks/inbox-sweep/SKILL.md';
    const made = store.fileSync.upsertFromFile(definition(filePath, true), 'agent-w');
    expect(made.readsOutsideText).toBe(true);
    store.fileSync.upsertFromFile(definition(filePath, false), 'agent-w');
    expect(store.getTask(made.id)?.readsOutsideText).toBe(true);
    // A new store on the same record, as after a restart.
    setDeclaredReaders(new DeclaredReaders({ file, logger: { warn: vi.fn() } }));
    expect(store.getTask(made.id)?.readsOutsideText).toBe(true);
  });

  it('is not declared when its file never said so', () => {
    const made = store.fileSync.upsertFromFile(definition('/tmp/tasks/plain/SKILL.md'), 'agent-w');
    expect(made.readsOutsideText).toBeUndefined();
    expect(runMarked(store, made)).toBe(false);
  });
});

// Security's ruling: moving a task folder never drops what it said.
describe('a task folder that moves', () => {
  const discovered = { source: 'discovery' as const };
  /** A new store on the same record, as after a restart. */
  const restart = () =>
    setDeclaredReaders(new DeclaredReaders({ file, logger: { warn: vi.fn() } }));

  it('keeps the declaration on its new task, though its new file leaves it out', () => {
    const before = '/tmp/tasks/inbox-sweep/SKILL.md';
    const made = store.fileSync.upsertFromFile(definition(before, true), 'agent-w', discovered);
    store.fileSync.markRemovedByFilePath(before);
    const moved = store.fileSync.upsertFromFile(
      definition('/tmp/elsewhere/inbox-sweep/SKILL.md'),
      'agent-w',
      discovered
    );
    expect(moved.id).not.toBe(made.id);
    expect(moved.readsOutsideText).toBe(true);
    restart();
    expect(store.getTask(moved.id)?.readsOutsideText).toBe(true);
    expect(runMarked(store, moved)).toBe(true);
  });

  it('keeps it through a copy and the old one deleted, by its agent and name', () => {
    const made = store.fileSync.upsertFromFile(
      definition('/tmp/tasks/inbox-sweep/SKILL.md', true),
      'agent-w',
      discovered
    );
    const copyPath = '/tmp/copy/inbox-sweep/SKILL.md';
    const copy = store.fileSync.upsertFromFile(definition(copyPath, false), 'agent-w', discovered);
    store.deleteTask(made.id);
    restart();
    store.fileSync.upsertFromFile(definition(copyPath, false), 'agent-w', discovered);
    expect(store.getTask(copy.id)?.readsOutsideText).toBe(true);
    expect(runMarked(store, copy)).toBe(true);
  });

  it('renamed and moved at once is a new task: undeclared, and waiting for a person', () => {
    store.fileSync.upsertFromFile(
      definition('/tmp/tasks/inbox-sweep/SKILL.md', true),
      'agent-w',
      discovered
    );
    const renamed = store.fileSync.upsertFromFile(
      definition('/tmp/elsewhere/inbox-triage/SKILL.md', undefined, 'inbox-triage'),
      'agent-w',
      discovered
    );
    expect(renamed.readsOutsideText).toBeUndefined();
    expect(runMarked(store, renamed)).toBe(false);
    // A schedule found in a file never arms itself, whatever the trust preset.
    expect(renamed.status).toBe('pending_approval');
  });
});

describe('the file a write leaves behind', () => {
  const declaredFile =
    '---\nname: inbox-sweep\ndescription: d\nschedule:\n  cron: 0 9 * * *\n  readsOutsideText: true\n---\nSort the inbox.\n';

  it("writes `true` into the schedule block, and a person's `false` takes it out", () => {
    const off = planTaskFileUpdate('/tmp/t/SKILL.md', declaredFile, { readsOutsideText: false });
    expect(off.kind === 'write' && off.frontmatter.schedule).toEqual({ cron: '0 9 * * *' });
    const plain = declaredFile.replace('  readsOutsideText: true\n', '');
    const on = planTaskFileUpdate('/tmp/t/SKILL.md', plain, { readsOutsideText: true });
    expect(on.kind === 'write' && on.frontmatter.schedule).toEqual({
      cron: '0 9 * * *',
      readsOutsideText: true,
    });
  });

  it('a `false` on a task that never said so opens no file', () => {
    const row = {
      name: 'n',
      enabled: true,
      sticky: false,
      permissionMode: 'acceptEdits',
      prompt: 'p',
    };
    expect(fileBackedChanges({ readsOutsideText: false }, row)).toEqual([]);
    expect(fileBackedChanges({ readsOutsideText: true }, row)).toEqual(['readsOutsideText']);
  });
});

describe('an agent may turn it on, never off', () => {
  it('the field policy lets `true` through and refuses anything else', () => {
    expect(findOperatorOnlyTaskFields({ readsOutsideText: true })).toEqual([]);
    expect(findOperatorOnlyTaskFields({ readsOutsideText: false })).toEqual(['readsOutsideText']);
    expect(findOperatorOnlyTaskFields({ readsOutsideText: null })).toEqual(['readsOutsideText']);
  });

  it('tasks_create and tasks_update refuse a `false` whole', () => {
    expect(refuseOperatorOnlyTaskFields({ id: 't', readsOutsideText: true })).toBeNull();
    const refused = refuseOperatorOnlyTaskFields({ id: 't', readsOutsideText: false });
    expect(refused?.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain('Only a person can turn this off: readsOutsideText.');
  });

  it('says only who may turn it off, never how much the task may do', () => {
    expect(describeOperatorOnlyTaskRefusal(['readsOutsideText'])).toBe(
      'DorkOS changed nothing. Only a person can turn this off: readsOutsideText. ' +
        'Send the rest of your changes again without it.'
    );
    const mixed = describeOperatorOnlyTaskRefusal(['permissionMode', 'readsOutsideText']);
    expect(mixed).toContain('how much it may do without asking is the person');
    expect(mixed).toContain(': permissionMode.');
    expect(mixed).toMatch(/Only a person can turn this off: readsOutsideText\.$/);
  });
});

describe('a run of a task that reads outside text', () => {
  let manager: SchedulerAgentManager;
  let service: TaskSchedulerService;
  let turnStarted: Promise<void>;

  beforeEach(() => {
    registerTestHomes([HOME]);
    turnStarted = new Promise<void>((resolve) => {
      manager = {
        ensureSession: vi.fn(),
        sendMessage: vi.fn().mockImplementation(async function* () {
          resolve();
        }),
        interruptQuery: vi.fn().mockResolvedValue(true),
        getInternalSessionId: vi.fn(() => undefined),
        acquireLock: vi.fn(() => true),
        releaseLock: vi.fn(),
      } as unknown as SchedulerAgentManager;
    });
    service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(manager),
      config: { maxConcurrentRuns: 1, retentionCount: 100, mayFire: true, firingReason: 'test' },
      meshCore: mesh,
    });
  });

  afterEach(async () => {
    await service.stop();
    clearTestHomes();
  });

  /** Run the task now and return the options its turn was sent with. */
  async function runNow(id: string) {
    await service.triggerManualRun(id);
    await turnStarted;
    return vi.mocked(manager.sendMessage).mock.calls[0]![2] as Record<string, unknown>;
  }

  it('starts the turn with the outsider mark, and must run in this process', async () => {
    const made = store.fileSync.upsertFromFile(
      definition('/tmp/tasks/inbox-sweep/SKILL.md', true),
      'agent-w'
    );
    expect(runMarked(store, made)).toBe(true);
    expect((await runNow(made.id)).carriedMarks).toEqual({ outsider: true });
  });

  it('a task that never said so starts unmarked', async () => {
    const made = store.fileSync.upsertFromFile(definition('/tmp/tasks/plain/SKILL.md'), 'agent-w');
    expect((await runNow(made.id)).carriedMarks).toBeUndefined();
  });
});

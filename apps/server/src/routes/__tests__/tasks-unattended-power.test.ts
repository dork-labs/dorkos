/**
 * `POST /api/tasks` resolves an omitted permission mode from the operator's own
 * trust stop (spec `full-power-defaults`, D6).
 *
 * `CreateTaskRequestSchema` used to default the field to `'acceptEdits'`, so
 * every scheduled run started at one fixed level no matter what the person had
 * chosen everywhere else. The default is gone and a ladder replaced it. These
 * cases pin the ladder's ENDS, which is where a regression would actually hurt:
 * an install with nothing configured must still land on exactly `'acceptEdits'`,
 * and the two guards that stand between an agent and a raised task must still
 * hold with the default no longer supplying the key.
 *
 * The config and the registry are mocked rather than booted, because the real
 * resolver is what is under test here: it reads a stored `runtimes` block and a
 * runtime's real capability profile, and both arrive through those two seams.
 *
 * @module routes/__tests__/tasks-unattended-power
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { CLAUDE_CODE_CAPABILITIES } from '../../services/runtimes/claude-code/runtime-constants.js';

/** Mutable state the mocked config manager and registry report. */
const state = vi.hoisted(() => ({
  runtimes: undefined as unknown,
  registered: true,
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => {
      if (key === 'auth') return { enabled: false };
      if (key === 'runtimes') return state.runtimes;
      return undefined;
    },
  },
}));

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getAllCapabilities: () => (state.registered ? { 'claude-code': CLAUDE_CODE_CAPABILITIES } : {}),
  },
}));

vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

vi.mock('@dorkos/skills/writer', () => ({
  writeSkillFile: vi.fn().mockResolvedValue('/tmp/dork-test/tasks/nightly/SKILL.md'),
  deleteSkillDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@dorkos/skills/parser', () => ({
  parseSkillFile: vi.fn().mockReturnValue({ ok: false, errors: ['mocked'] }),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    default: {
      ...(actual.default as Record<string, unknown>),
      access: vi.fn().mockRejectedValue(new Error('ENOENT')),
      // A path the POST path just "wrote" reads back empty; every other path is
      // a row fixture with no file behind it, and the honest answer for those is
      // ENOENT. The update route now tells that apart from a file it cannot read
      // or parse, and only ENOENT means "legacy DB-only task, edit the row alone"
      // (DOR-1481) — so a blanket empty read would make every fixture here look
      // like a file whose contents are unparseable garbage.
      readFile: vi.fn().mockImplementation(async (p: string) => {
        if (typeof p === 'string' && p.startsWith('/tmp/dork-test/')) return '';
        throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
          code: 'ENOENT',
        });
      }),
    },
  };
});

import { writeSkillFile } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { createTasksRouter } from '../tasks.js';
import { TaskRegistrar } from '../../services/tasks/task-registrar.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';

/** The stored `runtimes` block, with one section's fields replaced. */
function runtimes(overrides: Partial<UserConfig['runtimes']> = {}): UserConfig['runtimes'] {
  return { ...USER_CONFIG_DEFAULTS.runtimes, ...overrides };
}

function createMockScheduler(): TaskSchedulerService {
  return {
    isStarted: true,
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    triggerManualRun: vi.fn().mockResolvedValue(null),
    cancelRun: vi.fn().mockResolvedValue({ state: 'not_found' }),
    getNextRun: vi.fn().mockReturnValue(new Date('2026-03-01T00:00:00Z')),
    previewNextRuns: vi.fn().mockReturnValue([]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
}

/**
 * Make `parseSkillFile` answer as though the SKILL.md the route just wrote parsed
 * cleanly, declaring `permissions` (or omitting the key when `undefined`, which
 * is what the route writes for `acceptEdits`).
 *
 * @param permissions - The mode the file declares, or `undefined` for no line.
 */
function mockParsedFile(permissions: string | undefined): void {
  vi.mocked(parseSkillFile).mockReturnValue({
    ok: true,
    definition: {
      name: 'nightly',
      meta: {
        name: 'nightly',
        description: 'sweep the repo',
        cron: '0 3 * * *',
        timezone: 'UTC',
        enabled: true,
        ...(permissions !== undefined ? { permissions } : {}),
      },
      body: 'sweep it',
      filePath: '/tmp/dork-test/tasks/nightly/SKILL.md',
      dirPath: '/tmp/dork-test/tasks/nightly',
      scope: 'global',
    },
  } as unknown as ReturnType<typeof parseSkillFile>);
}

/** The body a person's task form sends, minus whatever a case overrides. */
function createBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'nightly',
    description: 'sweep the repo',
    prompt: 'sweep it',
    cron: '0 3 * * *',
    target: 'global',
    ...overrides,
  };
}

describe('POST /api/tasks resolves an omitted permission mode', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let scheduler: TaskSchedulerService;

  beforeEach(() => {
    state.runtimes = runtimes();
    state.registered = true;
    vi.mocked(parseSkillFile).mockReturnValue({
      ok: false,
      errors: ['mocked'],
    } as unknown as ReturnType<typeof parseSkillFile>);
    vi.mocked(writeSkillFile).mockClear();
    scheduler = createMockScheduler();
    db = createTestDb();
    store = new TaskStore(db);

    app = express();
    app.use(express.json());
    app.use(
      '/api/tasks',
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), '/tmp/dork-test')
    );
  });

  afterEach(() => {
    store.close();
  });

  it('lands on exactly acceptEdits when no stop is configured', async () => {
    // The byte-for-byte regression: anybody who never answered the power door
    // gets what this route has always produced.
    const res = await request(app).post('/api/tasks').send(createBody());

    expect(res.status).toBe(201);
    expect(store.getTasks()[0]!.permissionMode).toBe('acceptEdits');
  });

  it('writes no `permissions:` line into the file at that level', async () => {
    // Unchanged behavior, and worth pinning: `acceptEdits` is the level the file
    // format leaves unsaid, so the default must not start writing it out.
    await request(app).post('/api/tasks').send(createBody());

    const frontmatter = vi.mocked(writeSkillFile).mock.calls[0]![2] as Record<string, unknown>;
    expect(frontmatter.permissions).toBeUndefined();
  });

  it("uses the runtime's own autonomy mode when the operator is at full power", async () => {
    state.runtimes = runtimes({ defaultTrustStop: 'autonomy' });

    const res = await request(app).post('/api/tasks').send(createBody());

    expect(res.status).toBe(201);
    expect(store.getTasks()[0]!.permissionMode).toBe('bypassPermissions');
    const frontmatter = vi.mocked(writeSkillFile).mock.calls[0]![2] as Record<string, unknown>;
    expect(frontmatter.permissions).toBe('bypassPermissions');
  });

  it('uses an ask-first stop when that is what the operator chose', async () => {
    state.runtimes = runtimes({ defaultTrustStop: 'ask' });

    await request(app).post('/api/tasks').send(createBody());

    expect(store.getTasks()[0]!.permissionMode).toBe('default');
  });

  it("lets the runtime's own override beat the global stop", async () => {
    state.runtimes = runtimes({
      defaultTrustStop: 'autonomy',
      claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultTrustStop: 'ask' },
    });

    await request(app).post('/api/tasks').send(createBody());

    expect(store.getTasks()[0]!.permissionMode).toBe('default');
  });

  it('falls back to acceptEdits when the target runtime is not registered', async () => {
    state.registered = false;
    state.runtimes = runtimes({ defaultTrustStop: 'autonomy' });

    await request(app).post('/api/tasks').send(createBody());

    expect(store.getTasks()[0]!.permissionMode).toBe('acceptEdits');
  });

  it('never touches a mode the caller named', async () => {
    state.runtimes = runtimes({ defaultTrustStop: 'autonomy' });

    await request(app)
      .post('/api/tasks')
      .send(createBody({ permissionMode: 'plan' }));

    expect(store.getTasks()[0]!.permissionMode).toBe('plan');
  });
});

describe('the guards that stand between an agent and a raised task', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let scheduler: TaskSchedulerService;

  beforeEach(() => {
    state.runtimes = runtimes({ defaultTrustStop: 'autonomy' });
    state.registered = true;
    vi.mocked(writeSkillFile).mockClear();
    scheduler = createMockScheduler();
    db = createTestDb();
    store = new TaskStore(db);

    app = express();
    app.use(express.json());
    app.use(
      '/api/tasks',
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), '/tmp/dork-test')
    );
  });

  afterEach(() => {
    store.close();
  });

  it('still refuses an agent that names permissionMode, 403, with nothing created', async () => {
    vi.mocked(parseSkillFile).mockReturnValue({
      ok: false,
      errors: ['mocked'],
    } as unknown as ReturnType<typeof parseSkillFile>);

    const res = await request(app)
      .post('/api/tasks')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send(createBody({ permissionMode: 'bypassPermissions', reason: 'because' }));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('operator_only_task_field');
    expect(res.body.fields).toEqual(['permissionMode']);
    expect(store.getTasks()).toHaveLength(0);
  });

  it('clamps for an agent — in the ROW and in the FILE — with the operator at full power', async () => {
    // The clamp regression, and the file half of it is not decoration. This is a
    // file-first architecture: the reconciler and the watcher both re-read the
    // SKILL.md, so a file declaring `permissions: bypassPermissions` over a row
    // holding `acceptEdits` is a standing request from disk that no caller was
    // allowed to make. It used to write exactly that, because the frontmatter was
    // built from the RESOLVED mode and only the row was clamped.
    mockParsedFile(undefined);

    const res = await request(app)
      .post('/api/tasks')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send(createBody({ reason: 'nightly sweep, please' }));

    expect(res.status).toBe(201);
    const created = store.getTasks()[0]!;
    expect(created.permissionMode).toBe('acceptEdits');
    // …and it is parked, so nothing fires until a person says so.
    expect(created.status).toBe('pending_approval');

    // The file agrees: `acceptEdits` is the level the format leaves unsaid, so
    // the clamped write means no `permissions:` line at all.
    const frontmatter = vi.mocked(writeSkillFile).mock.calls[0]![2] as Record<string, unknown>;
    expect(frontmatter.permissions).toBeUndefined();
  });
});

/**
 * The un-clamp at `routes/tasks.ts`, driven end to end through the file path.
 *
 * This is the line the resolved mode widened, and the only one in the change
 * that can put a never-asking mode on a row nobody typed it into. Both
 * directions are pinned here, against the STORED ROW rather than the response
 * body, because the row is what the scheduler will read at 3am.
 */
describe('the un-clamp, for a trusted caller who named no mode', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let scheduler: TaskSchedulerService;

  beforeEach(() => {
    state.registered = true;
    vi.mocked(writeSkillFile).mockClear();
    scheduler = createMockScheduler();
    db = createTestDb();
    store = new TaskStore(db);

    app = express();
    app.use(express.json());
    app.use(
      '/api/tasks',
      createTasksRouter(store, scheduler, new TaskRegistrar({ store, scheduler }), '/tmp/dork-test')
    );
  });

  afterEach(() => {
    store.close();
  });

  it('really does store bypassPermissions when the operator sits at autonomy', async () => {
    state.runtimes = runtimes({ defaultTrustStop: 'autonomy' });
    // The route writes the file from the resolved mode and then reads it back,
    // so the parse has to carry what the route just wrote — which the assertion
    // below on the frontmatter confirms it did.
    mockParsedFile('bypassPermissions');

    const res = await request(app).post('/api/tasks').send(createBody());

    expect(res.status).toBe(201);
    const frontmatter = vi.mocked(writeSkillFile).mock.calls[0]![2] as Record<string, unknown>;
    expect(frontmatter.permissions).toBe('bypassPermissions');
    // The store clamped the file-declared mode down to `acceptEdits`; the
    // route's un-clamp put it back, because a trusted caller's own configured
    // stop is not a SKILL.md making a claim about itself.
    const created = store.getTasks()[0]!;
    expect(created.permissionMode).toBe('bypassPermissions');
    // Trusted, so it arms rather than parking — which is what makes the mode on
    // this row the one a run will actually use.
    expect(created.status).toBe('active');
  });

  it('stores acceptEdits when the operator sits at act, with no un-clamp in sight', async () => {
    state.runtimes = runtimes({ defaultTrustStop: 'act' });
    // `act` resolves to `acceptEdits` on Claude Code, which is the level the file
    // format leaves unsaid — so no `permissions:` line is written at all.
    mockParsedFile(undefined);

    const res = await request(app).post('/api/tasks').send(createBody());

    expect(res.status).toBe(201);
    const frontmatter = vi.mocked(writeSkillFile).mock.calls[0]![2] as Record<string, unknown>;
    expect(frontmatter.permissions).toBeUndefined();
    expect(store.getTasks()[0]!.permissionMode).toBe('acceptEdits');
  });
});

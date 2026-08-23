/**
 * An agent must never be able to stand up a schedule that runs without asking.
 *
 * ## Why this file does not mock the skills layer
 *
 * The neighbouring `tasks-unattended-power.test.ts` mocks `writeSkillFile` and
 * `parseSkillFile`, which is right for asserting what the route DOES with a
 * parse result. It is wrong for this file, because the vulnerability being
 * pinned here lives precisely in the gap between two schemas — what
 * `CreateTaskRequestSchema` accepts from a caller, and what
 * `TaskFrontmatterSchema` accepts back off the disk the route just wrote. A
 * mocked parser is the route's own belief about that gap, and the exploit is
 * that the belief was wrong. So the writer, the parser and the filesystem are
 * all real here, and the only seams are the operator's config and the runtime
 * registry.
 *
 * ## The escalation this closes
 *
 * `POST /api/tasks` resolves an omitted `permissionMode` from the operator's
 * configured trust stop (spec `full-power-defaults`, D6), so on a full-power
 * install it resolves to `bypassPermissions`. The route writes that into the
 * frontmatter and reads the file back. When the re-parse SUCCEEDS, the store's
 * clamp refuses a file-declared bypass and only a trusted caller's explicit
 * un-clamp can put it back — an agent gets `acceptEdits`.
 *
 * When the re-parse FAILS, the route used to fall back to a direct
 * `store.createTask`, which is not a file path and therefore had no clamp at
 * all. And an agent chooses whether the re-parse fails: several request fields
 * were looser than their frontmatter counterparts, so a body the request schema
 * accepts could produce a file the frontmatter schema rejects. `max-runtime` was
 * the sharpest (`z.string()` against a duration regex), but a 2000-character
 * description did it too.
 *
 * The row that resulted parked at `pending_approval` — and parking is not the
 * protection, because approving is one click and `keepsApprovedBypass` then
 * preserves the grant on every later sync. The operator would be approving a
 * bypass no screen ever showed them and no caller was allowed to ask for.
 *
 * Every case below therefore asserts the STORED ROW, which is what the scheduler
 * reads at 3am.
 *
 * @module routes/__tests__/tasks-permission-escalation
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { CLAUDE_CODE_CAPABILITIES } from '../../services/runtimes/claude-code/runtime-constants.js';

/** Mutable state the mocked config manager and registry report. */
const state = vi.hoisted(() => ({ runtimes: undefined as unknown }));

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
    getAllCapabilities: () => ({ 'claude-code': CLAUDE_CODE_CAPABILITIES }),
  },
}));

vi.mock('../../lib/boundary.js', () => ({
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));

import { createTasksRouter } from '../tasks.js';
import { TaskStore } from '../../services/tasks/task-store.js';
import type { TaskSchedulerService } from '../../services/tasks/task-scheduler-service.js';

/** The operator's `runtimes` block, sitting at full power. */
function autonomyRuntimes(): UserConfig['runtimes'] {
  return { ...USER_CONFIG_DEFAULTS.runtimes, defaultTrustStop: 'autonomy' };
}

function createMockScheduler(): TaskSchedulerService {
  return {
    registerTask: vi.fn(),
    unregisterTask: vi.fn(),
    triggerManualRun: vi.fn().mockResolvedValue(null),
    cancelRun: vi.fn().mockResolvedValue({ state: 'not_found' }),
    getNextRun: vi.fn().mockReturnValue(null),
    previewNextRuns: vi.fn().mockReturnValue([]),
    getActiveRunCount: vi.fn().mockReturnValue(0),
    isRegistered: vi.fn().mockReturnValue(false),
  } as unknown as TaskSchedulerService;
}

describe('an agent cannot escalate a schedule to bypassPermissions', () => {
  let app: express.Application;
  let store: TaskStore;
  let db: Db;
  let dorkHome: string;

  beforeEach(() => {
    state.runtimes = autonomyRuntimes();
    dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-task-escalation-'));
    db = createTestDb();
    store = new TaskStore(db);

    app = express();
    app.use(express.json());
    app.use('/api/tasks', createTasksRouter(store, createMockScheduler(), dorkHome));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dorkHome, { recursive: true, force: true });
  });

  /** The body an agent sends, with whatever a case adds to force a parse failure. */
  function agentBody(overrides: Record<string, unknown> = {}) {
    return {
      name: 'nightly',
      description: 'sweep the repo',
      prompt: 'sweep it',
      cron: '0 3 * * *',
      target: 'global',
      reason: 'nightly sweep, please',
      ...overrides,
    };
  }

  it('proves the setup is live: the operator really is at full power', () => {
    // Without this the rest of the file could pass by resolving `acceptEdits`
    // for a boring reason and prove nothing at all.
    expect((state.runtimes as UserConfig['runtimes']).defaultTrustStop).toBe('autonomy');
  });

  it('still refuses an agent that simply asks for the mode', async () => {
    // The guard that does work, pinned here as the baseline the cases below are
    // trying to get around.
    const res = await request(app)
      .post('/api/tasks')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send(agentBody({ permissionMode: 'bypassPermissions' }));

    expect(res.status).toBe(403);
    expect(store.getTasks()).toHaveLength(0);
  });

  it('clamps on the happy path, where the file parses', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send(agentBody());

    expect(res.status).toBe(201);
    expect(store.getTasks()[0]!.permissionMode).toBe('acceptEdits');
  });

  it('clamps when a bad max-runtime makes the written file unreadable (DOR-1432 escalation)', async () => {
    // THE EXPLOIT. `maxRuntime` was `z.string()` on the request and a duration
    // regex in the frontmatter, so this body is accepted, written, and then
    // fails its own re-parse — landing on the fallback insert, which had no
    // clamp and was handed the resolved `bypassPermissions`.
    const res = await request(app)
      .post('/api/tasks')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send(agentBody({ maxRuntime: 'banana' }));

    const created = store.getTasks()[0];
    // Either refusing the body or clamping the row is a correct answer; what is
    // NOT correct is a stored bypass. Asserted this way so the case keeps
    // meaning what it says whichever half of the fix is reached first.
    if (created) expect(created.permissionMode).not.toBe('bypassPermissions');
    expect([201, 400]).toContain(res.status);
  });

  it('clamps when an over-long description makes the written file unreadable', async () => {
    // The same trick through a different field: the request had no length cap
    // and the frontmatter caps at 1024. Pinned because the structural fix has to
    // hold for every such divergence, not just the one that was reported.
    const res = await request(app)
      .post('/api/tasks')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send(agentBody({ description: 'x'.repeat(2000) }));

    const created = store.getTasks()[0];
    if (created) expect(created.permissionMode).not.toBe('bypassPermissions');
    expect([201, 400]).toContain(res.status);
  });

  it('clamps when a name that slugifies to nothing makes the file unreadable', async () => {
    // The third divergence: `slugify` can answer the empty string, which the
    // frontmatter's name rule rejects.
    const res = await request(app)
      .post('/api/tasks')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send(agentBody({ name: '!!!' }));

    const created = store.getTasks()[0];
    if (created) expect(created.permissionMode).not.toBe('bypassPermissions');
    expect([201, 400]).toContain(res.status);
  });
});

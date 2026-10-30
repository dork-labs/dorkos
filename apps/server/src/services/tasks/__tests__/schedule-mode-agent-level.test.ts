/**
 * A schedule file's mode clamps to its agent's own level, not a fixed
 * `acceptEdits` (DOR-3425), and a looser mode is new work to approve.
 *
 * @module services/tasks/__tests__/schedule-mode-agent-level
 */
import { afterAll, beforeAll, describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { clampModeToCeiling } from '@dorkos/shared/permission-semantics';
import type { PermissionMode } from '@dorkos/shared/schemas';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import { boundTurnOpts } from '../../core/turn-power/agent-level-bound.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import {
  CHANGED_REASON,
  FILE_ASKS_FOR_MORE_REASON,
  needsScheduleApprovalAttention,
  type FileAgentLevel,
} from '../schedule-permission-clamp.js';
import { changesApprovedWork } from '../task-file-update.js';
import { TaskStore } from '../task-store.js';
import type { TaskFileSync } from '../sync/task-file-sync.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const AGENT = '/home/u/agent';
const FILE_PATH = `${AGENT}/.agents/skills/sweeper/${SKILL_FILENAME}`;
const FULL: FileAgentLevel = { bypassAs: 'bypassPermissions', full: true };
const ASK: FileAgentLevel = { bypassAs: 'default', full: false };

/** A parsed SKILL.md declaring `permissions`. */
function definition(permissions: string) {
  return {
    name: 'sweeper',
    meta: {
      name: 'sweeper',
      description: 'Sweep the repo overnight',
      schedule: { cron: '0 3 * * *', timezone: 'UTC', enabled: true, permissions },
    },
    body: 'sweep it',
    filePath: FILE_PATH,
    dirPath: FILE_PATH.replace(`/${SKILL_FILENAME}`, ''),
    scope: 'project',
  } as Parameters<TaskFileSync['upsertFromFile']>[0];
}

describe('a schedule file clamps to its agent’s level', () => {
  let store: TaskStore;
  let db: Db;

  beforeAll(() => registerTestHomes([AGENT]));
  afterAll(() => clearTestHomes());

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
  });

  /** One discovery sync of the file, as the watcher or the reconciler runs it. */
  function sync(permissions: string, agentLevel?: FileAgentLevel | null, agentId?: string) {
    return store.fileSync.upsertFromFile(definition(permissions), agentId, {
      source: 'discovery',
      problem: null,
      packageOwned: null,
      ...(agentLevel !== undefined ? { agentLevel } : {}),
    });
  }

  /** A person approving the row, as the route does. */
  function approve(id: string) {
    store.updateTask(id, { status: 'active' });
    return store.getTask(id)!;
  }

  describe('no agent, no lift', () => {
    it('keeps the fixed cap on a row with no agent, approved or not', () => {
      const first = sync('bypassPermissions', null);
      expect(first.permissionMode).toBe('acceptEdits');
      expect(approve(first.id).permissionMode).toBe('acceptEdits');

      const again = sync('bypassPermissions', null);
      expect(again.permissionMode).toBe('acceptEdits');
      expect(again.status).toBe('active');
    });
  });

  describe('agent at Full', () => {
    it('runs at Full once approved, stays approved, and asks nothing in the run', async () => {
      const first = sync('bypassPermissions', FULL, 'agent-1');
      // Nobody approved it yet: held, and quiet.
      expect(first.status).toBe('pending_approval');
      expect(first.quietHold).toBe(true);

      expect(approve(first.id).permissionMode).toBe('bypassPermissions');
      const again = sync('bypassPermissions', FULL, 'agent-1');
      expect(again.status).toBe('active');
      expect(again.permissionMode).toBe('bypassPermissions');
      expect(again.quietHold).toBe(false);

      // The run-time bound leaves it where it is: no ceiling, so no card.
      const run = await boundLevel('bypassPermissions', 'bypassPermissions');
      expect(run.runsAt).toBe('bypassPermissions');
      expect(run.ceiling).toBeUndefined();
    });

    it('holds a looser file quietly, with its row kept out of the escalation re-arm', () => {
      const row = sync('default', FULL, 'agent-1');
      approve(row.id);

      const held = sync('bypassPermissions', FULL, 'agent-1');
      expect(held.status).toBe('pending_approval');
      expect(held.reason).toBe(FILE_ASKS_FOR_MORE_REASON);
      expect(held.quietHold).toBe(true);
      // Still a row a person can act on.
      expect(needsScheduleApprovalAttention(held)).toBe(true);
    });

    it('keeps the quiet sentence across syncs, and drops it when the level falls', () => {
      const row = sync('default', FULL, 'agent-1');
      approve(row.id);
      sync('bypassPermissions', FULL, 'agent-1');

      expect(sync('bypassPermissions', FULL, 'agent-1').quietHold).toBe(true);
      expect(sync('bypassPermissions', ASK, 'agent-1').quietHold).toBe(false);
    });
  });

  describe('agent at Ask', () => {
    it('writes Ask, runs at Ask, and needs no new approval', async () => {
      const row = sync('default', ASK, 'agent-1');
      approve(row.id);

      const again = sync('bypassPermissions', ASK, 'agent-1');
      expect(again.permissionMode).toBe('default');
      expect(again.status).toBe('active');

      expect((await boundLevel('default', 'default')).runsAt).toBe('default');
    });

    it('holds a stored bypass down to Ask at run time', async () => {
      expect((await boundLevel('bypassPermissions', 'default')).runsAt).toBe('default');
    });
  });

  describe('a mode change is a change to approved work', () => {
    it('parks when a file goes looser after approval, and does not run at the new mode', () => {
      const row = sync('default', null);
      approve(row.id);

      const held = sync('bypassPermissions', null);
      expect(held.status).toBe('pending_approval');
      expect(held.reason).toBe(CHANGED_REASON);
      expect(held.quietHold).toBe(false);
      expect(held.permissionMode).toBe('acceptEdits');
    });

    it('takes a file going stricter without asking', () => {
      const row = sync('acceptEdits', null);
      approve(row.id);

      const lowered = sync('default', null);
      expect(lowered.status).toBe('active');
      expect(lowered.permissionMode).toBe('default');
    });

    it('asks again when a lowered file goes back up', () => {
      const row = sync('acceptEdits', null);
      approve(row.id);
      sync('default', null);

      expect(sync('acceptEdits', null).status).toBe('pending_approval');
    });

    it('counts the mode in changesApprovedWork', () => {
      const existing = {
        prompt: 'p',
        cron: null,
        timezone: null,
        name: 'n',
        runtime: null,
        model: null,
        effort: null,
        maxRuntime: null,
        sticky: false,
        account: null,
        permissionMode: 'default',
      };
      expect(changesApprovedWork({ permissionMode: 'default' }, existing)).toBe(false);
      expect(changesApprovedWork({ permissionMode: 'bypassPermissions' }, existing)).toBe(true);
    });
  });

  describe('marked origins stay capped', () => {
    /** A row a marked turn wrote: parked, with its marks kept. */
    function marked() {
      const row = sync('acceptEdits', FULL, 'agent-1');
      db.update(pulseSchedules)
        .set({ originMarks: JSON.stringify({ outsider: true }) })
        .where(eq(pulseSchedules.id, row.id))
        .run();
      return row;
    }

    it('never lifts a marked row, and never holds it quietly', () => {
      marked();
      const again = sync('bypassPermissions', FULL, 'agent-1');
      expect(again.permissionMode).toBe('acceptEdits');
      expect(again.status).toBe('pending_approval');
      expect(again.quietHold).toBe(false);
    });

    it('lifts only after a person approved it, and then asks about the new mode', () => {
      const row = marked();
      approve(row.id);
      expect(store.getTask(row.id)?.originMarks).toBeNull();

      const again = sync('bypassPermissions', FULL, 'agent-1');
      expect(again.status).toBe('pending_approval');
      expect(again.quietHold).toBe(true);
    });
  });
});

/**
 * The mode a scheduled turn of an agent at `agentMode` launches at, through the
 * real run-time bound on Claude Code's own modes, and the ceiling it was sent.
 */
async function boundLevel(rowMode: PermissionMode, agentMode: string) {
  const runtime = {
    type: 'claude-code',
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    getSessionCwd: () => undefined,
  } as unknown as AgentRuntime;
  const sent = await boundTurnOpts(
    runtime,
    'session-1',
    { permissionMode: rowMode, unattended: true, cwd: AGENT },
    {
      storedModeOf: () => rowMode,
      levelOf: async () => ({ stop: null, mode: agentMode }),
    }
  );
  const ceiling = sent?.permissionCeiling;
  return {
    ceiling,
    runsAt:
      ceiling === undefined
        ? rowMode
        : clampModeToCeiling(CLAUDE_CODE_CAPABILITIES.permissionModes, rowMode, ceiling),
  };
}

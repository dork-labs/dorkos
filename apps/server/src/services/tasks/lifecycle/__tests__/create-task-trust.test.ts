/**
 * An agent's schedule on a Trusted install is armed at once and the person is
 * told; on Careful it parks (ADR 261006-225605, spec `trusted-by-default-flip`
 * §5.4). Schedules that arrive as content (discovery, Shapes, packages) park
 * and are clamped whatever the posture.
 *
 * Driven through `createScheduledTask` with a real store and a real file, so
 * the status read back is the one the scheduler would see. Only the stored
 * preset and the notification seams are stand-ins.
 *
 * @module services/tasks/lifecycle/__tests__/create-task-trust
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { TaskStore } from '../../task-store.js';
import type { TaskFileSync } from '../../sync/task-file-sync.js';
import { createScheduledTask } from '../create-task.js';
import { notificationEntry } from '../../../notifications/notification-registry.js';

/** The stored preset, and what the notification seams were handed. */
const state = vi.hoisted(() => ({
  preset: 'trusted' as 'trusted' | 'careful',
  notified: [] as Array<{ kind: string; payload: unknown }>,
  raised: [] as Array<{ kind: string; payload: unknown }>,
}));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'permissions' ? { preset: state.preset } : undefined),
  },
}));

vi.mock('../../../notifications/notification-service.js', () => ({
  notify: async (kind: string, payload: unknown) => {
    state.notified.push({ kind, payload });
    return { notification: null, deduped: false };
  },
  resolveStanding: async () => undefined,
}));

vi.mock('../../../notifications/standing-events.js', () => ({
  raiseStanding: (kind: string, payload: unknown) => {
    state.raised.push({ kind, payload });
  },
}));

let store: TaskStore;
let dorkHome: string;

beforeEach(async () => {
  state.preset = 'trusted';
  state.notified = [];
  state.raised = [];
  store = new TaskStore(createTestDb());
  dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'create-task-trust-'));
});

afterEach(async () => {
  store.close();
  await fs.rm(dorkHome, { recursive: true, force: true });
});

const AGENT_REQUEST = {
  name: 'Nightly sweep',
  description: 'Sweep the backlog',
  prompt: 'Sweep the backlog.',
  cron: '0 3 * * *',
  target: 'global',
  reason: 'The overnight backlog needs sweeping before you start.',
};

/**
 * Create a schedule the way an agent door does.
 *
 * @param callerIsOurAgent - Whether the server identified the caller.
 */
async function agentCreates(callerIsOurAgent: boolean) {
  const outcome = await createScheduledTask(
    { store, registrar: null, dorkHome },
    {
      input: AGENT_REQUEST,
      trusted: false,
      callerIsOurAgent,
      proposal: { sessionId: 'ses-1', agentPath: '/tmp/agents/nb' },
    }
  );
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome;
}

describe('an agent schedule on a Trusted install', () => {
  it('is armed at once, names who made it, and tells the person with Pause', async () => {
    const outcome = await agentCreates(true);

    expect(outcome.parked).toBe(false);
    const row = store.getTask(outcome.task.id)!;
    expect(row.status).toBe('active');
    // The row still says which agent and session made it.
    expect(row.proposedBySessionId).toBe('ses-1');
    expect(row.proposedByAgentPath).toBe('/tmp/agents/nb');
    expect(row.reason).toBe(AGENT_REQUEST.reason);

    expect(state.raised).toEqual([]);
    expect(state.notified).toHaveLength(1);
    const { kind, payload } = state.notified[0]!;
    expect(kind).toBe('schedule.armed_by_agent');
    expect(payload).toEqual(outcome.armedPayload);
    expect(payload).toMatchObject({
      taskId: row.id,
      armedBy: 'An agent',
      cadence: 'every day at 3:00 AM',
      proposedBySessionId: 'ses-1',
    });

    const entry = notificationEntry('schedule.armed_by_agent');
    const armed = outcome.armedPayload!;
    expect(entry.title(armed)).toBe('An agent scheduled nightly-sweep');
    expect(entry.body?.(armed)).toBe('Runs every day at 3:00 AM. Pause it any time.');
    expect(entry.actions?.(armed).map((a) => a.id)).toEqual(['pause', 'open']);
  });

  it('parks when the caller is not known to be one of our agents', async () => {
    const outcome = await agentCreates(false);

    expect(outcome.parked).toBe(true);
    expect(store.getTask(outcome.task.id)!.status).toBe('pending_approval');
    expect(state.notified).toEqual([]);
    expect(state.raised.map((r) => r.kind)).toEqual(['schedule.parked']);
  });
});

describe('an agent schedule on a Careful install', () => {
  it('parks for a person and tells nobody it is live', async () => {
    state.preset = 'careful';
    const outcome = await agentCreates(true);

    expect(outcome.parked).toBe(true);
    expect(outcome.armedPayload).toBeUndefined();
    expect(store.getTask(outcome.task.id)!.status).toBe('pending_approval');
    expect(state.notified).toEqual([]);
    expect(state.raised.map((r) => r.kind)).toEqual(['schedule.parked']);
  });
});

describe('a schedule that arrives as content', () => {
  const FILE_PATH = `/home/u/.dork/skills/shape-digest/${SKILL_FILENAME}`;

  /** A discovered SKILL.md that asks for every approval prompt turned off. */
  function discovered() {
    return {
      name: 'shape-digest',
      meta: {
        name: 'shape-digest',
        description: 'From a Shape',
        schedule: {
          cron: '0 7 * * *',
          timezone: 'UTC',
          enabled: true,
          sticky: false,
          permissions: 'bypassPermissions',
        },
      },
      body: 'Post the digest.',
      filePath: FILE_PATH,
      dirPath: FILE_PATH.replace(`/${SKILL_FILENAME}`, ''),
      scope: 'global',
    } as Parameters<TaskFileSync['upsertFromFile']>[0];
  }

  it.each(['trusted', 'careful'] as const)('parks and is clamped on %s', (preset) => {
    state.preset = preset;
    const task = store.fileSync.upsertFromFile(discovered(), undefined, { source: 'discovery' });

    expect(task.status).toBe('pending_approval');
    expect(task.origin).toBe('file');
    expect(task.permissionMode).toBe('acceptEdits');
  });
});

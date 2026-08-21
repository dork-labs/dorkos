/**
 * What a parked schedule tells the notification pipeline about itself (DOR-1394).
 *
 * Two things have to be true of the payload and both were false before: it names
 * the agent that proposed the schedule rather than saying "An agent", and it
 * carries the session the proposal came from so the recorded row points at the
 * conversation behind it.
 *
 * @module services/notifications/__tests__/schedule-park-payload
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Task } from '@dorkos/shared/types';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
  type AgentIdentityService,
} from '../../core/agent-identity/index.js';
import { TaskStore } from '../../tasks/task-store.js';
import { resolveScheduleParkPayload, UNNAMED_PROPOSER } from '../emitters/schedule-park.js';
import { notificationEntry } from '../notification-registry.js';

const AGENT_PATH = '/tmp/agents/nightly-bot';

describe('the payload a parked schedule sends', () => {
  let db: Db;
  let store: TaskStore;
  let identity: AgentIdentityService;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    identity = initAgentIdentityService(db);
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  /** A schedule parked exactly as `tasks_create` parks one. */
  function parked(overrides: {
    proposedByAgentPath?: string | null;
    proposedBySessionId?: string | null;
  }): Task {
    const task = store.createTask({
      name: 'nightly-sweep',
      displayName: 'Nightly sweep',
      description: 'nightly',
      prompt: 'sweep the backlog',
      cron: '0 3 * * *',
      filePath: '',
      reason: 'The overnight backlog needs sweeping.',
      proposedBySessionId: overrides.proposedBySessionId ?? null,
      proposedByAgentPath: overrides.proposedByAgentPath ?? null,
    });
    return store.updateTask(task.id, { status: 'pending_approval' })!;
  }

  it('names the agent that proposed it', async () => {
    await identity.mint({ agentPath: AGENT_PATH, displayName: 'Nightly Bot' });
    const payload = await resolveScheduleParkPayload(
      parked({ proposedByAgentPath: AGENT_PATH, proposedBySessionId: 'ses-42' })
    );

    expect(payload.proposedBy).toBe('Nightly Bot');
    expect(payload.proposedBySessionId).toBe('ses-42');
    // The sentence a person actually reads, built by the registry from this payload.
    expect(notificationEntry('schedule.parked').title(payload)).toBe(
      'Nightly Bot proposed a scheduled task'
    );
  });

  it('falls back cleanly when nothing resolves', async () => {
    const payload = await resolveScheduleParkPayload(parked({}));

    expect(payload.proposedBy).toBe(UNNAMED_PROPOSER);
    expect(payload.proposedBySessionId).toBeUndefined();
    expect(notificationEntry('schedule.parked').title(payload)).toBe(
      'An agent proposed a scheduled task'
    );
  });

  it('falls back when the path is recorded but the agent has been revoked', async () => {
    await identity.mint({ agentPath: AGENT_PATH, displayName: 'Nightly Bot' });
    await identity.revoke(AGENT_PATH);
    const payload = await resolveScheduleParkPayload(parked({ proposedByAgentPath: AGENT_PATH }));
    expect(payload.proposedBy).toBe(UNNAMED_PROPOSER);
  });

  it('files the row against the proposing session, so the conversation is reachable', async () => {
    const payload = await resolveScheduleParkPayload(
      parked({ proposedBySessionId: 'ses-42', proposedByAgentPath: AGENT_PATH })
    );
    const located = notificationEntry('schedule.parked').locate(payload);

    expect(located.sessionId).toBe('ses-42');
    // Still filed under the TASK, which is what the approval actions act on.
    expect(located.subjectId).toBe(payload.taskId);
  });

  it('keys on the task alone, so naming the proposer cannot split one condition in two', async () => {
    // The escalation ladder disarms by dedupe key. If the key moved with the
    // resolved name, a condition armed before an agent was named and resolved
    // after it was revoked would be two different conditions, and a phone would
    // keep buzzing about a schedule somebody already approved.
    const task = parked({ proposedByAgentPath: AGENT_PATH, proposedBySessionId: 'ses-42' });
    const entry = notificationEntry('schedule.parked');

    const unnamed = await resolveScheduleParkPayload(task);
    await identity.mint({ agentPath: AGENT_PATH, displayName: 'Nightly Bot' });
    const named = await resolveScheduleParkPayload(task);

    expect(named.proposedBy).not.toBe(unnamed.proposedBy);
    expect(entry.dedupeKey(named)).toBe(entry.dedupeKey(unnamed));
  });
});

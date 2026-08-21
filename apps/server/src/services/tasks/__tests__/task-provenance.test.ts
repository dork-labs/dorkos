/**
 * Naming who proposed a schedule, at read time (DOR-1394).
 *
 * The one behaviour worth pinning here is that the name is never stored: a
 * proposal made by an agent that is later revoked has to stop naming it, and
 * the only way that can be true is if the lookup happens on every read.
 *
 * @module services/tasks/__tests__/task-provenance
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { Task } from '@dorkos/shared/types';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
  type AgentIdentityService,
} from '../../core/agent-identity/index.js';
import { TaskStore } from '../task-store.js';
import { resolveProposerName, withProposerName, withProposerNames } from '../task-provenance.js';

const AGENT_PATH = '/tmp/agents/nightly-bot';

describe('who proposed a schedule', () => {
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
    vi.restoreAllMocks();
  });

  /** A parked proposal, optionally attributed to a directory. */
  function proposal(proposedByAgentPath: string | null): Task {
    const task = store.createTask({
      name: 'nightly',
      description: 'nightly',
      prompt: 'sweep the backlog',
      cron: '0 3 * * *',
      filePath: '',
      reason: 'The overnight backlog needs sweeping.',
      proposedBySessionId: 'ses-1',
      proposedByAgentPath,
    });
    return store.updateTask(task.id, { status: 'pending_approval' })!;
  }

  describe('resolveProposerName', () => {
    it('names the agent that holds a live token for the directory', async () => {
      await identity.mint({ agentPath: AGENT_PATH, displayName: 'Nightly Bot' });
      await expect(resolveProposerName(AGENT_PATH)).resolves.toBe('Nightly Bot');
    });

    it('stops naming a revoked agent', async () => {
      await identity.mint({ agentPath: AGENT_PATH, displayName: 'Nightly Bot' });
      await identity.revoke(AGENT_PATH);
      // The whole reason the name is not persisted: an operator who switched an
      // agent off must not keep seeing its name on a card asking for approval.
      await expect(resolveProposerName(AGENT_PATH)).resolves.toBeNull();
    });

    it('answers null for a directory nothing was ever minted for', async () => {
      await expect(resolveProposerName('/tmp/agents/nobody')).resolves.toBeNull();
    });

    it('answers null when no path was recorded', async () => {
      await expect(resolveProposerName(null)).resolves.toBeNull();
      await expect(resolveProposerName('')).resolves.toBeNull();
    });

    it('answers null when no identity service is wired at all', async () => {
      resetAgentIdentityService();
      await expect(resolveProposerName(AGENT_PATH)).resolves.toBeNull();
    });

    it('degrades to null when the lookup throws, rather than failing the read', async () => {
      vi.spyOn(identity, 'describeAgent').mockRejectedValue(new Error('database is locked'));
      await expect(resolveProposerName(AGENT_PATH)).resolves.toBeNull();
    });
  });

  describe('withProposerName', () => {
    it('fills the name in on the task', async () => {
      await identity.mint({ agentPath: AGENT_PATH, displayName: 'Nightly Bot' });
      const named = await withProposerName(proposal(AGENT_PATH));
      expect(named.proposedByName).toBe('Nightly Bot');
      expect(named.proposedByAgentPath).toBe(AGENT_PATH);
    });

    it('leaves an operator-created task alone', async () => {
      const named = await withProposerName(proposal(null));
      expect(named.proposedByName).toBeNull();
    });
  });

  describe('withProposerNames', () => {
    it('names every task and asks once per distinct directory', async () => {
      await identity.mint({ agentPath: AGENT_PATH, displayName: 'Nightly Bot' });
      await identity.mint({ agentPath: '/tmp/agents/other', displayName: 'Other Bot' });
      const describeAgent = vi.spyOn(identity, 'describeAgent');

      const tasks = [
        proposal(AGENT_PATH),
        proposal(AGENT_PATH),
        proposal('/tmp/agents/other'),
        proposal(null),
      ];
      const named = await withProposerNames(tasks);

      expect(named.map((t) => t.proposedByName)).toEqual([
        'Nightly Bot',
        'Nightly Bot',
        'Other Bot',
        null,
      ]);
      // Two directories among four tasks: the list endpoint runs on every
      // cockpit poll, so a lookup per row would be a per-row database read.
      expect(describeAgent).toHaveBeenCalledTimes(2);
    });

    it('keeps the list in order and skips the lookup entirely when nothing is attributed', async () => {
      const describeAgent = vi.spyOn(identity, 'describeAgent');
      const tasks = [proposal(null), proposal(null)];
      const named = await withProposerNames(tasks);
      expect(named.map((t) => t.id)).toEqual(tasks.map((t) => t.id));
      expect(describeAgent).not.toHaveBeenCalled();
    });
  });
});

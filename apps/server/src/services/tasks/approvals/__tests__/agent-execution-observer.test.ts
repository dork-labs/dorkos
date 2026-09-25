/**
 * An agent's runtime, model or effort changed by editing its `.dork/agent.json`
 * rather than through DorkOS is recorded, and the approved schedules that
 * follow the agent wait for a person again (DOR-2337). Runs over a real
 * manifest in a temp directory and a real task store.
 *
 * @module services/tasks/approvals/__tests__/agent-execution-observer
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { writeManifest, readManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

import { TaskStore } from '../../task-store.js';
import {
  AGENT_EXECUTION_CHANGED_OUTSIDE_EVENT,
  AgentExecutionObserver,
} from '../agent-execution-observer.js';
import { AGENT_DEFAULTS_CHANGED_OUTSIDE_REASON } from '../../schedule-permission-clamp.js';
import { initAgentExecutionWrites } from '../../../core/agent-observation/agent-execution-writes.js';
import { updateAgentManifest } from '../../../core/operator/agent-updater.js';

const AGENT_ID = 'agent-warden';

interface Emitted {
  eventType: string;
  summary: string;
  actorLabel: string;
  metadata?: Record<string, unknown>;
}

describe('AgentExecutionObserver', () => {
  let root: string;
  let agentPath: string;
  let store: TaskStore;
  let events: Emitted[];
  let emitFails: boolean;
  let parkedRaised: string[];
  let observer: AgentExecutionObserver;

  function newObserver() {
    return new AgentExecutionObserver({
      snapshotFile: path.join(root, 'dork-home', 'agents', 'observed-execution.json'),
      agentAt: (p) => (p === agentPath ? { id: AGENT_ID, name: 'Warden' } : undefined),
      approvals: store.approvals,
      onParked: async (ids) => {
        parkedRaised.push(...ids);
      },
      activity: {
        emit: async (event) => {
          if (emitFails) throw new Error('activity is down');
          events.push(event as unknown as Emitted);
        },
      },
      logger: { warn: () => {} },
    });
  }

  async function manifest(): Promise<AgentManifest> {
    return (await readManifest(agentPath))!;
  }

  /** Edit the manifest the way a file tool would: DorkOS is not told. */
  async function editFile(fields: Partial<AgentManifest>): Promise<void> {
    await writeManifest(agentPath, { ...(await manifest()), ...fields });
  }

  function follower() {
    return store.createTask({
      name: 'digest',
      description: 'digest',
      prompt: 'Post the digest.',
      cron: '0 7 * * *',
      agentId: AGENT_ID,
      filePath: '/skills/digest/SKILL.md',
    });
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-observer-'));
    agentPath = path.join(root, 'warden');
    fs.mkdirSync(agentPath, { recursive: true });
    await writeManifest(agentPath, {
      id: AGENT_ID,
      name: 'warden',
      description: '',
      runtime: 'claude-code',
      model: 'claude-sonnet-4',
      capabilities: [],
      behavior: { responseMode: 'always' },
      registeredAt: new Date().toISOString(),
      registeredBy: 'test',
      personaEnabled: true,
      isSystem: false,
      enabledToolGroups: {},
      mcpServers: [],
      workspace: { mode: 'home' },
    } as AgentManifest);
    store = new TaskStore(createTestDb());
    events = [];
    emitFails = false;
    parkedRaised = [];
    observer = newObserver();
  });

  afterEach(() => {
    initAgentExecutionWrites(undefined);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('says nothing the first time it sees an agent', async () => {
    const task = follower();
    await observer.check(agentPath);

    expect(events).toEqual([]);
    expect(store.getTask(task.id)!.status).toBe('active');
  });

  it('records an outside edit old → new and re-asks for the schedules that follow', async () => {
    const task = follower();
    await observer.check(agentPath);

    await editFile({ model: 'claude-opus-4' });
    await observer.check(agentPath);

    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe(AGENT_EXECUTION_CHANGED_OUTSIDE_EVENT);
    expect(events[0]!.actorLabel).toBe('Changed outside DorkOS');
    expect(events[0]!.summary).toBe(
      "Warden's model claude-sonnet-4 → claude-opus-4, changed outside DorkOS. " +
        '1 scheduled task that follows it is waiting for you again'
    );
    const parked = store.getTask(task.id)!;
    expect(parked.status).toBe('pending_approval');
    expect(parked.reason).toBe(AGENT_DEFAULTS_CHANGED_OUTSIDE_REASON);
    expect(parked.approvalChanges).toEqual([
      { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'agent' },
    ]);
    expect(parkedRaised).toEqual([task.id]);
  });

  it('never takes DorkOS’s own write for an outside one', async () => {
    const task = follower();
    await observer.check(agentPath);

    await observer.writingExecution(agentPath, () => editFile({ model: 'claude-opus-4' }));
    await observer.check(agentPath);

    expect(events).toEqual([]);
    expect(store.getTask(task.id)!.status).toBe('active');
  });

  it('never parks for a person’s change made in the app', async () => {
    // Purpose: the app's Runs-on menu and the agent settings page save through
    // `updateAgentManifest`; with the observer installed as boot installs it,
    // that write is DorkOS's own and nothing waits.
    initAgentExecutionWrites((p, write) => observer.writingExecution(p, write));
    const task = follower();
    await observer.check(agentPath);

    await updateAgentManifest({ agentPath, body: { model: 'claude-opus-4', effort: 'high' } });
    await observer.check(agentPath);

    expect((await manifest()).model).toBe('claude-opus-4');
    expect(events).toEqual([]);
    expect(store.getTask(task.id)!.status).toBe('active');
  });

  it('does not let a DorkOS write carry an earlier outside edit through unseen', async () => {
    // Purpose: DorkOS's writes merge into the manifest, so a person changing
    // the effort in the app after an agent changed the model in the file must
    // not quietly adopt the agent's model as the new baseline.
    const task = follower();
    await observer.check(agentPath);
    await editFile({ model: 'claude-opus-4' });

    await observer.writingExecution(agentPath, () => editFile({ effort: 'high' }));

    expect(events).toHaveLength(1);
    expect(store.getTask(task.id)!.approvalChanges).toEqual([
      { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'agent' },
    ]);
    // And the person's effort is not reported afterwards.
    await observer.check(agentPath);
    expect(events).toHaveLength(1);
  });

  it('records a change back, and leaves the schedule waiting for a person', async () => {
    const task = follower();
    await observer.check(agentPath);
    await editFile({ model: 'claude-opus-4' });
    await observer.check(agentPath);

    await editFile({ model: 'claude-sonnet-4' });
    await observer.check(agentPath);

    expect(events).toHaveLength(2);
    expect(events[1]!.summary).toBe(
      "Warden's model claude-opus-4 → claude-sonnet-4, changed outside DorkOS. " +
        '1 scheduled task that follows it is waiting for you again'
    );
    const still = store.getTask(task.id)!;
    expect(still.status).toBe('pending_approval');
    expect(still.enabled).toBe(true);
    expect(still.approvalChanges).toEqual([
      { field: 'model', from: 'claude-sonnet-4', to: 'claude-sonnet-4', via: 'agent' },
    ]);
  });

  it('sees nothing of an edit reverted before anything looked', async () => {
    const task = follower();
    await observer.check(agentPath);
    await editFile({ model: 'claude-opus-4' });
    await editFile({ model: 'claude-sonnet-4' });

    await observer.check(agentPath);

    expect(events).toEqual([]);
    expect(store.getTask(task.id)!.status).toBe('active');
  });

  it('records one change once when two checks race on it', async () => {
    const task = follower();
    await observer.check(agentPath);
    await editFile({ model: 'claude-opus-4', effort: 'max' });

    await Promise.all([observer.check(agentPath), observer.check(agentPath)]);

    expect(events).toHaveLength(1);
    expect(store.getTask(task.id)!.approvalChanges).toEqual([
      { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'agent' },
      { field: 'effort', from: null, to: 'max', via: 'agent' },
    ]);
  });

  it('keeps the change to report again when it cannot be recorded', async () => {
    const task = follower();
    await observer.check(agentPath);
    await editFile({ model: 'claude-opus-4' });

    emitFails = true;
    await observer.check(agentPath);
    // The park is the part that stops work, so it has already happened.
    expect(store.getTask(task.id)!.status).toBe('pending_approval');

    emitFails = false;
    await observer.check(agentPath);
    expect(events).toHaveLength(1);
    // A person was told once, on the check that parked it.
    expect(parkedRaised).toEqual([task.id]);
    expect(store.getTask(task.id)!.approvalChanges).toEqual([
      { field: 'model', from: 'claude-sonnet-4', to: 'claude-opus-4', via: 'agent' },
    ]);
  });

  it('takes a manifest it cannot read for nothing, not for every value cleared', async () => {
    const task = follower();
    await observer.check(agentPath);
    fs.writeFileSync(path.join(agentPath, '.dork', 'agent.json'), '{ not json');

    await observer.check(agentPath);

    expect(events).toEqual([]);
    expect(store.getTask(task.id)!.status).toBe('active');
  });

  it('remembers across a restart, so one edit is reported once', async () => {
    follower();
    await observer.check(agentPath);
    await editFile({ runtime: 'codex' });
    await observer.check(agentPath);

    await newObserver().check(agentPath);

    expect(events).toHaveLength(1);
  });
});

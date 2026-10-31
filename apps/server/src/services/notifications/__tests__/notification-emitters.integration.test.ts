import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { TaskStore, type CreateTaskStoreInput } from '../../tasks/task-store.js';
import { SessionStateProjector } from '../../session/session-state-projector.js';
import { setAgentPathLookup, resetAgentPathLookup } from '../../mesh/agent-path-lookup.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { NotificationStore } from '../notification-store.js';
import { NotificationService, setNotificationService } from '../notification-service.js';
import { notifyRunCompleted } from '../emitters/run-completed.js';
import { watchAskResolution } from '../emitters/ask-resolution.js';
import { watchSessionLifecycle } from '../emitters/session-lifecycle.js';
import { registerBeatTurn, resetBeatTurns } from '../../heartbeats/beat-turns.js';
import { EventWakes } from '../../heartbeats/event-wakes.js';
import { systemClock } from '../../heartbeats/beat-scheduler.js';
import { createRelayNotifyUserHandler } from '../../runtimes/claude-code/mcp-tools/relay-notify-tools.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';

// Every scratch folder counts as a registered home here, so this suite's
// mocked mesh decides who is an agent, as it did before homes (DOR-2355).
beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

vi.mock('../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => true) }));
// Which chats' running turn another chat's message started (spec spin-off-chats §6).
const chatStarted = vi.hoisted(() => new Set<string>());
vi.mock('../../session/chat-messages/chat-started-turns.js', () => ({
  isChatStartedTurn: (sessionId: string) => chatStarted.has(sessionId),
}));

/** One captured SSE broadcast. */
type Broadcast = [string, unknown];

let db: Db;
let service: NotificationService;
let sent: Broadcast[] = [];
let unsubscribes: Array<() => void> = [];

/** Every `notification` event announced so far. */
function announced(): Array<{ kind: string; title: string; outcome?: string; readAt?: string }> {
  return sent
    .filter(([name]) => name === 'notification')
    .map(([, data]) => (data as { notification: never }).notification);
}

/** Let the fire-and-forget microtask dispatch and the async notify settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function taskInput(name: string): CreateTaskStoreInput {
  return {
    name,
    description: 'test',
    prompt: 'test',
    agentId: 'agent-1',
    filePath: `/tmp/tasks/${name}/SKILL.md`,
  };
}

/** The Mesh agent every test's `/Users/dev/acme` session resolves to. */
const ACME_AGENT_ID = 'agent-acme';

beforeEach(() => {
  db = createTestDb();
  service = new NotificationService(new NotificationStore(db));
  setNotificationService(service);
  sent = [];
  unsubscribes = [];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation((name, data) => {
    sent.push([name, data]);
  });
  // The one directory every session-lifecycle/ask test below runs a session
  // in resolves to a registered agent; every other directory (an unregistered
  // one, or none at all) genuinely does not — exercising both the stamp and
  // its honest absence through the same fake registry a real MeshCore would
  // answer through.
  setAgentPathLookup({
    getByPath: (projectPath) =>
      projectPath === '/Users/dev/acme' ? { id: ACME_AGENT_ID } : undefined,
  });
});

afterEach(() => {
  for (const off of unsubscribes) off();
  setNotificationService(null);
  resetAgentPathLookup();
  vi.restoreAllMocks();
});

describe('a finished run', () => {
  it('announces a notification and leaves a row behind', async () => {
    const store = new TaskStore(db);
    store.setOnRunTerminal((run, task) => void notifyRunCompleted(run, task));

    const task = store.createTask(taskInput('nightly'));
    const run = store.createRun(task.id, 'scheduled');
    store.updateRun(run.id, { status: 'completed', durationMs: 134_000 });
    await flush();

    expect(announced()).toHaveLength(1);
    expect(announced()[0]).toMatchObject({ kind: 'run.completed', title: 'nightly finished' });

    const listed = service.list({ limit: 25, unread: false });
    expect(listed.notifications).toHaveLength(1);
    expect(listed.notifications[0].subject).toEqual({ type: 'run', id: run.id });
    expect(listed.notifications[0].body).toBe('Done in 2m 14s.');
  });

  it('says a failed run needs attention, and files it against the same run', async () => {
    const store = new TaskStore(db);
    store.setOnRunTerminal((r, t) => void notifyRunCompleted(r, t));

    const task = store.createTask(taskInput('deploy'));
    const run = store.createRun(task.id, 'scheduled');
    store.updateRun(run.id, { status: 'failed', error: 'exit 1\nstack…', durationMs: 2000 });
    await flush();

    expect(announced()[0]).toMatchObject({
      kind: 'run.completed',
      title: 'deploy needs attention',
    });
    expect(service.list({ limit: 25, unread: false }).notifications[0].body).toBe(
      'Didn’t finish: exit 1. Open the schedule to fix it.'
    );
    // The Schedules row's cross, not the run kind's tick.
    expect(service.list({ limit: 25, unread: false }).notifications[0].mark).toBe('failed');
  });

  it('tells the operator about a run that could not use any of its tools', async () => {
    // The outcome nobody notices for themselves: the task looks like it ran,
    // and before DOR-2101 this row said "nightly finished" (DOR-2101 review —
    // the gate could be deleted with every notification test still green).
    const store = new TaskStore(db);
    store.setOnRunTerminal((r, t) => void notifyRunCompleted(r, t));

    const task = store.createTask(taskInput('mailroom'));
    const run = store.createRun(task.id, 'scheduled');
    store.updateRun(run.id, {
      status: 'needs_attention',
      error: 'Skipped Bash — nobody was there to approve it on a scheduled run.',
      refusedTools: ['Bash'],
      durationMs: 4000,
    });
    await flush();

    expect(announced()).toHaveLength(1);
    expect(announced()[0]).toMatchObject({
      kind: 'run.completed',
      title: 'mailroom needs attention',
    });
    expect(service.list({ limit: 25, unread: false }).notifications[0].body).toBe(
      'Bash was refused, with nobody there to approve it. Open the schedule to fix it.'
    );
  });

  describe('one notice per failing streak (DOR-3123)', () => {
    /** The store, with the hook wired as the server wires it: streak included. */
    function wiredStore(): TaskStore {
      const store = new TaskStore(db);
      store.setOnRunTerminal(
        (r, t) => void notifyRunCompleted(r, t, store.runHistory()(r.scheduleId).health.streak)
      );
      return store;
    }

    /** Finish one run of a schedule with a status. */
    async function finish(
      store: TaskStore,
      taskId: string,
      status: 'completed' | 'needs_attention'
    ) {
      const run = store.createRun(taskId, 'scheduled');
      store.updateRun(run.id, {
        status,
        ...(status === 'needs_attention'
          ? { outcome: 'partial' as const, refusedTools: ['Bash'] }
          : { refusedTools: [] }),
        durationMs: 4000,
      });
      await flush();
      return run.id;
    }

    it('raises one notice for three failing runs, and history shows all three', async () => {
      const store = wiredStore();
      const task = store.createTask(taskInput('health-check'));
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push(await finish(store, task.id, 'needs_attention'));

      const notices = announced().filter((n) => n.kind === 'run.completed');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ title: 'health-check needs attention' });
      // Only the notice is spared: every run still says what happened.
      expect(ids.map((id) => store.getRun(id)!.status)).toEqual([
        'needs_attention',
        'needs_attention',
        'needs_attention',
      ]);
    });

    it('names the tool, the fix, and that it will not repeat', async () => {
      const store = wiredStore();
      const task = store.createTask(taskInput('health-check'));
      await finish(store, task.id, 'needs_attention');

      expect(service.list({ limit: 25, unread: false }).notifications[0].body).toBe(
        'Bash was refused, with nobody there to approve it. Open the schedule to fix it. ' +
          'You won’t get another notice about it until it runs cleanly and fails again.'
      );
      expect(service.list({ limit: 25, unread: false }).notifications[0].mark).toBe('refused');
    });

    it('notifies again after a run that completed and a failure after it', async () => {
      const store = wiredStore();
      const task = store.createTask(taskInput('health-check'));
      await finish(store, task.id, 'needs_attention');
      await finish(store, task.id, 'needs_attention');
      await finish(store, task.id, 'completed');
      await finish(store, task.id, 'needs_attention');

      const failing = announced().filter(
        (n) => n.kind === 'run.completed' && n.title.endsWith('needs attention')
      );
      expect(failing).toHaveLength(2);
    });
  });

  it('stays quiet about a run the operator cancelled — they already know', async () => {
    const store = new TaskStore(db);
    store.setOnRunTerminal((r, t) => void notifyRunCompleted(r, t));

    const task = store.createTask(taskInput('long-job'));
    const run = store.createRun(task.id, 'manual');
    store.updateRun(run.id, { status: 'cancelled' });
    await flush();

    expect(announced()).toHaveLength(0);
    expect(service.list({ limit: 25, unread: false }).notifications).toHaveLength(0);
  });
});

describe('an agent that talks a lot', () => {
  /** The tool, wired so nothing external resolves — the stock-install shape. */
  function notifyUserHandler() {
    const deps = {
      relayCore: { publish: vi.fn() },
      bindingStore: { getAll: () => [] },
      bindingRouter: { getSessionsByBinding: () => [] },
      meshCore: { get: () => ({ name: 'ana', displayName: 'Ana' }) },
      // No `notifyDm`: rooms are not wired, so there is no DM to fall back to
      // and every note reaches nothing at all.
    } as unknown as Parameters<typeof createRelayNotifyUserHandler>[0];
    return createRelayNotifyUserHandler(deps, {
      subject: 'relay.agent.ns.agent-1',
      agentId: 'agent-1',
    });
  }

  it('keeps every note as an inbox row: nothing caps how often an agent speaks (DOR-2739)', async () => {
    // Every one of these reaches no transport. Each is still recorded, which is
    // what the review that replaced the hourly count reads from.
    const handler = notifyUserHandler();

    const codes: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const result = await handler({ message: `note number ${i}` });
      codes.push(JSON.parse(result.content[0].text).code as string);
    }

    expect(codes.filter((c) => c === 'NO_BINDING')).toHaveLength(15);
    expect(service.list({ limit: 100, unread: false }).notifications).toHaveLength(15);
  });

  it('writes no row at all when the operator switched initiating off', async () => {
    const deps = {
      relayCore: { publish: vi.fn() },
      bindingStore: {
        getAll: () => [
          {
            id: 'b-1',
            agentId: 'agent-1',
            adapterId: 'telegram-main',
            enabled: true,
            canInitiate: false,
            chatId: 'chat-1',
          },
        ],
      },
      bindingRouter: {
        getSessionsByBinding: () => [
          { scope: 'chat' as const, chatId: 'chat-1', sessionId: 's', lastActivityAt: 10 },
        ],
      },
      adapterManager: {
        listAdapters: () => [{ config: { id: 'telegram-main', type: 'telegram' } }],
      },
      meshCore: { get: () => ({ name: 'ana', displayName: 'Ana' }) },
    } as unknown as Parameters<typeof createRelayNotifyUserHandler>[0];
    const handler = createRelayNotifyUserHandler(deps, {
      subject: 'relay.agent.ns.agent-1',
      agentId: 'agent-1',
    });

    const result = await handler({ message: 'let me in' });

    expect(JSON.parse(result.content[0].text).code).toBe('INITIATE_NOT_ALLOWED');
    expect(service.list({ limit: 25, unread: false }).notifications).toHaveLength(0);
    expect(announced()).toHaveLength(0);
  });
});

describe('an ask that ends', () => {
  it('leaves a history row saying nobody answered', async () => {
    unsubscribes.push(watchAskResolution());
    const projector = new SessionStateProjector('sess-1');
    projector.cwd = '/Users/dev/acme';

    projector.ingest({
      type: 'approval_required',
      id: 'int-1',
      toolName: 'Bash',
      displayName: 'Run a shell command',
      input: 'rm -rf ./build',
      hasSuggestions: false,
    } as never);
    projector.ingest({
      type: 'interaction_resolved',
      id: 'int-1',
      resolution: 'expired',
      at: Date.now(),
    } as never);
    await flush();

    const [row] = service.list({ limit: 25, unread: false }).notifications;
    expect(row).toMatchObject({
      kind: 'ask.pending',
      outcome: 'expired',
      title: 'acme is waiting on your answer',
      body: 'Run a shell command',
      sessionId: 'sess-1',
      // The agent whose directory the session runs in — resolved from `cwd`
      // the same way `turn.completed` and `session.error` are (DOR-1408).
      agentId: ACME_AGENT_ID,
    });
    expect(row.resolvedAt).toBeDefined();
    // Nobody dealt with it, so it is genuinely news.
    expect(row.readAt).toBeUndefined();
    // The tool INPUT never travels: a title can end up on a lock screen.
    expect(JSON.stringify(row)).not.toContain('rm -rf');
  });

  it('leaves an answered ask already read', async () => {
    unsubscribes.push(watchAskResolution());
    const projector = new SessionStateProjector('sess-2');
    projector.cwd = '/Users/dev/acme';

    projector.ingest({
      type: 'question_prompt',
      id: 'int-2',
      question: 'Which branch?',
    } as never);
    projector.ingest({
      type: 'interaction_resolved',
      id: 'int-2',
      resolution: 'answered',
      at: Date.now(),
    } as never);
    await flush();

    const [row] = service.list({ limit: 25, unread: false }).notifications;
    expect(row).toMatchObject({ outcome: 'answered' });
    expect(row.readAt).toBeDefined();
  });

  it('leaves agentId unstamped when the directory names no registered agent', async () => {
    unsubscribes.push(watchAskResolution());
    const projector = new SessionStateProjector('sess-2b');
    projector.cwd = '/Users/dev/some-unregistered-project';

    projector.ingest({
      type: 'question_prompt',
      id: 'int-2b',
      question: 'Which branch?',
    } as never);
    projector.ingest({
      type: 'interaction_resolved',
      id: 'int-2b',
      resolution: 'answered',
      at: Date.now(),
    } as never);
    await flush();

    const [row] = service.list({ limit: 25, unread: false }).notifications;
    expect(row.agentId).toBeUndefined();
  });
});

describe('a turn that finishes', () => {
  it('announces once when the session settles from streaming to idle, and stamps the agent whose directory the session runs in', async () => {
    unsubscribes.push(watchSessionLifecycle());
    const projector = new SessionStateProjector('sess-3');
    projector.cwd = '/Users/dev/acme';

    projector.ingest({ type: 'turn_start' } as never);
    projector.ingest({ type: 'turn_end' } as never);
    await flush();

    const turns = announced().filter((n) => n.kind === 'turn.completed');
    expect(turns).toHaveLength(1);
    expect(turns[0].title).toBe('acme finished');

    const [row] = service.list({ limit: 25, unread: false }).notifications;
    expect(row).toMatchObject({ kind: 'turn.completed', agentId: ACME_AGENT_ID });
  });

  it('stays quiet for a turn another chat started: agents talking to each other never notify you', async () => {
    unsubscribes.push(watchSessionLifecycle());
    chatStarted.add('sess-chat');
    try {
      const projector = new SessionStateProjector('sess-chat');
      projector.cwd = '/Users/dev/acme';
      projector.ingest({ type: 'turn_start' } as never);
      projector.ingest({ type: 'turn_end' } as never);
      await flush();
      expect(announced().filter((n) => n.kind === 'turn.completed')).toHaveLength(0);
    } finally {
      chatStarted.delete('sess-chat');
    }
  });

  it('stays quiet for a heartbeat turn: a beat finishing is not news (spec heartbeats §7.4)', async () => {
    unsubscribes.push(watchSessionLifecycle());
    registerBeatTurn('sess-beat', { agentId: ACME_AGENT_ID, beatId: 'b1', messageId: 'm1' });
    try {
      const projector = new SessionStateProjector('sess-beat');
      projector.cwd = '/Users/dev/acme';
      projector.ingest({ type: 'turn_start' } as never);
      projector.ingest({ type: 'turn_end' } as never);
      await flush();
      expect(announced().filter((n) => n.kind === 'turn.completed')).toHaveLength(0);
    } finally {
      resetBeatTurns();
    }
  });

  it('arms no session.error for a heartbeat turn that fails', async () => {
    unsubscribes.push(watchSessionLifecycle());
    registerBeatTurn('sess-beat-err', { agentId: ACME_AGENT_ID, beatId: 'b2', messageId: 'm2' });
    try {
      const projector = new SessionStateProjector('sess-beat-err');
      projector.cwd = '/Users/dev/acme';
      projector.ingest({ type: 'status_change', status: { lifecycle: 'error' } } as never);
      projector.ingest({ type: 'status_change', status: { lifecycle: 'idle' } } as never);
      await flush();
      const rows = service.list({ limit: 25, unread: false }).notifications;
      expect(rows.filter((r) => r.kind === 'session.error')).toHaveLength(0);
    } finally {
      resetBeatTurns();
    }
  });

  it('escalates session.error, not turn.completed, when a fatal frame closes under an SDK-named reason', async () => {
    // DOR-1676: this shape used to settle idle, so the turn announced itself as
    // COMPLETED. It now settles error, arming the standing session.error
    // escalation instead — a deliberate, user-visible fan-out change.
    unsubscribes.push(watchSessionLifecycle());
    const projector = new SessionStateProjector('sess-1676');
    projector.cwd = '/Users/dev/acme';

    projector.ingest({ type: 'turn_start' } as never);
    projector.ingest({
      type: 'error',
      message: 'billing hard stop',
      code: 'error_during_execution',
    } as never);
    projector.ingest({ type: 'turn_end', terminalReason: 'api_error' } as never);
    await flush();

    expect(announced().filter((n) => n.kind === 'turn.completed')).toHaveLength(0);
    // Standing kind: nothing stored while it stands; the row lands on clear.
    // (The clearing turn itself completes normally and files its own
    // turn.completed row on top, so find the error row rather than take [0].)
    projector.ingest({ type: 'turn_start' } as never);
    projector.ingest({ type: 'turn_end', terminalReason: 'completed' } as never);
    await flush();
    const rows = service.list({ limit: 25, unread: false }).notifications;
    expect(rows.find((r) => r.kind === 'session.error')).toMatchObject({ outcome: 'cleared' });
  });

  it('leaves agentId unstamped when the session runs nowhere a registered agent lives', async () => {
    unsubscribes.push(watchSessionLifecycle());
    const projector = new SessionStateProjector('sess-3b');
    projector.cwd = '/Users/dev/some-unregistered-project';

    projector.ingest({ type: 'turn_start' } as never);
    projector.ingest({ type: 'turn_end' } as never);
    await flush();

    const [row] = service.list({ limit: 25, unread: false }).notifications;
    expect(row).toMatchObject({ kind: 'turn.completed' });
    expect(row.agentId).toBeUndefined();
  });

  it('leaves agentId unstamped when the session carries no directory at all', async () => {
    unsubscribes.push(watchSessionLifecycle());
    const projector = new SessionStateProjector('sess-3c');
    // No `projector.cwd` assigned — the case a session's cwd has not resolved yet.

    projector.ingest({ type: 'turn_start' } as never);
    projector.ingest({ type: 'turn_end' } as never);
    await flush();

    const [row] = service.list({ limit: 25, unread: false }).notifications;
    expect(row).toMatchObject({ kind: 'turn.completed', title: 'A chat finished' });
    expect(row.agentId).toBeUndefined();
  });
});

describe('a session that errors, and clears', () => {
  it('stamps the agent whose directory the session runs in on the row the resolution leaves', async () => {
    unsubscribes.push(watchSessionLifecycle());
    const projector = new SessionStateProjector('sess-err-1');
    projector.cwd = '/Users/dev/acme';

    // `session.error` is a STANDING kind (spec `notification-system`):
    // nothing is stored while it stands, only when it resolves — so the row
    // only exists once the error clears.
    projector.ingest({ type: 'status_change', status: { lifecycle: 'error' } } as never);
    projector.ingest({ type: 'status_change', status: { lifecycle: 'idle' } } as never);
    await flush();

    const [row] = service.list({ limit: 25, unread: false }).notifications;
    expect(row).toMatchObject({
      kind: 'session.error',
      outcome: 'cleared',
      title: 'acme stopped on an error',
      agentId: ACME_AGENT_ID,
    });
  });

  it('leaves agentId unstamped when the directory names no registered agent', async () => {
    unsubscribes.push(watchSessionLifecycle());
    const projector = new SessionStateProjector('sess-err-2');
    projector.cwd = '/Users/dev/some-unregistered-project';

    projector.ingest({ type: 'status_change', status: { lifecycle: 'error' } } as never);
    projector.ingest({ type: 'status_change', status: { lifecycle: 'idle' } } as never);
    await flush();

    const [row] = service.list({ limit: 25, unread: false }).notifications;
    expect(row).toMatchObject({ kind: 'session.error', outcome: 'cleared' });
    expect(row.agentId).toBeUndefined();
  });
});

describe('a turn of its own that fails outside a beat', () => {
  it("wakes the agent's beat, but never for a marked turn", async () => {
    vi.useFakeTimers();
    const woken: string[] = [];
    const hub = new EventWakes({
      clock: systemClock,
      localDay: () => '2026-10-12',
      beat: (agentId) => woken.push(agentId),
      agentIdAt: () => undefined,
      agentsForConnection: () => [],
      noteNewManager: () => undefined,
      refresh: () => undefined,
    });
    hub.install();
    try {
      unsubscribes.push(watchSessionLifecycle());
      const fail = (id: string) => {
        const projector = new SessionStateProjector(id);
        projector.cwd = '/Users/dev/acme';
        projector.ingest({ type: 'status_change', status: { lifecycle: 'error' } } as never);
        vi.advanceTimersByTime(60_000);
      };
      // DOR-3036: a teammate-marked hop's failure is a marked turn's, never the agent's own to
      // chase.
      const codex = recordTurnLevels(
        {
          type: 'codex',
          getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
          async *sendMessage() {
            yield { type: 'done', data: {} } as StreamEvent;
          },
        } as unknown as AgentRuntime,
        () => null
      );
      const marked = codex.sendMessage('sess-teammate-hop', 'hi', {
        permissionCeiling: {
          asks: 'always',
          reach: 'read',
          outsider: true,
          teammate: [{ roomId: 'space', authorId: 'priya' }],
        },
      });
      await marked.next();
      fail('sess-teammate-hop');
      expect(woken).toEqual([]);
      fail('sess-own');
      expect(woken).toEqual([ACME_AGENT_ID]);
    } finally {
      hub.uninstall();
      vi.useRealTimers();
    }
  });
});

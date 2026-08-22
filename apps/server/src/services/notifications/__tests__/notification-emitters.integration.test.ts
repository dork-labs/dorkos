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
import { NotifyBudget } from '../../relay/notify-budget.js';
import { createRelayNotifyUserHandler } from '../../runtimes/claude-code/mcp-tools/relay-notify-tools.js';

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

  it('says a failed run failed, and files it against the same run', async () => {
    const store = new TaskStore(db);
    store.setOnRunTerminal((r, t) => void notifyRunCompleted(r, t));

    const task = store.createTask(taskInput('deploy'));
    const run = store.createRun(task.id, 'scheduled');
    store.updateRun(run.id, { status: 'failed', error: 'exit 1\nstack…', durationMs: 2000 });
    await flush();

    expect(announced()[0]).toMatchObject({ kind: 'run.completed', title: 'deploy failed' });
    expect(service.list({ limit: 25, unread: false }).notifications[0].body).toBe(
      'Failed after 2s. exit 1'
    );
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

describe('an agent that will not stop talking', () => {
  /** The tool, wired so nothing external resolves — the stock-install shape. */
  function notifyUserHandler(limit: number) {
    const budget = new NotifyBudget({ limit: () => limit, now: () => 0 });
    const deps = {
      notifyBudget: budget,
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

  it('cannot write more inbox rows than its hourly allowance, however varied the notes', async () => {
    // The hole this closes: every one of these fails to reach any transport, so
    // before DOR-1383 each was refunded and none was ever rate-limited. Varying
    // the text defeats dedupe, which leaves the allowance as the only thing
    // standing between a looping agent and an unbounded inbox.
    const limit = 10;
    const handler = notifyUserHandler(limit);

    const codes: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const result = await handler({ message: `note number ${i}` });
      codes.push(JSON.parse(result.content[0].text).code as string);
    }

    expect(codes.filter((c) => c === 'NO_BINDING')).toHaveLength(limit);
    expect(codes.filter((c) => c === 'NOTIFY_RATE_LIMITED')).toHaveLength(200 - limit);
    expect(service.list({ limit: 100, unread: false }).notifications).toHaveLength(limit);
  });

  it('writes no row at all when the operator switched initiating off', async () => {
    const budget = new NotifyBudget({ limit: () => 10, now: () => 0 });
    const deps = {
      notifyBudget: budget,
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
    // A switch the operator set costs the agent nothing — it is a decision, not
    // a missing integration.
    expect(budget.tryReserve('agent-1')).toBe(true);
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
    expect(row).toMatchObject({ kind: 'turn.completed', title: 'A session finished' });
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

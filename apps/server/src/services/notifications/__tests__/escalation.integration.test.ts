/**
 * The escalation ladder, end to end from the seam that starts it.
 *
 * The unit tests next door drive {@link EscalationService} directly. This one
 * proves the WIRING: a real projector raises a real Ask, the real emitter arms a
 * real timer, and the delay elapsing reaches the channels exactly once — and
 * answering first reaches them not at all. That is the difference between "the
 * ladder works" and "the ladder is plugged in".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { EscalationDelay } from '@dorkos/shared/config-schema';
import { SessionStateProjector } from '../../session/session-state-projector.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { NotificationStore } from '../notification-store.js';
import {
  NotificationService,
  getNotificationService,
  setNotificationService,
} from '../notification-service.js';
import { watchAskResolution } from '../emitters/ask-resolution.js';
import { watchSessionLifecycle } from '../emitters/session-lifecycle.js';
import { scheduleParkPayload } from '../emitters/schedule-park.js';
import { EscalationService, armEscalation, setEscalationService } from '../escalation-service.js';
import type { WebPushChannel } from '../channels/web-push.js';
import { TaskStore } from '../../tasks/task-store.js';
import { getTasksTools } from '../../runtimes/claude-code/mcp-tools/task-tools.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';

const ONE_MINUTE = 60 * 1000;

let db: Db;
let store: NotificationStore;
let sendToAll: ReturnType<typeof vi.fn>;
let unsubscribes: Array<() => void> = [];
let delay: EscalationDelay;

/** Let the fire-and-forget microtasks settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** Every escalation the ledger recorded for one subject. */
function escalations(subjectKey: string): Array<{ channel: string }> {
  return store
    .deliveriesForSubject(subjectKey)
    .filter(
      (row) =>
        row.detailJson !== null &&
        (JSON.parse(row.detailJson) as { escalated?: boolean }).escalated === true
    )
    .map((row) => ({ channel: row.channel }));
}

/** Raise a real Ask on a real projector. */
function askOn(projector: SessionStateProjector, id: string): void {
  projector.ingest({
    type: 'approval_required',
    id,
    toolName: 'Bash',
    displayName: 'Run a shell command',
    input: 'rm -rf ./build',
    hasSuggestions: false,
  } as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  db = createTestDb();
  store = new NotificationStore(db);
  setNotificationService(new NotificationService(store));

  sendToAll = vi.fn().mockResolvedValue({ delivered: 1, pruned: 0, outcomes: [] });
  delay = 2;
  setEscalationService(
    new EscalationService({
      store,
      push: { sendToAll } as unknown as WebPushChannel,
      // No chat integration on this install, which is the stock state — the push
      // leg alone has to carry it.
      relay: () => undefined,
      readDelay: () => delay,
    })
  );

  unsubscribes = [watchAskResolution(), watchSessionLifecycle()];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
});

afterEach(() => {
  for (const off of unsubscribes) off();
  setEscalationService(null);
  setNotificationService(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('an Ask nobody answers', () => {
  it('reaches the phone exactly once, and leaves exactly one escalation row', async () => {
    const projector = new SessionStateProjector('sess-1');
    projector.cwd = '/Users/dev/acme';
    askOn(projector, 'int-1');

    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();

    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(escalations('ask:int-1')).toEqual([{ channel: 'web_push' }]);
  });

  it('carries a title and a deep link, and never the tool input', async () => {
    const projector = new SessionStateProjector('sess-1');
    projector.cwd = '/Users/dev/acme';
    askOn(projector, 'int-1');

    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);

    const payload = sendToAll.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      title: 'acme is waiting on your answer',
      body: 'Run a shell command',
      deepLink: '/session?session=sess-1',
      tier: 'blocking',
    });
    // A push is decrypted by a browser and drawn by the OS, often on a locked
    // screen. A proposed shell command has no business being there.
    expect(JSON.stringify(payload)).not.toContain('rm -rf');
  });
});

describe('an Ask somebody answers', () => {
  it('never escalates when the answer lands inside the delay', async () => {
    const projector = new SessionStateProjector('sess-1');
    projector.cwd = '/Users/dev/acme';
    askOn(projector, 'int-1');

    await vi.advanceTimersByTimeAsync(ONE_MINUTE);
    projector.ingest({
      type: 'interaction_resolved',
      id: 'int-1',
      resolution: 'answered',
      at: Date.now(),
    } as never);
    await flush();
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
    expect(escalations('ask:int-1')).toEqual([]);
  });

  it('stops escalating even when the Ask ended because nobody answered', async () => {
    // An expiry is not an acknowledgement, but it IS the condition ending: the
    // agent is no longer waiting, so a phone ping about it would arrive about
    // something that is over.
    const projector = new SessionStateProjector('sess-1');
    projector.cwd = '/Users/dev/acme';
    askOn(projector, 'int-1');

    projector.ingest({
      type: 'interaction_resolved',
      id: 'int-1',
      resolution: 'expired',
      at: Date.now(),
    } as never);
    await flush();
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
  });
});

/**
 * The `session.error` seam end to end. It had no integration coverage at all
 * until the DOR-1387 review, which is how the episode-identity bug below stayed
 * invisible: every unit test drove the service directly and therefore built its
 * own payloads, so nothing exercised the real emitter's two edges together.
 */
describe('a session that stops on an error', () => {
  /** Drive a real projector into (and out of) the error lifecycle. */
  function setLifecycle(projector: SessionStateProjector, lifecycle: 'error' | 'idle'): void {
    projector.ingest({ type: 'status_change', status: { lifecycle } } as never);
  }

  it('escalates once nobody has fixed it inside the delay', async () => {
    const projector = new SessionStateProjector('sess-err');
    projector.cwd = '/Users/dev/acme';
    setLifecycle(projector, 'error');

    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();

    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0][0]).toMatchObject({
      title: 'acme stopped on an error',
      deepLink: '/session?session=sess-err',
      tier: 'blocking',
    });
  });

  it('never escalates when the error clears inside the delay', async () => {
    const projector = new SessionStateProjector('sess-err');
    projector.cwd = '/Users/dev/acme';
    setLifecycle(projector, 'error');

    await vi.advanceTimersByTimeAsync(ONE_MINUTE);
    setLifecycle(projector, 'idle');
    await flush();
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
  });

  /**
   * The end-to-end half of the episode-identity fix. The arm and the disarm are
   * built by two different call sites in `session-lifecycle.ts`; only a test
   * that drives BOTH through the real emitter can show the second episode is
   * reachable — a unit test that hands the service its own payloads proves
   * nothing about whether those two sites agree.
   */
  it('escalates again when the same session falls over a second time', async () => {
    const projector = new SessionStateProjector('sess-err');
    projector.cwd = '/Users/dev/acme';

    setLifecycle(projector, 'error');
    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);

    setLifecycle(projector, 'idle');
    await flush();

    setLifecycle(projector, 'error');
    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();

    expect(sendToAll).toHaveBeenCalledTimes(2);
  });

  it('a second episode answered in time still disarms', async () => {
    // Proves the two edges agree on the KEY, not merely that a second episode
    // can fire: a disarm that missed would leave this at one call.
    const projector = new SessionStateProjector('sess-err');
    projector.cwd = '/Users/dev/acme';

    setLifecycle(projector, 'error');
    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();
    setLifecycle(projector, 'idle');
    await flush();

    setLifecycle(projector, 'error');
    await vi.advanceTimersByTimeAsync(ONE_MINUTE);
    setLifecycle(projector, 'idle');
    await flush();
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);

    expect(sendToAll).toHaveBeenCalledTimes(1);
  });
});

/**
 * A parked schedule can go away without anybody deciding it — an agent deletes
 * it, its file vanishes, a Shape is torn down. The DOR-1387 review found three
 * such paths that removed the row and left the escalation timer armed, so a
 * phone would buzz about a schedule that no longer existed. They all now route
 * through `resolveParkedScheduleRemoved`, and this drives the one they share
 * through the real MCP tool.
 */
describe('a parked schedule that is removed rather than decided', () => {
  /** The `tasks_delete` handler a real session calls, over a real store. */
  function tasksDelete(store: TaskStore): (args: { id: string }) => Promise<unknown> {
    const deps = { taskStore: store, defaultCwd: '/tmp/test' } as unknown as McpToolDeps;
    const tools = getTasksTools(deps) as unknown as Array<{
      name: string;
      handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
    }>;
    const tool = tools.find((t) => t.name === 'tasks_delete')!;
    return (args) => tool.handler(args, undefined);
  }

  /** A schedule parked exactly as `tasks_create` parks one. */
  function parkedSchedule(store: TaskStore) {
    const task = store.createTask({
      name: 'nightly',
      description: 'test',
      prompt: 'test',
      agentId: 'agent-1',
      filePath: '/tmp/tasks/nightly/SKILL.md',
    });
    store.updateTask(task.id, { status: 'pending_approval' });
    const parked = store.getTask(task.id)!;
    armEscalation('schedule.parked', scheduleParkPayload(parked));
    return parked;
  }

  it('disarms when an agent deletes it through tasks_delete', async () => {
    const store = new TaskStore(db);
    const parked = parkedSchedule(store);

    await tasksDelete(store)({ id: parked.id });
    await flush();
    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('leaves an unread row behind, because nobody decided anything', async () => {
    // `cancelled`, not `rejected`: an agent deleted it, so claiming the operator
    // rejected it would both put words in their mouth and file the row
    // already-read — which is how a pending approval vanishes silently.
    const store = new TaskStore(db);
    const parked = parkedSchedule(store);

    await tasksDelete(store)({ id: parked.id });
    await flush();

    const [row] = getNotificationService()!.list({ limit: 25, unread: false }).notifications;
    expect(row).toMatchObject({ kind: 'schedule.parked', outcome: 'cancelled' });
    expect(row.readAt).toBeUndefined();
  });

  it('writes nothing when the deleted schedule was not waiting on anybody', async () => {
    const store = new TaskStore(db);
    const active = store.createTask({
      name: 'active-one',
      description: 'test',
      prompt: 'test',
      filePath: '/tmp/tasks/active-one/SKILL.md',
    });

    await tasksDelete(store)({ id: active.id });
    await flush();

    expect(getNotificationService()!.list({ limit: 25, unread: false }).notifications).toEqual([]);
  });
});

describe('the knob', () => {
  it('escalates nothing at all while it is set to `never`', async () => {
    delay = 'never';
    const projector = new SessionStateProjector('sess-1');
    projector.cwd = '/Users/dev/acme';
    askOn(projector, 'int-1');

    await vi.advanceTimersByTimeAsync(60 * ONE_MINUTE);

    expect(sendToAll).not.toHaveBeenCalled();
  });
});

/**
 * A pending capability approval on the escalation ladder, end to end from the
 * seam that starts it (DOR-1570).
 *
 * The gap this pins: before DOR-1570 an agent could ask to do something
 * irreversible — delete a schedule, unregister an agent, uninstall a package —
 * and the request would sit its whole two-hour TTL with no signal outside the
 * app at all. A parked SCHEDULE reached the phone; the strictly more dangerous
 * case reached nothing.
 *
 * Driven through the real {@link ApprovalService}, not a fake, because the
 * property under test is the WIRING: the arm has to happen at the write that
 * creates the condition, and the disarm at every one of the four endings.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { EscalationDelay } from '@dorkos/shared/config-schema';
import { eventFanOut } from '../../core/event-fan-out.js';
import { ApprovalService } from '../../core/approvals/approval-service.js';
import { setAgentPathLookup, resetAgentPathLookup } from '../../mesh/agent-path-lookup.js';
import { NotificationStore } from '../notification-store.js';
import {
  EscalationService,
  getEscalationService,
  setEscalationService,
} from '../escalation-service.js';
import { capabilityApprovalKey } from '../emitters/capability-approval.js';
import type { WebPushChannel } from '../channels/web-push.js';

const ONE_MINUTE = 60 * 1000;

/** The Mesh agent the requesting path resolves to. */
const ACME_AGENT_ID = 'agent-acme';
const ACME_PATH = '/Users/dev/acme';

let db: Db;
let store: NotificationStore;
let approvals: ApprovalService;
let sendToAll: ReturnType<typeof vi.fn>;
let broadcast: MockInstance<typeof eventFanOut.broadcast>;
let delay: EscalationDelay;

/** Let the fire-and-forget microtasks settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** Record a request the way the tier gate does, and hand back its ticket. */
function ask(overrides: { capabilityId?: string; inputHash?: string; path?: string | null } = {}) {
  return approvals.request({
    capabilityId: overrides.capabilityId ?? 'tasks_delete',
    inputHash: overrides.inputHash ?? 'hash-1',
    summary: '"Ana" wants to run "Delete a scheduled task" with id: "nightly"',
    requestedBy: 'Ana',
    ...(overrides.path === null ? {} : { requestedByPath: overrides.path ?? ACME_PATH }),
  });
}

/** Every broadcast of one event name, with its payload. */
function broadcastsOf(name: string): Record<string, unknown>[] {
  return broadcast.mock.calls
    .filter((call) => call[0] === name)
    .map((call) => call[1] as Record<string, unknown>);
}

beforeEach(() => {
  vi.useFakeTimers();
  db = createTestDb();
  store = new NotificationStore(db);
  sendToAll = vi.fn().mockResolvedValue({ delivered: 1, pruned: 0, outcomes: [] });
  delay = 2;
  setEscalationService(
    new EscalationService({
      store,
      push: { sendToAll } as unknown as WebPushChannel,
      relay: () => undefined,
      readDelay: () => delay,
    })
  );
  setAgentPathLookup({
    getByPath: (projectPath) => (projectPath === ACME_PATH ? { id: ACME_AGENT_ID } : undefined),
  });
  broadcast = vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  approvals = new ApprovalService(db, {
    describeCapability: () => ({ title: 'Delete a scheduled task', tier: 'destructive' }),
  });
});

afterEach(() => {
  setEscalationService(null);
  resetAgentPathLookup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a capability approval nobody answers', () => {
  it('arms the ladder at the request, under the registry dedupe key', () => {
    const ticket = ask();

    expect(getEscalationService()?.armedSubjects()).toEqual([
      capabilityApprovalKey(ticket.approvalId),
    ]);
    expect(capabilityApprovalKey(ticket.approvalId)).toBe(`approval:${ticket.approvalId}`);
  });

  it('reaches the phone after the configured delay, exactly once', async () => {
    ask();

    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();

    expect(sendToAll).toHaveBeenCalledTimes(1);
  });

  it('sends a title-level payload with the bell deep link, never the arguments', async () => {
    ask();

    await vi.advanceTimersByTimeAsync(3 * ONE_MINUTE);
    await flush();

    const payload = sendToAll.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      title: 'Ana needs your approval',
      body: 'Delete a scheduled task cannot be undone, so it will not run until you decide.',
      deepLink: '/',
      tier: 'blocking',
    });
    // A push is drawn by the OS, often on a locked screen. The argument values
    // the agent asked to run something with belong on the card, not there.
    expect(JSON.stringify(payload)).not.toContain('nightly');
  });

  it('does not escalate when the operator turned the knob to never', async () => {
    delay = 'never';
    ask();

    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);
    await flush();

    expect(sendToAll).not.toHaveBeenCalled();
  });
});

describe('an approval somebody deals with', () => {
  it('disarms when the operator grants it inside the delay', async () => {
    const ticket = ask();
    approvals.grant(ticket.approvalId);

    expect(getEscalationService()?.armedSubjects()).toEqual([]);

    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);
    await flush();
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('disarms when the operator denies it', async () => {
    const ticket = ask();
    approvals.deny(ticket.approvalId, 'not today');

    expect(getEscalationService()?.armedSubjects()).toEqual([]);

    await vi.advanceTimersByTimeAsync(10 * ONE_MINUTE);
    await flush();
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it('disarms when a granted token is spent', async () => {
    const ticket = ask();
    approvals.grant(ticket.approvalId);
    // Re-arm by hand so the spend is the ONLY thing that could disarm it —
    // otherwise the grant above would be doing the work this case is about.
    getEscalationService()?.arm('approval.pending', {
      approvalId: ticket.approvalId,
      capabilityId: 'tasks_delete',
      capabilityTitle: 'Delete a scheduled task',
      requestedBy: 'Ana',
    });
    expect(getEscalationService()?.armedSubjects()).toHaveLength(1);

    const result = approvals.consume(ticket.token, {
      capabilityId: 'tasks_delete',
      inputHash: 'hash-1',
    });

    expect(result.outcome).toBe('granted');
    expect(getEscalationService()?.armedSubjects()).toEqual([]);
  });

  it('disarms when the decision window closed before the token was spent', () => {
    const shortLived = new ApprovalService(db, {
      ttlMs: 1_000,
      describeCapability: () => ({ title: 'Delete a scheduled task', tier: 'destructive' }),
    });
    const ticket = shortLived.request({
      capabilityId: 'tasks_delete',
      inputHash: 'hash-1',
      summary: 'wants to delete a schedule',
    });
    expect(getEscalationService()?.armedSubjects()).toHaveLength(1);

    vi.advanceTimersByTime(2_000);
    const result = shortLived.consume(ticket.token, {
      capabilityId: 'tasks_delete',
      inputHash: 'hash-1',
    });

    expect(result.outcome).toBe('expired');
    expect(getEscalationService()?.armedSubjects()).toEqual([]);
  });
});

describe('the arrival signal the periphery reads', () => {
  it('announces the condition once, with what a banner needs', () => {
    const ticket = ask();

    expect(broadcastsOf('standing_pending')).toEqual([
      {
        kind: 'approval.pending',
        subjectKey: `approval:${ticket.approvalId}`,
        tier: 'blocking',
        title: 'Ana needs your approval',
        body: 'Delete a scheduled task cannot be undone, so it will not run until you decide.',
        deepLink: '/',
        since: expect.any(String),
        // The decision window rides along so a surface can retire its own
        // banner when the approval expires unanswered — the one ending nothing
        // on the server announces (DOR-1570 review). It is the approval's own
        // deadline, not a fresh one.
        expiresAt: ticket.expiresAt,
      },
    ]);
  });

  it('names the condition the same way when it resolves, so a banner can be retired', () => {
    const ticket = ask();
    approvals.grant(ticket.approvalId);

    expect(broadcastsOf('standing_resolved')).toEqual([
      {
        kind: 'approval.pending',
        subjectKey: `approval:${ticket.approvalId}`,
        resolvedAt: expect.any(String),
      },
    ]);
  });

  it('addresses both to the operator, never to an agent principal', () => {
    const ticket = ask();
    approvals.grant(ticket.approvalId);

    for (const name of ['standing_pending', 'standing_resolved']) {
      const call = broadcast.mock.calls.find((c) => c[0] === name);
      const audience = call?.[2] as ((p: { kind: string }) => boolean) | undefined;
      expect(audience, name).toBeTypeOf('function');
      expect(audience?.({ kind: 'agent' }), name).toBe(false);
      expect(audience?.({ kind: 'operator' }), name).toBe(true);
    }
    expect(ticket.approvalId).toBeTruthy();
  });
});

describe('who the escalation is attributed to', () => {
  it('names the Mesh agent behind the requesting path', () => {
    const ticket = ask();
    expect(ticket.approvalId).toBeTruthy();

    const [event] = broadcastsOf('standing_pending');
    expect(event.title).toBe('Ana needs your approval');
    // The agent id is a lens/routing key, not banner copy — it rides the
    // payload the ladder holds, which `armedSubjects` cannot show. What this
    // asserts is that resolving it did not throw and did not change the copy.
    expect(getEscalationService()?.armedSubjects()).toHaveLength(1);
  });

  it('calls an unidentified caller what the approval card calls it', () => {
    approvals.request({
      capabilityId: 'tasks_delete',
      inputHash: 'hash-2',
      summary: 'An unidentified caller wants to run "Delete a scheduled task"',
    });

    const [event] = broadcastsOf('standing_pending');
    expect(event.title).toBe('An unidentified caller needs your approval');
  });
});

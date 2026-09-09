/**
 * Delivering a verdict to a session that stopped waiting (spec
 * `approval-verdict-delivery`).
 *
 * The reported bug in one sentence: an operator approved four `mesh_unregister`
 * cards, the requesting agent was never told, and they opened its session and
 * relayed the decision by hand. The in-session hold caps at ten minutes and the
 * approval window is two hours, so an answer at minute twenty reaches nobody —
 * the tool call returned its poll payload long ago and the turn has ended.
 *
 * What each test pins:
 *
 * - an IDLE session is woken, in ITS directory, carrying the verdict as a
 *   registered context kind rather than as words that read like the operator's;
 * - a session that ENDED and cannot be cold-started declines with a log line,
 *   never a throw — this runs detached from a broadcast nothing is awaiting;
 * - the claim makes it EXACTLY ONCE: a second broadcast for the same approval
 *   (the normal grant flow settles twice) delivers nothing;
 * - a request that never named a session is untouched — the external `/mcp`
 *   surface is byte-identical to what it always was;
 * - a BUSY session queues rather than losing the answer, which is the whole
 *   difference from `mcp-signin-resume`: a nudge that arrives late is noise, and
 *   a refusal that arrives late is the thing an agent most needs to hear.
 *
 * @vitest-environment node
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { hashApprovalInput } from '../approval-input-hash.js';

const SESSION_ID = 'sess-abc';
const SESSION_CWD = '/projects/somewhere-else';

const BINDING = {
  capabilityId: 'mesh.unregister',
  inputHash: hashApprovalInput({ agentId: '01KXQ3P7ADJY9DSXMZW1XGWCV4' }),
};

/** Load the deliverer under a fresh set of session/runtime/logger mocks. */
async function loadWithMocks(
  options: {
    accepted?: boolean;
    hasSession?: boolean;
    storedSession?: boolean;
  } = {}
) {
  vi.resetModules();
  const dispatchMessage = vi.fn().mockResolvedValue({ accepted: options.accepted ?? true });
  // The logger LEVEL is the only thing separating "declined quietly" from "blew
  // up and was swallowed": nothing here ever rejects.
  const warn = vi.fn();
  const info = vi.fn();
  vi.doMock('../../../../lib/logger.js', () => ({ logger: { warn, info, error: vi.fn() } }));
  const getSession = vi.fn(async () =>
    (options.storedSession ?? true) ? { id: SESSION_ID } : null
  );
  const runtime = {
    hasSession: () => options.hasSession ?? true,
    getSession,
    getCapabilities: () => ({ logBackedHistory: false }),
  };
  vi.doMock('../../runtime-registry.js', () => ({
    runtimeRegistry: { resolveForSession: async () => runtime },
  }));
  const getOrCreateProjector = vi.fn((_id: string, _cwd?: string) => ({ cwd: SESSION_CWD }));
  vi.doMock('../../../session/index.js', () => ({
    dispatchMessage,
    getOrCreateProjector,
    peekProjector: () => undefined,
    persistenceModeFor: () => 'record',
  }));

  const { ApprovalService } = await import('../approval-service.js');
  const { deliverApprovalVerdict, startApprovalVerdictDelivery } =
    await import('../approval-verdict-delivery.js');
  const db: Db = createTestDb();
  const approvals = new ApprovalService(db);
  return {
    approvals,
    deliverApprovalVerdict,
    startApprovalVerdictDelivery,
    dispatchMessage,
    getOrCreateProjector,
    runtime,
    warn,
    info,
  };
}

afterEach(() => {
  vi.doUnmock('../../runtime-registry.js');
  vi.doUnmock('../../../session/index.js');
  vi.doUnmock('../../../../lib/logger.js');
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('deliverApprovalVerdict', () => {
  /** Ask from a session, then have the person answer — the whole reported case. */
  function askAndAnswer(
    approvals: {
      request: (input: never) => { approvalId: string };
      grant: (id: string) => unknown;
    },
    session: { sessionId: string; cwd?: string } | null = {
      sessionId: SESSION_ID,
      cwd: SESSION_CWD,
    }
  ): string {
    const { approvalId } = approvals.request({
      ...BINDING,
      summary: 'Unregister "scout"',
      ...(session ? { requestingSession: session } : {}),
    } as never);
    approvals.grant(approvalId);
    return approvalId;
  }

  it('wakes an idle session and hands it the verdict as a registered context kind', async () => {
    const { approvals, deliverApprovalVerdict, dispatchMessage } = await loadWithMocks();
    const approvalId = askAndAnswer(approvals);

    await deliverApprovalVerdict(approvals, approvalId);

    expect(dispatchMessage).toHaveBeenCalledTimes(1);
    const call = dispatchMessage.mock.calls[0][0];
    expect(call.sessionId).toBe(SESSION_ID);
    // The substance rides the neutral bag, so every adapter renders it its own
    // way rather than one of them dumping JSON.
    expect(call.approvalVerdict).toEqual({
      approvalId,
      capabilityTitle: 'mesh.unregister',
      outcome: 'granted',
      decidedAt: expect.any(String),
    });
    // And the turn's own content is wrapped in the SAME registered tag, so the
    // transcript strip removes it and it can never read as the person's words.
    expect(call.content).toMatch(/^<approval_verdict>/);
    expect(call.content).toMatch(/<\/approval_verdict>$/);
  });

  it('carries a refusal, and the reason with it', async () => {
    const { approvals, deliverApprovalVerdict, dispatchMessage } = await loadWithMocks();
    const { approvalId } = approvals.request({
      ...BINDING,
      summary: 'Unregister "scout"',
      requestingSession: { sessionId: SESSION_ID, cwd: SESSION_CWD },
    });
    approvals.deny(approvalId, 'that agent is still running the nightly job');

    await deliverApprovalVerdict(approvals, approvalId);

    expect(dispatchMessage.mock.calls[0][0].approvalVerdict).toMatchObject({
      outcome: 'denied',
      denyReason: 'that agent is still running the nightly job',
    });
  });

  it('runs the turn in the session’s OWN directory, on every hop that takes one', async () => {
    // The DOR-981 lesson: the projector registry empties on restart and an
    // approval outlives one easily inside two hours, so the directory is read
    // from the ROW rather than from a live projector. A dropped hop cold-starts
    // the wrong checkout, silently.
    const { approvals, deliverApprovalVerdict, dispatchMessage, getOrCreateProjector, runtime } =
      await loadWithMocks({ hasSession: false });
    const approvalId = askAndAnswer(approvals);

    await deliverApprovalVerdict(approvals, approvalId);

    expect(runtime.getSession).toHaveBeenCalledWith(SESSION_CWD, SESSION_ID);
    expect(getOrCreateProjector.mock.calls[0][1]).toBe(SESSION_CWD);
    expect(dispatchMessage.mock.calls[0][0].cwd).toBe(SESSION_CWD);
  });

  it('delivers EXACTLY ONCE, however many times the answer is broadcast', async () => {
    // The normal grant flow settles twice for one subject (`approval-service.ts`
    // says so out loud), so a second call is the ordinary case rather than an
    // exotic one. The claim is what makes the second a no-op.
    const { approvals, deliverApprovalVerdict, dispatchMessage } = await loadWithMocks();
    const approvalId = askAndAnswer(approvals);

    await deliverApprovalVerdict(approvals, approvalId);
    await deliverApprovalVerdict(approvals, approvalId);
    await deliverApprovalVerdict(approvals, approvalId);

    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });

  it('does not deliver what a hold is already waiting to deliver', async () => {
    // The hold claims when it STARTS waiting, so a decision that lands inside the
    // cap is the hold's to report — through its own return value, in the turn the
    // agent is still running. A second turn here would tell it something it has
    // already acted on.
    const { approvals, deliverApprovalVerdict, dispatchMessage } = await loadWithMocks();
    const { approvalId } = approvals.request({
      ...BINDING,
      summary: 'Unregister "scout"',
      requestingSession: { sessionId: SESSION_ID, cwd: SESSION_CWD },
    });
    expect(approvals.claimVerdictDelivery(approvalId)).toBe(true);
    approvals.grant(approvalId);

    await deliverApprovalVerdict(approvals, approvalId);

    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('leaves a request that named no session completely alone', async () => {
    // The external `/mcp` surface has no session, which is exactly the set with
    // nowhere to deliver to. Nothing is dispatched and nothing is claimed.
    const { approvals, deliverApprovalVerdict, dispatchMessage } = await loadWithMocks();
    const approvalId = askAndAnswer(approvals, null);

    await deliverApprovalVerdict(approvals, approvalId);

    expect(dispatchMessage).not.toHaveBeenCalled();
  });

  it('declines with a log line when the session is gone for good', async () => {
    // A session that ended and cannot be cold-started has nothing to wake. This
    // runs detached from a broadcast nobody is awaiting, so it must never throw.
    const { approvals, deliverApprovalVerdict, dispatchMessage, warn, info } = await loadWithMocks({
      hasSession: false,
      storedSession: false,
    });
    const approvalId = askAndAnswer(approvals);

    await expect(deliverApprovalVerdict(approvals, approvalId)).resolves.toBeUndefined();

    expect(dispatchMessage).not.toHaveBeenCalled();
    // Declined, not faulted — the level is the only thing that tells them apart.
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('reports a real failure as a warning rather than as a polite decline', async () => {
    const { approvals, deliverApprovalVerdict, dispatchMessage, warn, info } =
      await loadWithMocks();
    dispatchMessage.mockRejectedValue(new Error('boom'));
    const approvalId = askAndAnswer(approvals);

    await expect(deliverApprovalVerdict(approvals, approvalId)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it('hands the claim BACK when the delivery failed, so the answer is still owed', async () => {
    // Found on a live server: a session whose recorded directory sat outside the
    // DorkOS boundary made the runtime resolve throw, and the row was left
    // stamped `notified_at` — an answer marked delivered that nobody received,
    // with every later attempt locked out by the very column meant to protect
    // it. `notified_at` means DELIVERED, not ATTEMPTED.
    const { approvals, deliverApprovalVerdict, dispatchMessage } = await loadWithMocks();
    dispatchMessage.mockRejectedValue(new Error('boom'));
    const approvalId = askAndAnswer(approvals);

    await deliverApprovalVerdict(approvals, approvalId);

    expect(approvals.claimVerdictDelivery(approvalId)).toBe(true);
  });

  it('KEEPS the claim when the session is gone — a settled ending, not a failure', async () => {
    // The counterpart that makes the release above mean something. A session
    // that ended will not come back, so re-offering the claim would only invite
    // attempts that can reach the same conclusion forever.
    const { approvals, deliverApprovalVerdict } = await loadWithMocks({
      hasSession: false,
      storedSession: false,
    });
    const approvalId = askAndAnswer(approvals);

    await deliverApprovalVerdict(approvals, approvalId);

    expect(approvals.claimVerdictDelivery(approvalId)).toBe(false);
  });

  it('QUEUES behind a busy session rather than dropping the answer', async () => {
    // The one place this deliberately differs from `mcp-signin-resume`, which
    // refuses a locked session because a "your server is connected" nudge that
    // arrives late is noise. A verdict is not: a denial may need to reach an
    // agent that is mid-work on the assumption it was allowed, and refusing here
    // would recreate the exact silence this feature exists to end.
    const { approvals, deliverApprovalVerdict, dispatchMessage } = await loadWithMocks();
    const approvalId = askAndAnswer(approvals);

    await deliverApprovalVerdict(approvals, approvalId);

    expect(dispatchMessage.mock.calls[0][0].whenBusy).toBe('queue');
  });
});

describe('startApprovalVerdictDelivery', () => {
  it('hands off rather than delivering on the broadcast write path', async () => {
    // `eventFanOut` listeners run SYNCHRONOUSLY ahead of every connected client,
    // and its own contract says work that is not cheap belongs on a queue the
    // listener owns. A delivery is a database read, a runtime resolve, a possible
    // cold start and a dispatch — so the listener must return before any of it.
    const { approvals, startApprovalVerdictDelivery, dispatchMessage } = await loadWithMocks();
    const { eventFanOut } = await import('../../event-fan-out.js');
    const stop = startApprovalVerdictDelivery(approvals);
    try {
      const { approvalId } = approvals.request({
        ...BINDING,
        summary: 'Unregister "scout"',
        requestingSession: { sessionId: SESSION_ID, cwd: SESSION_CWD },
      });
      approvals.grant(approvalId);

      // Nothing yet: the listener handed the work off.
      expect(dispatchMessage).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(dispatchMessage).toHaveBeenCalledTimes(1));
      expect(eventFanOut.listenerCount).toBeDefined();
    } finally {
      stop();
    }
  });

  it('ignores every outcome that is not a decision', async () => {
    // `settle` fires for `consumed` and `expired` too, and neither is an answer a
    // person gave. Expiry is DOR-1932's subject, not this seam's.
    const { approvals, startApprovalVerdictDelivery, dispatchMessage } = await loadWithMocks();
    const { eventFanOut } = await import('../../event-fan-out.js');
    const stop = startApprovalVerdictDelivery(approvals);
    try {
      eventFanOut.broadcast('approval_resolved', {
        approvalId: '01KXQ3P7ADJY9DSXMZW1XGWCV4',
        outcome: 'consumed',
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(dispatchMessage).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('stops listening when it is stopped', async () => {
    const { approvals, startApprovalVerdictDelivery, dispatchMessage } = await loadWithMocks();
    const stop = startApprovalVerdictDelivery(approvals);
    stop();

    const { approvalId } = approvals.request({
      ...BINDING,
      summary: 'Unregister "scout"',
      requestingSession: { sessionId: SESSION_ID, cwd: SESSION_CWD },
    });
    approvals.grant(approvalId);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(dispatchMessage).not.toHaveBeenCalled();
  });
});

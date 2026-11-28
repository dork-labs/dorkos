/**
 * Delivering a verdict to a session that stopped waiting (spec
 * `approval-verdict-delivery`), as a wake saved with its claim (spec
 * `turns-survive-restarts` §6.3, T7).
 *
 * The reported bug in one sentence: an operator approved four `mesh_unregister`
 * cards, the requesting agent was never told, and they opened its session and
 * relayed the decision by hand. The in-session hold caps at ten minutes and the
 * approval window is two hours, so an answer at minute twenty reaches nobody —
 * the tool call returned its poll payload long ago and the turn has ended.
 *
 * What each test pins:
 *
 * - an answered approval saves ONE wake keyed by its id, for ITS session and
 *   directory, carrying the verdict as a registered context kind rather than as
 *   words that read like the operator's, and with no deadline: a busy session
 *   waits rather than losing the answer;
 * - the claim and the wake are one write: a second broadcast (the normal grant
 *   flow settles twice) saves nothing, a claim the hold took saves nothing, and
 *   a wake that cannot be saved hands the claim back;
 * - a request that never named a session is untouched.
 *
 * What the wake does next (a chat that is gone, a busy chat, a restart between
 * the claim and the turn) is the run record's: `services/runs/__tests__/wake-chat.test.ts`.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { eq, turnEffects, type Db } from '@dorkos/db';
import { WakeRequestSchema, type WakeRequest } from '@dorkos/shared/turn-port';
import { hashApprovalInput } from '../approval-input-hash.js';
import { ApprovalService } from '../approval-service.js';
import {
  deliverApprovalVerdict,
  startApprovalVerdictDelivery,
} from '../approval-verdict-delivery.js';
import { eventFanOut } from '../../event-fan-out.js';
import { noteTurnHold, setContinuationHoldDb } from '../../turn-power/continuation-hold.js';
import { DEFAULT_CWD } from '../../../../lib/resolve-root.js';
import { disposeProjector, getOrCreateProjector } from '../../../session/index.js';
import {
  getRunRecord,
  installRunRecord,
  uninstallRunRecord,
  wakeChat,
  type RunRecord,
} from '../../../runs/index.js';

const SESSION_ID = 'sess-abc';
const SESSION_CWD = '/projects/somewhere-else';

const BINDING = {
  capabilityId: 'mesh.unregister',
  inputHash: hashApprovalInput({ agentId: '01KXQ3P7ADJY9DSXMZW1XGWCV4' }),
};

let db: Db;
let approvals: ApprovalService;
let record: RunRecord;

/** Every wake saved, by key, with its parsed request. */
function wakes(): { key: string; wake: WakeRequest }[] {
  return db
    .select()
    .from(turnEffects)
    .where(eq(turnEffects.kind, 'wake_chat'))
    .all()
    .map((row) => ({
      key: row.key,
      wake: WakeRequestSchema.parse(JSON.parse(row.payloadJson)),
    }));
}

/** Ask from a session, then have the person answer — the whole reported case. */
function askAndAnswer(
  session: { sessionId: string; cwd?: string } | null = { sessionId: SESSION_ID, cwd: SESSION_CWD }
): string {
  const { approvalId } = approvals.request({
    ...BINDING,
    summary: 'Unregister "scout"',
    ...(session ? { requestingSession: session } : {}),
  } as never);
  approvals.grant(approvalId);
  return approvalId;
}

beforeEach(() => {
  db = createTestDb();
  approvals = new ApprovalService(db);
  installRunRecord(db, { epoch: '01BOOTEPOCHVERDICT00000000' });
  record = getRunRecord()!;
});

afterEach(() => {
  uninstallRunRecord();
  setContinuationHoldDb(undefined);
  disposeProjector(SESSION_ID);
  vi.restoreAllMocks();
});

describe('deliverApprovalVerdict', () => {
  it('saves one wake for the asking session, keyed by the approval, the verdict as context', () => {
    const approvalId = askAndAnswer();

    expect(deliverApprovalVerdict(approvals, approvalId, wakeChat)).toBe(true);

    const [saved, ...more] = wakes();
    expect(more).toEqual([]);
    expect(saved!.key).toBe(`wake:approval:${approvalId}`);
    const { start } = saved!.wake;
    expect(saved!.wake).toMatchObject({ sourceKind: 'approval', eventId: approvalId });
    expect(start).toMatchObject({
      sessionId: SESSION_ID,
      // The ROW's directory (DOR-981): the projector registry empties on restart.
      cwd: SESSION_CWD,
      origin: { kind: 'resume' },
      // The substance rides the neutral bag, so every adapter renders it its own way.
      approvalVerdict: {
        approvalId,
        capabilityTitle: 'mesh.unregister',
        outcome: 'granted',
        endedAt: expect.any(String),
      },
    });
    // A busy chat waits for the answer rather than dropping it.
    expect(start.notAfter).toBeUndefined();
    // The turn's own content is wrapped in the registered tag, so the transcript
    // strip removes it and it can never read as the person's words.
    expect(start.content).toMatch(/^<approval_verdict>[\s\S]*<\/approval_verdict>$/);
    // A chat stored nowhere is gone for good: the wake must not start a new one.
    expect(saved!.wake.onlyIfChatExists).toEqual({ cwd: SESSION_CWD });
  });

  it('holds the answer’s turn to the runtime default when the chat’s latest turn was held (DOR-3037, DOR-3203)', () => {
    setContinuationHoldDb(createTestDb());
    deliverApprovalVerdict(approvals, askAndAnswer(), wakeChat);
    noteTurnHold(SESSION_ID, true);
    deliverApprovalVerdict(approvals, askAndAnswer(), wakeChat);
    const [unheld, held] = wakes().map(({ wake }) => wake.start);
    expect(unheld!.permissionCeiling).toBeUndefined();
    expect(unheld!.continuationHold).toBeUndefined();
    expect(held).toMatchObject({ permissionCeiling: 'runtime-default', continuationHold: true });
  });

  it('carries a refusal, and the reason with it', () => {
    const { approvalId } = approvals.request({
      ...BINDING,
      summary: 'Unregister "scout"',
      requestingSession: { sessionId: SESSION_ID, cwd: SESSION_CWD },
    });
    approvals.deny(approvalId, 'that agent is still running the nightly job');

    deliverApprovalVerdict(approvals, approvalId, wakeChat);

    expect(wakes()[0]!.wake.start.approvalVerdict).toMatchObject({
      outcome: 'denied',
      denyReason: 'that agent is still running the nightly job',
    });
  });

  it('reads the directory from the row, else the live projector, never an empty one', () => {
    // `UiToolSession.cwd` is optional, so an approval can be minted with a session
    // and no directory. The ladder `mcp-signin-resume` carries since DOR-981.
    deliverApprovalVerdict(approvals, askAndAnswer({ sessionId: SESSION_ID }), wakeChat);
    const live = getOrCreateProjector(SESSION_ID, '/the/live/checkout');
    deliverApprovalVerdict(approvals, askAndAnswer({ sessionId: SESSION_ID }), wakeChat);
    expect(wakes().map(({ wake }) => wake.start.cwd)).toEqual([DEFAULT_CWD, '/the/live/checkout']);
    expect(live.cwd, 'the delivery moved a running session').toBe('/the/live/checkout');
  });

  it('saves EXACTLY ONE wake, however many times the answer is broadcast', () => {
    const approvalId = askAndAnswer();
    expect(deliverApprovalVerdict(approvals, approvalId, wakeChat)).toBe(true);
    expect(deliverApprovalVerdict(approvals, approvalId, wakeChat)).toBe(false);
    expect(deliverApprovalVerdict(approvals, approvalId, wakeChat)).toBe(false);
    expect(wakes()).toHaveLength(1);
  });

  it('saves nothing for what a hold is already waiting to deliver', () => {
    // The hold claims when it STARTS waiting, so a decision that lands inside the
    // cap is the hold's to report, in the turn the agent is still running.
    const { approvalId } = approvals.request({
      ...BINDING,
      summary: 'Unregister "scout"',
      requestingSession: { sessionId: SESSION_ID, cwd: SESSION_CWD },
    });
    expect(approvals.claimVerdictDelivery(approvalId)).toBe(true);
    approvals.grant(approvalId);

    expect(deliverApprovalVerdict(approvals, approvalId, wakeChat)).toBe(false);
    expect(wakes()).toEqual([]);
  });

  it('leaves a request that named no session completely alone', () => {
    const approvalId = askAndAnswer(null);
    expect(deliverApprovalVerdict(approvals, approvalId, wakeChat)).toBe(false);
    expect(wakes()).toEqual([]);
  });

  it('hands the claim back when the wake cannot be saved: the answer is still owed', () => {
    // Purpose: fails if the claim were taken in a write of its own, apart from the wake.
    const approvalId = askAndAnswer();
    vi.spyOn(record.effects, 'insert').mockImplementationOnce(() => {
      throw new Error('disk full');
    });

    expect(deliverApprovalVerdict(approvals, approvalId, wakeChat)).toBe(false);

    expect(wakes()).toEqual([]);
    expect(deliverApprovalVerdict(approvals, approvalId, wakeChat)).toBe(true);
    expect(wakes()).toHaveLength(1);
  });
});

describe('startApprovalVerdictDelivery', () => {
  it('saves the wake on the broadcast itself, one write, before any turn', () => {
    const stop = startApprovalVerdictDelivery(approvals, wakeChat);
    try {
      const approvalId = askAndAnswer();
      expect(wakes().map(({ key }) => key)).toEqual([`wake:approval:${approvalId}`]);
    } finally {
      stop();
    }
  });

  it('attaches exactly one listener and detaches it, counted rather than assumed', () => {
    const before = eventFanOut.listenerCount;
    const stop = startApprovalVerdictDelivery(approvals, wakeChat);
    expect(eventFanOut.listenerCount).toBe(before + 1);
    stop();
    expect(eventFanOut.listenerCount).toBe(before);
  });

  it('ignores `consumed`, the one ending that is never delivered', () => {
    // The ordinary grant flow settles TWICE for one subject — once when the
    // operator decides, again when the agent spends the token. Driven on a REAL,
    // deliverable approval with its claim freed, so the outcome filter is the
    // ONLY thing that can stop a second wake.
    const stop = startApprovalVerdictDelivery(approvals, wakeChat);
    try {
      const approvalId = askAndAnswer();
      approvals.releaseVerdictDelivery(approvalId);
      db.delete(turnEffects).run();
      eventFanOut.broadcast('approval_resolved', { approvalId, outcome: 'consumed' });
      expect(wakes()).toEqual([]);
    } finally {
      stop();
    }
  });

  it('stops listening when it is stopped', () => {
    const stop = startApprovalVerdictDelivery(approvals, wakeChat);
    stop();
    askAndAnswer();
    expect(wakes()).toEqual([]);
  });
});

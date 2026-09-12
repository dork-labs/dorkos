/**
 * The whole expiry chain, driven end to end (spec `approval-expiry-notice`,
 * DOR-1932).
 *
 * ## Why this file exists beside the unit tests
 *
 * Its sibling `approval-verdict-end-to-end.test.ts` says it plainly: the defect
 * this seam exists to fix "was a chain with a link missing, and every link had a
 * passing test". DOR-1932 adds a THIRD outcome to that chain, and every unit
 * test around it stops short of the chain — `approval-expiry-sweep.test.ts`
 * mocks `eventFanOut.broadcast` outright, so the deliverer, the dispatcher and
 * the three adapter renderers are never reached for `expired` by any of them.
 *
 * So this drives the real thing: a real sweep, the real fan-out, the real
 * deliverer, the real dispatcher, and a `FakeAgentRuntime` at the end of it —
 * and asserts the expiry actually lands in the prompt on all three runtimes.
 *
 * It also pins the two claims the module docs assert and nothing else drives:
 * that exactly one turn opens for one expiry, and that a hold which is still
 * waiting reports the ending itself rather than being duplicated out of band.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { approvals as approvalsTable, eq, type Db } from '@dorkos/db';
import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';

import {
  SessionEventStore,
  setSessionEventStore,
  MessageQueueStore,
  setMessageQueueStore,
  disposeProjector,
} from '../../../session/index.js';
import { resetMessageDispatcher } from '../../../session/message-dispatcher.js';
import { resetStagedContextStore } from '../../../session/staged-context-store.js';
import { runtimeRegistry } from '../../runtime-registry.js';
import { renderContextEntry } from '../../../runtimes/claude-code/messaging/context-builder.js';
import { buildCodexPrompt } from '../../../runtimes/codex/turn-input.js';
import { buildOpenCodeParts } from '../../../runtimes/opencode/messaging/turn-input.js';
import { awaitCapabilityApproval } from '../../capabilities/capability-approval-hold.js';
import { ApprovalService } from '../approval-service.js';
import { startApprovalVerdictDelivery } from '../approval-verdict-delivery.js';
import { hashApprovalInput } from '../approval-input-hash.js';

const CWD = '/projects/scout';
const BINDING = {
  capabilityId: 'mesh.unregister',
  inputHash: hashApprovalInput({ agentId: '01KXQ3P7ADJY9DSXMZW1XGWCV4' }),
};

describe('nobody answers, and the agent is told', () => {
  let db: Db;
  let approvals: ApprovalService;
  let runtime: FakeAgentRuntime;
  let stop: () => void;
  let sessionId: string;

  beforeEach(() => {
    db = createTestDb();
    approvals = new ApprovalService(db);
    setSessionEventStore(new SessionEventStore(db));
    setMessageQueueStore(new MessageQueueStore(db));
    runtime = new FakeAgentRuntime();
    sessionId = randomUUID();
    runtime.ensureSession(sessionId, { cwd: CWD, permissionMode: 'default' });
    runtime.hasSession.mockReturnValue(true);
    vi.spyOn(runtimeRegistry, 'resolveForSession').mockResolvedValue(runtime);
    stop = startApprovalVerdictDelivery(approvals);
  });

  afterEach(() => {
    stop();
    disposeProjector(sessionId);
    resetMessageDispatcher();
    resetStagedContextStore();
    setSessionEventStore(undefined);
    setMessageQueueStore(undefined);
    vi.restoreAllMocks();
  });

  /** Drag one row's deadline into the past. */
  function expire(approvalId: string) {
    db.update(approvalsTable)
      .set({ expiresAt: new Date(Date.now() - 1_000).toISOString() })
      .where(eq(approvalsTable.id, approvalId))
      .run();
  }

  async function capturedContext(): Promise<AdditionalContextEntry[]> {
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
    const opts = runtime.sendMessage.mock.calls[0]![2] as MessageOpts | undefined;
    return (opts?.additionalContext ?? []) as AdditionalContextEntry[];
  }

  it('carries the expiry all the way into the prompt, on every runtime', async () => {
    const { approvalId } = approvals.request({
      ...BINDING,
      summary: 'Unregister "scout"',
      requestingSession: { sessionId, cwd: CWD },
    });
    expire(approvalId);

    // The tick. Nothing after this line is triggered by the test.
    expect(approvals.sweepExpired()).toBe(1);

    const bag = await capturedContext();
    const entry = bag.find((e) => e.kind === 'approval_verdict');
    expect(
      entry,
      'the turn ran but carried no approval_verdict entry — the chain has a link missing'
    ).toBeDefined();
    expect(entry!.data).toMatchObject({ approvalId, outcome: 'expired' });

    for (const [name, rendered] of [
      ['claude-code', renderContextEntry(entry!)],
      ['codex', buildCodexPrompt('', { additionalContext: [entry!] })],
      [
        'opencode',
        buildOpenCodeParts('', { additionalContext: [entry!] }).find((p) => p.synthetic)!.text,
      ],
    ] as const) {
      expect(rendered, `${name} did not wrap the expiry in its tag`).toContain(
        '<approval_verdict>'
      );
      expect(rendered, `${name} rendered the expiry as a JSON dump`).not.toContain(
        '"capabilityTitle"'
      );
      expect(rendered, `${name} claimed a person answered`).not.toContain('a person answered');
      expect(rendered, `${name} did not say nobody answered`).toContain('nobody answered');
    }
  });

  it('opens exactly one turn, and no second one on a later consume', async () => {
    const ticket = approvals.request({
      ...BINDING,
      summary: 'Unregister "scout"',
      requestingSession: { sessionId, cwd: CWD },
    });
    expire(ticket.approvalId);
    approvals.sweepExpired();
    await capturedContext();

    // The agent retries its dead token afterwards.
    approvals.consume(ticket.token, BINDING);
    approvals.sweepExpired();
    await new Promise((r) => setTimeout(r, 50));
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('tells a waiting hold once, and never also out of band', async () => {
    const { approvalId } = approvals.request({
      ...BINDING,
      summary: 'Unregister "scout"',
      requestingSession: { sessionId, cwd: CWD },
    });
    const session = { eventQueue: [] as never[] };

    // The hold starts waiting (claiming as it does), THEN the window closes and
    // the sweep settles it.
    const held = awaitCapabilityApproval({ approvals, session, capMs: 5_000 }, {
      approvalId,
    } as never);
    expire(approvalId);
    approvals.sweepExpired();

    expect(await held).toBe('expired');
    await new Promise((r) => setTimeout(r, 100));
    expect(
      runtime.sendMessage,
      'the hold already reported the expiry in-turn; an out-of-band turn tells the agent twice'
    ).not.toHaveBeenCalled();
  });
});

/**
 * The whole loop, with nothing mocked between the person's click and the prompt
 * a runtime is handed (spec `approval-verdict-delivery`).
 *
 * Every other test in this feature holds one seam still. This one holds none: a
 * REAL `ApprovalService` writes a REAL row, a REAL `grant` broadcasts on the REAL
 * `eventFanOut`, the REAL subscription saves its wake with the claim, the REAL
 * run record's worker makes the run and hands it to the REAL launch path, the
 * REAL dispatcher opens a REAL turn through `triggerTurn`, and the REAL context
 * assembler builds the bag the runtime receives. One stand-in remains, named
 * rather than glossed: the runtime is a `FakeAgentRuntime`, so the prompt can be
 * READ rather than believed — the assertion is on the `additionalContext` a
 * runtime actually got. The worker's passes are driven by the test.
 *
 * That matters because the defect this feature exists to fix was not a wrong
 * value anywhere. It was a chain with a link missing, and every link had a
 * passing test.
 *
 * The three adapter renderings ride the same captured entry, so what is asserted
 * on all three runtimes is the exact payload the live path produced, never a
 * hand-built copy of it.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { FakeAgentRuntime } from '@dorkos/test-utils';
import type { AdditionalContextEntry } from '@dorkos/shared/additional-context';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';

import { SessionEventStore, setSessionEventStore } from '../../../session/index.js';
import { resetStagedContextStore } from '../../../session/staged-context-store.js';
import { wakeHarness, type WakeHarness } from '../../../runs/__tests__/wake-harness.js';
import { wakeChat } from '../../../runs/index.js';
import { renderContextEntry } from '../../../runtimes/claude-code/messaging/context-builder.js';
import { buildCodexPrompt } from '../../../runtimes/codex/turn-input.js';
import { buildOpenCodeParts } from '../../../runtimes/opencode/messaging/turn-input.js';
import { awaitCapabilityApproval } from '../../capabilities/capability-approval-hold.js';
import { ApprovalService } from '../approval-service.js';
import { startApprovalVerdictDelivery } from '../approval-verdict-delivery.js';
import { hashApprovalInput } from '../approval-input-hash.js';

describe('an operator answers late, and the agent is told', () => {
  let approvals: ApprovalService;
  let runtime: FakeAgentRuntime;
  let stop: () => void;
  let sessionId: string;
  let h: WakeHarness;

  beforeEach(() => {
    const db = createTestDb();
    // The run record, its outbox's worker and the real launch path, over the approvals' own
    // database: the claim and the wake are one write (spec `turns-survive-restarts` §6.3).
    h = wakeHarness({ db, epoch: '01BOOTEPOCHVERDICTE2E00000' });
    approvals = new ApprovalService(db);
    setSessionEventStore(new SessionEventStore(db));
    runtime = h.runtime;
    sessionId = h.sessionId;
    stop = startApprovalVerdictDelivery(approvals, wakeChat);
  });

  afterEach(async () => {
    stop();
    resetStagedContextStore();
    setSessionEventStore(undefined);
    await h.dispose();
    vi.restoreAllMocks();
  });

  /** The `additionalContext` bag the runtime was handed for its one turn. */
  async function capturedContext(): Promise<AdditionalContextEntry[]> {
    // The worker's passes, as its wake-ups would run them.
    await vi.waitFor(
      async () => {
        await h.pass();
        expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
      },
      { timeout: 5_000 }
    );
    const opts = runtime.sendMessage.mock.calls[0]![2] as MessageOpts | undefined;
    return (opts?.additionalContext ?? []) as AdditionalContextEntry[];
  }

  it('carries the verdict all the way into the prompt, on every runtime', async () => {
    // The agent asked, from a session, and nobody answered inside the hold cap —
    // so by the time the person clicks, the turn that asked is long gone.
    const { approvalId } = approvals.request({
      capabilityId: 'mesh.unregister',
      inputHash: hashApprovalInput({ agentId: '01KXQ3P7ADJY9DSXMZW1XGWCV4' }),
      summary: 'Unregister "scout"',
      requestingSession: { sessionId, cwd: h.home },
    });

    // The click. Nothing after this line is triggered by the test.
    approvals.grant(approvalId);

    const bag = await capturedContext();
    const entry = bag.find((e) => e.kind === 'approval_verdict');
    expect(
      entry,
      'the turn ran but carried no approval_verdict entry — the chain has a link missing'
    ).toBeDefined();
    expect(entry!.data).toEqual({
      approvalId,
      capabilityTitle: 'mesh.unregister',
      outcome: 'granted',
      endedAt: expect.any(String),
    });

    // The same entry the live path produced, rendered by each adapter's own
    // switch. A JSON dump fails every one of these.
    for (const [name, rendered] of [
      ['claude-code', renderContextEntry(entry!)],
      ['codex', buildCodexPrompt('', { additionalContext: [entry!] })],
      [
        'opencode',
        buildOpenCodeParts('', { additionalContext: [entry!] }).find((p) => p.synthetic)!.text,
      ],
    ] as const) {
      expect(rendered, `${name} did not wrap the verdict in its tag`).toContain(
        '<approval_verdict>'
      );
      expect(rendered, `${name} rendered the verdict as a JSON dump`).not.toContain(
        '"capabilityTitle"'
      );
      expect(rendered, `${name} did not attribute the block to DorkOS`).toContain('DorkOS');
      expect(rendered, `${name} did not say what was decided`).toContain('allowed');
    }
  });

  it('reaches the session with a refusal and the reason, not just a grant', async () => {
    const { approvalId } = approvals.request({
      capabilityId: 'mesh.unregister',
      inputHash: hashApprovalInput({ agentId: '01KXQ3P7ADJY9DSXMZW1XGWCV4' }),
      summary: 'Unregister "scout"',
      requestingSession: { sessionId, cwd: h.home },
    });

    approvals.deny(approvalId, 'it is still running the nightly job');

    const bag = await capturedContext();
    const entry = bag.find((e) => e.kind === 'approval_verdict');
    expect(entry!.data).toMatchObject({
      outcome: 'denied',
      denyReason: 'it is still running the nightly job',
    });
    // The person's own sentence reaches the agent inside a fence, never loose.
    const rendered = renderContextEntry(entry!);
    expect(rendered).toContain('it is still running the nightly job');
    expect(rendered).toMatch(/--- BEGIN UNTRUSTED REFUSAL REASON [0-9a-f]{8} ---/);
    expect(rendered.toLowerCase()).toContain('refused');
  });

  it('opens exactly one turn across the REAL second settle', async () => {
    // The grant flow settles twice for one subject: once on the decision, and
    // again when the agent spends its token (`consume` → `settle(…, 'consumed')`).
    // An earlier version of this test called `grant` twice to stand in for that,
    // which proves nothing — the second `grant` returns `not_pending` BEFORE
    // `settle`, so no second broadcast is emitted at all and the assertion holds
    // whatever the code does. This drives the real one.
    const binding = {
      capabilityId: 'mesh.unregister',
      inputHash: hashApprovalInput({ agentId: '01KXQ3P7ADJY9DSXMZW1XGWCV4' }),
    };
    const ticket = approvals.request({
      ...binding,
      summary: 'Unregister "scout"',
      requestingSession: { sessionId, cwd: h.home },
    });

    approvals.grant(ticket.approvalId);
    await capturedContext();

    // The agent retries with its token. This DOES broadcast a second time.
    const spent = approvals.consume(ticket.token, binding);
    expect(spent.outcome, 'the token did not actually spend — no second settle happened').toBe(
      'granted'
    );

    await h.pass();
    await h.pass();
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a real hold, waiting when the answer lands, is the only one that speaks', async () => {
    // Acceptance item 3 asks for a test that RACES the hold against the
    // out-of-band path. The claim tests drive the primitive by hand; this drives
    // an actual `awaitCapabilityApproval` waiting on the same approval while the
    // live subscription is armed, which is the shape the bug would take.
    const ticket = approvals.request({
      capabilityId: 'mesh.unregister',
      inputHash: hashApprovalInput({ agentId: '01KXQ3P7ADJY9DSXMZW1XGWCV4' }),
      summary: 'Unregister "scout"',
      requestingSession: { sessionId, cwd: h.home },
    });

    const held = awaitCapabilityApproval(
      { approvals, session: { eventQueue: [] }, capMs: 5_000 },
      {
        status: 'approval_required',
        capabilityId: 'mesh.unregister',
        capabilityTitle: 'Unregister an agent',
        tier: 'destructive',
        approvalId: ticket.approvalId,
        approvalToken: ticket.token,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        reason: 'no_approval',
        message: 'needs approval',
        retry: { channel: 'mcp-argument', field: 'approvalToken', instructions: 'retry' },
      }
    );

    approvals.grant(ticket.approvalId);
    expect(await held).toBe('granted');

    // The hold reported the answer as its own return value. A turn here would be
    // a second telling of something the agent already has.
    await h.pass();
    await h.pass();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });
});

/**
 * The whole loop, with nothing mocked between the person's click and the prompt
 * a runtime is handed (spec `approval-verdict-delivery`).
 *
 * Every other test in this feature holds one seam still. This one holds none: a
 * REAL `ApprovalService` writes a REAL row, a REAL `grant` broadcasts on the REAL
 * `eventFanOut`, the REAL subscription hands off, the REAL dispatcher opens a
 * REAL turn through `triggerTurn`, and the REAL context assembler builds the bag
 * the runtime receives. The only stand-in is the runtime itself, and it is there
 * to be READ rather than to be believed — the assertion is on the
 * `additionalContext` a runtime actually got.
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
import { randomUUID } from 'node:crypto';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
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
import { ApprovalService } from '../approval-service.js';
import { startApprovalVerdictDelivery } from '../approval-verdict-delivery.js';
import { hashApprovalInput } from '../approval-input-hash.js';

const CWD = '/projects/scout';

describe('an operator answers late, and the agent is told', () => {
  let approvals: ApprovalService;
  let runtime: FakeAgentRuntime;
  let stop: () => void;
  let sessionId: string;

  beforeEach(() => {
    const db = createTestDb();
    approvals = new ApprovalService(db);
    setSessionEventStore(new SessionEventStore(db));
    setMessageQueueStore(new MessageQueueStore(db));
    runtime = new FakeAgentRuntime();
    sessionId = randomUUID();
    runtime.ensureSession(sessionId, { cwd: CWD, permissionMode: 'default' });
    // The fake's `hasSession` answers `false` for every id by default, which
    // would send the deliverer down the cold-start path and then the
    // session-is-gone path. This session is live, so say so.
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

  /** The `additionalContext` bag the runtime was handed for its one turn. */
  async function capturedContext(): Promise<AdditionalContextEntry[]> {
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(1), {
      timeout: 5_000,
    });
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
      requestingSession: { sessionId, cwd: CWD },
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
      decidedAt: expect.any(String),
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
      requestingSession: { sessionId, cwd: CWD },
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

  it('opens exactly one turn, however the answer is settled', async () => {
    // The grant flow settles twice for one subject — once on the decision, once
    // when the token is spent — and the second settle must open nothing.
    const { approvalId } = approvals.request({
      capabilityId: 'mesh.unregister',
      inputHash: hashApprovalInput({ agentId: '01KXQ3P7ADJY9DSXMZW1XGWCV4' }),
      summary: 'Unregister "scout"',
      requestingSession: { sessionId, cwd: CWD },
    });

    approvals.grant(approvalId);
    await capturedContext();
    // A second broadcast of the same decision, exactly as `settle` produces one.
    approvals.grant(approvalId);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
});

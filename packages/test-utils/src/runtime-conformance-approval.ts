/** Shared approval cases, including separate permission and invocation identities. */
import { describe, expect, it } from 'vitest';
import type { AgentRuntime, SessionOpts } from '@dorkos/shared/agent-runtime';
import type { ApprovalEvent, StreamEvent } from '@dorkos/shared/types';
import { ApprovalEventSchema, InterruptReceiptSchema } from '@dorkos/shared/schemas';
import type { RuntimeConformanceOpts } from './runtime-conformance.js';

/**
 * Register the approval branch without coupling the portable suite to a server projector.
 * @param makeRuntime - Fresh adapter factory.
 * @param wiring - Session and native driver wiring owned by the parent suite.
 */
export function runtimeApprovalConformance(
  makeRuntime: () => AgentRuntime,
  wiring: {
    approvalTurn: RuntimeConformanceOpts['approvalTurn'];
    nextSessionId: () => string;
    sessionOpts: (runtime: AgentRuntime) => SessionOpts;
    messageContent: string;
  }
): void {
  const { approvalTurn, nextSessionId, sessionOpts, messageContent } = wiring;
  const TERMINAL_EVENT_TYPE = 'done';
  describe('tool approval (approvalTurn)', () => {
    const declaresApproval = (runtime: AgentRuntime): boolean =>
      runtime.getCapabilities().supportsToolApproval === true;
    /** The status the turn's events last gave one tool. */
    const finalToolStatus = (events: StreamEvent[], toolCallId: string): unknown =>
      events
        .filter(
          (event) =>
            (event.type === 'tool_call_end' || event.type === 'tool_result') &&
            (event.data as { toolCallId?: string }).toolCallId === toolCallId
        )
        .map((event) => (event.data as { status?: unknown }).status)
        .at(-1);
    const terminals = (events: StreamEvent[]) =>
      events.filter((event) => event.type === TERMINAL_EVENT_TYPE);

    it('approveTool on an id nothing is waiting on answers false', () => {
      const runtime = makeRuntime();
      const sessionId = nextSessionId();
      runtime.ensureSession(sessionId, sessionOpts(runtime));
      expect(runtime.approveTool(sessionId, 'conformance-no-such-approval', true)).toBe(false);
    });

    it('a driver is wired only by a runtime that declares supportsToolApproval', () => {
      if (approvalTurn === undefined) return;
      expect(
        declaresApproval(makeRuntime()),
        'an approvalTurn driver was wired by a runtime that does not declare supportsToolApproval'
      ).toBe(true);
    });

    if (approvalTurn) {
      it('approving a card resumes the tool, and the turn ends with one done', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));
        let asked: ApprovalEvent | undefined;
        let invocationId: string | undefined;
        const events = await approvalTurn(runtime, sessionId, messageContent, {
          atApproval: async (approval, invocation) => {
            asked = ApprovalEventSchema.parse(approval);
            invocationId = invocation?.toolCallId ?? approval.toolCallId;
            expect(
              runtime.approveTool(sessionId, 'conformance-no-such-approval', true),
              'an id nothing is waiting on answers false, even with a card open'
            ).toBe(false);
            expect(runtime.approveTool(sessionId, 'conformance-no-such-approval', false)).toBe(
              false
            );
            expect(runtime.approveTool(sessionId, approval.toolCallId, true)).toBe(true);
            expect(
              runtime.approveTool(sessionId, approval.toolCallId, true),
              'a card answers once'
            ).toBe(false);
            expect(runtime.approveTool(sessionId, approval.toolCallId, false)).toBe(false);
          },
          afterTurn: async () => {
            const snapshot = await runtime.getSessionSnapshot(sessionOpts(runtime), sessionId);
            expect(snapshot.pendingInteractions.map((pending) => pending.id)).not.toContain(
              asked!.toolCallId
            );
          },
        });
        expect(asked, 'the approvalTurn driver never opened a card').toBeDefined();
        const card = events.findIndex((event) => event.type === 'approval_required');
        expect(
          events
            .slice(0, card)
            .some(
              (event) =>
                event.type === 'tool_call_start' &&
                (event.data as { toolCallId?: string }).toolCallId === invocationId
            ),
          'the approval names the exact invocation whose real tool start preceded it'
        ).toBe(true);
        expect(
          events.reduce(
            (last, event, index) =>
              (event.type === 'tool_call_end' || event.type === 'tool_result') &&
              (event.data as { toolCallId?: string }).toolCallId === invocationId
                ? index
                : last,
            -1
          )
        ).toBeGreaterThan(card);
        expect(finalToolStatus(events, invocationId!)).toBe('complete');
        expect(terminals(events)).toHaveLength(1);
        expect(events.at(-1)?.type).toBe(TERMINAL_EVENT_TYPE);
      });

      it('denying a card ends that tool as declined, and the turn with one done', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));
        let id: string | undefined;
        let invocationId: string | undefined;
        const events = await approvalTurn(runtime, sessionId, messageContent, {
          atApproval: async (approval, invocation) => {
            id = approval.toolCallId;
            invocationId = invocation?.toolCallId ?? approval.toolCallId;
            expect(runtime.approveTool(sessionId, 'conformance-no-such-approval', false)).toBe(
              false
            );
            expect(runtime.approveTool(sessionId, 'conformance-no-such-approval', true)).toBe(
              false
            );
            expect(runtime.approveTool(sessionId, approval.toolCallId, false)).toBe(true);
            expect(runtime.approveTool(sessionId, approval.toolCallId, false)).toBe(false);
            expect(runtime.approveTool(sessionId, approval.toolCallId, true)).toBe(false);
          },
          afterTurn: async () => {
            const snapshot = await runtime.getSessionSnapshot(sessionOpts(runtime), sessionId);
            expect(snapshot.pendingInteractions.map((pending) => pending.id)).not.toContain(id);
          },
        });
        expect(id, 'the approvalTurn driver never opened a card').toBeDefined();
        const card = events.findIndex((event) => event.type === 'approval_required');
        expect(
          events
            .slice(0, card)
            .some(
              (event) =>
                event.type === 'tool_call_start' &&
                (event.data as { toolCallId?: string }).toolCallId === invocationId
            ),
          'the approval names the exact invocation whose real tool start preceded it'
        ).toBe(true);
        expect(
          events.reduce(
            (last, event, index) =>
              (event.type === 'tool_call_end' || event.type === 'tool_result') &&
              (event.data as { toolCallId?: string }).toolCallId === invocationId
                ? index
                : last,
            -1
          )
        ).toBeGreaterThan(card);
        expect(finalToolStatus(events, invocationId!)).toBe('error');
        expect(terminals(events)).toHaveLength(1);
      });

      it('stopping with a card open withdraws the card, and the turn ends with one done', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));
        let id: string | undefined;
        const events = await approvalTurn(runtime, sessionId, messageContent, {
          atApproval: async (approval) => {
            id = approval.toolCallId;
            const receipt = await runtime.interruptQuery(sessionId);
            InterruptReceiptSchema.parse(receipt);
          },
          afterTurn: async () => {
            const snapshot = await runtime.getSessionSnapshot(sessionOpts(runtime), sessionId);
            expect(
              snapshot.pendingInteractions.map((pending) => pending.id),
              'a stopped turn leaves no answerable card behind'
            ).not.toContain(id);
          },
        });
        expect(id, 'the approvalTurn driver never opened a card').toBeDefined();
        expect(runtime.approveTool(sessionId, id!, true)).toBe(false);
        expect(runtime.approveTool(sessionId, id!, false)).toBe(false);
        expect(terminals(events)).toHaveLength(1);
      });
    } else {
      it('SKIPPED unless declared: approval cases need an approvalTurn driver', ({ skip }) => {
        if (declaresApproval(makeRuntime())) {
          skip(
            'this runtime declares supportsToolApproval but wires no approvalTurn driver, so ' +
              'nothing here proves its cards resume, decline and withdraw (see ' +
              'RuntimeConformanceOpts.approvalTurn)'
          );
        }
        skip('this runtime does not declare supportsToolApproval, so it has no card to answer');
      });
    }
  });
}

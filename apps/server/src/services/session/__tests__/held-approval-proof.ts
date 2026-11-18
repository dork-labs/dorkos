import { expect } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { ApprovalEvent } from '@dorkos/shared/types';
import { getOrCreateProjector } from '../session-state-projector.js';

/** The existing conformance driver's probes, with no fabricated runtime events. */
export interface ApprovalProbes {
  atApproval: (approval: ApprovalEvent, invocation?: { toolCallId: string }) => Promise<void>;
  afterTurn: () => Promise<void>;
}

/**
 * Hold vendor completion until the real answer has withdrawn its exact live card.
 * @param runtime - Production adapter under test.
 * @param sessionId - The actual projected session.
 * @param cwd - Its hermetic working directory.
 * @param probes - Shared approve/deny/stop behavior.
 * @param control - Vendor completion gate and actual interrupt observation.
 */
export function heldApprovalProbes(
  runtime: AgentRuntime,
  sessionId: string,
  cwd: string,
  probes: ApprovalProbes,
  control: {
    stopped: () => boolean;
    release: () => void;
    resolution: () => Promise<'approved' | 'denied'>;
  }
): ApprovalProbes {
  return {
    ...probes,
    atApproval: async (approval, invocation) => {
      const projector = getOrCreateProjector(sessionId, cwd);
      const cursor = projector.replayFrom(0).at(-1)?.seq ?? 0;
      expect(projector.getPendingInteractions().map((card) => card.id)).toContain(
        approval.toolCallId
      );
      try {
        expect(runtime.approveTool(sessionId, 'held-no-such-card', true)).toBe(false);
        expect(runtime.approveTool(sessionId, 'held-no-such-card', false)).toBe(false);
        await probes.atApproval(approval, invocation);
        if (!control.stopped()) {
          expect(runtime.approveTool(sessionId, approval.toolCallId, true)).toBe(false);
          expect(runtime.approveTool(sessionId, approval.toolCallId, false)).toBe(false);
          const answered = projector
            .replayFrom(cursor)
            .filter(
              (event) => event.type === 'interaction_resolved' && event.id === approval.toolCallId
            );
          expect(answered, 'the answered card must resolve before vendor completion').toHaveLength(
            1
          );
          expect(answered[0]).toMatchObject({ resolution: await control.resolution() });
          expect(projector.replayFrom(cursor).some((event) => event.type === 'turn_end')).toBe(
            false
          );
          const snapshot = await runtime.getSessionSnapshot(
            { cwd, permissionMode: 'default' },
            sessionId
          );
          expect(
            snapshot.pendingInteractions.map((card) => card.id),
            'answered card withdrawn while turn held open'
          ).not.toContain(approval.toolCallId);
          expect(snapshot.inProgressTurn, 'vendor completion is still held').not.toBeNull();
        }
      } finally {
        control.release();
      }
    },
  };
}

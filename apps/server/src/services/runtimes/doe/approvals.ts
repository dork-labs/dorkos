import { randomUUID } from 'node:crypto';
import type { ApprovalCallback } from '@dorkos/doe';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ToolDecisionOptions } from '@dorkos/shared/agent-runtime';

import { SESSIONS } from '../../../config/constants.js';
const READ_TOOLS = new Set(['read', 'search', 'load_skill', 'tool_search', 'end_beat']);
const EDIT_TOOLS = new Set(['write', 'edit']);
interface PendingApproval {
  settle: (allowed: boolean) => void;
}

/** Approval channel for local engine tools; capability MCP retains its own policy gates. */
export class DoeApprovals {
  private readonly pending = new Map<string, PendingApproval>();

  /** Return a callback scoped to this turn's clamped mode and cancellation signal. */
  callback(
    mode: string,
    emit: (event: StreamEvent) => void,
    signal: AbortSignal,
    unattended = false,
    hostTools: ReadonlySet<string> = new Set()
  ): ApprovalCallback {
    return async (tool, args, context) => {
      if (signal.aborted || context.signal.aborted) return 'deny';
      if (
        mode === 'bypassPermissions' ||
        READ_TOOLS.has(tool.name) ||
        hostTools.has(tool.name) ||
        (mode === 'acceptEdits' && EDIT_TOOLS.has(tool.name))
      )
        return 'allow';
      const id = context.callId ?? randomUUID();
      return new Promise<'allow' | 'deny'>((resolve) => {
        const aborted = () => settle(false, 'aborted');
        const settle = (
          allowed: boolean,
          reason: 'approved' | 'denied' | 'timeout' | 'aborted' = allowed ? 'approved' : 'denied'
        ): void => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          signal.removeEventListener('abort', aborted);
          context.signal.removeEventListener('abort', aborted);
          emit({ type: 'interaction_cancelled', data: { interactionId: id, reason } });
          resolve(allowed ? 'allow' : 'deny');
        };
        const timer = setTimeout(
          () => settle(false, 'timeout'),
          unattended ? SESSIONS.INTERACTION_TIMEOUT_MS : SESSIONS.INTERACTION_PARK_CEILING_MS
        );
        timer.unref();
        this.pending.set(id, { settle });
        signal.addEventListener('abort', aborted, { once: true });
        context.signal.addEventListener('abort', aborted, { once: true });
        emit({
          type: 'approval_required',
          data: {
            toolCallId: id,
            toolName: tool.name,
            input: JSON.stringify(args),
            startedAt: Date.now(),
            timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
            hasSuggestions: false,
          },
        });
      });
    };
  }

  /** Resolve only an actual pending interaction; Always Allow is deliberately unsupported. */
  approve(id: string, allowed: boolean, _options?: ToolDecisionOptions): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    pending.settle(allowed);
    return true;
  }

  /** Refuse this turn's remaining requests during owned cleanup. */
  close(): void {
    for (const pending of [...this.pending.values()]) pending.settle(false);
  }
}

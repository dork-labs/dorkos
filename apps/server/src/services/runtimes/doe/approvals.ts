import { randomUUID } from 'node:crypto';
import type { ApprovalCallback } from '@dorkos/doe';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ToolDecisionOptions } from '@dorkos/shared/agent-runtime';

import { resolveApprovalDecision } from '../shared/policy/approvals.js';
import { isProtectedPath, type ProtectedPathRoots } from '../shared/policy/protected-path-check.js';
import { protectedPathRoots } from '../shared/policy/protected-path-roots.js';
import { checkShellCommand, type ShellCommandVerdict } from '../shared/policy/package-hooks.js';
import { logger, logError } from '../../../lib/logger.js';
import { PendingApprovalRegistry } from '../shared/timing/pending-approval-registry.js';
import { PENDING_APPROVAL_TIMING } from '../shared/timing/pending-approval-timing.js';

const TURN_SCOPE = Symbol('Doe turn approval channel');
const READ_TOOLS = new Set(['read', 'search', 'load_skill', 'tool_search', 'end_beat']);
const EDIT_TOOLS = new Set(['write', 'edit']);
interface PendingApproval {
  settle: (allowed: boolean) => void;
}

/** Approval channel for local engine tools; capability MCP retains its own policy gates. */
export class DoeApprovals {
  private readonly pending = new PendingApprovalRegistry<PendingApproval>();

  /** Return a callback scoped to this turn's clamped mode and cancellation signal. */
  callback(
    mode: string,
    emit: (event: StreamEvent) => void,
    signal: AbortSignal,
    unattended = false,
    hostTools: ReadonlySet<string> = new Set(),
    protectedRoots?: ProtectedPathRoots
  ): ApprovalCallback {
    return async (tool, args, context) => {
      if (signal.aborted || context.signal.aborted) return 'deny';
      if (
        ['read', 'search', 'write', 'edit'].includes(tool.name) &&
        args &&
        typeof args === 'object' &&
        !Array.isArray(args) &&
        typeof args.path === 'string'
      ) {
        // A browser sign-in store opens at Full only, read from this turn's clamped mode (DOR-4136).
        const roots = {
          ...(protectedRoots ?? protectedPathRoots(context.workingDirectory)),
          full: mode === 'bypassPermissions',
        };
        const denied =
          isProtectedPath(args.path, EDIT_TOOLS.has(tool.name) ? 'write' : 'read', roots) ||
          (tool.name === 'edit' && isProtectedPath(args.path, 'read', roots));
        if (denied) {
          logger.warn('[ProtectedFiles] Refused a Doe native file operation', {
            sessionId: context.sessionId,
            toolName: tool.name,
          });
          return 'deny';
        }
      }
      // An installed package's own shell guards run before any mode allows the
      // call, Full included: Doe has no hooks of its own (DOR-4379). A call
      // whose command cannot be read is still checked, and refused if a guard
      // applies; a check that throws refuses.
      if (tool.name === 'shell') {
        const command =
          args &&
          typeof args === 'object' &&
          !Array.isArray(args) &&
          typeof args.command === 'string'
            ? args.command
            : undefined;
        let verdict: ShellCommandVerdict;
        try {
          verdict = await checkShellCommand({
            runtime: 'doe',
            cwd: context.workingDirectory,
            command,
            sessionId: context.sessionId,
            permissionMode: mode,
            signal: context.signal,
          });
        } catch (err) {
          logger.warn('[PackageHooks] Doe shell check failed', logError(err));
          verdict = {
            allowed: false,
            packageName: 'DorkOS',
            reason:
              "DorkOS could not run this project's safety checks, so this command was blocked.",
          };
        }
        if (signal.aborted || context.signal.aborted) return 'deny';
        if (!verdict.allowed) return { decision: 'deny', reason: verdict.reason };
      }
      if (
        READ_TOOLS.has(tool.name) ||
        hostTools.has(tool.name) ||
        resolveApprovalDecision(mode, EDIT_TOOLS.has(tool.name) ? 'edit' : 'other') ===
          'auto-approve'
      )
        return 'allow';
      const id = context.callId ?? randomUUID();
      return new Promise<'allow' | 'deny'>((resolve) => {
        const aborted = () => settle(false, 'aborted');
        const finish = (
          allowed: boolean,
          reason: 'approved' | 'denied' | 'timeout' | 'aborted'
        ): void => {
          signal.removeEventListener('abort', aborted);
          context.signal.removeEventListener('abort', aborted);
          emit({ type: 'interaction_cancelled', data: { interactionId: id, reason } });
          resolve(allowed ? 'allow' : 'deny');
        };
        const settle = (
          allowed: boolean,
          reason: 'approved' | 'denied' | 'aborted' = allowed ? 'approved' : 'denied'
        ): void => {
          if (removeOwned?.()) finish(allowed, reason);
        };
        const profile = unattended ? 'unattended' : 'attended';
        const removeOwned = this.pending.insert(TURN_SCOPE, id, { settle }, profile, () =>
          finish(false, 'timeout')
        );
        if (!removeOwned) {
          resolve('deny');
          return;
        }
        signal.addEventListener('abort', aborted, { once: true });
        context.signal.addEventListener('abort', aborted, { once: true });
        emit({
          type: 'approval_required',
          data: {
            toolCallId: id,
            toolName: tool.name,
            input: JSON.stringify(args),
            startedAt: Date.now(),
            timeoutMs: PENDING_APPROVAL_TIMING[profile].countdownMs,
            hasSuggestions: false,
          },
        });
      });
    };
  }

  /** Resolve only an actual pending interaction; Always Allow is deliberately unsupported. */
  approve(id: string, allowed: boolean, _options?: ToolDecisionOptions): boolean {
    const pending = this.pending.peek(TURN_SCOPE, id);
    if (!pending) return false;
    pending.settle(allowed);
    return true;
  }

  /** Refuse this turn's remaining requests during owned cleanup. */
  close(): void {
    for (const pending of this.pending.values(TURN_SCOPE)) pending.settle(false);
  }
}

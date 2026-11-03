/**
 * Claiming a start slot for a chat `session_start` starts from another chat, and
 * writing who started it: the first line, the limits and the scheduled origin
 * (DOR-3703, ME) all hang off that one row.
 *
 * @module services/runtimes/claude-code/mcp-tools/session-start-reserve
 */
import { getStartWorkService, type StartReservation } from '../../../extensions/start-work.js';
import { scheduledOriginStamp } from '../../../tasks/agent-mode/agent-mode-run-origin.js';
import type { SessionStartPermission } from './session-start-permission.js';
import type { McpToolDeps } from './types.js';

/**
 * Claim a start slot for a chat started from `parentSessionId`, recording who
 * started it. The new chat inherits the parent's origin extension, so it counts
 * against that extension's start limits and is refused past them. Without a
 * calling chat (the external `/mcp` server) or before boot wired the seam,
 * nothing is recorded and nothing is limited here.
 */
export function reserveChatStart(start: {
  sessionId: string;
  parentSessionId: string | null;
  reason: string | undefined;
  permission: SessionStartPermission;
  reportBack: boolean;
  taskStore: McpToolDeps['taskStore'];
}): { ok: true; reservation: StartReservation | null } | { ok: false; message: string } {
  const { sessionId, parentSessionId, reason, permission, reportBack, taskStore } = start;
  const service = getStartWorkService();
  if (!parentSessionId || !service) return { ok: true, reservation: null };
  const claimed = service.reserveFromChat({
    sessionId,
    parentSessionId,
    reason: reason ?? null,
    permissionMode: permission.mode,
    starterPermissionMode: permission.callerMode,
    permissionSameAsStarter: permission.sameAsCaller,
    reportBack,
    // On the new chat's own row, because retention prunes the run behind it (DOR-3703, ME).
    scheduledOrigin: taskStore ? scheduledOriginStamp(parentSessionId, taskStore) : null,
  });
  return claimed.ok
    ? { ok: true, reservation: claimed.reservation }
    : { ok: false, message: claimed.error.message };
}

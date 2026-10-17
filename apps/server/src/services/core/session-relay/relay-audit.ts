/**
 * How the relay writes to the audit log: every relayed action as the owner,
 * on the `relay` surface, naming the chat but never what was said, and
 * readable by the owner alone, like the chats themselves.
 *
 * @module services/core/session-relay/relay-audit
 */
import type { AuditActor, AuditOperation, AuditOutcome } from '@dorkos/shared/audit-schemas';
import { logger } from '../../../lib/logger.js';
import type { RecordAuditInput } from '../../audit/audit-trail.js';

/** One relayed action, as the request server describes it. */
export interface RelayAuditEntry {
  action: string;
  operation: AuditOperation;
  outcome: AuditOutcome;
  summary: string;
  sessionId?: string | undefined;
  target?: { type: string; id: string };
}

/**
 * Record one relayed action as the owner, on the relay surface. Never throws.
 *
 * @param deps - The owner, and the audit log's writer.
 * @param entry - What happened.
 */
export function recordRelayAudit(
  deps: { owner: () => AuditActor; recordAudit: (input: RecordAuditInput) => void },
  entry: RelayAuditEntry
): void {
  try {
    const actor = deps.owner();
    const { sessionId, target, ...rest } = entry;
    deps.recordAudit({
      ...rest,
      actor,
      source: { surface: 'relay', ...(sessionId ? { sessionId } : {}) },
      target: target ?? (sessionId ? { type: 'session', id: sessionId } : null),
      visibility: 'participants',
      participants: [actor.accountId],
    });
  } catch (error) {
    logger.warn('[SessionRelay] Could not record a relayed action', {
      error: (error as Error).name,
    });
  }
}

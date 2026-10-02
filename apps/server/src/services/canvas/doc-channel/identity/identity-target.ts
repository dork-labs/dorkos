import { DocChannelIdentityBlockedError } from './identity-error.js';
/** Frozen old/new/current target checks before any ownership movement. */
import {
  and,
  eq,
  isNull,
  canvasDocGrants,
  sessionMetadata,
  agents,
  type DbTransaction,
} from '@dorkos/db';
/** Refuse canonical movement unless both sessions still match the exact approved active agent path. */
export function assertIdentityMoveTarget(
  tx: DbTransaction,
  documentId: string,
  fromId: string,
  toId: string
): void {
  const grants = tx
    .select()
    .from(canvasDocGrants)
    .where(
      and(
        eq(canvasDocGrants.documentId, documentId),
        eq(canvasDocGrants.targetSessionId, fromId),
        isNull(canvasDocGrants.revokedAt)
      )
    )
    .all();
  for (const grant of grants) {
    const approvedPath = (
      grant.approvalEvidence as { binding?: { target?: { agentPath?: unknown } } }
    ).binding?.target?.agentPath;
    const source = tx
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, fromId))
      .get();
    const target = tx
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, toId))
      .get();
    const agent = grant.targetAgentId
      ? tx.select().from(agents).where(eq(agents.id, grant.targetAgentId)).get()
      : undefined;
    if (
      !source ||
      !target ||
      source.runtime !== grant.targetRuntime ||
      typeof approvedPath !== 'string' ||
      source.agentPath !== approvedPath ||
      source.agentPath !== target.agentPath ||
      target.runtime !== grant.targetRuntime ||
      !agent ||
      agent.status !== 'active' ||
      agent.runtime !== target.runtime ||
      agent.projectPath !== target.agentPath
    )
      throw new DocChannelIdentityBlockedError();
  }
}

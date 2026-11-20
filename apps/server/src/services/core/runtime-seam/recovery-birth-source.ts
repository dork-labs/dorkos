import type { RecoveryLaunchInput } from '../../rooms/reseat/required-launch-store.js';
/** Physical pre-publication recovery source, separate from permission to launch. */
import {
  and,
  authors,
  eq,
  roomSessions,
  sessionMetadata,
  sessionNativeBindings,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { currentDispatchId } from '../../../lib/dispatch-context.js';
import { SessionEventStore } from '../../session/session-event-store.js';
import { latestClaudeRoomServerFailure } from '../../session/history/latest-room-failure.js';

/** Prepared by the actual replacement mint while its old seat and handoff still exist. */
export interface RecoveryBirthContext {
  kind: 'required-recovery';
  allocationCreatedAt: string;
  requirementId: string;
  destinationSessionId: string;
  sourceSessionId: string;
  sourceDispatchId: string;
  startSeq: number;
  endSeq: number;
  roomId: string;
  authorId: string;
  agentPath: string;
  seatCreatedAt: string;
  handoffDispatchId: string;
  root: string;
}

/** Re-read the actual old generation and failed dispatch inside the owning transaction. */
export function currentRecoveryBirthSource(
  tx: DbTransaction,
  context: RecoveryBirthContext
): boolean {
  if (context.destinationSessionId === context.sourceSessionId) return false;
  if (!context.handoffDispatchId || currentDispatchId() !== context.handoffDispatchId) return false;
  const seat = tx
    .select()
    .from(roomSessions)
    .where(
      and(eq(roomSessions.roomId, context.roomId), eq(roomSessions.authorId, context.authorId))
    )
    .get();
  const author = tx.select().from(authors).where(eq(authors.id, context.authorId)).get();
  const source = tx
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, context.sourceSessionId))
    .get();
  const native = tx
    .select()
    .from(sessionNativeBindings)
    .where(eq(sessionNativeBindings.sessionId, context.sourceSessionId))
    .get();
  const failure = latestClaudeRoomServerFailure(
    new SessionEventStore(tx as unknown as Db).readLatestTurnStrict(context.sourceSessionId),
    context.roomId
  );
  return (
    seat?.sessionId === context.sourceSessionId &&
    seat.createdAt === context.seatCreatedAt &&
    author?.kind === 'agent' &&
    author.retiredAt === null &&
    author.naturalKey === context.agentPath &&
    source?.runtime === 'claude-code' &&
    source.agentPath === context.agentPath &&
    (!native || (native.runtime === 'claude-code' && native.account === context.root)) &&
    failure?.dispatchId === context.sourceDispatchId &&
    failure.startSeq === context.startSeq &&
    failure.endSeq === context.endSeq
  );
}

/** The prepared mint and published immutable requirement must describe the same replacement. */
export function recoveryBirthMatchesInput(
  birth: RecoveryBirthContext,
  input: RecoveryLaunchInput
): boolean {
  return (
    birth.requirementId === input.id &&
    birth.destinationSessionId === input.destinationSessionId &&
    birth.sourceSessionId === input.sourceSessionId &&
    birth.sourceDispatchId === input.sourceDispatchId &&
    birth.startSeq === input.startSeq &&
    birth.endSeq === input.endSeq &&
    birth.roomId === input.roomId &&
    birth.authorId === input.authorId &&
    birth.root === input.root
  );
}

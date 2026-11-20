/** Durable destination-owned recovery constraints plus process-local pending ownership. */
import { z } from 'zod';
import { currentDispatchId } from '../../../lib/dispatch-context.js';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  and,
  eq,
  roomSessions,
  roomSessionRetirements,
  sessionMetadata,
  sessionNativeBindings,
  roomSeatLaunchRequirements,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { SessionEventStore } from '../../session/session-event-store.js';
import { latestClaudeRoomServerFailure } from '../../session/history/latest-room-failure.js';

const authoritySchema = z
  .object({
    version: z.literal(1),
    roomId: z.string().min(1),
    authorId: z.string().min(1),
    runtime: z.literal('claude-code'),
    root: z.string().min(1),
    accountId: z.string().nullable(),
    inference: z.enum(['credits', 'own-account']),
    billing: z.enum(['subscription', 'per-token']),
  })
  .strict();
/** Positively established previous-turn launch authority, without credentials. */
export type RecoveryAuthority = Omit<
  z.infer<typeof authoritySchema>,
  'version' | 'roomId' | 'authorId'
>;
/** Immutable identity used by the common mover's publication transaction. */
export interface RecoveryLaunchInput extends RecoveryAuthority {
  id: string;
  destinationSessionId: string;
  sourceSessionId: string;
  sourceDispatchId: string;
  startSeq: number;
  endSeq: number;
  roomId: string;
  authorId: string;
}
/** A validated launch restriction, including lifecycle state. */
export interface RequiredRoomLaunch extends RecoveryLaunchInput {
  state: 'pending' | 'settled' | 'refused';
}

/** Atomic publication, strict reads and ownership for this recovery path only. */
export class RequiredRoomLaunchStore {
  private readonly owners = new Map<string, { token: symbol; dispatchId: string }>();
  /** Bind this store to the app database; a new instance has no pending attempt ownership. */
  constructor(private readonly db: Db | DbTransaction) {}

  /** Strict bidirectional lookup. Aliased old metadata retains the same immutable reference. */
  forSession(sessionId: string): RequiredRoomLaunch | null {
    const marker = this.db
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, sessionId))
      .get();
    const direct = this.db
      .select()
      .from(roomSeatLaunchRequirements)
      .where(eq(roomSeatLaunchRequirements.destinationSessionId, sessionId))
      .get();
    if (!marker?.requiredLaunchId && !direct) return null;
    if (!marker?.requiredLaunchId) throw new Error('Recovery launch reference is missing.');
    const row = this.db
      .select()
      .from(roomSeatLaunchRequirements)
      .where(eq(roomSeatLaunchRequirements.id, marker.requiredLaunchId))
      .get();
    if (!row || (direct && direct.id !== row.id))
      throw new Error('Recovery launch requirement is missing.');
    const destination = this.db
      .select()
      .from(sessionMetadata)
      .where(eq(sessionMetadata.sessionId, row.destinationSessionId))
      .get();
    if (destination?.requiredLaunchId !== row.id)
      throw new Error('Recovery destination reference disagrees.');
    const authority = authoritySchema.parse(JSON.parse(row.payload));
    if (
      authority.root !== resolve(authority.root) ||
      (marker.runtime !== null && marker.runtime !== authority.runtime) ||
      (destination.runtime !== null && destination.runtime !== authority.runtime) ||
      !['pending', 'settled', 'refused'].includes(row.state)
    )
      throw new Error('Recovery launch identity disagrees.');
    return { ...authority, ...row, state: row.state };
  }

  /** Publish requirement, immutable session reference and expected binding in one transaction. */
  publish(input: RecoveryLaunchInput, currentGuardsAllow: () => boolean): symbol {
    const dispatchId = currentDispatchId();
    if (!dispatchId) throw new Error('Recovery requires an owned handoff dispatch.');
    const authority = authoritySchema.parse({
      version: 1,
      roomId: input.roomId,
      authorId: input.authorId,
      runtime: input.runtime,
      root: input.root,
      accountId: input.accountId,
      inference: input.inference,
      billing: input.billing,
    });
    if (
      !input.accountId ||
      !input.sourceDispatchId ||
      resolve(input.root) !== input.root ||
      !currentGuardsAllow()
    )
      throw new Error('Recovery launch is not allowed.');
    this.db.transaction((tx) => {
      const latest = latestClaudeRoomServerFailure(
        new SessionEventStore(tx as unknown as Db).readLatestTurnStrict(input.sourceSessionId),
        input.roomId
      );
      if (
        !latest ||
        latest.startSeq !== input.startSeq ||
        latest.endSeq !== input.endSeq ||
        latest.dispatchId !== input.sourceDispatchId ||
        !currentGuardsAllow()
      ) {
        throw new Error('The failed seat changed before recovery.');
      }
      if (
        tx
          .select()
          .from(roomSessionRetirements)
          .where(eq(roomSessionRetirements.retiredSessionId, input.destinationSessionId))
          .get()
      )
        throw new Error('Recovery destination is a retired session.');
      const destination = tx
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, input.destinationSessionId))
        .get();
      if (destination?.runtime || destination?.requiredLaunchId)
        throw new Error('Recovery destination already has an identity.');
      const createdAt = new Date().toISOString();
      tx.insert(roomSeatLaunchRequirements)
        .values({
          id: input.id,
          destinationSessionId: input.destinationSessionId,
          sourceSessionId: input.sourceSessionId,
          sourceDispatchId: input.sourceDispatchId,
          startSeq: input.startSeq,
          endSeq: input.endSeq,
          payload: JSON.stringify(authority),
          state: 'pending',
          createdAt,
        })
        .run();
      tx.insert(sessionMetadata)
        .values({ sessionId: input.destinationSessionId, requiredLaunchId: input.id, createdAt })
        .onConflictDoUpdate({
          target: sessionMetadata.sessionId,
          set: { requiredLaunchId: input.id },
        })
        .run();
      const moved = tx
        .update(roomSessions)
        .set({ sessionId: input.destinationSessionId })
        .where(
          and(
            eq(roomSessions.roomId, input.roomId),
            eq(roomSessions.authorId, input.authorId),
            eq(roomSessions.sessionId, input.sourceSessionId)
          )
        )
        .run();
      if (moved.changes !== 1) throw new Error('The room seat moved before recovery.');
    });
    const token = Symbol(randomUUID());
    this.owners.set(input.id, { token, dispatchId });
    return token;
  }

  /** Whether this exact process-owned attempt may consume a pending requirement. */
  owns(sessionId: string, token: symbol): boolean {
    const requirement = this.forSession(sessionId);
    return (
      requirement?.state === 'pending' &&
      this.owners.get(requirement.id)?.token === token &&
      this.owners.get(requirement.id)?.dispatchId === currentDispatchId()
    );
  }

  /** Read-only ownership gate used by all launch surfaces; ownership is process-local. */
  hasOwnedAttempt(sessionId: string): boolean {
    const row = this.forSession(sessionId);
    return (
      row?.state === 'pending' &&
      this.owners.get(row.id)?.dispatchId === currentDispatchId() &&
      currentDispatchId() !== undefined
    );
  }

  /** Refuse pending launches after the attempt ends; never remove immutable billing constraints. */
  refuse(sessionId: string): void {
    const row = this.forSession(sessionId);
    if (!row) return;
    this.owners.delete(row.id);
    if (row.state === 'pending')
      this.db
        .update(roomSeatLaunchRequirements)
        .set({ state: 'refused' })
        .where(eq(roomSeatLaunchRequirements.id, row.id))
        .run();
  }

  /** Native proof settles only the currently owned attempt; immutable billing remains enforced. */
  settleObserved(sessionId: string, actual: RecoveryAuthority): void {
    const row = this.forSession(sessionId);
    const owner = row ? this.owners.get(row.id) : undefined;
    if (
      !row ||
      !owner ||
      !this.hasOwnedAttempt(sessionId) ||
      actual.runtime !== row.runtime ||
      actual.root !== row.root ||
      actual.inference !== row.inference ||
      actual.billing !== row.billing ||
      actual.accountId !== row.accountId
    )
      throw new Error('Recovery native billing proof disagrees.');
    this.settle(sessionId, owner.token);
  }

  /** End all tokens belonging to this dispatch even if the database is no longer readable. */
  endOwnedAttempt(): void {
    const dispatchId = currentDispatchId();
    for (const [id, owner] of this.owners)
      if (owner.dispatchId === dispatchId) this.owners.delete(id);
  }

  /** Explicit server reauthorization requires a new current guarded dispatch, never task replay. */
  reauthorize(sessionId: string, currentGuardsAllow: () => boolean): symbol {
    const row = this.forSession(sessionId);
    const dispatchId = currentDispatchId();
    if (
      !row ||
      row.state !== 'pending' ||
      this.owners.has(row.id) ||
      !dispatchId ||
      !currentGuardsAllow()
    ) {
      throw new Error('Pending recovery cannot be reauthorized.');
    }
    const token = Symbol(randomUUID());
    this.owners.set(row.id, { token, dispatchId });
    return token;
  }

  /** Mark settled only for the owned attempt after the caller verified actual final native identity. */
  private settle(sessionId: string, token: symbol): void {
    if (!this.owns(sessionId, token))
      throw new Error('Recovery launch is not owned by this attempt.');
    const row = this.forSession(sessionId)!;
    this.db
      .update(roomSeatLaunchRequirements)
      .set({ state: 'settled' })
      .where(eq(roomSeatLaunchRequirements.id, row.id))
      .run();
    this.owners.delete(row.id);
  }

  /** Rekey constraints atomically; keep old-id tombstone and reject conflicting destination facts. */
  rekey(from: string, to: string): void {
    if (from === to) return;
    this.db.transaction((tx) => {
      const store = new RequiredRoomLaunchStore(tx as unknown as Db);
      const source = store.forSession(from);
      const destination = store.forSession(to);
      if (!source && !destination) return;
      if (!source || (destination && destination.id !== source.id))
        throw new Error('Recovery alias requirements conflict.');
      const metadata = tx
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, to))
        .get();
      const sourceMetadata = tx
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, from))
        .get();
      if (metadata && metadata.requiredLaunchId !== source.id)
        throw new Error('Recovery destination is independently occupied.');
      if (
        sourceMetadata?.agentPath &&
        metadata?.agentPath &&
        sourceMetadata.agentPath !== metadata.agentPath
      )
        throw new Error('Recovery alias agent identity conflicts.');
      const native = tx
        .select()
        .from(sessionNativeBindings)
        .where(eq(sessionNativeBindings.sessionId, to))
        .get();
      if (
        (metadata?.runtime && metadata.runtime !== source.runtime) ||
        (native && (native.runtime !== source.runtime || native.account !== source.root))
      ) {
        throw new Error('Recovery alias native identity conflicts.');
      }
      tx.insert(sessionMetadata)
        .values({ sessionId: to, requiredLaunchId: source.id, createdAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: sessionMetadata.sessionId,
          set: { requiredLaunchId: source.id },
        })
        .run();
      tx.update(roomSeatLaunchRequirements)
        .set({ destinationSessionId: to })
        .where(eq(roomSeatLaunchRequirements.id, source.id))
        .run();
    });
  }
}

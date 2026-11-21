/**
 * A person's choice, per connected app, that an agent whose turn read only that app may write
 * back to it without asking (DOR-4794, Security's threat read of 2026-11-19).
 *
 * Every read through a connected app marks the turn, because what it hands back may be someone
 * else's words, and a marked turn asks before it writes. That made every routine tracker update
 * ask. With this on, a `write`-class action back to the same app, in a turn that read nothing
 * else, runs unasked (`core/prompts/should-ask.ts`). Deletions, sends elsewhere and
 * writes to any other app still ask.
 *
 * Only a person changes it: the one writer, {@link setWritesBack}, takes a verified owner and is
 * reached only from the operator-only route `routes/connector-writes-back.ts`. No capability, MCP
 * tool or management action names it, which `same-source-writes-census.test.ts` proves.
 *
 * DorkOS can't see whether an app copies what it holds somewhere else on its own (a two-way sync
 * that posts tracker comments to a public site). So turning it on records when the person
 * confirmed it does not.
 *
 * @module services/connectors/access/writes-back-store
 */
import {
  and,
  connections,
  connectorProviderInstances,
  eq,
  isNull,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type {
  ConnectorWritesBack,
  ConnectorWritesBackChange,
} from '@dorkos/shared/connector-exclusion-schemas';
import { logger } from '../../../lib/logger.js';
import { writesBackSupported } from '../../core/prompts/writes-back-toolkits.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';

/** A connection that does not exist here, or belongs to someone else. */
export class WritesBackConnectionNotFoundError extends Error {
  /** The stable refusal code the route answers with. */
  readonly code = 'connection_not_found';

  /** Construct the refusal. */
  constructor() {
    super('Connection not found.');
    this.name = 'WritesBackConnectionNotFoundError';
  }
}

/** Turning writes back on for an app not on the list (`core/prompts/writes-back-toolkits.ts`). */
export class WritesBackUnsupportedAppError extends Error {
  /** The stable refusal code the route answers with. */
  readonly code = 'writes_back_unsupported_app';

  /** Construct the refusal. */
  constructor() {
    super(
      "Agents can't write back to this app without asking. Its changes can reach other people."
    );
    this.name = 'WritesBackUnsupportedAppError';
  }
}

/** The connection a change was made on, for the Activity line. */
export interface WritesBackConnection {
  /** The connection. */
  readonly id: string;
  /** Its app. */
  readonly toolkit: string;
  /** The name the person gave the account. */
  readonly label: string;
}

/** The owner's columns, as the provider instance stores them. */
function ownerColumns(owner: ConnectorOwnerAuthority): { ownerKind: string; ownerId: string } {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

/** The owner's live connection row, or a refusal. */
function ownedRow(db: Db | DbTransaction, owner: ConnectorOwnerAuthority, connectionId: string) {
  const expected = ownerColumns(owner);
  const row = db
    .select({
      id: connections.id,
      toolkit: connections.toolkit,
      label: connections.label,
      writesBackUnasked: connections.writesBackUnasked,
      writesBackAttestedAt: connections.writesBackAttestedAt,
      ownerKind: connectorProviderInstances.ownerKind,
      ownerId: connectorProviderInstances.ownerId,
    })
    .from(connections)
    .innerJoin(
      connectorProviderInstances,
      eq(connectorProviderInstances.id, connections.providerInstanceId)
    )
    .where(and(eq(connections.id, connectionId), isNull(connections.removedAt)))
    .get();
  if (!row || row.ownerKind !== expected.ownerKind || row.ownerId !== expected.ownerId) {
    throw new WritesBackConnectionNotFoundError();
  }
  return row;
}

/**
 * Whether writes back are on for one of the owner's connected apps.
 *
 * @param db - The connector database.
 * @param owner - The verified connection owner.
 * @param connectionId - The connection.
 * @throws {WritesBackConnectionNotFoundError} When the owner has no such live connection.
 */
export function readWritesBack(
  db: Db,
  owner: ConnectorOwnerAuthority,
  connectionId: string
): ConnectorWritesBack {
  const row = ownedRow(db, owner, connectionId);
  return {
    connectionId: row.id,
    writesBackUnasked: row.writesBackUnasked,
    writesBackAttestedAt: row.writesBackAttestedAt,
    supported: writesBackSupported(row.toolkit),
  };
}

/**
 * Turn writes back on or off for one of the owner's connected apps. Turning it on stamps when the
 * person confirmed the app copies nothing elsewhere on its own; turning it off clears the stamp.
 * Setting the state it already has changes nothing, so an earlier confirmation keeps its time.
 *
 * Only the operator-only route calls this. Never call it from anything an agent can reach.
 *
 * @param db - The connector database.
 * @param owner - The verified connection owner, from `resolveConnectorOperator`.
 * @param connectionId - The connection.
 * @param on - The person's choice.
 * @param now - The time to stamp.
 * @returns What the change did, and the connection it was made on.
 * @throws {WritesBackConnectionNotFoundError} When the owner has no such live connection.
 * @throws {WritesBackUnsupportedAppError} When turning it on for an app not on the list.
 */
export function setWritesBack(
  db: Db,
  owner: ConnectorOwnerAuthority,
  connectionId: string,
  on: boolean,
  now: Date
): { change: ConnectorWritesBackChange; connection: WritesBackConnection } {
  return db.transaction((tx) => {
    const row = ownedRow(tx, owner, connectionId);
    const connection = { id: row.id, toolkit: row.toolkit, label: row.label };
    const supported = writesBackSupported(row.toolkit);
    // Turning it off is always allowed, so a row switched on before the list existed can be cleared.
    if (on && !supported) throw new WritesBackUnsupportedAppError();
    if (row.writesBackUnasked === on) {
      return {
        connection,
        change: {
          connectionId: row.id,
          writesBackUnasked: on,
          writesBackAttestedAt: row.writesBackAttestedAt,
          supported,
          changed: false,
        },
      };
    }
    const writesBackAttestedAt = on ? now.toISOString() : null;
    tx.update(connections)
      .set({ writesBackUnasked: on, writesBackAttestedAt })
      .where(eq(connections.id, row.id))
      .run();
    return {
      connection,
      change: {
        connectionId: row.id,
        writesBackUnasked: on,
        writesBackAttestedAt,
        supported,
        changed: true,
      },
    };
  });
}

/**
 * Whether writes back are on for a connection, as the connector preflight reads it for a call it
 * has already authorized. Fails closed: an app not on the list in
 * `core/prompts/writes-back-toolkits.ts` (even with the column on), a removed connection, a
 * missing row or a failed read answers `false`, so the write keeps today's ask.
 *
 * @param db - The connector database.
 * @param connectionId - The connection the preflight just checked.
 */
export function writesBackUnaskedFor(db: Db, connectionId: string): boolean {
  try {
    const row = db
      .select({ on: connections.writesBackUnasked, toolkit: connections.toolkit })
      .from(connections)
      .where(and(eq(connections.id, connectionId), isNull(connections.removedAt)))
      .get();
    return row?.on === true && writesBackSupported(row.toolkit);
  } catch (err) {
    logger.warn('[connectors] could not read whether writes back are on; asking as usual', {
      connectionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

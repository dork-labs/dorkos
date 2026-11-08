/**
 * Leave one agent out of a connection's every-agent share (DOR-3961, spec
 * `agent-grant-autonomy`).
 *
 * An exclusion is a deny that wins over the share for one agent on one
 * connection. It never changes the share or any grant row: every read of what
 * an agent may do goes through `everyAgentGrantFor`, which checks the live
 * exclusion in the same statement, so a share made later can't reach the
 * agent. The agent's own named grants still count.
 *
 * Only a person sets or lifts one here; these methods take a verified owner,
 * and the routes that call them refuse agents and programs. On a connection
 * made through a DorkOS account the deny is local: hosted authority still
 * holds the every-agent grant, but every call is authorized here first, and an
 * excluded agent gets no grant subject to send.
 *
 * @module services/connectors/access/grant-exclusions
 */
import { ulid } from 'ulidx';
import {
  and,
  connectionGrantExclusions,
  connections,
  connectorProviderInstances,
  eq,
  isNull,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { ConnectorGrantExclusion } from '@dorkos/shared/connector-exclusion-schemas';
import {
  everyAgentActivityLink,
  serviceName,
  type EveryAgentActivitySink,
  type EveryAgentChangeWriter,
} from '../every-agent-activity.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';

/** Event type for an agent left out of, or let back into, an every-agent share. */
export const AGENT_EXCLUSION_CHANGED_EVENT = 'connectors.agent_exclusion_changed';

/** Stable refusal codes for exclusion changes. */
export type ConnectorGrantExclusionErrorCode = 'connection_not_found' | 'agent_not_found';

/** A secret-free, typed refusal from {@link ConnectorGrantExclusionService}. */
export class ConnectorGrantExclusionError extends Error {
  /**
   * Construct one typed refusal.
   *
   * @param code - Stable refusal category.
   * @param message - Person-facing safe explanation.
   */
  constructor(
    readonly code: ConnectorGrantExclusionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ConnectorGrantExclusionError';
  }
}

/** An agent this computer knows, as the exclusion list names it. */
export interface ConnectorGrantExclusionAgent {
  /** Stable registered agent id. */
  readonly id: string;
  /** Its name. */
  readonly name: string;
  /** The name a person gave it, when there is one. */
  readonly displayName?: string;
}

/** Construction options for {@link ConnectorGrantExclusionService}. */
export interface ConnectorGrantExclusionServiceOptions {
  /** Canonical connector database. */
  readonly db: Db;
  /** The agents registered now. */
  readonly agents: () => ReadonlyArray<ConnectorGrantExclusionAgent>;
  /** Activity trail; absent in a process that has none. */
  readonly activity?: EveryAgentActivitySink;
  /** Who is changing it, as honestly as DorkOS can say. */
  readonly writer: () => EveryAgentChangeWriter;
  /** Injectable clock. */
  readonly now?: () => Date;
  /** Injectable id source. */
  readonly createId?: () => string;
}

/** What one change did. */
export interface ConnectorGrantExclusionResult {
  /** The connection. */
  readonly connectionId: string;
  /** The agent. */
  readonly agentId: string;
  /** Whether the agent is left out after the change. */
  readonly excluded: boolean;
  /** False when it already was in that state. */
  readonly changed: boolean;
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

/** Sets, lifts and lists the agents left out of a connection's every-agent share. */
export class ConnectorGrantExclusionService {
  private readonly db: Db;
  private readonly agents: () => ReadonlyArray<ConnectorGrantExclusionAgent>;
  private readonly activity: EveryAgentActivitySink | undefined;
  private readonly writer: () => EveryAgentChangeWriter;
  private readonly now: () => Date;
  private readonly createId: () => string;

  /** Construct the service from current process authority. */
  constructor(options: ConnectorGrantExclusionServiceOptions) {
    this.db = options.db;
    this.agents = options.agents;
    this.activity = options.activity;
    this.writer = options.writer;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ulid;
  }

  /**
   * The agents left out of one connection's every-agent share, oldest first.
   *
   * @param owner - The verified connection owner.
   * @param connectionId - The connection.
   */
  list(owner: ConnectorOwnerAuthority, connectionId: string): ConnectorGrantExclusion[] {
    this.requireConnection(this.db, owner, connectionId);
    const names = new Map(this.agents().map((agent) => [agent.id, agent]));
    return this.db
      .select({
        agentId: connectionGrantExclusions.agentId,
        createdAt: connectionGrantExclusions.createdAt,
      })
      .from(connectionGrantExclusions)
      .where(
        and(
          eq(connectionGrantExclusions.connectionId, connectionId),
          isNull(connectionGrantExclusions.revokedAt)
        )
      )
      .orderBy(connectionGrantExclusions.createdAt)
      .all()
      .map((row) => {
        const agent = names.get(row.agentId);
        return {
          agentId: row.agentId,
          displayName: agent ? (agent.displayName ?? agent.name) : null,
          createdAt: row.createdAt,
        };
      });
  }

  /**
   * Leave one agent out of a connection's every-agent share. Setting one that
   * is already set changes nothing.
   *
   * @param owner - The verified connection owner.
   * @param connectionId - The connection.
   * @param agentId - The agent left out; must be registered here.
   */
  async leaveOut(
    owner: ConnectorOwnerAuthority,
    connectionId: string,
    agentId: string
  ): Promise<ConnectorGrantExclusionResult> {
    const agent = this.requireAgent(agentId);
    const writer = this.writer();
    const now = this.now().toISOString();
    const result = this.db.transaction((tx) => {
      const connection = this.requireConnection(tx, owner, connectionId);
      if (this.liveExclusion(tx, connectionId, agentId)) {
        return { connection, changed: false };
      }
      tx.insert(connectionGrantExclusions)
        .values({
          id: this.createId(),
          agentId,
          connectionId,
          createdBy: ownerColumns(owner).ownerId,
          createdAt: now,
        })
        .run();
      return { connection, changed: true };
    });
    if (result.changed) {
      await this.record(writer, result.connection, agent, true);
    }
    return { connectionId, agentId, excluded: true, changed: result.changed };
  }

  /**
   * Let one agent back into a connection's every-agent share. Lifting one that
   * is not set changes nothing. The agent then gets whatever the share gives
   * every agent now.
   *
   * @param owner - The verified connection owner.
   * @param connectionId - The connection.
   * @param agentId - The agent let back in.
   */
  async letBackIn(
    owner: ConnectorOwnerAuthority,
    connectionId: string,
    agentId: string
  ): Promise<ConnectorGrantExclusionResult> {
    const writer = this.writer();
    const now = this.now().toISOString();
    const result = this.db.transaction((tx) => {
      const connection = this.requireConnection(tx, owner, connectionId);
      const live = this.liveExclusion(tx, connectionId, agentId);
      if (!live) return { connection, changed: false };
      tx.update(connectionGrantExclusions)
        .set({ revokedAt: now, revokedBy: ownerColumns(owner).ownerId })
        .where(eq(connectionGrantExclusions.id, live.id))
        .run();
      return { connection, changed: true };
    });
    if (result.changed) {
      const agent = this.agents().find((candidate) => candidate.id === agentId);
      await this.record(writer, result.connection, agent ?? { id: agentId, name: agentId }, false);
    }
    return { connectionId, agentId, excluded: false, changed: result.changed };
  }

  private liveExclusion(tx: DbTransaction, connectionId: string, agentId: string) {
    return tx
      .select({ id: connectionGrantExclusions.id })
      .from(connectionGrantExclusions)
      .where(
        and(
          eq(connectionGrantExclusions.connectionId, connectionId),
          eq(connectionGrantExclusions.agentId, agentId),
          isNull(connectionGrantExclusions.revokedAt)
        )
      )
      .get();
  }

  private requireAgent(agentId: string): ConnectorGrantExclusionAgent {
    const agent = this.agents().find((candidate) => candidate.id === agentId);
    if (!agent) throw new ConnectorGrantExclusionError('agent_not_found', 'Agent not found.');
    return agent;
  }

  private requireConnection(
    db: Db | DbTransaction,
    owner: ConnectorOwnerAuthority,
    connectionId: string
  ): { id: string; toolkit: string; label: string } {
    const expected = ownerColumns(owner);
    const row = db
      .select({
        id: connections.id,
        toolkit: connections.toolkit,
        label: connections.label,
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
      throw new ConnectorGrantExclusionError('connection_not_found', 'Connection not found.');
    }
    return { id: row.id, toolkit: row.toolkit, label: row.label };
  }

  private async record(
    writer: EveryAgentChangeWriter,
    connection: { id: string; toolkit: string; label: string },
    agent: ConnectorGrantExclusionAgent,
    excluded: boolean
  ): Promise<void> {
    if (!this.activity) return;
    const app = `${serviceName(connection.toolkit)} (${connection.label})`;
    const agentName = agent.displayName ?? agent.name;
    await this.activity.emit({
      actorType: writer.actorType,
      actorLabel: writer.actorLabel,
      ...(writer.actorId ? { actorId: writer.actorId } : {}),
      category: 'permissions',
      eventType: AGENT_EXCLUSION_CHANGED_EVENT,
      resourceType: 'connection',
      resourceId: connection.id,
      resourceLabel: app,
      summary: excluded
        ? `Left ${agentName} out of sharing ${app} with every agent`
        : `Let ${agentName} back into sharing ${app} with every agent`,
      linkPath: everyAgentActivityLink(connection.id),
      metadata: { connectionId: connection.id, agentId: agent.id, excluded },
    });
  }
}

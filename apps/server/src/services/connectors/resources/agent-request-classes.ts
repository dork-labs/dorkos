/**
 * What an agent's answered request holds, by class (read, write), and how its
 * account offers each class, so a note can say plainly what is missing and
 * why (DOR-2503, DOR-3930, DOR-4193). Split out of `agent-request-service.ts`,
 * which owns the requests themselves.
 *
 * @module services/connectors/resources/agent-request-classes
 */
import {
  and,
  connectorOperationRevisions,
  connections,
  eq,
  inArray,
  type ConnectorAgentRequest,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { ConnectorRequestAccess } from '@dorkos/shared/connector-schemas';
import { everyAgentLevel } from '../execution/access-levels.js';
import { parseResolvedEventSelection, parseStringArray } from './agent-request-rows.js';
import type { ClassOffer, RequestClass } from './agent-request-messages.js';

/** The action classes a request's answer holds, and what it asked for that the answer leaves out. */
export interface GrantedClasses {
  readonly held: ReadonlySet<RequestClass>;
  readonly notGranted: RequestClass[];
  /** How the answered account offers each class, so a note can say why one is missing. */
  readonly offers: Readonly<Record<RequestClass, ClassOffer>>;
  /** It asked to hear about new activity and no updates were set up for it. */
  readonly noUpdates: boolean;
}

/** An answer with nothing recorded, for a note read without one. */
export const NOTHING_HELD: GrantedClasses = {
  held: new Set(),
  notGranted: [],
  offers: { read: 'level', write: 'level' },
  noUpdates: false,
};

/**
 * Whether an app's recorded actions hold some, and none a level can give for
 * changing things: "Read and write" there gives Read (DOR-4193). An app whose
 * actions were never read is not called read-only.
 *
 * @param db - The database to read from.
 * @param providerInstanceId - The way the app is reached.
 * @param toolkit - The app.
 */
export function appCanOnlyRead(db: Db, providerInstanceId: string, toolkit: string): boolean {
  const classes = new Set(
    db
      .selectDistinct({ classification: connectorOperationRevisions.capabilityClassification })
      .from(connectorOperationRevisions)
      .where(
        and(
          eq(connectorOperationRevisions.providerInstanceId, providerInstanceId),
          eq(connectorOperationRevisions.toolkit, toolkit)
        )
      )
      .all()
      .map((revision) => revision.classification)
  );
  return classes.size > 0 && !classes.has('write');
}

/**
 * The level facts a connection summary carries: the level every agent was
 * given, and whether the app can only be read for now.
 *
 * @param db - The database to read from.
 * @param row - The connection and the way and app it is on.
 */
export function connectionLevelFacts(
  db: Db,
  row: { connectionId: string; providerInstanceId: string; toolkit: string }
) {
  return {
    everyAgentLevel: everyAgentLevel(db, row.connectionId),
    canOnlyRead: appCanOnlyRead(db, row.providerInstanceId, row.toolkit),
  };
}

/** The classes a level covers: Read is `read`; Read and write adds `write`. */
function classesFor(access: ConnectorRequestAccess): RequestClass[] {
  return access === 'read' ? ['read'] : ['read', 'write'];
}

/** The class an action counts toward: anything that is not a read changes things. */
function requestClassOf(classification: string): RequestClass {
  return classification === 'read' ? 'read' : 'write';
}

/**
 * Compare what an agent asked for with what its answer gave it, by class
 * (read, write), never by action name (DOR-2503). A `destructive` action
 * changes things, so holding one counts as `write`. A class the answer holds
 * no action of is not granted, whatever the reason: the person chose less, the
 * app offers its change actions only one at a time, or the app has none
 * (DOR-4193). `offers` says which, so the note can tell the agent why.
 *
 * @param db - The database or open transaction to read from.
 * @param request - The answered request.
 * @param asked - The level to measure against; defaults to what the request
 *   itself asked, and a new ask is measured against the level it names.
 */
export function grantedClasses(
  db: Db | DbTransaction,
  request: ConnectorAgentRequest,
  asked: ConnectorRequestAccess = request.requestedAccess
): GrantedClasses {
  const ids = parseStringArray(request.resolvedOperationRevisionIdsJson);
  const held = new Set(
    ids.length === 0
      ? []
      : db
          .select({ classification: connectorOperationRevisions.capabilityClassification })
          .from(connectorOperationRevisions)
          .where(inArray(connectorOperationRevisions.id, ids))
          .all()
          .map((revision) => requestClassOf(revision.classification))
  );
  const account = request.resolvedConnectionId
    ? db
        .select({
          providerInstanceId: connections.providerInstanceId,
          toolkit: connections.toolkit,
        })
        .from(connections)
        .where(eq(connections.id, request.resolvedConnectionId))
        .get()
    : undefined;
  const offered = new Set(
    account
      ? db
          .selectDistinct({ classification: connectorOperationRevisions.capabilityClassification })
          .from(connectorOperationRevisions)
          .where(
            and(
              eq(connectorOperationRevisions.providerInstanceId, account.providerInstanceId),
              eq(connectorOperationRevisions.toolkit, account.toolkit)
            )
          )
          .all()
          .map((revision) => revision.classification)
      : []
  );
  return {
    held,
    notGranted: classesFor(asked).filter((kind) => !held.has(kind)),
    offers: {
      read: offered.has('read') ? 'level' : 'none',
      write: offered.has('write') ? 'level' : offered.has('destructive') ? 'exact' : 'none',
    },
    noUpdates:
      parseStringArray(request.requestedEventsJson).length > 0 &&
      !parseResolvedEventSelection(request.resolvedEventsJson).appliedEventScopeHash,
  };
}

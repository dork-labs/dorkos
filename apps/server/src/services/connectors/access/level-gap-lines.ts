/**
 * What an agent reads about the actions its access level leaves out (DOR-4678).
 *
 * Two silent gaps from the write-for-every-app change (DOR-4194, DOR-4461):
 * actions no level includes are simply not listed, and the one-time upgrade
 * moved old "Read and write" choices to "Read" with a notice only the person
 * sees. Each line here is shown only where it is true, and says what the
 * person can do, in the words the Connections page uses ("exact actions").
 * A line names "Read and write" only for an app that offers that level, by the
 * Connections page's own rule (`offersReadWrite` in the client).
 *
 * The "trashing or deleting" examples hold while deletes stay out of levels
 * (`WRITE_INCLUDES_DELETES`, DOR-4451); `level-gap-lines.test.ts` fails if
 * that flips.
 *
 * @module services/connectors/access/level-gap-lines
 */
import {
  activityEvents,
  and,
  connectionAccessLevels,
  connectionGrantExclusions,
  connections,
  connectorOperationRevisions,
  connectorReconciliationCandidates,
  connectorReconciliationPreviews,
  desc,
  eq,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  isNull,
  or,
  sql,
  type Db,
  type SQL,
} from '@dorkos/db';
import {
  isPaidOperation,
  levelIncludes,
  serviceNameFromToolkit,
  type ConnectorOperationClassification,
} from '@dorkos/shared/connector-schemas';

/** The Activity event the one-time upgrade wrote for each level it lowered. */
const WRITE_UPGRADE_EVENT = 'connectors.write_upgrade';

/** The action an agent tried, as the refusal reads it. */
interface LevelGapOperation {
  readonly toolkit: string;
  readonly operationSlug: string;
  readonly classification: ConnectorOperationClassification;
}

/**
 * Whether no access level can include an action: everything `destructive`
 * (ADR 260928-121730) and every paid action. The same rule the level presets
 * grant with (`accessLevelRevisionIds`), so this never disagrees with them.
 * Whether the person can actually pick the action is a separate question,
 * answered by {@link outsideLevelsRefusalFor} from the app's newest review.
 *
 * @param operation - The action's app, id and stored classification.
 */
export function isOutsideLevels(operation: LevelGapOperation): boolean {
  return isPaidOperation(operation) || !levelIncludes(operation.classification, 'read-write');
}

/** One action in the account's newest review, as the Connections page offers it. */
interface ReviewedAction {
  readonly operationRevisionId: string;
  readonly toolkit: string;
  readonly operationSlug: string;
  readonly classification: ConnectorOperationClassification;
  readonly supported: boolean;
}

/** The account's newest review (the snapshot the Connections page last offered), if any. */
function newestReviewId(db: Db, connectionId: string): string | undefined {
  return (
    db
      .select({ id: connectorReconciliationPreviews.id })
      .from(connectorReconciliationPreviews)
      .where(eq(connectorReconciliationPreviews.connectionId, connectionId))
      // Insertion order breaks a tie within one clock tick, as in reconciliation-service.ts.
      .orderBy(desc(connectorReconciliationPreviews.createdAt), desc(sql`rowid`))
      .limit(1)
      .get()?.id
  );
}

/** Actions of one review, narrowed by `where` in SQL. */
function reviewedActions(db: Db, previewId: string, where?: SQL): ReviewedAction[] {
  return db
    .select({
      operationRevisionId: connectorOperationRevisions.id,
      toolkit: connectorOperationRevisions.toolkit,
      operationSlug: connectorOperationRevisions.operationSlug,
      classification: connectorOperationRevisions.capabilityClassification,
      supported: connectorReconciliationCandidates.supported,
    })
    .from(connectorReconciliationCandidates)
    .innerJoin(
      connectorOperationRevisions,
      eq(connectorOperationRevisions.id, connectorReconciliationCandidates.operationRevisionId)
    )
    .where(and(eq(connectorReconciliationCandidates.previewId, previewId), where))
    .all();
}

/**
 * Whether the account offers "Read and write": it has an action that level
 * adds to "Read" (a supported, unpaid `write`), the Connections page's rule.
 * With no review yet, read from every action DorkOS knows for the account.
 *
 * @param db - The DorkOS database.
 * @param connectionId - The connection.
 */
export function offersReadWrite(db: Db, connectionId: string): boolean {
  const previewId = newestReviewId(db, connectionId);
  const writes = previewId
    ? reviewedActions(
        db,
        previewId,
        and(
          eq(connectorOperationRevisions.capabilityClassification, 'write'),
          eq(connectorReconciliationCandidates.supported, true)
        )
      )
    : knownActions(db, connectionId).filter((action) => action.classification === 'write');
  return writes.some((action) => !isPaidOperation(action));
}

/** Every action DorkOS has stored for an account, each assumed offered. */
function knownActions(db: Db, connectionId: string): ReviewedAction[] {
  return db
    .select({
      operationRevisionId: connectorOperationRevisions.id,
      toolkit: connectorOperationRevisions.toolkit,
      operationSlug: connectorOperationRevisions.operationSlug,
      classification: connectorOperationRevisions.capabilityClassification,
    })
    .from(connectorOperationRevisions)
    .innerJoin(
      connections,
      and(
        eq(connections.providerInstanceId, connectorOperationRevisions.providerInstanceId),
        eq(connections.toolkit, connectorOperationRevisions.toolkit)
      )
    )
    .where(eq(connections.id, connectionId))
    .all()
    .map((action) => ({ ...action, supported: true }));
}

/**
 * The refusal text for an action no level includes that this agent was not
 * given. It names "Read and write" only when the app offers it.
 *
 * @param toolkit - The action's app id.
 * @param readWrite - Whether the app offers "Read and write".
 */
export function outsideLevelsRefusal(toolkit: string, readWrite: boolean): string {
  const app = serviceNameFromToolkit(toolkit);
  return (
    (readWrite
      ? 'No access level includes this action, so "Read and write" doesn\'t cover it. It has to '
      : 'No access level includes this action, so it has to ') +
    `be given to this agent on its own: the person chooses it under exact actions for ${app} ` +
    'on the Connections page.'
  );
}

/**
 * The refusal for an action no level includes, or null when the person
 * couldn't pick it either (not offered, or not supported, in the account's
 * newest review), so the plain refusal stays.
 *
 * @param db - The DorkOS database.
 * @param connectionId - The connection.
 * @param operationRevisionId - The exact action tried.
 * @param operation - Its app, id and classification.
 */
export function outsideLevelsRefusalFor(
  db: Db,
  connectionId: string,
  operationRevisionId: string,
  operation: LevelGapOperation
): string | null {
  const previewId = newestReviewId(db, connectionId);
  const offered = previewId
    ? reviewedActions(
        db,
        previewId,
        and(
          eq(connectorOperationRevisions.id, operationRevisionId),
          eq(connectorReconciliationCandidates.supported, true)
        )
      )
    : [];
  if (offered.length === 0) return null;
  return outsideLevelsRefusal(operation.toolkit, offersReadWrite(db, connectionId));
}

/**
 * The note on every list of an agent's actions. True whatever the agent
 * holds: a level never includes these actions, and exact actions are how the
 * person gives one. It names "Read and write" only when the app offers it.
 *
 * @param toolkit - The account's app id.
 * @param readWrite - Whether the app offers "Read and write".
 */
export function outsideLevelsListNote(toolkit: string, readWrite: boolean): string {
  return outsideLevelsLine(
    serviceNameFromToolkit(toolkit),
    readWrite,
    "one that isn't listed here"
  );
}

/**
 * The same note for an agent the person just gave changes in an app, so it
 * doesn't take "Read and write" to mean every change (see
 * {@link outsideLevelsListNote}). Only shown where the app offers that level.
 *
 * @param app - The app's display name.
 */
export function outsideLevelsGrantedNote(app: string): string {
  return outsideLevelsLine(app, true, 'one');
}

function outsideLevelsLine(app: string, readWrite: boolean, needed: string): string {
  return (
    'Some actions, such as trashing or deleting, are never part of an access level' +
    (readWrite ? ', so "Read and write" doesn\'t cover them. ' : '. ') +
    `If you need ${needed}, ask the person to choose it for you under exact actions for ${app} ` +
    'on the Connections page.'
  );
}

/**
 * The whole note on one agent's list of actions for one account: the lowered
 * line when it applies, then what no level includes.
 *
 * @param db - The DorkOS database.
 * @param agentId - The agent.
 * @param connectionId - The connection.
 * @param toolkit - The account's app id.
 */
export function operationsListNote(
  db: Db,
  agentId: string,
  connectionId: string,
  toolkit: string
): string {
  const readWrite = offersReadWrite(db, connectionId);
  const lowered = loweredWriteLine(db, agentId, connectionId, readWrite);
  const outside = outsideLevelsListNote(toolkit, readWrite);
  return lowered ? `${lowered} ${outside}` : outside;
}

/**
 * Why this agent can no longer change things on one connection, when the
 * one-time write upgrade (DOR-4461) is the reason and still stands, or `null`.
 *
 * The level that speaks for the agent is its own when it has one (the person
 * decided for it), else the one every agent shares, unless the agent is left
 * out of sharing on this account (DOR-3961, the rule `everyAgentGrantFor`
 * applies). That level must still be the "Read" the upgrade wrote: the
 * upgrade's own Activity row for that subject and an unchanged `updatedAt`,
 * so any later choice by the person ends the line. And no level that speaks
 * for the agent may include changes. The line asks for "Read and write", so
 * it is shown only for an app that offers that level: the upgrade also
 * lowered levels on apps whose every change is paid or one at a time.
 *
 * @param db - The DorkOS database.
 * @param agentId - The agent.
 * @param connectionId - The connection.
 * @param readWrite - Whether the app offers "Read and write"; read when omitted.
 */
export function loweredWriteLine(
  db: Db,
  agentId: string,
  connectionId: string,
  readWrite: boolean = offersReadWrite(db, connectionId)
): string | null {
  if (!readWrite) return null;
  const levels = db
    .select({
      subjectType: connectionAccessLevels.subjectType,
      subjectId: connectionAccessLevels.subjectId,
      level: connectionAccessLevels.level,
      updatedAt: connectionAccessLevels.updatedAt,
      toolkit: connections.toolkit,
    })
    .from(connectionAccessLevels)
    .innerJoin(connections, eq(connections.id, connectionAccessLevels.connectionId))
    .where(
      and(
        eq(connectionAccessLevels.connectionId, connectionId),
        or(
          and(
            eq(connectionAccessLevels.subjectType, 'agent'),
            eq(connectionAccessLevels.subjectId, agentId)
          ),
          and(
            eq(connectionAccessLevels.subjectType, 'every_agent'),
            eq(connectionAccessLevels.subjectId, EVERY_AGENT_GRANT_SUBJECT_ID)
          )
        )
      )
    )
    .all();
  const own = levels.find((level) => level.subjectType === 'agent');
  const shared = isLeftOutOfSharing(db, agentId, connectionId)
    ? undefined
    : levels.find((level) => level.subjectType === 'every_agent');
  if (own?.level === 'read-write' || shared?.level === 'read-write') return null;
  const speaking = own ?? shared;
  if (!speaking || !wasLoweredByUpgrade(db, connectionId, speaking)) return null;
  const app = serviceNameFromToolkit(speaking.toolkit);
  const whose = speaking.subjectType === 'agent' ? 'your access' : 'the access every agent shares';
  return (
    `When DorkOS started allowing changes in ${app} through "Read and write", it moved ${whose} ` +
    'there from "Read and write" to "Read", and the person hasn\'t chosen again since. If you ' +
    `need to change things in ${app}, ask the person to choose "Read and write" for you on the ` +
    'Connections page.'
  );
}

/** Whether a live exclusion keeps this account's every-agent share from this agent (DOR-3961). */
function isLeftOutOfSharing(db: Db, agentId: string, connectionId: string): boolean {
  return (
    db
      .select({ id: connectionGrantExclusions.id })
      .from(connectionGrantExclusions)
      .where(
        and(
          eq(connectionGrantExclusions.agentId, agentId),
          eq(connectionGrantExclusions.connectionId, connectionId),
          isNull(connectionGrantExclusions.revokedAt)
        )
      )
      .get() !== undefined
  );
}

/** Whether this level is still exactly the "Read" the upgrade wrote for its subject. */
function wasLoweredByUpgrade(
  db: Db,
  connectionId: string,
  level: { subjectType: string; subjectId: string; level: string; updatedAt: string }
): boolean {
  if (level.level !== 'read') return false;
  return db
    .select({ occurredAt: activityEvents.occurredAt, metadata: activityEvents.metadata })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.eventType, WRITE_UPGRADE_EVENT),
        eq(activityEvents.resourceId, connectionId),
        eq(activityEvents.occurredAt, level.updatedAt)
      )
    )
    .all()
    .some((event) => {
      const subject = upgradedSubject(event.metadata);
      return subject?.subjectType === level.subjectType && subject.subjectId === level.subjectId;
    });
}

/** The subject one upgrade Activity row lowered, or null when its metadata is unreadable. */
function upgradedSubject(
  metadata: string | null
): { subjectType: string; subjectId: string } | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { subjectType?: unknown; subjectId?: unknown };
    return typeof parsed.subjectType === 'string' && typeof parsed.subjectId === 'string'
      ? { subjectType: parsed.subjectType, subjectId: parsed.subjectId }
      : null;
  } catch {
    return null;
  }
}

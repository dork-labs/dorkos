/** Fixed full-row readers cache compiled queries only; every invocation reads current SQLite rows. */
import {
  and,
  asc,
  gt,
  eq,
  sql,
  canvasDocuments,
  sessionMetadata,
  canvasDocChannels,
  canvasDocEvents,
  canvasDocGrants,
  canvasDocWriteIntents,
  type Db,
  type DbTransaction,
} from '@dorkos/db';

type Executor = Db | DbTransaction;

function preparePhysicalDocument(executor: Executor) {
  return executor
    .select()
    .from(canvasDocuments)
    .where(eq(canvasDocuments.id, sql.placeholder('documentId')))
    .prepare();
}
function prepareSourceSession(executor: Executor) {
  return executor
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, sql.placeholder('sessionId')))
    .prepare();
}
const physicalDocuments = new WeakMap<Executor, ReturnType<typeof preparePhysicalDocument>>();
const sourceSessions = new WeakMap<Executor, ReturnType<typeof prepareSourceSession>>();

/** Reuse full-row compilation only; each current physical/incarnation check executes SQL. */
export function readPreparedPhysicalDocument(executor: Executor, documentId: string) {
  let query = physicalDocuments.get(executor);
  if (!query) {
    query = preparePhysicalDocument(executor);
    physicalDocuments.set(executor, query);
  }
  return query.get({ documentId });
}
/** Every source descriptor reads the current session row through its exact scoped executor. */
export function readPreparedSourceSession(executor: Executor, sessionId: string) {
  let query = sourceSessions.get(executor);
  if (!query) {
    query = prepareSourceSession(executor);
    sourceSessions.set(executor, query);
  }
  return query.get({ sessionId });
}

function prepareChannel(executor: Executor) {
  return executor
    .select()
    .from(canvasDocChannels)
    .where(eq(canvasDocChannels.documentId, sql.placeholder('documentId')))
    .prepare();
}
function prepareGrant(executor: Executor) {
  return executor
    .select()
    .from(canvasDocGrants)
    .where(eq(canvasDocGrants.grantId, sql.placeholder('grantId')))
    .prepare();
}
function prepareIntent(executor: Executor) {
  return executor
    .select()
    .from(canvasDocWriteIntents)
    .where(eq(canvasDocWriteIntents.intentId, sql.placeholder('intentId')))
    .prepare();
}
function prepareEvent(executor: Executor) {
  return executor
    .select()
    .from(canvasDocEvents)
    .where(
      and(
        eq(canvasDocEvents.documentId, sql.placeholder('documentId')),
        eq(canvasDocEvents.eventId, sql.placeholder('eventId'))
      )
    )
    .prepare();
}
const channels = new WeakMap<Executor, ReturnType<typeof prepareChannel>>();
const grants = new WeakMap<Executor, ReturnType<typeof prepareGrant>>();
const intents = new WeakMap<Executor, ReturnType<typeof prepareIntent>>();
const events = new WeakMap<Executor, ReturnType<typeof prepareEvent>>();

/** Execute the exact channel query on the same original executor; scoped handles still retire. */
export function readPreparedChannel(executor: Executor, documentId: string) {
  let query = channels.get(executor);
  if (!query) {
    query = prepareChannel(executor);
    channels.set(executor, query);
  }
  return query.get({ documentId });
}
/** Execute the exact grant query; no previously read authority data is retained. */
export function readPreparedGrant(executor: Executor, grantId: string) {
  let query = grants.get(executor);
  if (!query) {
    query = prepareGrant(executor);
    grants.set(executor, query);
  }
  return query.get({ grantId });
}
/** Execute the exact intent query; durable row mutations remain visible on the next call. */
export function readPreparedIntent(executor: Executor, intentId: string) {
  let query = intents.get(executor);
  if (!query) {
    query = prepareIntent(executor);
    intents.set(executor, query);
  }
  return query.get({ intentId });
}
/** Execute the exact original event query without caching payloads or receipt identity. */
export function readPreparedEvent(executor: Executor, documentId: string, eventId: string) {
  let query = events.get(executor);
  if (!query) {
    query = prepareEvent(executor);
    events.set(executor, query);
  }
  return query.get({ documentId, eventId });
}

function prepareIntentPage(executor: Executor, tail: boolean) {
  return executor
    .select()
    .from(canvasDocWriteIntents)
    .where(tail ? gt(canvasDocWriteIntents.intentId, sql.placeholder('cursor')) : undefined)
    .orderBy(asc(canvasDocWriteIntents.intentId))
    .limit(100)
    .prepare();
}
const unresolvedIntentColumns = {
  intentId: canvasDocWriteIntents.intentId,
  documentId: canvasDocWriteIntents.documentId,
  eventId: canvasDocWriteIntents.eventId,
  envelopeHash: canvasDocWriteIntents.envelopeHash,
  grantId: canvasDocWriteIntents.grantId,
  sourceIdentity: canvasDocWriteIntents.sourceIdentity,
  resolvedCwd: canvasDocWriteIntents.resolvedCwd,
  treeKind: canvasDocWriteIntents.treeKind,
  canonicalPath: canvasDocWriteIntents.canonicalPath,
  operation: canvasDocWriteIntents.operation,
  input: canvasDocWriteIntents.input,
  beforeHash: canvasDocWriteIntents.beforeHash,
  afterHash: canvasDocWriteIntents.afterHash,
  expectedVersion: canvasDocWriteIntents.expectedVersion,
  evidence: canvasDocWriteIntents.evidence,
  status: canvasDocWriteIntents.status,
  errorCode: canvasDocWriteIntents.errorCode,
  createdAt: canvasDocWriteIntents.createdAt,
  updatedAt: canvasDocWriteIntents.updatedAt,
};

function prepareUnresolvedIntentPage(executor: Executor, tail: boolean) {
  return executor
    .select(unresolvedIntentColumns)
    .from(canvasDocWriteIntents)
    .where(
      sql`${canvasDocWriteIntents.status} NOT IN ('committed','no_op','conflict')
              ${tail ? sql`AND ${gt(canvasDocWriteIntents.intentId, sql.placeholder('cursor'))}` : sql``}`
    )
    .orderBy(asc(canvasDocWriteIntents.intentId))
    .limit(100)
    .prepare();
}
const intentFirstPages = new WeakMap<Executor, ReturnType<typeof prepareIntentPage>>();
const intentTailPages = new WeakMap<Executor, ReturnType<typeof prepareIntentPage>>();
const unresolvedFirstPages = new WeakMap<
  Executor,
  ReturnType<typeof prepareUnresolvedIntentPage>
>();
const unresolvedTailPages = new WeakMap<Executor, ReturnType<typeof prepareUnresolvedIntentPage>>();

/** Reuse only the fixed first/tail query plan; read every current retained row on each call. */
export function readPreparedIntentPage(executor: Executor, cursor?: string) {
  const tail = cursor !== undefined;
  const plans = tail ? intentTailPages : intentFirstPages;
  let query = plans.get(executor);
  if (!query) {
    query = prepareIntentPage(executor, tail);
    plans.set(executor, query);
  }
  return query.all(tail ? { cursor } : {});
}
/** Preserve the exact unresolved status filter and fresh complete100-row keyset page. */
export function readPreparedUnresolvedIntentPage(executor: Executor, cursor?: string) {
  const tail = Boolean(cursor);
  const plans = tail ? unresolvedTailPages : unresolvedFirstPages;
  let query = plans.get(executor);
  if (!query) {
    query = prepareUnresolvedIntentPage(executor, tail);
    plans.set(executor, query);
  }
  return query.all(tail ? { cursor } : {});
}

/** Complete fresh raw rows; original text decoders are retained alongside the fixed selection. */
export function readPreparedUnresolvedIntentValues(executor: Executor, cursor?: string) {
  const tail = Boolean(cursor);
  const plans = tail ? unresolvedTailPages : unresolvedFirstPages;
  let query = plans.get(executor);
  if (!query) {
    query = prepareUnresolvedIntentPage(executor, tail);
    plans.set(executor, query);
  }
  return query.values(tail ? { cursor } : {});
}

/** Fixed original full projection, for pure decoding reuse only; no row or admission is cached here. */
export const unresolvedIntentDecoders = Object.freeze(
  Object.entries(unresolvedIntentColumns).map(([key, column]) =>
    Object.freeze({ key, column, decode: column.mapFromDriverValue })
  )
);

/** Fixed full-row readers cache compiled queries only; every invocation reads current SQLite rows. */
import {
  and,
  eq,
  sql,
  canvasDocChannels,
  canvasDocEvents,
  canvasDocGrants,
  canvasDocWriteIntents,
  type Db,
  type DbTransaction,
} from '@dorkos/db';

type Executor = Db | DbTransaction;
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

/**
 * Cross-community room-list aggregation — ADR-0310's shape with the nouns
 * changed.
 *
 * Listing rooms across communities is the same problem session listing already
 * solved across runtimes: fan out, budget each backend, and **degrade per
 * community**. One unreachable community contributes a `warnings[]` entry and
 * zero rooms — never a failed request and never a blank list.
 *
 * @module services/communities/aggregate-community-rooms
 */
import type {
  CommunityAdapter,
  CommunityConnection,
  CommunityDescriptor,
  CommunityRoom,
  CommunityWarning,
} from '@dorkos/shared/community-adapter';
import { logger } from '../../lib/logger.js';

/**
 * Per-community listing budget: a cold or slow community must not stall the
 * list. Matches `LIST_SESSIONS_TIMEOUT_MS`.
 */
export const LIST_ROOMS_TIMEOUT_MS = 2_000;

/**
 * The disclosure shown when a `'not-admitted'` community declared none — the
 * status is required to carry one, and this is what a surface renders if a
 * backend forgets rather than rendering nothing at all.
 */
const NOT_ADMITTED_FALLBACK =
  'You are not in this community yet. Ask whoever runs it to let you in.';

/**
 * A community that did not answer inside its budget.
 *
 * A class rather than a message match: the copy a person is shown is chosen by
 * failure CLASS ({@link describeFailure}), and matching on `/timed out/` would
 * have made an adapter's own error text decide which sentence renders.
 */
class CommunityListingTimeoutError extends Error {
  /**
   * Name the budget the community failed to answer inside.
   *
   * @param ms - The budget that elapsed.
   */
  constructor(ms: number) {
    super(`listRooms timed out after ${ms}ms`);
    this.name = 'CommunityListingTimeoutError';
  }
}

/**
 * The sentence a person is shown when a community fails to list.
 *
 * **Raw error text never reaches this return value**, and the rule is not
 * stylistic. `CommunityWarning.message` is contractually "plain language,
 * already safe to render — never a raw protocol string", and the strings on the
 * other side of this boundary are written by whatever the adapter talked to: a
 * relay refusal carries the remote's own `event.message`, so passing it through
 * would let a server we do not run choose copy that renders in our cockpit. The
 * detail is not lost — it goes to the log, once, beside the community it came
 * from.
 *
 * @param error - What the listing rejected with.
 * @param label - What a person calls the community.
 */
function describeFailure(error: unknown, label: string): string {
  if (error instanceof CommunityListingTimeoutError) return `${label} took too long to answer.`;
  return `${label} could not be reached.`;
}

/** Reject `promise` if it does not settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CommunityListingTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}

/** One community's contribution to a listing: its adapter, its name, and where it stands. */
export interface CommunityListingSource {
  /** Ref, label and type — a warning has to name the community that failed. */
  descriptor: CommunityDescriptor;
  /** The adapter to list from. */
  adapter: CommunityAdapter;
  /** The last connection result, when one has been driven. */
  connection?: CommunityConnection;
}

/**
 * List rooms across the given communities in parallel and merge the results.
 *
 * Fulfilled listings merge and sort by `lastActivityAt` descending. A rejected
 * or timed-out community contributes one {@link CommunityWarning} and zero
 * rooms.
 *
 * **A `'not-admitted'` community is not an error either — it is asked for
 * nothing.** Its rooms are not listed, not even the ones it listed a minute ago,
 * and its `disclosure` is what the surface renders in their place. The
 * alternative fails in the most misleading way available: a cache that outlives
 * admission shows a person a list of rooms they can click, each of which fails
 * on read, which reads as "DorkOS is broken" rather than "you are not in this
 * one any more".
 *
 * The other three statuses deliberately do **not** suppress a listing.
 * `'unreachable'` is not evidence about membership, and a cache is the only
 * thing that makes an install readable while a host is down; `'unauthorized'`
 * carries a ban indistinguishably from an expiry, so acting on it would throw
 * away a correct cache on a re-authentication.
 *
 * **What this function does NOT do**, stated so it is not assumed: dropping the
 * cached rows themselves — and, with them, that community's message-index rows,
 * in the same transaction — belongs to the adapter that owns the cache (the
 * local-adapter ticket). Suppressing them here is the half that is enforceable
 * without a cache to delete from.
 *
 * @param opts - Aggregation inputs.
 * @param opts.communities - Each configured community, descriptor included.
 * @param opts.timeoutMs - Per-community budget; defaults to {@link LIST_ROOMS_TIMEOUT_MS}.
 */
export async function aggregateCommunityRooms(opts: {
  communities: CommunityListingSource[];
  timeoutMs?: number;
}): Promise<{ rooms: CommunityRoom[]; warnings: CommunityWarning[] }> {
  const { communities, timeoutMs = LIST_ROOMS_TIMEOUT_MS } = opts;

  const rooms: CommunityRoom[] = [];
  const warnings: CommunityWarning[] = [];

  // A community that has not admitted us is never asked: the honest thing to
  // render is "you are not in this one yet", not a spinner and not a stale list.
  const askable = communities.filter((source) => {
    if (source.connection?.status !== 'not-admitted') return true;
    warnings.push({
      community: source.descriptor.community,
      label: source.descriptor.label,
      message: source.connection.disclosure ?? NOT_ADMITTED_FALLBACK,
    });
    return false;
  });

  const results = await Promise.allSettled(
    // `Promise.resolve().then(…)` rather than calling `listRooms()` inline: an
    // adapter that throws SYNCHRONOUSLY throws before `allSettled` ever sees a
    // promise, which would take down the whole request — and with it the local
    // room list this function's caller has already computed. One community's bug
    // must cost one community's rooms, which is the entire premise here.
    askable.map((source) =>
      withTimeout(
        Promise.resolve().then(() => source.adapter.listRooms()),
        timeoutMs
      )
    )
  );

  askable.forEach((source, i) => {
    const result = results[i]!;
    if (result.status === 'fulfilled') {
      rooms.push(...result.value);
      return;
    }
    // The raw text goes here and nowhere else. See `describeFailure`.
    logger.warn('[aggregateCommunityRooms] community listing degraded', {
      community: source.descriptor.community,
      label: source.descriptor.label,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
    warnings.push({
      community: source.descriptor.community,
      label: source.descriptor.label,
      message: describeFailure(result.reason, source.descriptor.label),
    });
  });

  rooms.sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
  return { rooms, warnings };
}

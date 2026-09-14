/**
 * What the config read's last failure of this launch came back with.
 *
 * Lives beside the shell rather than inside it because it is state with a
 * lifetime of its own: the LAUNCH, not the mount. See {@link latestFailure} for
 * why that distinction is the whole point, and `AppShell`'s boot gate for what
 * it decides.
 *
 * @module app/config-failure-memory
 */
import { LAUNCH_STARTED_AT } from '@/layers/shared/lib';

/** What a failed request came back with, once the shell has read it off. */
export interface FailureFacts {
  /** The HTTP status of the reply, absent when nothing replied. */
  status?: number;
  /** The `error` field of the reply body, as `http-client.ts` puts on `message`. */
  message?: string;
  /** The `code` field of the reply body — the only thing that says WHO refused. */
  code?: string;
}

/**
 * What a failed request came back WITH: a status, the message that rode with
 * it, and the code that identifies the refusal.
 *
 * `http-client.ts` can only fill these in from a response it actually read, so
 * a status is proof that something on the other end replied. Nothing to read
 * means nothing to report: a refused connection (nothing listening on the port)
 * and the client's own 30s timeout both throw with no status at all, which is
 * the difference this shell needs.
 *
 * **A status says a reply arrived, never that DorkOS sent it.** Remote Access
 * runs through an ngrok tunnel, and a tunnel edge whose origin is dead answers
 * 502 on its own account — a real "can't reach its server" wearing a status
 * code. Proxies, captive portals and CDNs all write their own bodies too, which
 * is why the `code` travels with the message: only this server's own refusals
 * set one, and only those may ever be shown as words on the page.
 *
 * @param error - The rejection value off a TanStack query.
 */
function failureFacts(error: unknown): FailureFacts {
  const reply = error as { status?: unknown; message?: unknown; code?: unknown } | null | undefined;
  return {
    ...(typeof reply?.status === 'number' ? { status: reply.status } : {}),
    ...(typeof reply?.message === 'string' && reply.message.length > 0
      ? { message: reply.message }
      : {}),
    ...(typeof reply?.code === 'string' && reply.code.length > 0 ? { code: reply.code } : {}),
  };
}

/**
 * The config read's most recent failure THIS LAUNCH, as last seen.
 *
 * **Module scope, deliberately, and the two reasons are different.**
 *
 * First, the error object is not durable while `errorUpdatedAt` is: TanStack
 * rewinds a query with NO data to `status: 'pending'` and nulls its `error` the
 * instant the next attempt starts (`fetchState` in query-core), leaving the
 * stamp standing. That is why the gate asks the timestamp whether a failure
 * happened, and why asking the live error what KIND of failure it was answers
 * "unknown" for the length of every in-flight retry. On a screen that re-asks
 * every five seconds, reading it live is a window flipping between two different
 * full-page explanations of the same failure.
 *
 * Second, a component-scoped `useRef` would lose the answer on any remount — an
 * `AuthGuard` flip, a dev-mode remount — and hand back the unreachable screen
 * for a whole retry interval, over a server that had already replied. The fact
 * being remembered belongs to the LAUNCH, which is what `LAUNCH_STARTED_AT`
 * already keys every other half of this gate to, so it outlives any one mount.
 *
 * What is remembered is stamped with the failure it came from, and only a NEWER
 * stamp may overwrite it. Without that, a failure nobody was mounted to see —
 * its error already wiped by the retry that followed — would inherit the status
 * of the one before it and describe itself with someone else's number. Writing
 * the stamp even when the error is gone is the whole point: it says "something
 * newer failed and we could not see what", which reads out as no status, which
 * reads out as unreachable.
 *
 * Every write is derived from this render's own inputs and is idempotent, so a
 * StrictMode double render and a discarded concurrent render both leave the same
 * value behind.
 */
let lastSeenFailure: FailureFacts & { at: number } = { at: 0 };

/**
 * Forget the remembered failure. **Tests only.**
 *
 * The memory is per-LAUNCH by design, and a module lives exactly one launch in
 * the app. A test file is the one place where that is false: several launches
 * share one module, and fake timers move `Date.now()` forwards by tens of
 * seconds inside a single case, so a later test's real-clock failure can be
 * stamped BEHIND an earlier test's and be silently ignored. Resetting between
 * cases keeps each one a launch of its own, the way the app has it. Same shape
 * as `resetLegacyPromoImportForTests` in the config entity.
 */
export function resetFailureMemoryForTests(): void {
  lastSeenFailure = { at: 0 };
}

/**
 * What the latest config failure of this launch came back with, or `undefined`
 * when nothing has failed yet this launch.
 *
 * @param failedAt - `errorUpdatedAt` from the config query.
 * @param error - `error` from the same query, live and possibly already cleared.
 */
export function latestFailure(failedAt: number, error: unknown): FailureFacts | undefined {
  if (failedAt > lastSeenFailure.at) {
    lastSeenFailure =
      error === null || error === undefined
        ? { at: failedAt }
        : { at: failedAt, ...failureFacts(error) };
  }
  return failedAt > LAUNCH_STARTED_AT ? lastSeenFailure : undefined;
}

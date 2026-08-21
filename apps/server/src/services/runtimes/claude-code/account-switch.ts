/**
 * Applying a Claude account change without a server restart (spec
 * `claude-code-accounts` D5).
 *
 * Choosing a different active account, or registering/removing one, changes the
 * answer to three things that are all cached somewhere: which account a session
 * belongs to, which directories the session-list watcher watches, and which
 * sessions a connected cockpit is holding. Restarting the server would fix all
 * three; this module is why nobody has to.
 *
 * Three steps, in this order:
 *
 * 1. **Drop the derived caches.** `TranscriptReader` memoizes both session
 *    metadata (keyed by bare session id) and which account holds each session.
 *    After a switch a session's account can be one the reader has never probed,
 *    and a row cached under the old account set still names the old account.
 * 2. **Restart the session-list broadcaster.** Its watchers captured the OLD
 *    projects roots when they were constructed; `stop()` closes every iterator
 *    and its watcher, and `start()` re-resolves the roots.
 * 3. **Tell connected clients the list is stale.** Not optional: a restarted
 *    watcher emits upserts for the roots it now watches but never REMOVALS for
 *    roots it no longer watches, so a cockpit left to converge on its own shows
 *    a stale union of both account sets forever.
 *
 * @module services/runtimes/claude-code/account-switch
 */
import type { UserConfig } from '@dorkos/shared/config-schema';
import { logger } from '../../../lib/logger.js';
import { eventFanOut } from '../../core/event-fan-out.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { sessionListBroadcaster } from '../../session/session-list-broadcaster.js';
// Type-only, so this module adds no runtime dependency on the runtime facade
// (and no import cycle): the value comes out of the registry, which keys on
// `runtime.type`.
import type { ClaudeCodeRuntime } from './claude-code-runtime.js';

/**
 * The only part of the `runtimes` section this module reads — deliberately
 * narrower than `UserConfig['runtimes']`, whose every field is required, so a
 * caller (and a test) can hand over just the accounts.
 */
type RuntimesAccountView = {
  claudeCode?: {
    defaultAccount?: UserConfig['runtimes']['claudeCode']['defaultAccount'];
    accounts?: readonly UserConfig['runtimes']['claudeCode']['accounts'][number][];
  };
  /** Sibling runtime sections ride along and are deliberately not compared. */
  [otherRuntime: string]: unknown;
};

/**
 * Whether a config write changed WHERE Claude Code sessions live — the default
 * account or the registered roster.
 *
 * Compared by serialized value rather than by reference: the config manager hands
 * back fresh objects on every read, and a PATCH that rewrites a section with
 * identical contents (the cockpit saving an unchanged form) must not restart
 * every watcher. Ordering counts as a change, which is correct — the roster's
 * order decides which account wins a duplicate session id.
 *
 * An absent section reads as its defaults (`null` + `[]`), so the first write of
 * a section that was never on disk is not mistaken for a move.
 *
 * @param before - The `runtimes` section as it was before the write.
 * @param after - The `runtimes` section as it is after the write.
 * @returns True when the accounts DorkOS reads or runs in may have moved.
 */
export function claudeAccountsChanged(
  before: RuntimesAccountView | undefined,
  after: RuntimesAccountView | undefined
): boolean {
  const shape = (runtimes: RuntimesAccountView | undefined): string =>
    JSON.stringify([
      runtimes?.claudeCode?.defaultAccount ?? null,
      runtimes?.claudeCode?.accounts ?? [],
    ]);
  return shape(before) !== shape(after);
}

/**
 * Re-derive everything downstream of the Claude account set, live.
 *
 * Best-effort by design and never throws: this runs off the back of a config
 * write that has already been persisted and answered, so a failure here must
 * leave the operator with a saved setting and a stale view — recoverable with a
 * reload — rather than a failed request. Each step is isolated so one failure
 * does not skip the others.
 *
 * @returns When every step has been attempted.
 */
export async function applyClaudeAccountChange(): Promise<void> {
  // The reader lives on the Claude runtime, which is the only thing that holds
  // account-derived caches. A server booted without it (some tests, a future
  // build) simply has nothing to drop.
  const claude = runtimeRegistry
    .listRuntimes()
    .find((runtime) => runtime.type === 'claude-code') as ClaudeCodeRuntime | undefined;
  try {
    claude?.getTranscriptReader().invalidateAll();
  } catch (err) {
    logger.warn('[claude-accounts] could not drop the transcript caches', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Stop and start are caught SEPARATELY: `start()` is the half that puts
  // discovery back, so a failing `stop()` must not be able to skip it.
  try {
    await sessionListBroadcaster.stop();
  } catch (err) {
    logger.error('[claude-accounts] could not stop session-list discovery', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    // The registry doubles as the persisted-settings store, exactly as the
    // composition root wires it — without it every upsert would overwrite the
    // operator's stored permission mode in the client's cache (DOR-463).
    sessionListBroadcaster.start(runtimeRegistry.listRuntimes(), runtimeRegistry);
  } catch (err) {
    logger.error('[claude-accounts] session-list discovery did not restart', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    eventFanOut.broadcast('session_list_invalidated', { changedAt: new Date().toISOString() });
  } catch (err) {
    // warn, not debug: without this event every connected cockpit keeps showing
    // the union of the old and new account sets until someone reloads.
    logger.warn('[claude-accounts] invalidation broadcast failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('[claude-accounts] applied an account change without a restart');
}

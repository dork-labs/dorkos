/**
 * The fleet fields on a session list page (spec `claude-account-fleet` D7):
 * which account each session runs on, its live status, the work item it
 * serves, and the usage of every account the page names.
 *
 * `status` is MERGED onto whatever the session already carries, never
 * replaced, so another overlay's fields on it survive in either order.
 *
 * ## One pass, no extra I/O
 *
 * A list page is overlaid in one pass. The account id comes from the usage
 * store's memory, resolved once per distinct account folder on the page (not
 * per session); the status from this process's projectors; the limits of
 * sessions with no projector from ONE `session_limits` query for the page; and
 * the envelope's usage from one `store.peek` per runtime. Nothing here reads a
 * transcript, lists the store, or touches a credential.
 *
 * ## Which account a session runs on
 *
 * - **Claude Code:** the registered account whose folder is the one the
 *   session runs on, compared in the contract's canonical form. That folder is
 *   the runtime's in-memory answer when it has one (so a new session with no
 *   transcript yet is named too), else the session's transcript `account`. The machine's
 *   own folder is `default`, or the id of the row `default` aliases. A folder
 *   that is neither gets no `accountId`.
 * - **Codex and OpenCode** (no accounts of their own in DorkOS): `default`,
 *   and the envelope carries that runtime's `default` usage (S5 N9).
 * - Any other runtime: no `accountId`.
 *
 * @module services/session/fleet/session-fleet-overlay
 */
import {
  IMPLICIT_ACCOUNT_ID,
  LEDGER_RUNTIMES,
  type AccountUsage,
  type LedgerRuntime,
} from '@dorkos/shared/account-usage';
import type { SessionLimit } from '@dorkos/shared/schemas';
import type { SessionStatus } from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';

import { logger } from '../../../lib/logger.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { getAccountUsageStore } from '../../core/usage/current-usage-store.js';
import { projectorFor } from '../session-key-registry.js';
import { applyTrackerItems } from './flow-run-link.js';
import { withSessionLimitStore } from './session-limit-store.js';

/** The part of the account usage store the overlay reads: memory only. */
export interface FleetUsageReader {
  /**
   * Named accounts' usage from memory; `default` resolves to its alias.
   *
   * @param runtime - The accounts' runtime.
   * @param accountIds - Registry ids, or `default`.
   */
  peek(runtime: LedgerRuntime, accountIds: readonly string[]): AccountUsage[];
  /**
   * The usage of the account a session running in `root` bills, from memory;
   * `accountId` is `null` for a folder that is no account.
   *
   * @param runtime - The account's runtime.
   * @param root - The folder the session runs in.
   */
  peekByRoot(runtime: LedgerRuntime, root: string): AccountUsage;
}

/** What the overlay reads from, injectable for tests. */
export interface SessionFleetOverlayDeps {
  /** The account usage store, or `undefined` before boot wires one. */
  store: FleetUsageReader | undefined;
  /**
   * This process's projector for a session, or `undefined` when the session is
   * not live here.
   *
   * @param sessionId - The session id as the list carries it.
   */
  projectorFor: (
    sessionId: string
  ) => { getStatus(): Pick<SessionStatus, 'lifecycle' | 'limit'> } | undefined;
  /**
   * The account folder the session's runtime holds in memory for it
   * (`AgentRuntime.getSessionAccount`), or `undefined` when it names none.
   * Synchronous and never throws.
   *
   * @param session - A session on the page.
   */
  sessionAccountOf: (session: Session) => string | undefined;
  /**
   * The stored limits of the named sessions, keyed by session id, in one query.
   *
   * @param sessionIds - Sessions with no live projector.
   */
  limitsFor: (sessionIds: readonly string[]) => ReadonlyMap<string, { limit: SessionLimit }>;
  /**
   * Set `trackerItem` on every session a flow run names, in place.
   *
   * @param page - The sessions about to be returned.
   */
  applyTrackerItems: (page: Session[]) => Promise<void>;
}

/** Runtimes whose `getSessionAccount` threw, so each is logged once per process. */
const warnedAccountRuntimes = new Set<string>();

/** The server's own collaborators for {@link applySessionFleetOverlay}. */
export function sessionFleetOverlayDeps(): SessionFleetOverlayDeps {
  return {
    store: getAccountUsageStore(),
    projectorFor,
    sessionAccountOf: (session) => {
      if (!session.runtime || !runtimeRegistry.has(session.runtime)) return undefined;
      try {
        return runtimeRegistry.get(session.runtime).getSessionAccount?.(session.id);
      } catch (err) {
        // The contract says it never throws; one that does costs only the
        // in-memory answer, and the transcript's folder is used instead.
        if (!warnedAccountRuntimes.has(session.runtime)) {
          warnedAccountRuntimes.add(session.runtime);
          logger.warn(
            "[session-fleet-overlay] a runtime could not name a session's account; using the transcript's",
            {
              runtime: session.runtime,
              sessionId: session.id,
              err: err instanceof Error ? err.message : String(err),
            }
          );
        }
        return undefined;
      }
    },
    limitsFor: (ids) =>
      withSessionLimitStore('list page limits', (store) => store.getMany(ids)) ?? new Map(),
    applyTrackerItems,
  };
}

function isLedgerRuntime(runtime: string | undefined): runtime is LedgerRuntime {
  return (LEDGER_RUNTIMES as readonly string[]).includes(runtime ?? '');
}

/**
 * Put `accountId`, `status` and `trackerItem` on each session of a list page,
 * in place, and return the usage of the accounts the page names.
 *
 * A failure in one part (the limit table, the flow file) costs that part only:
 * the page is still returned.
 *
 * @param page - The sessions about to be returned.
 * @param deps - Where to read from ({@link sessionFleetOverlayDeps}).
 * @returns The usage of each distinct account on the page, or `undefined` when
 *   the page names none (or no store is wired).
 */
export async function applySessionFleetOverlay(
  page: Session[],
  deps: SessionFleetOverlayDeps
): Promise<AccountUsage[] | undefined> {
  const { store } = deps;
  const idsByRuntime = new Map<LedgerRuntime, Set<string>>();
  const idByRoot = new Map<string, string | undefined>();
  const withoutProjector: Session[] = [];

  for (const session of page) {
    if (store && isLedgerRuntime(session.runtime)) {
      let accountId: string | undefined;
      if (session.runtime !== 'claude-code') {
        accountId = IMPLICIT_ACCOUNT_ID;
      } else {
        const root = deps.sessionAccountOf(session) ?? session.account;
        if (root) {
          // A registered row, `default` for the machine's own folder (or the
          // row `default` aliases), else no id.
          if (!idByRoot.has(root)) {
            idByRoot.set(root, store.peekByRoot('claude-code', root).accountId ?? undefined);
          }
          accountId = idByRoot.get(root);
        }
      }
      if (accountId !== undefined) {
        session.accountId = accountId;
        let ids = idsByRuntime.get(session.runtime);
        if (!ids) idsByRuntime.set(session.runtime, (ids = new Set()));
        ids.add(accountId);
      }
    }

    const projector = deps.projectorFor(session.id);
    if (projector) {
      const { lifecycle, limit } = projector.getStatus();
      session.status = { ...session.status, lifecycle, limit };
    } else {
      withoutProjector.push(session);
    }
  }

  if (withoutProjector.length > 0) {
    const limits = deps.limitsFor(withoutProjector.map((s) => s.id));
    for (const session of withoutProjector) {
      const stored = limits.get(session.id);
      // Not live in this process, so idle; the limit it last hit still stands.
      if (stored) session.status = { ...session.status, lifecycle: 'idle', limit: stored.limit };
    }
  }

  try {
    await deps.applyTrackerItems(page);
  } catch (err) {
    logger.warn('[session-fleet-overlay] could not read the flow runs for a session list', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (!store || idsByRuntime.size === 0) return undefined;
  const usage: AccountUsage[] = [];
  for (const [runtime, ids] of idsByRuntime) usage.push(...store.peek(runtime, [...ids]));
  return usage.length > 0 ? usage : undefined;
}

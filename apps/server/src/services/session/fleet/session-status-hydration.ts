/**
 * Fills a session's status from caches the moment it opens, and keeps it in
 * step afterwards (spec `claude-account-fleet` §6 U).
 *
 * Two things are cached, at two scopes:
 *
 * - **Account usage is account-wide.** A new projector is stamped with its
 *   account's `accountUsage` from the usage store's memory, so the first
 *   snapshot carries it before any turn, for one account as for many. For
 *   Claude Code the session's subscription `usage` is derived from the same
 *   record. When the store changes, every live projector on that account is
 *   updated IN MEMORY: nothing is written to any session's event stream, so an
 *   idle log-backed session (which persists every event) never accumulates
 *   usage rows. Clients learn of the change from the global `account_usage`
 *   event. A launch that settles a session's account re-stamps it, because a
 *   new session's per-send account hint is only known at its first send, and
 *   each turn's end resolves it again, once the session is bound for certain.
 * - **Context usage is per session.** A new projector with no reading takes the
 *   session's stored one from `session_context`; with no row it asks the
 *   runtime once for the reading in its own record and stores it. Each turn
 *   that ends with a context reading writes it through.
 *
 * @module services/session/fleet/session-status-hydration
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { withAccountSubscription, type AccountUsage } from '@dorkos/shared/account-usage';
import { logger } from '../../../lib/logger.js';
import type { AccountUsageStore } from '../../core/usage/account-usage-store.js';
import {
  listLiveProjectors,
  onProjectorTurnBoundary,
  peekProjector,
  setProjectorHydrator,
  type SessionStateProjector,
} from '../session-state-projector.js';
import {
  billingAccountFor,
  isSameAccount,
  peekBillingUsage,
  type SessionBilling,
} from './session-account.js';
import {
  contextUsageOfReading,
  type SessionContextReading,
  type SessionContextStore,
} from './session-context-store.js';

/** What the hydration reads from. */
export interface SessionStatusHydrationDeps {
  /** The account usage store, when one is installed. */
  usageStore: () => AccountUsageStore | undefined;
  /** Stored context readings; without it context usage is not cached. */
  contextStore?: SessionContextStore;
  /** The runtime a session runs on, or `undefined` when it cannot be resolved. */
  resolveRuntime: (sessionId: string) => Promise<AgentRuntime | undefined>;
  /** A session's working directory when its projector has none stamped. */
  resolveCwd: (sessionId: string) => Promise<string>;
  /** Clock seam. */
  now?: () => Date;
}

/** The installed hydration's handles. */
export interface SessionStatusHydration {
  /**
   * A launch settled which folder a Claude Code session runs on: re-stamp its
   * account usage from that account.
   */
  noteAccountLaunched(sessionId: string, root: string, perToken: boolean): void;
  /** Uninstall every hook. */
  dispose(): void;
}

/**
 * Install the hydrator on the projector registry and the listeners that keep
 * live sessions in step. Call once at boot, after the usage store and the
 * database exist.
 *
 * @param deps - See {@link SessionStatusHydrationDeps}.
 */
export function installSessionStatusHydration(
  deps: SessionStatusHydrationDeps
): SessionStatusHydration {
  const now = deps.now ?? (() => new Date());
  /** The account each live projector bills (keyed by instance, so a rekey carries it). */
  const billing = new WeakMap<SessionStateProjector, SessionBilling>();
  /** The context reading last written for each projector, to skip rewriting it. */
  const written = new WeakMap<SessionStateProjector, string>();

  /**
   * Put an account's usage on a projector, and for a Claude Code session on a
   * subscription its derived `usage`. A session billed per token keeps its own
   * pay-as-you-go `usage`: its folder's windows are not what it pays.
   */
  const stamp = (
    projector: SessionStateProjector,
    account: AccountUsage,
    bill: SessionBilling
  ): void => {
    projector.seedStatus({
      accountUsage: account,
      ...(account.runtime === 'claude-code' && bill.perToken === false
        ? { usage: withAccountSubscription(projector.getStatus().usage, account) }
        : {}),
    });
  };

  const stampFromStore = (projector: SessionStateProjector, bill: SessionBilling): void => {
    const store = deps.usageStore();
    if (!store) return;
    const account = peekBillingUsage(store, bill);
    if (account) stamp(projector, account, bill);
  };

  const hydrateContext = async (
    projector: SessionStateProjector,
    runtime: AgentRuntime,
    cwd: string
  ): Promise<void> => {
    const contextStore = deps.contextStore;
    if (!contextStore || projector.getStatus().contextUsage !== null) return;
    const sessionId = projector.sessionId;
    let reading = contextStore.get(sessionId);
    if (!reading && runtime.readContextUsage) {
      const derived = await runtime.readContextUsage(sessionId, cwd);
      if (derived && derived.contextTokens > 0) {
        // Insert-only: a turn that ended while this was reading wrote a newer
        // reading, and a derived one must never replace it.
        reading = contextStore.putIfAbsent(projector.sessionId, {
          ...derived,
          observedAt: now().toISOString(),
        });
      }
    }
    if (reading) projector.seedStatus({ contextUsage: contextUsageOfReading(reading) });
  };

  setProjectorHydrator(async (projector) => {
    const runtime = await deps.resolveRuntime(projector.sessionId);
    if (!runtime) return;
    const cwd = projector.cwd ?? (await deps.resolveCwd(projector.sessionId));
    const bill = await billingAccountFor(runtime, projector.sessionId, cwd);
    if (bill) {
      // A launch may have landed while the account was being resolved; its
      // answer is the newer one.
      if (!billing.has(projector)) billing.set(projector, bill);
      stampFromStore(projector, billing.get(projector)!);
    }
    await hydrateContext(projector, runtime, cwd);
  });

  /**
   * Resolve the account again once a turn has ended. A projector minted before
   * its session was bound (a brand-new session's first send) was resolved by
   * inference, and by now the binding row and the launch both say for certain.
   */
  const rebill = async (projector: SessionStateProjector): Promise<void> => {
    const runtime = await deps.resolveRuntime(projector.sessionId);
    if (!runtime) return;
    const cwd = projector.cwd ?? (await deps.resolveCwd(projector.sessionId));
    const bill = await billingAccountFor(runtime, projector.sessionId, cwd);
    if (!bill) {
      billing.delete(projector);
      return;
    }
    billing.set(projector, bill);
    stampFromStore(projector, bill);
  };

  const offStore = deps.usageStore()?.onChange((changed) => {
    const store = deps.usageStore();
    if (!store) return;
    for (const projector of listLiveProjectors()) {
      const bill = billing.get(projector);
      if (!bill || bill.runtime !== changed.runtime) continue;
      const account = peekBillingUsage(store, bill);
      if (account && isSameAccount(account, changed)) stamp(projector, account, bill);
    }
  });

  const offBoundary = onProjectorTurnBoundary((sessionId, kind) => {
    if (kind !== 'turn_end') return;
    const projector = peekProjector(sessionId);
    if (projector) {
      void rebill(projector).catch((err: unknown) => {
        logger.debug('[session-status] could not re-resolve a session account', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
    if (!deps.contextStore) return;
    const usage = projector?.getStatus().contextUsage;
    if (!projector || !usage || usage.totalTokens <= 0) return;
    const reading: SessionContextReading = {
      contextTokens: usage.totalTokens,
      contextMaxTokens: usage.maxTokens,
      observedAt: usage.observedAt ?? now().toISOString(),
    };
    const key = readingKey(reading);
    if (written.get(projector) === key) return;
    try {
      deps.contextStore.put(projector.sessionId, reading);
      written.set(projector, key);
    } catch (err) {
      logger.warn('[session-status] could not store a context reading', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return {
    noteAccountLaunched(sessionId, root, perToken) {
      const projector = peekProjector(sessionId);
      if (!projector) return;
      const bill: SessionBilling = { runtime: 'claude-code', root, perToken };
      billing.set(projector, bill);
      stampFromStore(projector, bill);
    },
    dispose() {
      setProjectorHydrator(undefined);
      offStore?.();
      offBoundary();
    },
  };
}

function readingKey(reading: SessionContextReading): string {
  return `${reading.contextTokens}:${reading.contextMaxTokens}:${reading.observedAt}`;
}

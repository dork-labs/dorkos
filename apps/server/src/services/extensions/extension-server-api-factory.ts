/**
 * Factory for building a {@link DataProviderContext} per server-side extension.
 *
 * Each extension gets isolated secrets, scoped storage, interval scheduling
 * with a 5-second floor, namespaced SSE event emission via {@link eventFanOut},
 * the DorkOS data directory, read access to the agent accounts DorkOS knows
 * with the account advisor seam (spec `claude-account-fleet` §6 X1-X3), and the
 * projects core knows, scoped to the extension (spec `flow-multiproject` §6.1).
 *
 * @module services/extensions/extension-server-api-factory
 */
import { z } from 'zod';
import type {
  AccountSummary,
  AccountsApi,
  DataProviderContext,
} from '@dorkos/extension-api/server';
import { LEDGER_RUNTIMES, type LedgerRuntime } from '@dorkos/shared/account-usage';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import { ExtensionSettingsStore } from '@dorkos/shared/extension-settings';
import { eventFanOut } from '../core/event-fan-out.js';
import { registerAccountAdvisor, toExtensionAccountUsage } from '../core/usage/account-advisor.js';
import { getAccountUsageStore } from '../core/usage/current-usage-store.js';
import { recordContinuation } from '../core/usage/session-continuation.js';
import { createProjectsApi } from '../projects/extension-projects-api.js';
import { projectRegistry } from '../projects/project-registry.js';
import {
  createInboxApi,
  createProjectSettingsReader,
  createRequirePerson,
} from './inbox/extension-inbox-context.js';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../lib/logger.js';

/** Minimum scheduling interval in seconds (prevents tight loops). */
const MIN_INTERVAL_SECONDS = 5;

const ContinuationSchema = z.object({
  sourceSessionId: z.string().min(1),
  to: z.object({
    sessionId: z.string().min(1),
    runtime: z.string().min(1),
    accountId: z.string().min(1),
  }),
});

function isLedgerRuntime(runtime: string): runtime is LedgerRuntime {
  return (LEDGER_RUNTIMES as readonly string[]).includes(runtime);
}

/**
 * Build one extension's {@link AccountsApi}. Every listener and advisor it
 * registers is tracked, so `release` removes them when the extension shuts
 * down or reloads, whether or not its own cleanup did.
 *
 * After `release` the API is closed: `onUsage` and `registerAdvisor` throw and
 * register nothing, and `markContinued` rejects. A shut-down or replaced
 * instance can still have work in flight (a `.then(() => registerAdvisor(…))`
 * that resolves after the reload), and that late call must never leak a
 * listener or replace the new instance's advisor. `list` and `usage` keep
 * answering; they only read.
 */
function createAccountsApi(extensionId: string): { accounts: AccountsApi; release: () => void } {
  const releases = new Set<() => void>();
  let released = false;

  function assertOpen(method: string): void {
    if (released) {
      throw new Error(
        `accounts.${method} was called after the extension "${extensionId}" shut down or reloaded.`
      );
    }
  }

  function track(remove: () => void): () => void {
    let removed = false;
    const once = () => {
      if (removed) return;
      removed = true;
      releases.delete(once);
      remove();
    };
    releases.add(once);
    return once;
  }

  const accounts: AccountsApi = {
    async list(): Promise<AccountSummary[]> {
      const store = getAccountUsageStore();
      if (!store) return [];
      return store.listAccounts().map((a) => ({
        runtime: a.runtime,
        id: a.id,
        label: a.label,
        color: a.color,
        implicit: a.implicit,
      }));
    },
    async usage(runtime) {
      const store = getAccountUsageStore();
      if (!store) return [];
      if (runtime !== undefined && !isLedgerRuntime(runtime)) return [];
      return (runtime === undefined ? store.list() : store.list(runtime)).map(
        toExtensionAccountUsage
      );
    },
    onUsage(listener) {
      assertOpen('onUsage');
      if (typeof listener !== 'function') {
        throw new TypeError('accounts.onUsage needs a listener function.');
      }
      const store = getAccountUsageStore();
      if (!store) {
        logger.debug(`[ext:${extensionId}] account usage is not available; onUsage is inert`);
        return () => {};
      }
      return track(store.onChange((usage) => listener(toExtensionAccountUsage(usage))));
    },
    async markContinued(sourceSessionId, to) {
      assertOpen('markContinued');
      const parsed = ContinuationSchema.safeParse({ sourceSessionId, to });
      if (!parsed.success) {
        throw new TypeError(
          'accounts.markContinued needs a source session id and { sessionId, runtime, accountId }.'
        );
      }
      await recordContinuation(extensionId, parsed.data.sourceSessionId, parsed.data.to);
    },
    registerAdvisor(advisor) {
      assertOpen('registerAdvisor');
      return track(registerAccountAdvisor(extensionId, advisor));
    },
  };

  return {
    accounts,
    release: () => {
      released = true;
      for (const remove of [...releases]) {
        try {
          remove();
        } catch (err) {
          logger.warn(`[ext:${extensionId}] releasing an account listener failed:`, err);
        }
      }
    },
  };
}

/** Dependencies required to build a {@link DataProviderContext}. */
interface CreateContextDeps {
  extensionId: string;
  extensionDir: string;
  dorkHome: string;
  /** The manifest name, which inbox rows, pushes and the person bar say. Defaults to the id. */
  extensionName?: string;
}

/**
 * Build a {@link DataProviderContext} for a server-side extension.
 *
 * Each extension gets its own isolated context with:
 * - Scoped encrypted secret store
 * - Persistent JSON storage with atomic writes (tmp + rename)
 * - Interval-based scheduler with a 5-second minimum floor
 * - SSE event emitter via EventFanOut with `ext:{id}:{event}` namespace
 * - The resolved DorkOS data directory (`dorkHome`)
 * - `accounts`: the agent accounts, their usage, and the account advisor seam
 * - `projects`: the projects core knows, scoped to this extension
 * - `inbox`: decisions in the Activity inbox (spec `flow-multiproject` §7)
 * - `requirePerson`: the person bar for the extension's own routes
 * - `projectSettings`: per-project settings only a person writes, read-only here
 *
 * @param deps - Extension identity and directory info
 * @returns The context, a function to retrieve scheduled cleanup functions, and
 *   `releaseListeners`, which removes every usage listener, advisor and project
 *   change listener the extension registered (called on shutdown and reload)
 */
export function createDataProviderContext(deps: CreateContextDeps): {
  ctx: DataProviderContext;
  getScheduledCleanups: () => Array<() => void>;
  releaseListeners: () => void;
  dispose: () => void;
} {
  const scheduledCleanups: Array<() => void> = [];
  const { extensionId, extensionDir, dorkHome } = deps;
  // Set when this instance was given up on (its `register()` never finished):
  // whatever it still does afterwards must start nothing (see `dispose`).
  let disposed = false;
  let toldDisposed = false;
  const inert = (what: string): (() => void) => {
    if (!toldDisposed) {
      toldDisposed = true;
      logger.warn(
        `[ext:${extensionId}] ${what} was called after DorkOS stopped waiting for this ` +
          `extension to start; it does nothing. Reload the extension to try again.`
      );
    }
    return () => undefined;
  };

  const secrets = new ExtensionSecretStore(extensionId, dorkHome);
  const settings = new ExtensionSettingsStore(dorkHome, extensionId);

  const dataPath = path.join(dorkHome, 'extension-data', extensionId, 'data.json');

  const storage = {
    async loadData<T = unknown>(): Promise<T | null> {
      try {
        const raw = await fs.readFile(dataPath, 'utf-8');
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async saveData<T = unknown>(data: T): Promise<void> {
      await writeFileAtomic(dataPath, JSON.stringify(data, null, 2));
    },
  };

  function schedule(intervalSeconds: number, fn: () => Promise<void>): () => void {
    if (disposed) return inert('ctx.schedule');
    const clamped = Math.max(intervalSeconds, MIN_INTERVAL_SECONDS);
    const interval = setInterval(() => {
      fn().catch((err) => {
        logger.error(`[ext:${extensionId}] Scheduled task error:`, err);
      });
    }, clamped * 1000);
    const cancel = () => clearInterval(interval);
    scheduledCleanups.push(cancel);
    return cancel;
  }

  function emit(event: string, data: unknown): void {
    eventFanOut.broadcast(`ext:${extensionId}:${event}`, data);
  }

  const extensionName = deps.extensionName ?? extensionId;
  const { accounts, release: releaseAccounts } = createAccountsApi(extensionId);
  const { projects, release: releaseProjects } = createProjectsApi(extensionId, projectRegistry);
  const { inbox, release: releaseInbox } = createInboxApi(extensionId, extensionName);
  const { projectSettings, release: releaseProjectSettings } = createProjectSettingsReader(
    extensionId,
    dorkHome
  );

  // Every way this instance can start something that outlives the call.
  const guardedAccounts = accounts && {
    ...accounts,
    onUsage: (listener: Parameters<typeof accounts.onUsage>[0]) =>
      disposed ? inert('accounts.onUsage') : accounts.onUsage(listener),
    registerAdvisor: (advisor: Parameters<typeof accounts.registerAdvisor>[0]) =>
      disposed ? inert('accounts.registerAdvisor') : accounts.registerAdvisor(advisor),
  };
  const guardedProjects = {
    ...projects,
    onChange: (listener: Parameters<typeof projects.onChange>[0]) =>
      disposed ? inert('projects.onChange') : projects.onChange(listener),
  };
  const guardedInbox = inbox && {
    ...inbox,
    onAction: (handler: Parameters<typeof inbox.onAction>[0]) =>
      disposed ? inert('inbox.onAction') : inbox.onAction(handler),
  };
  const guardedProjectSettings = {
    ...projectSettings,
    onChange: (listener: Parameters<typeof projectSettings.onChange>[0]) =>
      disposed ? inert('projectSettings.onChange') : projectSettings.onChange(listener),
  };

  const ctx: DataProviderContext = {
    secrets,
    settings,
    storage,
    schedule,
    emit,
    extensionId,
    extensionDir,
    dorkHome,
    accounts: guardedAccounts,
    projects: guardedProjects,
    inbox: guardedInbox,
    requirePerson: createRequirePerson(extensionName),
    projectSettings: guardedProjectSettings,
  };

  const releaseListeners = () => {
    releaseAccounts();
    releaseProjects();
    releaseInbox();
    releaseProjectSettings();
  };

  return {
    ctx,
    getScheduledCleanups: () => [...scheduledCleanups],
    releaseListeners,
    /**
     * Give up on this instance: cancel what it scheduled, release what it
     * registered, and make every later `schedule` or listener registration a
     * no-op (logged once). For a `register()` DorkOS stopped waiting for, which
     * may still run on in the background (`extension-server-lifecycle.ts`).
     */
    dispose: () => {
      disposed = true;
      for (const cancel of scheduledCleanups.splice(0)) {
        try {
          cancel();
        } catch {
          /* swallow cancellation errors */
        }
      }
      releaseListeners();
    },
  };
}

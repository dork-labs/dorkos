/**
 * Factory for building a {@link DataProviderContext} per server-side extension.
 *
 * Each extension gets isolated secrets, scoped storage, interval scheduling
 * with a 5-second floor, and namespaced SSE event emission via {@link eventFanOut}.
 *
 * @module services/extensions/extension-server-api-factory
 */
import type { DataProviderContext } from '@dorkos/extension-api/server';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import { ExtensionSettingsStore } from '@dorkos/shared/extension-settings';
import { eventFanOut } from '../core/event-fan-out.js';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../../lib/logger.js';

/** Minimum scheduling interval in seconds (prevents tight loops). */
const MIN_INTERVAL_SECONDS = 5;

/** Dependencies required to build a {@link DataProviderContext}. */
interface CreateContextDeps {
  extensionId: string;
  extensionDir: string;
  dorkHome: string;
}

/**
 * Build a {@link DataProviderContext} for a server-side extension.
 *
 * Each extension gets its own isolated context with:
 * - Scoped encrypted secret store
 * - Persistent JSON storage with atomic writes (tmp + rename)
 * - Interval-based scheduler with a 5-second minimum floor
 * - SSE event emitter via EventFanOut with `ext:{id}:{event}` namespace
 *
 * @param deps - Extension identity and directory info
 * @returns Object with the context and a function to retrieve scheduled cleanup functions
 */
export function createDataProviderContext(deps: CreateContextDeps): {
  ctx: DataProviderContext;
  getScheduledCleanups: () => Array<() => void>;
} {
  const scheduledCleanups: Array<() => void> = [];
  const { extensionId, extensionDir, dorkHome } = deps;

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

  const ctx: DataProviderContext = {
    secrets,
    settings,
    storage,
    schedule,
    emit,
    extensionId,
    extensionDir,
  };

  return {
    ctx,
    getScheduledCleanups: () => [...scheduledCleanups],
  };
}

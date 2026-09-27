/**
 * The kept app list: each connection service's whole catalog, held in memory
 * and on disk so paging, search and the agent lookup stop re-listing it.
 *
 * Before this, every catalog page (24 apps) and every search asked each
 * service for its whole list again — about 850 Composio apps at 100 per call,
 * so ~9 upstream calls per page. Now each service is listed at most once per
 * {@link DEFAULT_FRESH_FOR_MS}:
 *
 * - **Fresh** (younger than a day): served straight from the kept copy.
 * - **Stale**: still served, while one background refresh replaces it. A failed
 *   refresh keeps the old copy and is not retried for {@link RETRY_AFTER_FAILURE_MS}.
 * - **None yet**: the reader waits for the refresh. A failure propagates, so the
 *   caller reports it as a per-service warning — never a silent empty list
 *   (DOR-703).
 *
 * Concurrent readers share one refresh per service (single-flight). The
 * refresh runs under its own deadline, not a reader's signal, so one reader
 * giving up never cancels the listing every other reader is waiting on; each
 * reader stops waiting when its own signal fires.
 *
 * Every copy is bound to a fingerprint of the service's setup (the registry's
 * secret-free execution-config digest, hashed once more here). A copy made
 * under a different key or setup is never served, and the registry drops the
 * copy outright when it unregisters the service.
 *
 * The provider-neutral layer is deliberate: the cache sits under the registry,
 * over the `ConnectorProvider` port's own paging, so Composio, Nango, the
 * DorkOS account and every future service share one policy.
 *
 * The file under `<dorkHome>/cache/connectors/catalog/` holds only validated
 * `ConnectorToolkit` entries — no keys, no accounts — and is safe to delete. A
 * corrupt, foreign or unknown-version file is ignored and rebuilt.
 *
 * @module services/connectors/resources/catalog-cache
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  ConnectorToolkitSchema,
  type ConnectorProvider,
  type ConnectorToolkit,
} from '@dorkos/shared/connector-provider';
import type { ConnectorUnsupportedResult } from '@dorkos/shared/connector-schemas';
import { logger, logError } from '../../../lib/logger.js';

/** How long a kept app list counts as fresh: one day. */
export const DEFAULT_FRESH_FOR_MS = 24 * 60 * 60 * 1000;

/** The deadline one shared refresh runs under, independent of any reader. */
const DEFAULT_REFRESH_TIMEOUT_MS = 60_000;

/** After a failed background refresh, keep serving the old copy this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 60_000;

/** Apps asked for per provider page. */
const CATALOG_PAGE_SIZE = 100;

/** Pages read before a listing is kept as truncated (10,000 apps). */
const CATALOG_PAGE_LIMIT = 100;

const CATALOG_FILE_VERSION = 1;

const KeptCatalogFileSchema = z.object({
  version: z.literal(CATALOG_FILE_VERSION),
  setupKey: z.string().length(64),
  fetchedAt: z.number().int().nonnegative(),
  truncated: z.boolean(),
  toolkits: z.array(ConnectorToolkitSchema),
});
type KeptCatalog = z.infer<typeof KeptCatalogFileSchema>;

/** One service's kept app list, or the service's own statement that it has none. */
export type KeptCatalogRead =
  | {
      status: 'ok';
      /** Every app the service lists, exactly as validated on the way in. */
      toolkits: readonly ConnectorToolkit[];
      /** True when the service listed more apps than DorkOS keeps. */
      truncated: boolean;
    }
  | ConnectorUnsupportedResult;

/** Construction options for {@link ConnectorCatalogCache}. */
export interface ConnectorCatalogCacheOptions {
  /**
   * Directory for the on-disk copies, resolved from dorkHome
   * (`<dorkHome>/cache/connectors/catalog`). Omitted: memory only.
   */
  readonly dir?: string;
  /** Override the one-day freshness window. */
  readonly freshForMs?: number;
  /** Override the deadline a shared refresh runs under. */
  readonly refreshTimeoutMs?: number;
  /** Clock seam for tests. */
  readonly now?: () => number;
}

interface RefreshRecord {
  readonly setupKey: string;
  /** Identifies this refresh, so one a drop or newer setup replaced never stores its answer. */
  readonly ticket: symbol;
  readonly promise: Promise<KeptCatalogRead>;
}

/** Hash the registry's setup digest again so the file never carries it verbatim. */
function setupKeyFor(configDigest: string): string {
  return createHash('sha256').update(`dorkos:connector-catalog:${configDigest}`).digest('hex');
}

/** Filesystem-safe file name for one provider instance. */
function fileNameFor(instanceId: string): string {
  return `${createHash('sha256').update(instanceId).digest('hex')}.json`;
}

/** Stop waiting when `signal` fires, without cancelling the shared work. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/** Page through one provider's whole account-free catalog. */
async function listWholeCatalog(
  provider: ConnectorProvider,
  signal: AbortSignal
): Promise<KeptCatalogRead> {
  const toolkits: ConnectorToolkit[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < CATALOG_PAGE_LIMIT; pageIndex += 1) {
    signal.throwIfAborted();
    const page = await provider.listToolkitPage({
      ...(cursor ? { cursor } : {}),
      limit: CATALOG_PAGE_SIZE,
      signal,
    });
    if (page.status === 'unsupported') return page;
    toolkits.push(...page.toolkits);
    cursor = page.nextCursor;
    if (!cursor) return { status: 'ok', toolkits, truncated: false };
  }
  return { status: 'ok', toolkits, truncated: true };
}

/**
 * Keeps each connection service's whole app list; see the module docs for the
 * freshness, sharing and invalidation rules.
 */
export class ConnectorCatalogCache {
  readonly #dir: string | undefined;
  readonly #freshForMs: number;
  readonly #refreshTimeoutMs: number;
  readonly #now: () => number;
  readonly #kept = new Map<string, KeptCatalog>();
  /** The one disk read per instance this process; a drop settles it so nothing is read back. */
  readonly #diskLoads = new Map<string, Promise<void>>();
  /** Bumped by every drop, so a disk read that started before it is discarded. */
  readonly #generations = new Map<string, number>();
  readonly #refreshes = new Map<string, RefreshRecord>();
  readonly #failedAt = new Map<string, number>();
  /** Serialises disk writes and deletes per instance so a drop never races a rebuild. */
  readonly #diskQueue = new Map<string, Promise<void>>();

  /**
   * Construct the cache.
   *
   * @param opts - Disk directory and timing overrides; see {@link ConnectorCatalogCacheOptions}.
   */
  constructor(opts: ConnectorCatalogCacheOptions = {}) {
    this.#dir = opts.dir;
    this.#freshForMs = opts.freshForMs ?? DEFAULT_FRESH_FOR_MS;
    this.#refreshTimeoutMs = opts.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Read one service's whole app list from the kept copy, listing it upstream
   * only when there is no usable copy or the copy has gone stale.
   *
   * @param provider - The registered provider instance to read.
   * @param configDigest - Its current setup fingerprint; a copy made under another is never served.
   * @param signal - The reader's own deadline. It stops this reader waiting, not the refresh.
   * @throws When there is no kept copy and the listing fails, or when `signal` fires.
   */
  async read(
    provider: ConnectorProvider,
    configDigest: string,
    signal: AbortSignal
  ): Promise<KeptCatalogRead> {
    signal.throwIfAborted();
    const setupKey = setupKeyFor(configDigest);
    const kept = await this.#keptCopy(provider.instanceId, setupKey);
    if (kept) {
      if (this.#isStale(kept) && this.#mayRetry(provider.instanceId)) {
        // The stale copy keeps serving; the refresh logs its own failure.
        this.#refresh(provider, setupKey).catch(() => undefined);
      }
      return { status: 'ok', toolkits: kept.toolkits, truncated: kept.truncated };
    }
    return untilAborted(this.#refresh(provider, setupKey), signal);
  }

  /**
   * Find one app in a service's kept list without listing anything upstream.
   *
   * @param instanceId - The provider instance whose kept list to search.
   * @param configDigest - Its current setup fingerprint.
   * @param slug - The app's service slug.
   * @returns The kept entry, or `undefined` when there is no usable copy or no such app.
   */
  async find(
    instanceId: string,
    configDigest: string,
    slug: string
  ): Promise<ConnectorToolkit | undefined> {
    const kept = await this.#keptCopy(instanceId, setupKeyFor(configDigest));
    return kept?.toolkits.find((toolkit) => toolkit.slug === slug);
  }

  /**
   * Forget one service's kept list, in memory and on disk, and discard any
   * refresh still running for it. Called when the service's key or setup
   * changes or it is removed.
   *
   * @param instanceId - The provider instance to forget.
   */
  drop(instanceId: string): void {
    this.#kept.delete(instanceId);
    this.#refreshes.delete(instanceId);
    this.#failedAt.delete(instanceId);
    this.#generations.set(instanceId, this.#generation(instanceId) + 1);
    // Nothing on disk can be valid for this instance any more.
    this.#diskLoads.set(instanceId, Promise.resolve());
    const dir = this.#dir;
    if (dir) {
      void this.#onDisk(instanceId, () =>
        fs.rm(path.join(dir, fileNameFor(instanceId)), { force: true })
      );
    }
  }

  #isStale(kept: KeptCatalog): boolean {
    return this.#now() - kept.fetchedAt >= this.#freshForMs;
  }

  #mayRetry(instanceId: string): boolean {
    const failedAt = this.#failedAt.get(instanceId);
    return failedAt === undefined || this.#now() - failedAt >= RETRY_AFTER_FAILURE_MS;
  }

  /** The usable copy for this setup: memory first, then the disk copy (read once per process). */
  async #keptCopy(instanceId: string, setupKey: string): Promise<KeptCatalog | undefined> {
    if (!this.#kept.has(instanceId)) await this.#loadFromDisk(instanceId);
    const kept = this.#kept.get(instanceId);
    return kept?.setupKey === setupKey ? kept : undefined;
  }

  /** Concurrent first reads share one file read, so none of them lists upstream needlessly. */
  #loadFromDisk(instanceId: string): Promise<void> {
    const dir = this.#dir;
    if (!dir) return Promise.resolve();
    const existing = this.#diskLoads.get(instanceId);
    if (existing) return existing;
    const generation = this.#generation(instanceId);
    const load = this.#readFile(path.join(dir, fileNameFor(instanceId))).then((fromDisk) => {
      // A refresh that landed, or a drop, while the file was read wins over it.
      if (fromDisk && !this.#kept.has(instanceId) && this.#generation(instanceId) === generation) {
        this.#kept.set(instanceId, fromDisk);
      }
    });
    this.#diskLoads.set(instanceId, load);
    return load;
  }

  #generation(instanceId: string): number {
    return this.#generations.get(instanceId) ?? 0;
  }

  async #readFile(file: string): Promise<KeptCatalog | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf-8');
    } catch {
      return undefined;
    }
    try {
      const parsed = KeptCatalogFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** One refresh per service at a time; every concurrent reader shares it. */
  #refresh(provider: ConnectorProvider, setupKey: string): Promise<KeptCatalogRead> {
    const instanceId = provider.instanceId;
    const running = this.#refreshes.get(instanceId);
    if (running?.setupKey === setupKey) return running.promise;
    const ticket = Symbol(instanceId);
    const promise = this.#listAndKeep(
      provider,
      setupKey,
      () => this.#refreshes.get(instanceId)?.ticket === ticket
    );
    const record: RefreshRecord = { setupKey, ticket, promise };
    this.#refreshes.set(instanceId, record);
    promise.then(
      () => this.#settle(instanceId, record),
      (error: unknown) => {
        if (this.#refreshes.get(instanceId) === record) this.#failedAt.set(instanceId, this.#now());
        this.#settle(instanceId, record);
        logger.warn(
          `[Connectors] Could not refresh the ${provider.type} app list`,
          logError(error)
        );
      }
    );
    return promise;
  }

  async #listAndKeep(
    provider: ConnectorProvider,
    setupKey: string,
    isCurrent: () => boolean
  ): Promise<KeptCatalogRead> {
    const listing = await listWholeCatalog(provider, AbortSignal.timeout(this.#refreshTimeoutMs));
    if (listing.status !== 'ok') return listing;
    const kept: KeptCatalog = {
      version: CATALOG_FILE_VERSION,
      setupKey,
      fetchedAt: this.#now(),
      truncated: listing.truncated,
      toolkits: z.array(ConnectorToolkitSchema).parse(listing.toolkits),
    };
    // A drop or a newer setup replaced this refresh: its answer is not kept.
    if (isCurrent()) {
      this.#kept.set(provider.instanceId, kept);
      this.#failedAt.delete(provider.instanceId);
      await this.#persist(provider.instanceId, kept);
    }
    return { status: 'ok', toolkits: kept.toolkits, truncated: kept.truncated };
  }

  #settle(instanceId: string, record: RefreshRecord): void {
    if (this.#refreshes.get(instanceId) === record) this.#refreshes.delete(instanceId);
  }

  async #persist(instanceId: string, kept: KeptCatalog): Promise<void> {
    const dir = this.#dir;
    if (!dir) return;
    await this.#onDisk(instanceId, async () => {
      // Dropped while queued: writing now would resurrect a copy for an old setup.
      if (this.#kept.get(instanceId) !== kept) return;
      await fs.mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.${randomUUID()}.tmp`);
      try {
        await fs.writeFile(tmp, JSON.stringify(kept), 'utf-8');
        await fs.rename(tmp, path.join(dir, fileNameFor(instanceId)));
      } catch (error) {
        await fs.rm(tmp, { force: true });
        throw error;
      }
    });
  }

  /** Run one disk operation after every earlier one for the same instance; log, never throw. */
  #onDisk(instanceId: string, operation: () => Promise<unknown>): Promise<void> {
    const previous = this.#diskQueue.get(instanceId) ?? Promise.resolve();
    const next = previous.then(operation).then(
      () => undefined,
      (error: unknown) => {
        logger.warn('[Connectors] Could not update the kept app list on disk', logError(error));
      }
    );
    this.#diskQueue.set(instanceId, next);
    void next.then(() => {
      if (this.#diskQueue.get(instanceId) === next) this.#diskQueue.delete(instanceId);
    });
    return next;
  }
}

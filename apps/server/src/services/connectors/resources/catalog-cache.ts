/**
 * The kept app list: each connection service's whole catalog, held so paging,
 * search and the agent lookup stop re-listing it.
 *
 * Before this, every catalog page (24 apps) and every search asked each
 * service for its whole list again — about 850 Composio apps at 100 per call,
 * so ~9 upstream calls per page.
 *
 * **How long a list is kept depends on what the list is** ({@link catalogKeepingFor}):
 *
 * - Composio (own key) lists a vendor catalog that changes about daily: kept a
 *   day, in memory and on disk, so a restart does not re-list it.
 * - The DorkOS account's list carries per-app sign-in availability the hosted
 *   side can change at any time: kept 15 minutes, in memory and on disk, so a
 *   change there corrects itself quickly.
 * - Nango lists the person's own configured integrations: kept 60 seconds in
 *   memory only — just long enough to collapse one burst of pages.
 * - Raw MCP lists local configuration: never kept, it is read directly.
 * - Anything else (a new or test service) gets the cautious Nango treatment.
 *
 * Within a kept window:
 *
 * - **Fresh**: served straight from the kept copy.
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
 * secret-free execution-config digest, hashed once more with
 * {@link CONNECTOR_TOOLKIT_SHAPE_VERSION}). A copy made under a different key,
 * setup or entry shape is never served, and the registry drops the copy
 * outright when it unregisters the service.
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
import { COMPOSIO_PROVIDER_TYPE } from '../providers/composio.js';
import { MANAGED_CLOUD_PROVIDER_TYPE } from '../providers/managed/managed-cloud.js';
import { NANGO_PROVIDER_TYPE } from '../providers/nango.js';
import { RAW_MCP_PROVIDER_TYPE } from '../providers/raw-mcp.js';

/**
 * THE SHAPE OF ONE KEPT ENTRY. BUMP THIS WHENEVER `ConnectorToolkitSchema`
 * CHANGES — a field added, removed, renamed or re-typed.
 *
 * It is part of every copy's key, so a copy written by an older DorkOS is
 * ignored and re-listed rather than served without the new fields (a kept
 * list from before logos existed would otherwise hide every logo for a day).
 * `catalog-cache.test.ts` pins the schema's field list to this number and
 * fails when one moves without the other.
 */
export const CONNECTOR_TOOLKIT_SHAPE_VERSION = 2;

/** How one service's app list is kept. */
export type CatalogKeeping =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'keep';
      /** How long a copy counts as fresh. */
      readonly freshForMs: number;
      /** Whether the copy also survives a restart on disk. */
      readonly onDisk: boolean;
    };

const MINUTE_MS = 60 * 1000;

/** Composio's vendor catalog: a day, surviving restarts. */
export const VENDOR_CATALOG_KEEPING: CatalogKeeping = {
  kind: 'keep',
  freshForMs: 24 * 60 * MINUTE_MS,
  onDisk: true,
};

/** The DorkOS account's list, whose per-app sign-in the hosted side can change: 15 minutes. */
export const MANAGED_CATALOG_KEEPING: CatalogKeeping = {
  kind: 'keep',
  freshForMs: 15 * MINUTE_MS,
  onDisk: true,
};

/** A person's own configured integrations: one page burst, memory only. */
export const OWN_INTEGRATIONS_KEEPING: CatalogKeeping = {
  kind: 'keep',
  freshForMs: MINUTE_MS,
  onDisk: false,
};

/** Local configuration: read directly every time. */
export const NOT_KEPT: CatalogKeeping = { kind: 'none' };

/**
 * How a service type's app list is kept. See the module docs for why each
 * service differs; an unknown type gets the cautious memory-only minute.
 *
 * @param type - The provider's backend type.
 */
export function catalogKeepingFor(type: string): CatalogKeeping {
  switch (type) {
    case COMPOSIO_PROVIDER_TYPE:
      return VENDOR_CATALOG_KEEPING;
    case MANAGED_CLOUD_PROVIDER_TYPE:
      return MANAGED_CATALOG_KEEPING;
    case RAW_MCP_PROVIDER_TYPE:
      return NOT_KEPT;
    case NANGO_PROVIDER_TYPE:
    default:
      return OWN_INTEGRATIONS_KEEPING;
  }
}

/** The deadline one shared refresh runs under, independent of any reader. */
const DEFAULT_REFRESH_TIMEOUT_MS = 60_000;

/** After a failed background refresh, keep serving the old copy this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 60_000;

/** A staging file older than this is a crash's leftover, not a write in flight. */
const ORPHAN_TMP_AGE_MS = 60 * MINUTE_MS;

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
  /** Override how each service type is kept (tests). Default {@link catalogKeepingFor}. */
  readonly keepingFor?: (type: string) => CatalogKeeping;
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

/** Hash the setup digest and entry shape so the file never carries the digest verbatim. */
function setupKeyFor(configDigest: string): string {
  return createHash('sha256')
    .update(`dorkos:connector-catalog:shape-${CONNECTOR_TOOLKIT_SHAPE_VERSION}:${configDigest}`)
    .digest('hex');
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
 * per-service keeping, sharing and invalidation rules.
 */
export class ConnectorCatalogCache {
  readonly #dir: string | undefined;
  readonly #keepingFor: (type: string) => CatalogKeeping;
  readonly #refreshTimeoutMs: number;
  readonly #now: () => number;
  readonly #kept = new Map<string, KeptCatalog>();
  /** The one disk read per instance this process; a drop settles it so nothing is read back. */
  readonly #diskLoads = new Map<string, Promise<void>>();
  /** Bumped by every drop, so a disk read that started before it is discarded. */
  readonly #generations = new Map<string, number>();
  readonly #refreshes = new Map<string, RefreshRecord>();
  readonly #failedAt = new Map<string, number>();
  /**
   * Serialises disk writes and deletes per instance. A drop's delete is always
   * queued after any write its refresh already queued, so a dropped copy never
   * survives on disk.
   */
  readonly #diskQueue = new Map<string, Promise<void>>();

  /**
   * Construct the cache, and sweep staging files a crash left in its directory.
   *
   * @param opts - Disk directory, keeping and timing overrides; see {@link ConnectorCatalogCacheOptions}.
   */
  constructor(opts: ConnectorCatalogCacheOptions = {}) {
    this.#dir = opts.dir;
    this.#keepingFor = opts.keepingFor ?? catalogKeepingFor;
    this.#refreshTimeoutMs = opts.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
    this.#now = opts.now ?? Date.now;
    // Caught as well as logged inside: a constructor must never leave an
    // unhandled rejection behind over a leftover temp file.
    if (this.#dir) void this.#sweepOrphanedTempFiles(this.#dir).catch(() => {});
  }

  /**
   * Read one service's whole app list, from the kept copy when its service
   * type keeps one, listing it upstream only when there is no usable copy or
   * the copy has gone stale.
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
    const keeping = this.#keepingFor(provider.type);
    if (keeping.kind === 'none') return listWholeCatalog(provider, signal);
    const setupKey = setupKeyFor(configDigest);
    const kept = await this.#keptCopy(provider.instanceId, setupKey, keeping.onDisk);
    if (kept) {
      if (
        this.#now() - kept.fetchedAt >= keeping.freshForMs &&
        this.#mayRetry(provider.instanceId)
      ) {
        // The stale copy keeps serving; the refresh logs its own failure.
        this.#refresh(provider, setupKey, keeping.onDisk).catch(() => undefined);
      }
      return { status: 'ok', toolkits: kept.toolkits, truncated: kept.truncated };
    }
    return untilAborted(this.#refresh(provider, setupKey, keeping.onDisk), signal);
  }

  /**
   * The kept copy of one service's app list, fresh or stale, without ever
   * listing it upstream: `undefined` when nothing is kept for this setup (or
   * the service type keeps nothing). For lookups that must stay cheap, like
   * finding one app's logo address.
   *
   * @param provider - The registered provider instance to look in.
   * @param configDigest - Its current setup fingerprint; a copy made under another is never returned.
   */
  async peek(
    provider: ConnectorProvider,
    configDigest: string
  ): Promise<readonly ConnectorToolkit[] | undefined> {
    const keeping = this.#keepingFor(provider.type);
    if (keeping.kind === 'none') return undefined;
    const kept = await this.#keptCopy(
      provider.instanceId,
      setupKeyFor(configDigest),
      keeping.onDisk
    );
    return kept?.toolkits;
  }

  /**
   * The copy of one service's app list already held in memory for this setup,
   * without reading the disk or listing upstream: for a lookup that must stay
   * synchronous, like whether a way reaches one app. `undefined` when nothing
   * is held (not read yet this run, another setup, or a type that keeps none).
   *
   * @param instanceId - The provider instance to look in.
   * @param configDigest - Its current setup fingerprint.
   */
  heldInMemory(instanceId: string, configDigest: string): readonly ConnectorToolkit[] | undefined {
    const kept = this.#kept.get(instanceId);
    return kept?.setupKey === setupKeyFor(configDigest) ? kept.toolkits : undefined;
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

  #mayRetry(instanceId: string): boolean {
    const failedAt = this.#failedAt.get(instanceId);
    return failedAt === undefined || this.#now() - failedAt >= RETRY_AFTER_FAILURE_MS;
  }

  /** The usable copy for this setup: memory first, then the disk copy (read once per process). */
  async #keptCopy(
    instanceId: string,
    setupKey: string,
    onDisk: boolean
  ): Promise<KeptCatalog | undefined> {
    if (onDisk && !this.#kept.has(instanceId)) await this.#loadFromDisk(instanceId);
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
  #refresh(
    provider: ConnectorProvider,
    setupKey: string,
    onDisk: boolean
  ): Promise<KeptCatalogRead> {
    const instanceId = provider.instanceId;
    const running = this.#refreshes.get(instanceId);
    if (running?.setupKey === setupKey) return running.promise;
    const ticket = Symbol(instanceId);
    const promise = this.#listAndKeep(
      provider,
      setupKey,
      onDisk,
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
    onDisk: boolean,
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
      if (onDisk) await this.#persist(provider.instanceId, kept);
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

  /**
   * Remove staging files a crash between write and rename left behind. Only a
   * file older than {@link ORPHAN_TMP_AGE_MS} is reaped: a younger one may be
   * another instance's write still in flight.
   */
  async #sweepOrphanedTempFiles(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      logger.warn('[Connectors] Could not list the kept app lists to tidy them', logError(error));
      return;
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith('.tmp'))
        .map(async (name) => {
          const file = path.join(dir, name);
          try {
            const { mtimeMs } = await fs.stat(file);
            if (Date.now() - mtimeMs < ORPHAN_TMP_AGE_MS) return;
            await fs.rm(file, { force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            logger.warn('[Connectors] Could not remove a leftover kept-list file', logError(error));
          }
        })
    );
  }
}

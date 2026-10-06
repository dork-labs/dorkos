/**
 * The size of each model's context window, as the sidecar's own provider
 * catalog states it (`provider.list` → `models[id].limit.context`), so an
 * OpenCode reply's context reading can say how full the conversation is
 * (DOR-2732: the 80% note, and the gauge's window on the server side).
 *
 * OpenCode's `message.updated` names the provider and model but carries no
 * window, so the window is looked up here. Three rules keep the lookup from
 * costing a reply anything:
 *
 * - **Read once, per sidecar client AND project directory.** One sidecar
 *   serves every project, and a project's `opencode.json` can add or resize
 *   models, so the catalog is per directory. A read is kept for
 *   {@link CONTEXT_WINDOW_TTL_MS}; a failed one for {@link CONTEXT_WINDOW_RETRY_MS}.
 * - **Started early.** {@link OpenCodeContextWindows.prefetch} starts the read
 *   when a turn opens, so it is usually done by the time the reply's usage
 *   arrives.
 * - **Never waited on for long.** A lookup waits at most
 *   {@link CONTEXT_WINDOW_READ_TIMEOUT_MS}; a catalog read that stalls leaves
 *   that reading without a window (the read carries on for the next reply),
 *   so a slow sidecar can never hold a reply's `done`, or a Stop, hostage.
 *
 * A model the catalog gives no positive limit for answers `undefined`, and the
 * reading goes without a window rather than with a guessed one.
 *
 * @module services/runtimes/opencode/providers/context-windows
 */
import type { OpencodeClient, ProviderListResponse } from '@opencode-ai/sdk';
import { logger, logError } from '../../../../lib/logger.js';

/** How long one read of the catalog is trusted. */
export const CONTEXT_WINDOW_TTL_MS = 10 * 60_000;

/** How long a failed read is remembered before the next one is tried. */
export const CONTEXT_WINDOW_RETRY_MS = 60_000;

/** The longest a reply's reading waits for the catalog before going without a window. */
export const CONTEXT_WINDOW_READ_TIMEOUT_MS = 1_500;

/** `provider/model` → window, from one catalog read. */
type WindowTable = ReadonlyMap<string, number>;

interface Entry {
  readonly at: number;
  readonly ttl: number;
  readonly table: Promise<WindowTable>;
}

/**
 * Every model's context window in a `provider.list` answer, keyed
 * `provider/model`. Models with no positive limit are left out.
 *
 * @param payload - The sidecar's provider catalog.
 */
export function contextWindowsFrom(payload: ProviderListResponse): WindowTable {
  const table = new Map<string, number>();
  for (const provider of payload.all ?? []) {
    for (const [id, model] of Object.entries(provider.models ?? {})) {
      const window = model.limit?.context;
      if (typeof window === 'number' && window > 0) table.set(`${provider.id}/${id}`, window);
    }
  }
  return table;
}

/** Seams for {@link OpenCodeContextWindows}. */
export interface OpenCodeContextWindowsOptions {
  /** Clock (tests). */
  readonly now?: () => number;
  /** The longest a lookup waits (tests). */
  readonly readTimeoutMs?: number;
}

/** Cached context windows, one catalog read per sidecar client and directory. */
export class OpenCodeContextWindows {
  private readonly entries = new WeakMap<object, Map<string, Entry>>();
  private readonly now: () => number;
  private readonly readTimeoutMs: number;

  /**
   * Construct the cache.
   *
   * @param options - Clock and timeout seams.
   */
  constructor(options: OpenCodeContextWindowsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.readTimeoutMs = options.readTimeoutMs ?? CONTEXT_WINDOW_READ_TIMEOUT_MS;
  }

  /**
   * Start reading the catalog for a directory if no fresh read is held, so a
   * reply's lookup later usually finds it done. Never throws.
   *
   * @param client - The sidecar client the turn runs on.
   * @param directory - The turn's project directory.
   */
  prefetch(client: OpencodeClient, directory: string): void {
    void this.tableFor(client, directory);
  }

  /**
   * The window of one model, or `undefined` when the catalog does not say or
   * did not answer within the bound. Never throws.
   *
   * @param client - The sidecar client the reply came from.
   * @param directory - The project directory the catalog is read for.
   * @param providerId - The reply's provider.
   * @param modelId - The reply's model.
   */
  async lookup(
    client: OpencodeClient,
    directory: string,
    providerId: string | undefined,
    modelId: string | undefined
  ): Promise<number | undefined> {
    if (!providerId || !modelId) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.readTimeoutMs);
      timer.unref?.();
    });
    try {
      const table = await Promise.race([this.tableFor(client, directory), timedOut]);
      return table?.get(`${providerId}/${modelId}`);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private tableFor(client: OpencodeClient, directory: string): Promise<WindowTable> {
    let byDirectory = this.entries.get(client);
    if (!byDirectory) {
      byDirectory = new Map();
      this.entries.set(client, byDirectory);
    }
    const held = byDirectory.get(directory);
    if (held && this.now() - held.at < held.ttl) return held.table;
    const directories = byDirectory;
    const table = this.read(client, directory).then((read) => {
      // A failed read is kept only briefly, so the next try is not ten minutes away.
      if (read === null) {
        directories.set(directory, {
          at: this.now(),
          ttl: CONTEXT_WINDOW_RETRY_MS,
          table: Promise.resolve(new Map()),
        });
        return new Map<string, number>();
      }
      return read;
    });
    directories.set(directory, { at: this.now(), ttl: CONTEXT_WINDOW_TTL_MS, table });
    return table;
  }

  /** One catalog read; `null` when it failed, however it failed. */
  private async read(client: OpencodeClient, directory: string): Promise<WindowTable | null> {
    try {
      const listed = await client.provider.list({ query: { directory } });
      if (listed.error !== undefined || listed.data === undefined) {
        throw new Error(`provider.list failed: ${JSON.stringify(listed.error)}`);
      }
      return contextWindowsFrom(listed.data);
    } catch (err) {
      logger.debug(
        '[OpenCodeRuntime] model catalog unavailable for context windows',
        logError(err)
      );
      return null;
    }
  }
}

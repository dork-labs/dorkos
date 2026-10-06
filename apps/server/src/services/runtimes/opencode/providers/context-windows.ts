/**
 * The size of each model's context window, as the sidecar's own provider
 * catalog states it (`provider.list` → `models[id].limit.context`), so an
 * OpenCode reply's context reading can say how full the conversation is
 * (DOR-2732: the 80% note, and the gauge's window on the server side).
 *
 * OpenCode's `message.updated` names the provider and model but carries no
 * window, so the window is looked up here. The catalog is read once per
 * sidecar client and kept for {@link CONTEXT_WINDOW_TTL_MS}, so a reply costs
 * no network call; a failed read is remembered for a short while rather than
 * retried on every reply. A model the catalog gives no positive limit for
 * answers `undefined`, and the reading goes without a window rather than with
 * a guessed one.
 *
 * @module services/runtimes/opencode/providers/context-windows
 */
import type { OpencodeClient, ProviderListResponse } from '@opencode-ai/sdk';
import { logger, logError } from '../../../../lib/logger.js';

/** How long one read of the catalog is trusted. */
export const CONTEXT_WINDOW_TTL_MS = 10 * 60_000;

/** How long a failed read is remembered before the next one is tried. */
export const CONTEXT_WINDOW_RETRY_MS = 60_000;

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

/** Cached context windows, one catalog read per sidecar client. */
export class OpenCodeContextWindows {
  private readonly entries = new WeakMap<object, Entry>();

  /**
   * Construct the cache.
   *
   * @param now - Clock seam (tests).
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * The window of one model, or `undefined` when the catalog does not say.
   *
   * @param client - The sidecar client the reply came from.
   * @param directory - The directory to read the catalog for.
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
    const table = await this.tableFor(client, directory);
    return table.get(`${providerId}/${modelId}`);
  }

  private tableFor(client: OpencodeClient, directory: string): Promise<WindowTable> {
    const held = this.entries.get(client);
    if (held && this.now() - held.at < held.ttl) return held.table;
    const entry: Entry = {
      at: this.now(),
      ttl: CONTEXT_WINDOW_TTL_MS,
      table: this.read(client, directory, () => {
        // Failed: keep the empty answer only briefly.
        this.entries.set(client, { ...entry, ttl: CONTEXT_WINDOW_RETRY_MS });
      }),
    };
    this.entries.set(client, entry);
    return entry.table;
  }

  private async read(
    client: OpencodeClient,
    directory: string,
    onFailure: () => void
  ): Promise<WindowTable> {
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
      onFailure();
      return new Map();
    }
  }
}

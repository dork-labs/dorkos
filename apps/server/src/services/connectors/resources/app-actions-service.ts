/**
 * What one app lets agents do: its action list, read on demand from the
 * configured way that reaches it and kept so reopening a panel is instant.
 *
 * Every action carries the classification the service's own discovery
 * produced, the exact value the grant review stores and execution enforces.
 * Nothing here reclassifies an action, so a screen built on this list can
 * never promise less than what an agent is allowed to do.
 *
 * The kept copy lives in memory and at
 * `<dorkHome>/cache/connectors/actions/`, one file per way and app. It holds
 * action ids, names and classifications only: no keys, accounts or schemas.
 * A copy counts as fresh for 24 hours; after that it is served at once while
 * one refresh runs behind it. A partial list counts as fresh for 15 minutes
 * only, so a listing that stopped part way is soon tried again. Anything under
 * `cache/` is safe to delete and is rebuilt.
 *
 * @module services/connectors/resources/app-actions-service
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import {
  CONNECTOR_APP_ACTIONS_LIMIT,
  ConnectorAppActionSchema,
  type ConnectorAppAction,
  type ConnectorAppActions,
} from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-schemas';
import { logger } from '../../../lib/logger.js';

/** How long a complete list counts as fresh. */
export const APP_ACTIONS_FRESH_MS = 24 * 60 * 60 * 1_000;
/** How long a partial list counts as fresh before it is tried again. */
export const PARTIAL_APP_ACTIONS_FRESH_MS = 15 * 60 * 1_000;
/** Actions asked for per page; the widest page every way accepts. */
const PAGE_SIZE = 100;
/** Pages read at most, matching {@link CONNECTOR_APP_ACTIONS_LIMIT}. */
const MAX_PAGES = CONNECTOR_APP_ACTIONS_LIMIT / PAGE_SIZE;
/** How long one listing may take before it is given up. */
const LISTING_DEADLINE_MS = 60_000;

/** Safe refusal for an action-list read. */
export class ConnectorAppActionsError extends Error {
  /** Stable machine-readable refusal. */
  readonly code: 'provider_not_found' | 'actions_unavailable';

  /** Construct one safe action-list error. */
  constructor(code: ConnectorAppActionsError['code'], message: string) {
    super(message);
    this.name = 'ConnectorAppActionsError';
    this.code = code;
  }
}

/** Dependencies for {@link ConnectorAppActionsService}. */
export interface ConnectorAppActionsServiceOptions {
  /** Resolves the configured way whose actions are listed. */
  readonly registry: {
    resolveProviderInstance(instanceId: ConnectorProviderInstanceId): ConnectorProvider | undefined;
  };
  /** The DorkOS data directory, from `lib/dork-home.ts`. */
  readonly dorkHome: string;
  /** Clock, injected for deterministic freshness evidence. */
  readonly now?: () => Date;
}

/** One kept list, as held in memory and on disk. */
const KeptActionsSchema = z.discriminatedUnion('status', [
  z
    .object({
      version: z.literal(1),
      status: z.literal('listed'),
      providerInstanceId: z.string().min(1),
      toolkit: z.string().min(1),
      toolkitVersion: z.string().min(1),
      actions: z.array(ConnectorAppActionSchema).max(CONNECTOR_APP_ACTIONS_LIMIT),
      complete: z.boolean(),
      fetchedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      status: z.literal('unlisted'),
      providerInstanceId: z.string().min(1),
      toolkit: z.string().min(1),
      fetchedAt: z.string().datetime(),
    })
    .strict(),
]);
type KeptActions = z.infer<typeof KeptActionsSchema>;

/** List an app's actions through one configured way, keeping the answer. */
export class ConnectorAppActionsService {
  private readonly registry: ConnectorAppActionsServiceOptions['registry'];
  private readonly directory: string;
  private readonly now: () => Date;
  private readonly kept = new Map<string, KeptActions>();
  private readonly inFlight = new Map<string, Promise<KeptActions>>();

  /** Create the service; nothing is read from disk until a list is asked for. */
  constructor(options: ConnectorAppActionsServiceOptions) {
    this.registry = options.registry;
    this.directory = path.join(options.dorkHome, 'cache', 'connectors', 'actions');
    this.now = options.now ?? (() => new Date());
  }

  /**
   * What one app lets agents do through one configured way.
   *
   * @param input.providerInstanceId - The configured way that reaches the app.
   * @param input.toolkit - The app's service id, e.g. `gmail`.
   * @throws {ConnectorAppActionsError} `provider_not_found` for an unknown way,
   *   `actions_unavailable` when the service could not list anything.
   */
  async list(input: {
    providerInstanceId: ConnectorProviderInstanceId;
    toolkit: string;
  }): Promise<ConnectorAppActions> {
    const provider = this.registry.resolveProviderInstance(input.providerInstanceId);
    if (!provider) {
      throw new ConnectorAppActionsError(
        'provider_not_found',
        'This way of reaching apps is not set up.'
      );
    }
    // A way that declares it has no trusted action list is answered without a call.
    if (provider.getCapabilities().capabilities.operations.status === 'unsupported') {
      return { status: 'unlisted', toolkit: input.toolkit };
    }

    const key = keyOf(input.providerInstanceId, input.toolkit);
    const kept = this.kept.get(key) ?? (await this.readKept(key, input));
    if (kept) {
      if (!this.isFresh(kept)) {
        void this.refresh(key, provider, input, kept).catch((error: unknown) =>
          logger.debug('[ConnectorAppActions] background refresh failed', {
            toolkit: input.toolkit,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
      return present(kept);
    }
    return present(await this.refresh(key, provider, input, undefined));
  }

  private isFresh(kept: KeptActions): boolean {
    const freshFor =
      kept.status === 'listed' && !kept.complete
        ? PARTIAL_APP_ACTIONS_FRESH_MS
        : APP_ACTIONS_FRESH_MS;
    return this.now().getTime() - Date.parse(kept.fetchedAt) < freshFor;
  }

  /** One listing per way and app at a time; concurrent callers share it. */
  private refresh(
    key: string,
    provider: ConnectorProvider,
    input: { providerInstanceId: ConnectorProviderInstanceId; toolkit: string },
    previous: KeptActions | undefined
  ): Promise<KeptActions> {
    const running = this.inFlight.get(key);
    if (running) return running;
    const task = (async () => {
      const next = await this.fetch(provider, input, previous);
      this.kept.set(key, next);
      await this.writeKept(key, next);
      return next;
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async fetch(
    provider: ConnectorProvider,
    input: { providerInstanceId: ConnectorProviderInstanceId; toolkit: string },
    previous: KeptActions | undefined
  ): Promise<KeptActions> {
    const signal = AbortSignal.timeout(LISTING_DEADLINE_MS);
    const fetchedAt = this.now().toISOString();
    const base = {
      version: 1 as const,
      providerInstanceId: input.providerInstanceId,
      toolkit: input.toolkit,
      fetchedAt,
    };
    let toolkitVersion: string;
    try {
      const resolved = await provider.resolveToolkitVersion(input.toolkit, signal);
      if (resolved.status === 'unsupported') return { ...base, status: 'unlisted' };
      toolkitVersion = resolved.toolkitVersion;
    } catch {
      throw unavailable();
    }
    // A version's action list never changes, so an unchanged complete list
    // only needs its date moved on.
    if (
      previous?.status === 'listed' &&
      previous.complete &&
      previous.toolkitVersion === toolkitVersion
    ) {
      return { ...previous, fetchedAt };
    }

    const actions: ConnectorAppAction[] = [];
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let result: Awaited<ReturnType<ConnectorProvider['listOperationSchemas']>>;
      try {
        result = await provider.listOperationSchemas({
          toolkit: input.toolkit,
          toolkitVersion,
          ...(cursor !== undefined && { cursor }),
          limit: PAGE_SIZE,
          signal,
        });
      } catch {
        // Nothing read yet is a failure. A listing that stops part way (a
        // service's own page safety limit, or a lost connection) keeps what
        // it read and says it is partial; it is never passed off as whole.
        if (actions.length === 0) throw unavailable();
        break;
      }
      if (result.status === 'unsupported') {
        if (actions.length === 0) return { ...base, status: 'unlisted' };
        break;
      }
      for (const operation of result.page.operations) {
        // An action from another app or version is not part of this list.
        if (operation.toolkit !== input.toolkit || operation.toolkitVersion !== toolkitVersion) {
          continue;
        }
        actions.push({
          operationSlug: operation.operationSlug,
          ...(operation.displayName !== undefined && { displayName: operation.displayName }),
          capabilityClassification: operation.capabilityClassification,
          important: operation.important === true,
        });
      }
      const next = result.page.nextCursor;
      if (!result.page.truncated && next === undefined) {
        complete = true;
        break;
      }
      if (next === undefined || next === cursor) break;
      cursor = next;
    }
    return {
      ...base,
      status: 'listed',
      toolkitVersion,
      actions: actions.slice(0, CONNECTOR_APP_ACTIONS_LIMIT),
      complete: complete && actions.length <= CONNECTOR_APP_ACTIONS_LIMIT,
    };
  }

  private fileOf(key: string): string {
    return path.join(this.directory, `${key}.json`);
  }

  private async readKept(
    key: string,
    input: { providerInstanceId: ConnectorProviderInstanceId; toolkit: string }
  ): Promise<KeptActions | undefined> {
    try {
      const parsed = KeptActionsSchema.safeParse(
        JSON.parse(await readFile(this.fileOf(key), 'utf-8'))
      );
      // A file for another way or app (a hash collision, or a hand edit) is ignored.
      if (
        !parsed.success ||
        parsed.data.providerInstanceId !== input.providerInstanceId ||
        parsed.data.toolkit !== input.toolkit
      ) {
        return undefined;
      }
      this.kept.set(key, parsed.data);
      return parsed.data;
    } catch {
      return undefined;
    }
  }

  private async writeKept(key: string, kept: KeptActions): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
      const file = this.fileOf(key);
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify(kept)}\n`, 'utf-8');
      await rename(temp, file);
    } catch (error) {
      // The memory copy still serves; only the next restart pays for a listing.
      logger.debug('[ConnectorAppActions] could not keep the list on disk', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** A file-safe key for one way and app. */
function keyOf(providerInstanceId: string, toolkit: string): string {
  return createHash('sha256').update(`${providerInstanceId}\n${toolkit}`).digest('hex');
}

function unavailable(): ConnectorAppActionsError {
  return new ConnectorAppActionsError(
    'actions_unavailable',
    'DorkOS could not list this app’s actions just now. Try again.'
  );
}

/** The public shape of a kept list. */
function present(kept: KeptActions): ConnectorAppActions {
  if (kept.status === 'unlisted') return { status: 'unlisted', toolkit: kept.toolkit };
  return {
    status: 'listed',
    toolkit: kept.toolkit,
    toolkitVersion: kept.toolkitVersion,
    actions: kept.actions,
    complete: kept.complete,
    fetchedAt: kept.fetchedAt,
  };
}

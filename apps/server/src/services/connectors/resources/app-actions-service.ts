/**
 * What one app lets agents do: its action list, read on demand from the
 * configured way that reaches it and kept so reopening a panel is instant.
 *
 * Every action carries the classification the service's own discovery
 * produced, the exact value the grant review stores and execution enforces.
 * Nothing here reclassifies an action.
 *
 * The kept copy lives in memory and under
 * `<dorkHome>/cache/connectors/actions/<way>/`, one file per app and setup
 * generation. It holds action ids, names and classifications only: no keys,
 * accounts or schemas. A complete list counts as fresh for 24 hours; after
 * that it is served at once while one refresh runs behind it. A partial list,
 * or an answer that the way can't list actions, counts as fresh for 15
 * minutes only, so it is soon tried again. Changing a way's setup starts a new
 * generation, and removing or replacing the way drops everything kept for it.
 * Anything under `cache/` is safe to delete and is rebuilt.
 *
 * @module services/connectors/resources/app-actions-service
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { and, connectorProviderInstances, eq, type Db } from '@dorkos/db';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import {
  CONNECTOR_APP_ACTIONS_LIMIT,
  ConnectorAppActionSchema,
  type ConnectorAppAction,
  type ConnectorAppActions,
} from '@dorkos/shared/connector-resource-schemas';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-schemas';
import { logger } from '../../../lib/logger.js';
import type { ConnectorOwnerAuthority } from '../principal/server-principal.js';
import type { ConnectorRegistry } from '../registry.js';

/** How long a complete list counts as fresh. */
export const APP_ACTIONS_FRESH_MS = 24 * 60 * 60 * 1_000;
/** How long a partial list, or an "unlisted" answer, counts as fresh. */
export const SHORT_APP_ACTIONS_FRESH_MS = 15 * 60 * 1_000;
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
  /** The DorkOS database, for the owned-and-available check on a way. */
  readonly db: Db;
  /** Resolves the configured way, its setup generation, and its removal. */
  readonly registry: Pick<
    ConnectorRegistry,
    'resolveProviderInstance' | 'providerExecutionConfigGeneration' | 'onProviderInstanceRemoved'
  >;
  /** The DorkOS data directory, from `lib/dork-home.ts`. */
  readonly dorkHome: string;
  /** Clock, injected for deterministic freshness evidence. */
  readonly now?: () => Date;
}

const KeptBaseSchema = z.object({
  version: z.literal(2),
  providerInstanceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  toolkit: z.string().min(1),
  fetchedAt: z.string().datetime(),
});

/** One kept list, as held in memory and on disk. */
const KeptActionsSchema = z.discriminatedUnion('status', [
  KeptBaseSchema.extend({
    status: z.literal('listed'),
    toolkitVersion: z.string().min(1),
    actions: z.array(ConnectorAppActionSchema).max(CONNECTOR_APP_ACTIONS_LIMIT),
    completeness: z.enum(['complete', 'too_large', 'interrupted']),
  }).strict(),
  KeptBaseSchema.extend({ status: z.literal('unlisted') }).strict(),
]);
type KeptActions = z.infer<typeof KeptActionsSchema>;

/** Which list is asked for: one app through one way at one setup generation. */
interface ListTarget {
  providerInstanceId: ConnectorProviderInstanceId;
  toolkit: string;
  generation: number;
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

/** List an app's actions through one configured way, keeping the answer. */
export class ConnectorAppActionsService {
  private readonly db: Db;
  private readonly registry: ConnectorAppActionsServiceOptions['registry'];
  private readonly directory: string;
  private readonly now: () => Date;
  private readonly kept = new Map<string, KeptActions>();
  private readonly inFlight = new Map<string, Promise<KeptActions>>();
  /**
   * Bumped each time a way is dropped. Anything read or listed before the
   * bump is never kept after it, so a way removed or replaced mid-listing
   * can't bring its old answer back.
   */
  private readonly epochs = new Map<string, number>();
  /** Each way's disk work, one step at a time, so a drop never races a write or a read. */
  private readonly diskQueues = new Map<string, Promise<unknown>>();

  /** Create the service; nothing is read from disk until a list is asked for. */
  constructor(options: ConnectorAppActionsServiceOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.directory = path.join(options.dorkHome, 'cache', 'connectors', 'actions');
    this.now = options.now ?? (() => new Date());
    this.registry.onProviderInstanceRemoved((instanceId) => void this.forget(instanceId));
  }

  /**
   * What one app lets agents do through one configured way.
   *
   * @param owner - The verified owner; only a way they own and can use is listed.
   * @param input - The way that reaches the app and the app's service id.
   * @throws {ConnectorAppActionsError} `provider_not_found` for a way that is
   *   unknown, not the owner's, or unavailable; `actions_unavailable` when the
   *   service could not list anything.
   */
  async list(
    owner: ConnectorOwnerAuthority,
    input: { providerInstanceId: ConnectorProviderInstanceId; toolkit: string }
  ): Promise<ConnectorAppActions> {
    // Read once, before the way is resolved: anything that drops the way
    // after this point makes this call's provider and reads stale.
    const epoch = this.epochOf(input.providerInstanceId);
    const provider = this.ownedProvider(owner, input.providerInstanceId);
    const generation = provider && this.registry.providerExecutionConfigGeneration(provider);
    if (!provider || generation === undefined) {
      throw new ConnectorAppActionsError(
        'provider_not_found',
        'This way of reaching apps is not set up.'
      );
    }
    // A way that declares it has no trusted action list is answered without a call.
    if (provider.getCapabilities().capabilities.operations.status === 'unsupported') {
      return { status: 'unlisted', toolkit: input.toolkit };
    }

    const target: ListTarget = { ...input, generation };
    const key = keyOf(target);
    const kept = this.kept.get(key) ?? (await this.readKept(key, target, epoch));
    // The way was removed or replaced while its copy was read: ask again, so
    // the answer comes from the way as it is now.
    if (this.epochOf(input.providerInstanceId) !== epoch) return this.list(owner, input);
    if (kept) {
      if (!this.isFresh(kept)) {
        void this.refresh(key, provider, target, kept, epoch).catch((error: unknown) =>
          logger.debug('[ConnectorAppActions] background refresh failed', {
            toolkit: input.toolkit,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      }
      return present(kept);
    }
    return present(await this.refresh(key, provider, target, undefined, epoch));
  }

  /** The same owned-and-available check a sign-in makes before it starts. */
  private ownedProvider(
    owner: ConnectorOwnerAuthority,
    instanceId: ConnectorProviderInstanceId
  ): ConnectorProvider | undefined {
    const ownerKey = ownerColumns(owner);
    const row = this.db
      .select({ status: connectorProviderInstances.status })
      .from(connectorProviderInstances)
      .where(
        and(
          eq(connectorProviderInstances.id, instanceId),
          eq(connectorProviderInstances.ownerKind, ownerKey.ownerKind),
          eq(connectorProviderInstances.ownerId, ownerKey.ownerId)
        )
      )
      .get();
    return row?.status === 'available'
      ? this.registry.resolveProviderInstance(instanceId)
      : undefined;
  }

  /**
   * Wait until every listing and disk step now in progress has finished. For
   * deterministic tests; list() never needs it.
   */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values(), ...this.diskQueues.values()]);
  }

  private epochOf(instanceId: string): number {
    return this.epochs.get(instanceId) ?? 0;
  }

  /** Run one disk step for a way after the ones already queued for it. */
  private onDisk<T>(instanceId: string, step: () => Promise<T>): Promise<T> {
    const queued = (this.diskQueues.get(instanceId) ?? Promise.resolve()).then(step, step);
    const settled = queued.then(
      () => undefined,
      () => undefined
    );
    this.diskQueues.set(instanceId, settled);
    void settled.then(() => {
      if (this.diskQueues.get(instanceId) === settled) this.diskQueues.delete(instanceId);
    });
    return queued;
  }

  private isFresh(kept: KeptActions): boolean {
    const freshFor =
      kept.status === 'listed' && kept.completeness === 'complete'
        ? APP_ACTIONS_FRESH_MS
        : SHORT_APP_ACTIONS_FRESH_MS;
    return this.now().getTime() - Date.parse(kept.fetchedAt) < freshFor;
  }

  /** One listing per way and app at a time; concurrent callers share it. */
  private refresh(
    key: string,
    provider: ConnectorProvider,
    target: ListTarget,
    previous: KeptActions | undefined,
    epoch: number
  ): Promise<KeptActions> {
    const running = this.inFlight.get(key);
    if (running) return running;
    // The body reads its own promise only after an await, once it is set here.
    const slot: { task?: Promise<KeptActions> } = {};
    slot.task = (async () => {
      const next = await this.fetch(provider, target, previous);
      // The way may have been removed or replaced while the listing ran; keep
      // nothing for it then.
      if (
        this.inFlight.get(key) !== slot.task ||
        this.epochOf(target.providerInstanceId) !== epoch ||
        this.registry.resolveProviderInstance(target.providerInstanceId) !== provider
      ) {
        return next;
      }
      this.kept.set(key, next);
      await this.writeKept(key, target, next, epoch);
      return next;
    })().finally(() => {
      if (this.inFlight.get(key) === slot.task) this.inFlight.delete(key);
    });
    this.inFlight.set(key, slot.task);
    return slot.task;
  }

  private async fetch(
    provider: ConnectorProvider,
    target: ListTarget,
    previous: KeptActions | undefined
  ): Promise<KeptActions> {
    const signal = AbortSignal.timeout(LISTING_DEADLINE_MS);
    const fetchedAt = this.now().toISOString();
    const base = {
      version: 2 as const,
      providerInstanceId: target.providerInstanceId,
      generation: target.generation,
      toolkit: target.toolkit,
      fetchedAt,
    };
    let toolkitVersion: string;
    try {
      const resolved = await provider.resolveToolkitVersion(target.toolkit, signal);
      if (resolved.status === 'unsupported') return { ...base, status: 'unlisted' };
      toolkitVersion = resolved.toolkitVersion;
    } catch {
      throw unavailable();
    }
    // A version's action list never changes, so a complete list of the same
    // version only needs its date moved on. This is also why a later partial
    // listing can never replace a complete list of the same version.
    if (
      previous?.status === 'listed' &&
      previous.completeness === 'complete' &&
      previous.toolkitVersion === toolkitVersion
    ) {
      return { ...previous, fetchedAt };
    }

    const actions: ConnectorAppAction[] = [];
    let cursor: string | undefined;
    // Running out of pages before the service says it is done means too large.
    let completeness: 'complete' | 'too_large' | 'interrupted' = 'too_large';
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let result: Awaited<ReturnType<ConnectorProvider['listOperationSchemas']>>;
      try {
        result = await provider.listOperationSchemas({
          toolkit: target.toolkit,
          toolkitVersion,
          ...(cursor !== undefined && { cursor }),
          limit: PAGE_SIZE,
          signal,
        });
      } catch {
        // Nothing read yet is a failure. A listing that stops part way keeps
        // what it read and says so; it is never passed off as whole.
        if (actions.length === 0) throw unavailable();
        completeness = 'interrupted';
        break;
      }
      if (result.status === 'unsupported') {
        if (actions.length === 0) return { ...base, status: 'unlisted' };
        completeness = 'interrupted';
        break;
      }
      for (const operation of result.page.operations) {
        // An action from another app or version is not part of this list.
        if (operation.toolkit !== target.toolkit || operation.toolkitVersion !== toolkitVersion) {
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
        completeness = actions.length > CONNECTOR_APP_ACTIONS_LIMIT ? 'too_large' : 'complete';
        break;
      }
      if (next === undefined || next === cursor) {
        completeness = 'interrupted';
        break;
      }
      cursor = next;
    }
    return {
      ...base,
      status: 'listed',
      toolkitVersion,
      actions: actions.slice(0, CONNECTOR_APP_ACTIONS_LIMIT),
      completeness,
    };
  }

  /** Drop everything kept for a way that was removed or replaced. */
  private forget(instanceId: ConnectorProviderInstanceId): Promise<void> {
    this.epochs.set(instanceId, this.epochOf(instanceId) + 1);
    for (const [key, kept] of this.kept) {
      if (kept.providerInstanceId === instanceId) this.kept.delete(key);
    }
    const prefix = `${wayDir(instanceId)}/`;
    for (const key of this.inFlight.keys()) {
      if (key.startsWith(prefix)) this.inFlight.delete(key);
    }
    // Queued behind any write already under way, so nothing lands after it.
    return this.onDisk(instanceId, async () => {
      try {
        await rm(path.join(this.directory, wayDir(instanceId)), { recursive: true, force: true });
      } catch (error) {
        logger.debug('[ConnectorAppActions] could not drop a removed way’s lists', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private fileOf(key: string): string {
    return path.join(this.directory, `${key}.json`);
  }

  private async readKept(
    key: string,
    target: ListTarget,
    epoch: number
  ): Promise<KeptActions | undefined> {
    const parsed = await this.onDisk(target.providerInstanceId, async () => {
      try {
        return KeptActionsSchema.safeParse(JSON.parse(await readFile(this.fileOf(key), 'utf-8')));
      } catch {
        return undefined;
      }
    });
    // A file for another way, app or setup (or a hand edit), or one read
    // before the way was dropped, is ignored.
    if (
      !parsed?.success ||
      this.epochOf(target.providerInstanceId) !== epoch ||
      parsed.data.providerInstanceId !== target.providerInstanceId ||
      parsed.data.toolkit !== target.toolkit ||
      parsed.data.generation !== target.generation
    ) {
      return undefined;
    }
    this.kept.set(key, parsed.data);
    return parsed.data;
  }

  private writeKept(
    key: string,
    target: ListTarget,
    kept: KeptActions,
    epoch: number
  ): Promise<void> {
    return this.onDisk(target.providerInstanceId, async () => {
      // Dropped while this waited its turn: write nothing.
      if (this.epochOf(target.providerInstanceId) !== epoch) return;
      try {
        await mkdir(path.join(this.directory, wayDir(target.providerInstanceId)), {
          recursive: true,
        });
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
    });
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A file-safe directory name for one way. */
function wayDir(providerInstanceId: string): string {
  return hash(providerInstanceId);
}

/** A file-safe key for one app through one way at one setup generation. */
function keyOf(target: ListTarget): string {
  return `${wayDir(target.providerInstanceId)}/${hash(`${target.generation}\n${target.toolkit}`)}`;
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
    completeness: kept.completeness,
    fetchedAt: kept.fetchedAt,
  };
}

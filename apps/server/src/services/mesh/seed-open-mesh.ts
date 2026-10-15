/**
 * Apply the Trusted defaults to the stores that live outside `config.json`, once
 * per install (DOR-2739, ADR 261006-225605, spec `trusted-by-default-flip` §5.3).
 *
 * A config migration can only change `config.json`. Two Trusted defaults live
 * elsewhere: the mesh rule that lets our agents message each other across
 * projects (this file), and who may use an existing connected app
 * (`services/connectors/access/trusted-sharing.ts`, §5.6). Each is a boot step
 * that runs once and records that it ran, so a person who later narrows the
 * result keeps their choice: a second boot changes nothing.
 *
 * ## Steps and stamps
 *
 * {@link applyTrustedStores} takes a list of {@link TrustedStoreStep}s and one
 * stamp, and stamps only when every step reports `'applied'`. A step that
 * cannot run yet (Relay is switched off, so there is no mesh rule to write)
 * reports `'deferred'`, and the whole list runs again on the next boot. So a
 * step must be safe to repeat until its stamp lands.
 *
 * Each list has its own stamp, so a step added in a later release still runs
 * on an install that already stamped an earlier list:
 * `permissions.trustedStoresAppliedAt` for the open mesh, and
 * `permissions.sharedAppsAppliedAt` for the connected apps.
 *
 * The open mesh is seeded on a Trusted install only. A closed mesh cannot tell
 * "never opened" from "a person turned it off", and a person on Careful asked
 * to be asked first, so their mesh stays as it is (the step still counts as
 * applied, and the switch stays in Topology).
 *
 * @module services/mesh/seed-open-mesh
 */
import type { MeshCore } from '@dorkos/mesh';
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { Logger } from '@dorkos/shared/logger';
import { trustPosture } from '@dorkos/shared/permissions';
import { logError } from '../../lib/logger.js';
import type { ConfigManager } from '../core/config-manager.js';
import type { TrustedConnectionSharing } from '../connectors/access/trusted-sharing.js';

/** What one step did on this boot. */
export type TrustedStoreOutcome = 'applied' | 'deferred';

/** One store the Trusted defaults reach, applied at most once per install. */
export interface TrustedStoreStep {
  /** A short name for the boot log. */
  name: string;
  /**
   * Apply the Trusted default to this store. Returns `'deferred'` when the
   * store is not available on this boot. A throw counts as deferred.
   */
  run: () => TrustedStoreOutcome | Promise<TrustedStoreOutcome>;
}

/** The `permissions` config section, read and written whole. */
export interface TrustedStoresConfig {
  /** Read the stored `permissions` section. */
  get: () => UserConfig['permissions'];
  /** Write the whole `permissions` section back. */
  set: (next: UserConfig['permissions']) => void;
}

/** The `permissions` leaves a list of Trusted-store steps is stamped in. */
export type TrustedStoresStamp = 'trustedStoresAppliedAt' | 'sharedAppsAppliedAt';

/** Dependencies for {@link applyTrustedStores}. */
export interface ApplyTrustedStoresDeps {
  /** Where the stamp lives. */
  config: TrustedStoresConfig;
  /** Which stamp this list keeps; `trustedStoresAppliedAt` when omitted. */
  stamp?: TrustedStoresStamp;
  /** The steps to run, in order. */
  steps: readonly TrustedStoreStep[];
  /** Boot logger. */
  logger: Pick<Logger, 'info' | 'warn'>;
  /** The time to stamp; injectable for tests. */
  now?: () => Date;
}

/**
 * The open-mesh step: let every one of our agents message every other, across
 * projects, by writing the same `* → *` rule the Topology switch writes.
 *
 * Deferred when Relay is off, because the rule lives in Relay's access table
 * and Mesh drops it when there is no Relay to hold it.
 *
 * Deferred too when Mesh did not start, since there is no registry to write.
 *
 * @param mesh - The agent registry, or `undefined` when Mesh did not start.
 * @param relayReady - Whether Relay started on this boot.
 * @param isTrusted - Whether the install is Trusted; a Careful one is left closed.
 */
export function openMeshStep(
  mesh: Pick<MeshCore, 'allowCrossNamespace'> | undefined,
  relayReady: boolean,
  isTrusted: () => boolean = () => true
): TrustedStoreStep {
  return {
    name: 'open mesh',
    run: () => {
      if (!isTrusted()) return 'applied';
      if (!relayReady || !mesh) return 'deferred';
      mesh.allowCrossNamespace('*', '*');
      return 'applied';
    },
  };
}

/**
 * Run every Trusted-store step in one list once per install, and stamp the
 * list's own leaf (`permissions.trustedStoresAppliedAt` unless told otherwise)
 * when all of them applied.
 *
 * Does nothing when the stamp is already set. A failed step is logged and
 * leaves the stamp unset, so the next boot tries again; only a failing config
 * read or write throws.
 *
 * @param deps - The config, the steps and a logger.
 * @returns Whether the stamp is set after this call.
 */
export async function applyTrustedStores(deps: ApplyTrustedStoresDeps): Promise<boolean> {
  const { config, steps, logger } = deps;
  const key = deps.stamp ?? 'trustedStoresAppliedAt';
  if (config.get()[key] != null) return true;

  let allApplied = true;
  for (const step of steps) {
    let outcome: TrustedStoreOutcome;
    try {
      outcome = await step.run();
    } catch (err) {
      logger.warn(`[Trust] Could not apply the ${step.name} default yet`, {
        error: err instanceof Error ? err.message : String(err),
      });
      outcome = 'deferred';
    }
    if (outcome === 'deferred') allApplied = false;
  }
  if (!allApplied) return false;

  const stamp = (deps.now ?? (() => new Date()))().toISOString();
  config.set({ ...config.get(), [key]: stamp });
  logger.info(`[Trust] Applied the trusted defaults: ${steps.map((s) => s.name).join(', ')}`);
  return true;
}

/** The stores {@link applyTrustedStoresAtBoot} reaches on this boot. */
export interface TrustedStores {
  /** The agent registry, or `undefined` when Mesh did not start. */
  readonly mesh: Pick<MeshCore, 'allowCrossNamespace'> | undefined;
  /** Whether Relay started on this boot. */
  readonly relayReady: boolean;
  /** Shares connected apps nobody was given with every agent. */
  readonly connections: Pick<TrustedConnectionSharing, 'upgradeStep'>;
}

/**
 * The boot call `index.ts` makes: run every Trusted-store step against the live
 * config, mesh and connections. A failing config read or write is logged, never
 * thrown, so it cannot stop the server starting; the next boot tries again.
 *
 * @param configManager - The live config, whose `permissions` section holds the stamp.
 * @param logger - Boot logger.
 * @param stores - The mesh and the connected apps.
 */
export async function applyTrustedStoresAtBoot(
  configManager: Pick<ConfigManager, 'get' | 'set'>,
  logger: Pick<Logger, 'info' | 'warn'>,
  stores: TrustedStores
): Promise<void> {
  const config: TrustedStoresConfig = {
    get: () => configManager.get('permissions'),
    set: (next) => configManager.set('permissions', next),
  };
  const lists: Array<Pick<ApplyTrustedStoresDeps, 'stamp' | 'steps'>> = [
    {
      steps: [
        openMeshStep(
          stores.mesh,
          stores.relayReady,
          () => trustPosture(configManager.get('permissions').preset) === 'trusted'
        ),
      ],
    },
    { stamp: 'sharedAppsAppliedAt', steps: [stores.connections.upgradeStep()] },
  ];
  // Each list stands alone: one that cannot be stamped never holds back another.
  for (const list of lists) {
    try {
      await applyTrustedStores({ config, logger, ...list });
    } catch (err) {
      logger.warn('[Trust] Could not apply the trusted defaults', logError(err));
    }
  }
}

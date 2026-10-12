/**
 * Apply the Trusted defaults to the stores that live outside `config.json`, once
 * per install (DOR-2739, ADR 261006-225605, spec `trusted-by-default-flip` §5.3).
 *
 * A config migration can only change `config.json`. Two Trusted defaults live
 * elsewhere: the mesh rule that lets our agents message each other across
 * projects (this file), and who may use an existing connected app (a later
 * step). Each is a boot step that runs once and records that it ran in
 * `permissions.trustedStoresAppliedAt`, so a person who later narrows the
 * result keeps their choice: a second boot changes nothing.
 *
 * ## One stamp, several steps
 *
 * {@link applyTrustedStores} takes a list of {@link TrustedStoreStep}s and
 * stamps only when every one of them reports `'applied'`. A step that cannot
 * run yet (Relay is switched off, so there is no mesh rule to write) reports
 * `'deferred'`, and the whole list runs again on the next boot. So a step must
 * be safe to repeat until the stamp lands. A new store joins by adding its step
 * to the list at the one call site in `index.ts`, never by stamping on its own.
 *
 * The open mesh is seeded whatever the posture: Careful is about asking first,
 * not about which of our agents may talk to each other, and the switch stays in
 * Topology for anyone who wants it off.
 *
 * @module services/mesh/seed-open-mesh
 */
import type { MeshCore } from '@dorkos/mesh';
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { Logger } from '@dorkos/shared/logger';

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

/** Dependencies for {@link applyTrustedStores}. */
export interface ApplyTrustedStoresDeps {
  /** Where the stamp lives. */
  config: TrustedStoresConfig;
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
 * @param mesh - The agent registry.
 * @param relayReady - Whether Relay started on this boot.
 */
export function openMeshStep(
  mesh: Pick<MeshCore, 'allowCrossNamespace'>,
  relayReady: boolean
): TrustedStoreStep {
  return {
    name: 'open mesh',
    run: () => {
      if (!relayReady) return 'deferred';
      mesh.allowCrossNamespace('*', '*');
      return 'applied';
    },
  };
}

/**
 * Run every Trusted-store step once per install, and stamp
 * `permissions.trustedStoresAppliedAt` when all of them applied.
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
  if (config.get().trustedStoresAppliedAt != null) return true;

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
  config.set({ ...config.get(), trustedStoresAppliedAt: stamp });
  logger.info(`[Trust] Applied the trusted defaults: ${steps.map((s) => s.name).join(', ')}`);
  return true;
}

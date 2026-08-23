/**
 * Where an unattended creation form starts on the trust dial.
 *
 * A scheduled task and a relay binding both run an agent with nobody watching,
 * and both used to open hardcoded at `'acceptEdits'`. After the full-power
 * defaults, they start from the operator's OWN configured stop instead, so a
 * person who set their default to Full autonomy does not have to re-choose it on
 * every task, and a person who kept "Ask first" is not quietly opted up.
 *
 * The fall-back stays `'acceptEdits'` — byte-for-byte the old behaviour — for
 * anyone who never set a stop, so this is additive, never a silent widening.
 *
 * @module shared/lib/unattended-form-defaults
 */
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import type { ExecutionDefaults } from '@dorkos/shared/schemas';
import type { PermissionMode } from '@dorkos/shared/types';
import { resolveTrustStops } from '@dorkos/shared/permission-semantics';

/** The mode id an unattended form falls back to when no stop is configured. */
const FALLBACK_MODE: PermissionMode = 'acceptEdits';

/**
 * The operator's configured trust stop for one runtime, or `null` when they
 * never set one.
 *
 * Reads the per-runtime override first, then the global default — the same
 * precedence Settings → Runtimes resolves and the server's unattended ladder
 * applies. A stored `null` at either level means "no preference", which is a
 * reason to fall through, never a stop in its own right.
 *
 * @param executionDefaults - `config.executionDefaults`, or undefined before it loads.
 * @param runtime - The runtime the form's turns will actually run on.
 */
export function operatorStopForRuntime(
  executionDefaults: Pick<ExecutionDefaults, 'trustStop' | 'perRuntime'> | undefined,
  runtime: string
): PermissionStop | null {
  if (!executionDefaults) return null;
  const override = executionDefaults.perRuntime.find(
    (entry) => entry.runtime === runtime
  )?.trustStop;
  return override ?? executionDefaults.trustStop ?? null;
}

/**
 * The runtime mode id an unattended form should open at, given the operator's
 * configured stop and the runtime's declared modes.
 *
 * The stop is mapped through {@link resolveTrustStops} — the same function the
 * dial renders from — so a resolved default lands on exactly the mode the dial
 * would show as selected, including the first-declared rule where a runtime
 * declares two modes at one stop. Falls back to `'acceptEdits'` when no stop is
 * configured, when the runtime declares no mode at that stop, or before the
 * runtime's profile has loaded — always the old default, never a wider one.
 *
 * @param configuredStop - The operator's stop for this runtime, or null/undefined when unset.
 * @param descriptors - The runtime's declared permission modes.
 */
export function resolveConfiguredStopMode(
  configuredStop: PermissionStop | null | undefined,
  descriptors: readonly PermissionModeDescriptor[]
): PermissionMode {
  if (!configuredStop) return FALLBACK_MODE;
  const mode = resolveTrustStops(descriptors).find((s) => s.stop === configuredStop)?.mode.id;
  return (mode as PermissionMode | undefined) ?? FALLBACK_MODE;
}

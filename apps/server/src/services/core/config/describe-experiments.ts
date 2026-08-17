/**
 * Resolve {@link EXPERIMENTS} into what `GET /api/config` puts on the wire.
 *
 * The client renders this block dumbly — one switch per entry, in the order it
 * arrives — so every question that needs the server's own state is answered
 * here: what the setting currently says, and whether an environment variable has
 * taken the decision away from it. A client that had to work either out would
 * need the config file and the server's environment, and it has neither.
 *
 * @module services/core/config/describe-experiments
 */
import type { ExperimentState } from '@dorkos/shared/schemas';
import { configManager } from '../config-manager.js';
import { EXPERIMENTS, type ExperimentEntry } from './experiments-registry.js';

/**
 * Read a dot-path out of the live config.
 *
 * `configManager.getDot` exists, but it is typed against known paths; the
 * registry's whole point is that the resolver does not know which paths it is
 * holding, so it walks the section object instead.
 *
 * @param path - Dot-path of a leaf in `UserConfigSchema`.
 * @returns The stored value, or `undefined` when any hop is missing.
 */
function readConfigPath(path: string): unknown {
  const [section, ...rest] = path.split('.');
  if (section === undefined) return undefined;
  let cursor: unknown = configManager.get(section as Parameters<typeof configManager.get>[0]);
  for (const part of rest) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * Whether an environment variable, rather than the setting, decides this
 * experiment.
 *
 * PRESENCE is the question, not value — exactly as `routes/config.ts` asks it for
 * Tasks and Relay. `env.ts` parses an unset flag to `false`, so the parsed value
 * cannot tell "nobody said" from "somebody said no", and only the raw environment
 * can.
 *
 * @param entry - The registry entry.
 * @returns True when the entry names a variable that is set on this machine.
 */
function lockedByEnv(entry: ExperimentEntry): boolean {
  if (entry.envOverride === undefined) return false;
  // eslint-disable-next-line no-restricted-syntax -- Checking presence, not value: env.ts can't distinguish "unset" from "set to false"
  return entry.envOverride in process.env;
}

/**
 * Whether the experiment is ON right now.
 *
 * When a variable has taken over, the variable's VALUE is the answer — showing
 * the inert setting would put "off" over a machine where the thing is running,
 * or the reverse. Same rule the Tasks and Relay switches follow.
 *
 * `=== 'true'` is the whole parse, and it is exactly what `env.ts` does: these
 * flags are `z.enum(['true', 'false'])`, so a present value is one of those two
 * literals or the server refused to boot at all. There is no third case to be
 * lenient about.
 *
 * @param entry - The registry entry.
 * @param envName - The variable that has taken over, when one has.
 * @returns The effective position of the switch.
 */
function resolveEnabled(entry: ExperimentEntry, envName: string | undefined): boolean {
  // eslint-disable-next-line no-restricted-syntax -- The override's value, read only once presence is established
  if (envName !== undefined) return process.env[envName] === 'true';
  return readConfigPath(entry.path) === true;
}

/**
 * The `experiments` block for `GET /api/config`.
 *
 * An ARRAY, in registry order, so the client never re-sorts and never has to
 * hold an opinion about which experiment matters most. An empty array is a
 * legitimate, expected answer — see the registry's module docs.
 *
 * @returns One resolved entry per registered experiment.
 */
export function describeExperiments(): ExperimentState[] {
  return EXPERIMENTS.map((entry) => {
    const envName = lockedByEnv(entry) ? entry.envOverride : undefined;
    return {
      key: entry.path,
      title: entry.title,
      description: entry.description,
      ...(entry.costNote !== undefined && { costNote: entry.costNote }),
      enabled: resolveEnabled(entry, envName),
      lockedByEnv: envName !== undefined,
      // Only when it has actually taken over: the client interpolates this into
      // the locked-row sentence, and naming a variable that is NOT deciding
      // anything would send somebody to their shell for nothing.
      ...(envName !== undefined && { envOverride: envName }),
    };
  });
}

/**
 * Which agent tool DorkOS itself runs in a project it manages.
 *
 * DorkOS runs agents; the agents read their instructions and skills through a
 * HARNESS. `runtimes.default` names the runtime a session starts on, and
 * `harnessForRuntime` says which harness that runtime reads — so this module is
 * the one place the server turns a setting into an answer the Harness Sync
 * engine can use.
 *
 * The engine cannot ask this question itself, and deliberately: `@dorkos/harness`
 * reads no config, so every caller injects the answer. That is what makes the
 * engine testable against a fixture tree with no `~/.dork` anywhere near it.
 *
 * ## Two readers, and why the second exists
 *
 * {@link dorkosHarness} is the running server's answer, read through the config
 * manager like every other setting. {@link dorkosHarnessFromDisk} parses
 * `config.json` directly and exists for exactly one caller, for exactly the
 * reason `readHookDecisionsFromDisk` does (DOR-678): `dorkos harness sync
 * --check` is documented as never writing anything, and opening a `conf` store
 * is not a read — its constructor creates the directory and writes
 * `config.json` when either is missing. A check run from the wrong folder would
 * otherwise plant a `~/.dork` there. The two parse the SAME Zod schema, so they
 * cannot drift.
 *
 * Both answer `undefined` for a runtime with no harness (`test-mode`) and for
 * one DorkOS has never heard of. Nothing is enabled on a guess.
 *
 * @module services/harness/dorkos-harness
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { harnessForRuntime, type HarnessId } from '@dorkos/shared/harness-schemas';
import { configManager } from '../core/config-manager.js';

/**
 * The harness DorkOS's own default runtime reads, as the running server sees it.
 *
 * @returns The harness, or `undefined` when the default runtime reads none.
 */
export function dorkosHarness(): HarnessId | undefined {
  return harnessForRuntime(configManager.get('runtimes').default);
}

/**
 * The same answer, read straight off `config.json` without opening the store.
 *
 * A file that is absent, unparseable, or carrying a `runtimes` block the schema
 * rejects all resolve to the SCHEMA's own default runtime rather than to
 * nothing. That is the honest reading: the server would boot on that default
 * too, so a project it manages really would run that harness — and answering
 * `undefined` here would silently drop the notice for every person whose
 * `config.json` has not been written yet, which is every fresh install.
 *
 * @param dorkHome - The resolved DorkOS data directory holding `config.json`.
 * @returns The harness, or `undefined` when the default runtime reads none.
 */
export function dorkosHarnessFromDisk(dorkHome: string): HarnessId | undefined {
  const fallback = UserConfigSchema.shape.runtimes.parse(undefined).default;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dorkHome, 'config.json'), 'utf8'));
  } catch {
    return harnessForRuntime(fallback);
  }
  const parsed = UserConfigSchema.shape.runtimes.safeParse(
    (raw as { runtimes?: unknown } | null)?.runtimes
  );
  return harnessForRuntime(parsed.success ? parsed.data.default : fallback);
}

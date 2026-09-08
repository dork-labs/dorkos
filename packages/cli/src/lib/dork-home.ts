/**
 * Where the CLI's data directory comes from, in one place.
 *
 * `process.env.DORK_HOME || <homedir>/.dork` had been written out five times —
 * `cli.ts`, `update-check.ts`, `newsletter-tip.ts`, `lib/api-client.ts` and the
 * harness commands — each with its own copy of the eslint-disable and its own
 * half of the reason. Five copies of a path resolution is five chances for one
 * of them to drift into reading a different directory than the rest of the
 * process, which is the kind of bug that looks like "my settings did not save".
 *
 * The server has its own, stricter answer to the same question
 * (`lib/dork-home.ts` there, and `os.homedir()` is banned around it). This is
 * the CLI's, and it is deliberately separate: the CLI resolves the directory
 * BEFORE the server module ever loads, which is the whole reason it cannot just
 * ask.
 *
 * @module lib/dork-home
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The directory used when nothing names one: `~/.dork`. */
export function defaultDorkHome(): string {
  return join(homedir(), '.dork');
}

/**
 * The DorkOS data directory for a command that runs before `cli.ts` exports one.
 *
 * Reads `process.env.DORK_HOME` directly rather than the Zod-validated `env.ts`,
 * and that is not laziness: several command namespaces (`harness`, `doctor`,
 * `shape`) are intercepted at the top of `cli.ts`, before the block that
 * resolves and exports `DORK_HOME`, so `env.ts` has been parsed but the
 * imperative export has not happened yet. `cli.ts` itself passes its own
 * validated value instead — see {@link defaultDorkHome}, which is the half those
 * two calls share.
 *
 * @returns The resolved DorkOS data directory.
 */
export function resolveDorkHome(): string {
  // eslint-disable-next-line no-restricted-syntax -- these commands are intercepted in cli.ts before DORK_HOME is exported, so this mirrors its `env || ~/.dork` resolution
  return process.env.DORK_HOME || defaultDorkHome();
}

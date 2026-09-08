/**
 * Where the `dorkos harness` commands read and write hook decisions, and how
 * they render one for a person.
 *
 * Two rules govern this file, and both come from something that went wrong.
 *
 * **`--check` never writes** (DOR-678). It used to scaffold a manifest into
 * whatever directory it was invoked from, and the fix was a rule rather than a
 * patch. Opening the config store would break it again by a different route:
 * `conf`'s constructor creates the directory and writes `config.json` when
 * either is missing — measured, not assumed — so a drift check run from the
 * wrong folder would plant a `~/.dork` there. Every read-only path therefore
 * goes through {@link readHookDecisionsFromDisk}, which parses the file with the
 * same Zod schema the server uses and answers "nothing decided" when there is no
 * file. Only `--fix --allow-hooks` and `hooks --revoke` open the store, and both
 * are commands a person ran to change something.
 *
 * **One store, one digest** (contract D5). `--allow-hooks` records the same
 * `<package>@<digest>` entry the approval card writes, through the same
 * function. It is not a per-run override: allowing a package here is the same
 * decision as saying yes on the card, and `dorkos harness hooks --revoke` undoes
 * either one.
 *
 * @module harness-consent
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { WithheldHooks } from '../server/services/harness/project-with-consent.js';

/**
 * Resolve the dork home for installed-plugin projection, mirroring `cli.ts`.
 *
 * The `harness` namespace is intercepted in `cli.ts` *before* the block that
 * resolves and exports `process.env.DORK_HOME`, so we resolve it here with the
 * same precedence (`DORK_HOME` env var, else `~/.dork`). This lets GLOBAL-scope
 * installs project; PROJECT-scope installs are repo-relative and project even
 * when no home exists.
 *
 * @returns the resolved dork home directory.
 */
export function resolveDorkHome(): string {
  // eslint-disable-next-line no-restricted-syntax -- the harness branch in cli.ts runs before DORK_HOME is exported, so we mirror its `env || ~/.dork` resolution here
  return process.env.DORK_HOME || join(homedir(), '.dork');
}

/** Where a person's decisions are stored, for the messages that name the file. */
export function configPathFor(dorkHome: string): string {
  return join(dorkHome, 'config.json');
}

/**
 * Both stored lists, read without opening (or creating) the config store.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @returns The approved and refused entries.
 */
export async function readStoredDecisions(dorkHome: string): Promise<{
  approved: readonly string[];
  refused: readonly string[];
}> {
  const { readHookDecisionsFromDisk } = await import('../server/services/harness/hook-consent.js');
  return readHookDecisionsFromDisk(dorkHome);
}

/**
 * How a withheld hook's trigger is written on the left of the arrow.
 *
 * The event alone is not the decision — `Stop` runs once when a turn finishes
 * and `PreToolUse` runs before every single tool call — so the matcher travels
 * with it wherever the package narrowed one.
 */
function triggerLabel(hook: { event: string; matcher?: string }): string {
  return hook.matcher !== undefined && hook.matcher !== '*'
    ? `${hook.event} (matcher: ${hook.matcher})`
    : hook.event;
}

/**
 * The terminal block for one package whose hooks were not installed.
 *
 * Names every command, says which decision is being obeyed, and gives the exact
 * re-run — because a notice after the write is not consent, and a withheld hook
 * that is printed is (contract D5). The commands are shown as they would be
 * written into the harness file, `${CLAUDE_PLUGIN_ROOT}` already resolved, so
 * what is on screen is what would have run.
 *
 * @param withheld - One package's withheld hooks and the reason.
 * @returns The lines to print, in order.
 */
export function formatWithheldBlock(withheld: WithheldHooks): string[] {
  const { request, reason } = withheld;
  const triggers: string[] = request.hooks.map(triggerLabel);
  const width = Math.max(0, ...triggers.map((t: string) => t.length));
  return [
    '',
    `Withheld: hooks from "${request.packageName}" were not installed`,
    ...request.hooks.map(
      (hook: { command: string }, i: number) =>
        `  ${triggers[i]!.padEnd(width)}  ->  ${hook.command}`
    ),
    reason === 'refused'
      ? '  You turned this package down earlier.'
      : '  You have not allowed this package yet.',
    `  To install them: dorkos harness sync --fix --allow-hooks ${request.packageName}`,
  ];
}

/**
 * The one summary line counting what was held back.
 *
 * A count, not a list: the blocks above it name every command, and a person
 * scanning the summary wants to know whether anything was held back at all.
 *
 * @param withheld - Every package whose hooks were withheld.
 * @returns The line, or `undefined` when nothing was withheld.
 */
export function withheldSummaryLine(withheld: readonly WithheldHooks[]): string | undefined {
  if (withheld.length === 0) return undefined;
  const hooks = withheld.reduce((total, w) => total + w.request.hooks.length, 0);
  const packages = withheld.length;
  return `  ${hooks} hook${hooks === 1 ? '' : 's'} withheld from ${packages} package${packages === 1 ? '' : 's'}`;
}

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
import type { WithheldHooks } from '../server/services/harness/project-with-consent.js';

// The `harness` namespace is intercepted in `cli.ts` before DORK_HOME is
// exported, so it resolves the directory the same way three other commands do —
// through the one helper that owns that resolution. Passing a resolved home
// lets GLOBAL-scope installs project; PROJECT-scope installs are repo-relative
// and project even when no home exists.
export { resolveDorkHome } from './lib/dork-home.js';

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
  unreadable?: string;
}> {
  const { readHookDecisionsFromDisk } = await import('../server/services/harness/hook-consent.js');
  return readHookDecisionsFromDisk(dorkHome);
}

/**
 * The two lines shown when the settings file itself could not be read.
 *
 * It deliberately does NOT suggest `--allow-hooks`. That flag opens the config
 * store, and `conf`'s corrupt-recovery would back the unreadable file up and
 * replace it with defaults — resetting telemetry, login, accounts and the port
 * along with it. Being told to run the command that wipes your settings is a
 * worse outcome than the withheld hook.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @param reason - What went wrong, from `readHookDecisionsFromDisk`.
 * @returns The lines to print, in order.
 */
export function unreadableConfigLines(dorkHome: string, reason: string): string[] {
  return [
    `  DorkOS could not read ${configPathFor(dorkHome)}: ${reason}`,
    '  Fix the file before allowing hooks. Nothing is installed until DorkOS can read your answers.',
  ];
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
 * Names every command the package's `hooks/hooks.json` could be read for, says
 * which decision is being obeyed, and gives the exact re-run — because a notice
 * after the write is not consent, and a withheld hook that is printed is
 * (contract D5). The commands are shown as they would be written into the
 * harness file, `${CLAUDE_PLUGIN_ROOT}` already resolved, so what is on screen
 * is what would have run.
 *
 * "Could be read for" is the precise claim and not a hedge: a damaged
 * `hooks/hooks.json` loses declarations at read time, before consent is even a
 * question, and what it lost is reported separately in the plan's warnings —
 * which is why those warnings are computed over EVERY hook-declaring package
 * and not only the allowed ones (DOR-1724).
 *
 * A file DorkOS could not read is the one case with no re-run to offer: see
 * {@link unreadableConfigLines}.
 *
 * @param withheld - One package's withheld hooks and the reason.
 * @param dorkHome - The resolved DorkOS data directory, for the unreadable case.
 * @returns The lines to print, in order.
 */
export function formatWithheldBlock(withheld: WithheldHooks, dorkHome: string): string[] {
  const { request, reason } = withheld;
  const triggers: string[] = request.hooks.map(triggerLabel);
  const width = Math.max(0, ...triggers.map((t: string) => t.length));
  const commands = request.hooks.map(
    (hook: { command: string }, i: number) => `  ${triggers[i]!.padEnd(width)}  ->  ${hook.command}`
  );

  if (reason === 'unreadable-config') {
    return [
      '',
      `Withheld: hooks from "${request.packageName}" were not installed`,
      ...commands,
      ...unreadableConfigLines(dorkHome, withheld.unreadable ?? 'the file could not be parsed'),
    ];
  }

  return [
    '',
    `Withheld: hooks from "${request.packageName}" were not installed`,
    ...commands,
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

/**
 * `dorkos harness hooks` — see what you have decided about package hooks, and
 * change your mind.
 *
 * This is the first surface for the record that has always existed and never
 * been visible (contract VC-05). Until it, the only way to see which packages
 * you had allowed to run commands was to open `~/.dork/config.json`, and the
 * only way to change one was to edit it — which is also why a "no" could not be
 * written down at all: a decision with no way back is not one a misclick should
 * be able to make. `--revoke` is that way back, which is what lets a refusal
 * last (DOR-1849).
 *
 * `--list` never writes, and it goes out of its way not to: it reads
 * `config.json` directly rather than opening the config store, whose constructor
 * would create the file and the directory around it (see `harness-consent.ts`).
 *
 * @module harness-hooks-command
 */
import { parseArgs } from 'node:util';
import { rethrowUnknownOption } from './lib/parse-args-error.js';
import { configPathFor, readStoredDecisions, resolveDorkHome } from './harness-consent.js';

/** Parsed arguments accepted by {@link runHarnessHooks}. */
export interface HarnessHooksArgs {
  /** Show every stored decision. Never writes. */
  list: boolean;
  /** The package whose decisions to forget, when one was named. */
  revoke?: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos harness hooks [--list] [--revoke <package>]';

/**
 * Parse raw CLI arguments for `dorkos harness hooks`.
 *
 * Expected shape: `[--list] [--revoke <package>]`. Bare `hooks` means `--list`,
 * because listing is the read-only half and a command that does nothing is worse
 * than one that shows you where you stand. Throws an `Error` (caught and
 * formatted by the dispatcher) on an unknown option.
 *
 * @param rawArgs - Raw argv slice that comes after `harness hooks`.
 * @returns Parsed {@link HarnessHooksArgs}.
 */
export function parseHarnessHooksArgs(rawArgs: string[]): HarnessHooksArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        list: { type: 'boolean', default: false },
        revoke: { type: 'string' },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'harness hooks', USAGE_LINE);
  }

  const { values } = parsed;
  const revoke = typeof values.revoke === 'string' ? values.revoke : undefined;
  return { list: Boolean(values.list) || revoke === undefined, revoke };
}

/**
 * Print every stored decision, saying which ones apply to the project you are
 * standing in.
 *
 * A decision is `<package>@<digest>` over the project path and the exact
 * commands, and the digest is one-way — so an entry cannot say which project it
 * came from. What CAN be computed is whether it matches what that package
 * declares HERE, right now, and that is the only distinction that changes
 * anything: an entry that does not match is inert, and the package is treated as
 * undecided wherever it now differs.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @returns 0 when the file was read, 1 when it could not be.
 */
async function listDecisions(dorkHome: string): Promise<number> {
  const { approved, refused, unreadable } = await readStoredDecisions(dorkHome);

  // "No hook decisions stored yet" over a file full of them is the worst
  // sentence this command could print, so an unreadable file says what it is
  // and stops.
  //
  // Exit 1 here while `harness sync --fix` exits 0 for the same file, and the
  // difference is the commands, not an oversight: sync did its whole job apart
  // from the hooks it held back, which is a decision being obeyed rather than a
  // failure (contract D5). Listing your decisions IS this command's only job,
  // and it could not do it. There is no partial success to report.
  if (unreadable !== undefined) {
    console.error(`DorkOS could not read ${configPathFor(dorkHome)}: ${unreadable}`);
    console.error(
      '  Fix the file to see your decisions. Until then DorkOS holds every package’s hooks back.'
    );
    return 1;
  }

  if (approved.length === 0 && refused.length === 0) {
    console.log('No hook decisions stored yet.');
    console.log(
      '  A package that ships hooks is held back until you allow it, and nothing here has been asked about.'
    );
    return 0;
  }

  const { hookApprovalEntry, hookEntryPackageName } =
    await import('../server/services/harness/hook-consent.js');
  const { scanHookRequests } = await import('../server/services/harness/project-with-consent.js');

  // The entries this project's packages would produce RIGHT NOW. Scanning the
  // installed packages needs no manifest and builds no plan, so it answers the
  // same way in a directory that is not a project — as an empty set, which reads
  // as "none of these are about here".
  const here = new Set(
    scanHookRequests(process.cwd(), dorkHome).map((request) => hookApprovalEntry(request))
  );

  console.log(`Hook decisions stored in ${configPathFor(dorkHome)}:`);
  for (const [heading, entries] of [
    ['Allowed to run commands', approved],
    ['Turned down', refused],
  ] as const) {
    if (entries.length === 0) continue;
    console.log('');
    console.log(`${heading}:`);
    for (const entry of entries) {
      const where = here.has(entry)
        ? 'matches the hooks installed in this project'
        : 'from another project, or from before this package changed its hooks';
      console.log(`  ${hookEntryPackageName(entry)} — ${where}`);
    }
  }
  console.log('');
  console.log('Forget one with `dorkos harness hooks --revoke <package>`.');
  return 0;
}

/**
 * Forget every stored decision for one package, and say what was removed.
 *
 * Scoped by package name — see `revokeHookDecisions`, which states why the
 * project cannot be narrowed further and why the wider scope is safe: removing a
 * decision only ever means "ask me again".
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @param packageName - The package to forget.
 * @returns 0 when something was removed, 1 when there was nothing to remove.
 */
async function revokeDecisions(dorkHome: string, packageName: string): Promise<number> {
  const { initConfigManager } = await import('../server/services/core/config-manager.js');
  const { revokeHookDecisions } = await import('../server/services/harness/hook-consent.js');
  initConfigManager(dorkHome);
  const removed = revokeHookDecisions(packageName);

  if (removed.length === 0) {
    console.error(`Nothing stored for '${packageName}'.`);
    console.error('  Run `dorkos harness hooks --list` to see what is on file.');
    return 1;
  }

  console.log(
    `Forgot ${removed.length} decision${removed.length === 1 ? '' : 's'} for "${packageName}":`
  );
  for (const { decision } of removed) {
    console.log(decision === 'approved' ? '  was: allowed' : '  was: turned down');
  }
  console.log('');
  console.log(
    'The next `dorkos harness sync --fix` will hold this package’s hooks back and say so, and DorkOS will ask again the next time it is installed.'
  );
  return 0;
}

/**
 * Implements `dorkos harness hooks`.
 *
 * Returns an exit code rather than calling `process.exit` — exit-code policy
 * lives in the dispatcher.
 *
 * @param args - Parsed {@link HarnessHooksArgs}.
 * @returns An object carrying the process exit code.
 */
export async function runHarnessHooks(args: HarnessHooksArgs): Promise<{ exitCode: number }> {
  const dorkHome = resolveDorkHome();
  try {
    if (args.revoke !== undefined) {
      if (args.revoke.trim() === '') {
        console.error('--revoke needs a package name.');
        console.error(USAGE_LINE);
        return { exitCode: 1 };
      }
      return { exitCode: await revokeDecisions(dorkHome, args.revoke) };
    }
    return { exitCode: await listDecisions(dorkHome) };
  } catch (err) {
    console.error(`Harness hooks failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  settings file: ${configPathFor(dorkHome)}`);
    return { exitCode: 1 };
  }
}

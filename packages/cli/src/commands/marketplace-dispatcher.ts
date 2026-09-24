/**
 * Top-level dispatcher for the `dorkos marketplace <subcommand>` namespace:
 * the one home for everything marketplace — packages (`install`, `update`,
 * `uninstall`, `installed`, `outdated`) and sources (`add`, `remove`, `list`,
 * `refresh`, `validate`).
 *
 * `dorkos install`, `dorkos update` and `dorkos uninstall` are shorthand for the
 * same three package verbs: `cli.ts` hands them straight to this dispatcher, so
 * both spellings run one handler and print one help text. Every other
 * multi-verb domain in this CLI is a noun namespace (`cache`, `agent`,
 * `connections`, …), and a bare `dorkos update` reads as updating DorkOS itself,
 * so the namespaced form is the one the help and docs teach; the shorthand stays
 * because it is published, scripted against, and printed on dorkos.ai.
 *
 * Lives in its own module so `cli.ts` can stay focused on global flag
 * parsing and server bootstrap. The dispatcher owns:
 *
 * - Help text for `marketplace` itself (no/`--help`/`-h` subcommand) and for
 *   each package verb (`<verb> --help`).
 * - Dispatch into the leaf command modules, imported on demand (`outdated`
 *   statically, since its exit codes shape the dispatcher's own error path).
 * - Uniform error rendering for parse and runtime failures.
 *
 * Like every other command handler in this package, the dispatcher
 * returns the intended exit code rather than calling `process.exit`
 * directly — `cli.ts` remains the single source of truth for process
 * termination.
 *
 * @module commands/marketplace-dispatcher
 */
import {
  OUTDATED_EXIT,
  parseMarketplaceOutdatedArgs,
  runMarketplaceOutdated,
} from './marketplace-outdated.js';

/** Help text rendered when the user runs `dorkos marketplace` with no subcommand or `--help`. */
const HELP_TEXT = `
Usage: dorkos marketplace <subcommand> [options]

Install, update and remove marketplace packages on the running DorkOS server,
manage the marketplace sources they come from, and validate a marketplace
before publishing it.

Packages:
  install <name>              Install a package
  update [<name>]             Check for updates; add --apply to install them
  uninstall <name>            Remove an installed package
  installed                   List what is installed, and where
  outdated                    List only the packages that have an update
                                (exits 1 when any do, for scripts)

Sources:
  add <url> [--name <name>]   Register a marketplace source
  remove <name>               Remove a registered marketplace source
  list                        List configured marketplace sources
  refresh [<name>]            Re-fetch one or every marketplace.json
  validate <path-or-url>      Validate a marketplace.json (local path
                                or remote HTTPS URL) against the DorkOS
                                schema + strict Claude Code schema;
                                also checks the optional dorkos.json
                                sidecar. No clone; HTTPS fetch only.

\`dorkos install\`, \`dorkos update\` and \`dorkos uninstall\` are shorthand
for the same package commands. Run \`dorkos marketplace <subcommand> --help\`
for a package command's options.

Examples:
  dorkos marketplace install code-review-suite
  dorkos marketplace outdated
  dorkos marketplace update --apply
  dorkos marketplace installed --project .
  dorkos marketplace add https://github.com/acme/plugins --name acme
  dorkos marketplace refresh dorkos-community
  dorkos marketplace validate https://github.com/dork-labs/marketplace

Exit codes for \`validate\`:
  0  All checks pass
  1  Fetch/read failed, DorkOS schema failed, sidecar invalid, or reserved name
  2  DorkOS schema passes but strict Claude Code compatibility fails
     (i.e. your marketplace drifted out of the CC superset — move the
     offending fields to the dorkos.json sidecar)
`;

/** Help for each package verb, printed for `<verb> --help` under either spelling. */
const VERB_HELP: Record<string, string> = {
  install: `
Usage: dorkos marketplace install <name> [options]
       dorkos install <name> [options]

Install a marketplace package on the running DorkOS server. It shows what the
package will be allowed to do and asks before installing.

Options:
      --marketplace <name>  Marketplace identifier (e.g. dorkos-community)
      --source <url>        Explicit Git URL or marketplace.json URL
      --force               Override warning-level conflicts
  -y, --yes                 Skip the interactive confirmation prompt
      --project <path>      Project path for project-local installs

Examples:
  dorkos marketplace install code-review-suite
  dorkos marketplace install code-review-suite@dorkos-community
  dorkos marketplace install --yes --force my-package
`,
  update: `
Usage: dorkos marketplace update [<name>] [options]
       dorkos update [<name>] [options]

Check installed marketplace packages for a newer version. On its own it only
checks and changes nothing; add --apply to install the updates it finds. Before
it installs anything it prints everything each new version runs (commands,
servers, programs) and asks. Each package is updated where it is installed,
exactly as printed: if a new version changes what it runs in the meantime,
nothing is updated.

Options:
      --apply             Apply the updates (default: advisory only)
  -y, --yes               Do not ask before applying (it still prints what runs)
      --approval <token>  Retry an update a person approved in DorkOS
      --project <path>    Check what this project sees (global installs plus its own)

Examples:
  dorkos marketplace update                       # check every installed package
  dorkos marketplace update code-review-suite     # check a single package
  dorkos marketplace update --apply               # review and apply every available update
`,
  uninstall: `
Usage: dorkos marketplace uninstall <name> [options]
       dorkos uninstall <name> [options]

Remove an installed marketplace package from the running DorkOS server.

Removing a package cannot be undone, so an agent has to get a person's approval
first: the command answers with an approval id and a token, and you run it again
with --approval once the person has said yes in DorkOS.

Options:
      --purge             Remove preserved data and secrets in addition to package files
      --project <path>    Project path for project-local uninstalls
      --approval <token>  Approval token from a previous run that was waiting on a person

Examples:
  dorkos marketplace uninstall code-review-suite
  dorkos marketplace uninstall --purge code-review-suite
  dorkos marketplace uninstall code-review-suite --approval appr_tok_...
`,
  installed: `
Usage: dorkos marketplace installed [options]

List every installed marketplace package: its version, its type, and where it
is installed. A package installed globally and for two agents is three rows.

Options:
      --project <path>  List what this project sees (global installs plus its own)
      --json            Print { "installed": [...] } instead of a table

Examples:
  dorkos marketplace installed
  dorkos marketplace installed --project .
`,
  outdated: `
Usage: dorkos marketplace outdated [options]

List the installed marketplace packages that have a newer version, and any that
could not be checked. It changes nothing; run \`dorkos marketplace update --apply\`
to install the updates.

Options:
      --project <path>  Check what this project sees (global installs plus its own)
      --json            Print { "outdated": [...], "unknown": [...], "linked": [...] }
                        instead of lines

Exit codes:
  0  Every installed package is up to date (or nothing is installed)
  1  At least one package has an update
  2  Could not tell: nothing has an update, but a package could not be
     checked, or the check itself failed (for example, DorkOS is not running)

A package linked to a working copy on this computer is never checked. It is
listed under "Linked, not checked" and does not change the exit code.

Examples:
  dorkos marketplace outdated
  dorkos marketplace outdated --project . --json
`,
};

/** Every subcommand, in the order the one-line usage names them. */
const SUBCOMMANDS = 'install|update|uninstall|installed|outdated|add|remove|list|refresh|validate';

/**
 * Dispatch a `dorkos marketplace <subcommand>` invocation.
 *
 * @param subcommand - The subcommand name (e.g. `install`, `outdated`, `add`).
 *   Pass `undefined`, `--help`, or `-h` to print help.
 * @param subArgs - The argv slice that follows the subcommand.
 * @returns The intended process exit code: `0` success, `1` error, except
 *   `outdated`, which answers with {@link OUTDATED_EXIT}, and `validate`,
 *   which has its own `2`.
 */
export async function runMarketplaceDispatcher(
  subcommand: string | undefined,
  subArgs: string[]
): Promise<number> {
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP_TEXT);
    return 0;
  }

  if (Object.hasOwn(VERB_HELP, subcommand) && subArgs.some((a) => a === '--help' || a === '-h')) {
    console.log(VERB_HELP[subcommand]);
    return 0;
  }

  // `outdated` answers with its exit code, so its own failures must read as
  // "could not tell" (2), never as the generic 1 that means "out of date" there.
  if (subcommand === 'outdated') {
    try {
      return await runMarketplaceOutdated(parseMarketplaceOutdatedArgs(subArgs));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      return OUTDATED_EXIT.unknown;
    }
  }

  try {
    if (subcommand === 'install') {
      const { runInstall, parseInstallArgs } = await import('./install.js');
      return await runInstall(parseInstallArgs(subArgs));
    }
    if (subcommand === 'update') {
      const { runUpdate, parseUpdateArgs } = await import('./update.js');
      return await runUpdate(parseUpdateArgs(subArgs));
    }
    if (subcommand === 'uninstall') {
      const { runUninstall, parseUninstallArgs } = await import('./uninstall.js');
      return await runUninstall(parseUninstallArgs(subArgs));
    }
    if (subcommand === 'installed') {
      const { runMarketplaceInstalled, parseMarketplaceInstalledArgs } =
        await import('./marketplace-installed.js');
      return await runMarketplaceInstalled(parseMarketplaceInstalledArgs(subArgs));
    }
    if (subcommand === 'add') {
      const { runMarketplaceAdd, parseMarketplaceAddArgs } = await import('./marketplace-add.js');
      return await runMarketplaceAdd(parseMarketplaceAddArgs(subArgs));
    }
    if (subcommand === 'remove') {
      const { runMarketplaceRemove, parseMarketplaceRemoveArgs } =
        await import('./marketplace-remove.js');
      return await runMarketplaceRemove(parseMarketplaceRemoveArgs(subArgs));
    }
    if (subcommand === 'list') {
      const { runMarketplaceList, parseMarketplaceListArgs } =
        await import('./marketplace-list.js');
      parseMarketplaceListArgs(subArgs);
      return await runMarketplaceList();
    }
    if (subcommand === 'refresh') {
      const { runMarketplaceRefresh, parseMarketplaceRefreshArgs } =
        await import('./marketplace-refresh.js');
      return await runMarketplaceRefresh(parseMarketplaceRefreshArgs(subArgs));
    }
    if (subcommand === 'validate') {
      const { runMarketplaceValidate, parseMarketplaceValidateArgs } =
        await import('./marketplace-validate.js');
      return await runMarketplaceValidate(parseMarketplaceValidateArgs(subArgs));
    }

    console.error(`Unknown marketplace subcommand: ${subcommand}`);
    console.error(`Usage: dorkos marketplace <${SUBCOMMANDS}> [args]`);
    return 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

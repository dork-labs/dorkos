/**
 * Top-level dispatcher for the `dorkos marketplace <subcommand>` namespace.
 *
 * Lives in its own module so `cli.ts` can stay focused on global flag
 * parsing and server bootstrap. The dispatcher is invoked from the
 * top-of-file interception block in `cli.ts` and owns:
 *
 * - Help text for `marketplace` itself (no/`--help`/`-h` subcommand).
 * - Dynamic-import dispatch into the four leaf command modules
 *   (`add`/`remove`/`list`/`refresh`).
 * - Uniform error rendering for parse and runtime failures.
 *
 * Like every other command handler in this package, the dispatcher
 * returns the intended exit code rather than calling `process.exit`
 * directly — `cli.ts` remains the single source of truth for process
 * termination.
 *
 * @module commands/marketplace-dispatcher
 */

/** Help text rendered when the user runs `dorkos marketplace` with no subcommand or `--help`. */
const HELP_TEXT = `
Usage: dorkos marketplace <subcommand> [options]

Manage marketplace sources on the running DorkOS server, and validate
marketplace registries before publishing them.

Subcommands:
  add <url> [--name <name>]   Register a marketplace source
  remove <name>               Remove a registered marketplace source
  list                        List configured marketplace sources
  refresh [<name>]            Re-fetch one or every marketplace.json
  validate <path-or-url>      Validate a marketplace.json (local path
                                or remote HTTPS URL) against the DorkOS
                                schema + strict Claude Code schema;
                                also checks the optional dorkos.json
                                sidecar. No clone; HTTPS fetch only.

Examples:
  dorkos marketplace add https://github.com/dorkos/marketplace
  dorkos marketplace add https://github.com/acme/plugins --name acme
  dorkos marketplace list
  dorkos marketplace refresh
  dorkos marketplace refresh dorkos-community
  dorkos marketplace remove acme
  dorkos marketplace validate ./.claude-plugin/marketplace.json
  dorkos marketplace validate https://github.com/dork-labs/marketplace

Exit codes for \`validate\`:
  0  All checks pass
  1  Fetch/read failed, DorkOS schema failed, sidecar invalid, or reserved name
  2  DorkOS schema passes but strict Claude Code compatibility fails
     (i.e. your marketplace drifted out of the CC superset — move the
     offending fields to the dorkos.json sidecar)
`;

/**
 * Dispatch a `dorkos marketplace <subcommand>` invocation.
 *
 * @param subcommand - The subcommand name (e.g. `add`, `remove`, `list`,
 *   `refresh`). Pass `undefined`, `--help`, or `-h` to print help.
 * @param subArgs - The argv slice that follows the subcommand.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runMarketplaceDispatcher(
  subcommand: string | undefined,
  subArgs: string[]
): Promise<number> {
  if (subcommand === undefined || subcommand === '--help' || subcommand === '-h') {
    console.log(HELP_TEXT);
    return 0;
  }

  try {
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
    console.error('Usage: dorkos marketplace <add|remove|list|refresh|validate> [args]');
    return 1;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

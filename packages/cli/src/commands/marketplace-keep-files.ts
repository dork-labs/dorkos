/**
 * CLI handler for `dorkos marketplace keep-files <name>` (DOR-2341).
 *
 * When an update of a package couldn't tell whether some files were yours or
 * left over from the earlier version, it kept them, and Check files sorts them
 * once that version can be fetched. A package installed from a folder on this
 * computer, or one whose version no longer exists, never has that version, so
 * its kept files would be listed forever. This makes them yours:
 *
 * - it prints the kept files, marking the ones that still run;
 * - for a global package held back from sessions, it prints everything the
 *   package runs, and your yes also approves what it discloses now, like a
 *   Review;
 * - it asks (skip with `--yes`), then sends back exactly what it printed.
 *
 * Nothing is moved or deleted. Deciding is yours: the server refuses an agent,
 * and with sign-in on it takes this only from a signed-in session in the app,
 * so this command then points you there.
 *
 * @module commands/marketplace-keep-files
 */
import { parseArgs } from 'node:util';
import type {
  HeldBackPackage,
  InstalledPackage,
  KeepFilesOptions,
  KeepFilesResult,
} from '@dorkos/shared/marketplace-schemas';
import { ApiError, apiCall } from '../lib/api-client.js';
import { confirm } from '../lib/confirm-prompt.js';
import { renderDisclosureLines } from '../lib/disclosure-render.js';
import { printError, printJson } from '../lib/operator-output.js';
import { resolveProjectFlag } from '../lib/package-commands.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Parsed CLI arguments accepted by {@link runMarketplaceKeepFiles}. */
export interface MarketplaceKeepFilesArgs {
  /** The installed package whose kept files to keep. */
  name: string;
  /** The project the installation belongs to, for a project-scoped install. */
  projectPath?: string;
  /** Do not ask first (it still prints what it keeps). */
  yes: boolean;
  /** Print the server's answer as JSON. */
  json: boolean;
}

/** The code the server answers with when only a signed-in session may do this. */
const OPERATOR_COOKIE_REQUIRED = 'operator_cookie_required';

/** One-line usage string surfaced in error messages. */
const USAGE_LINE =
  'Usage: dorkos marketplace keep-files <name> [--project <path>] [--yes] [--json]';

/**
 * Parse the raw argv slice that follows `dorkos marketplace keep-files`.
 *
 * @param rawArgs - The argv slice after `marketplace keep-files`.
 * @returns A typed {@link MarketplaceKeepFilesArgs} object.
 * @throws When no package name is given.
 */
export function parseMarketplaceKeepFilesArgs(rawArgs: string[]): MarketplaceKeepFilesArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        project: { type: 'string' },
        yes: { type: 'boolean', short: 'y', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'marketplace keep-files', USAGE_LINE);
  }
  const [name] = parsed.positionals;
  if (!name) throw new Error(`Name the package whose kept files to keep.\n${USAGE_LINE}`);
  const projectPath = resolveProjectFlag(parsed.values.project);
  return {
    name,
    ...(projectPath !== undefined && { projectPath }),
    yes: Boolean(parsed.values.yes),
    json: Boolean(parsed.values.json),
  };
}

/** The installation of `name` this command acts on: the project's, or the global one. */
async function findInstallation(args: MarketplaceKeepFilesArgs): Promise<InstalledPackage | null> {
  const query = [
    ...(args.projectPath ? [`projectPath=${encodeURIComponent(args.projectPath)}`] : []),
    'verify=true',
  ].join('&');
  const { packages } = await apiCall<{ packages: InstalledPackage[] }>(
    'GET',
    `/api/marketplace/installed?${query}`
  );
  const named = packages.filter((p) => p.name === args.name);
  if (args.projectPath) return named[0] ?? null;
  return named.find((p) => p.scope === undefined || p.scope === 'global') ?? null;
}

/**
 * Implements `dorkos marketplace keep-files`.
 *
 * @param args - Parsed arguments.
 * @returns `0` when the files are yours now (or nothing was kept, or you said
 *   no), `1` when the server refused or the package is not installed.
 */
export async function runMarketplaceKeepFiles(args: MarketplaceKeepFilesArgs): Promise<number> {
  let installation: InstalledPackage | null;
  try {
    installation = await findInstallation(args);
  } catch (err) {
    printError(err);
    return 1;
  }
  if (!installation) {
    console.error(`${args.name} is not installed${args.projectPath ? ' in that project' : ''}.`);
    return 1;
  }
  const integrity = installation.integrity;
  const unproven = integrity && integrity.status !== 'unknown' ? integrity.unproven : undefined;
  if (!unproven) {
    console.log(`${args.name} has no kept files to sort.`);
    return 0;
  }
  // Check files comes first where it can help: it sets leftovers aside
  // rather than keeping them (DOR-2341).
  if (unproven.check.source !== 'local' && unproven.check.last?.outcome !== 'fetch-failed') {
    console.log(
      `Check files can sort the files ${args.name} kept: run ` +
        `\`dorkos marketplace check-files ${args.name}\` first. Nothing was changed.`
    );
    return 0;
  }

  console.log(
    `An update of ${args.name} kept ${unproven.files.length === 1 ? 'this file' : 'these files'}, ` +
      'and DorkOS has no earlier version to sort them with:'
  );
  for (const file of unproven.files) {
    console.log(`  ${file}${unproven.running.includes(file) ? ' (runs)' : ''}`);
  }
  if (integrity && integrity.status !== 'unknown' && integrity.truncated) {
    console.log('  (Only the first 50 are listed. Keeping keeps them all.)');
  }
  console.log('Keeping them makes them yours: updates keep them, and nothing is moved or deleted.');

  // A held-back global package is approved too (what it discloses now, like a
  // Review), so the
  // person sees everything it runs first.
  let review: KeepFilesOptions['review'];
  if (installation.heldBack && !args.projectPath) {
    const { packages } = await apiCall<{ packages: HeldBackPackage[] }>(
      'GET',
      '/api/marketplace/held-back'
    );
    const held = packages.find((p) => p.name === args.name);
    if (held?.effects && held.bindsTo) {
      review = { effects: held.effects, bindsTo: held.bindsTo };
      console.log('');
      console.log(
        `${args.name} is held back from sessions. Keeping also lets it run, in every session:`
      );
      for (const line of renderDisclosureLines(held.effects, 'global')) console.log(line);
    }
  }
  console.log('');

  if (!args.yes) {
    const proceed = await confirm(`Keep these files as yours?`);
    if (!proceed) {
      console.log('Nothing was changed.');
      return 0;
    }
  }

  let result: KeepFilesResult;
  try {
    result = await apiCall<KeepFilesResult>(
      'POST',
      `/api/marketplace/packages/${encodeURIComponent(args.name)}/keep-files`,
      {
        ...(args.projectPath !== undefined && { projectPath: args.projectPath }),
        installRoot: installation.installPath,
        keepKey: unproven.keepKey,
        ...(review && { review }),
      } satisfies KeepFilesOptions
    );
  } catch (err) {
    if (err instanceof ApiError && err.body.code === OPERATOR_COOKIE_REQUIRED) {
      console.error(
        `Nothing was changed. DorkOS requires sign-in, so do this in the app: open ` +
          `Marketplace, then Installed, and press Keep these as mine on ${args.name}.`
      );
      return 1;
    }
    if (err instanceof ApiError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  if (args.json) printJson(result);
  else console.log(result.message);
  return 0;
}

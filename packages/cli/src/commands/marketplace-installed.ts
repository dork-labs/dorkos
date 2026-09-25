/**
 * CLI handler for `dorkos marketplace installed`.
 *
 * Calls `GET /api/marketplace/installed` (with `?projectPath=` for `--project`)
 * and prints one row per installation: a package installed globally and on two
 * agents is three rows, each naming where it lives. Without `--project` that is
 * every scope; with it, the view one project sees (global installs plus its
 * own). `--json` prints `{ installed }`, the server's rows untouched.
 * `--verify` also says whether each installation's files still match what
 * was installed (DOR-2197), in a FILES column.
 *
 * @module commands/marketplace-installed
 */
import { parseArgs } from 'node:util';
import type { InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import { apiCall } from '../lib/api-client.js';
import { placeOf } from '../lib/installation-label.js';
import { printError, printJson, renderTable } from '../lib/operator-output.js';
import { resolveProjectFlag } from '../lib/package-commands.js';
import { rethrowUnknownOption } from '../lib/parse-args-error.js';

/** Parsed CLI arguments accepted by {@link runMarketplaceInstalled}. */
export interface MarketplaceInstalledArgs {
  /** List this project's view (global installs plus its own) instead of every scope. */
  projectPath?: string;
  /** Print `{ installed }` as JSON instead of a table. */
  json: boolean;
  /** Also check each installation's files against what was installed. */
  verify: boolean;
}

/** Response shape for `GET /api/marketplace/installed`. */
interface InstalledResponseBody {
  packages: InstalledPackage[];
}

/** The `--json` document: an object, like `outdated`'s, so fields can be added later. */
export interface InstalledJson {
  /** The server's rows, untouched, in its order: one per installation. */
  installed: InstalledPackage[];
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos marketplace installed [--project <path>] [--verify] [--json]';

/**
 * Parse the raw argv slice that follows `dorkos marketplace installed`.
 *
 * @param rawArgs - The argv slice after `marketplace installed`.
 * @returns A typed {@link MarketplaceInstalledArgs} object.
 */
export function parseMarketplaceInstalledArgs(rawArgs: string[]): MarketplaceInstalledArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: rawArgs,
      options: {
        project: { type: 'string' },
        json: { type: 'boolean', default: false },
        verify: { type: 'boolean', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    rethrowUnknownOption(err, 'marketplace installed', USAGE_LINE);
  }
  const { values } = parsed;
  return {
    projectPath: resolveProjectFlag(values.project),
    json: Boolean(values.json),
    verify: Boolean(values.verify),
  };
}

/** What the FILES column says about one installation, or `undefined` when it was not verified. */
function filesOf(pkg: InstalledPackage): string | undefined {
  const integrity = pkg.integrity;
  if (!integrity) return undefined;
  const kept = integrity.status !== 'unknown' && integrity.unproven;
  const keptNote = kept ? `, ${kept.files.length} kept` : '';
  switch (integrity.status) {
    case 'clean':
      return `as installed${keptNote}`;
    case 'modified':
      return `changed (${integrity.changed.length + integrity.missing.length + integrity.added.length}${integrity.truncated ? '+' : ''})${keptNote}`;
    case 'unknown':
      return integrity.reason === 'linked' ? '-' : 'unknown';
  }
}

/** The short notes a row carries, in a fixed order. */
function notesOf(pkg: InstalledPackage): string {
  return [
    pkg.linked && 'linked',
    pkg.scope === 'override' && 'overrides global',
    pkg.dependencyWarnings && pkg.dependencyWarnings.length > 0 && 'libraries incomplete',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Render the installed table. Pure, so tests can check formatting without I/O.
 * The NOTES column appears only when some row has a note.
 *
 * @param packages - The installations, in the server's order.
 * @returns The table: a header, a separator, and one row per installation.
 */
export function renderInstalledTable(packages: InstalledPackage[]): string {
  const withFiles = packages.some((pkg) => pkg.integrity !== undefined);
  const rows = packages.map((pkg) => ({
    cells: [
      pkg.name,
      pkg.version || '-',
      pkg.type,
      placeOf(pkg) ?? 'global',
      ...(withFiles ? [filesOf(pkg) ?? '-'] : []),
    ],
    notes: notesOf(pkg),
  }));
  const withNotes = rows.some((r) => r.notes !== '');
  const headers = [
    'NAME',
    'VERSION',
    'TYPE',
    'WHERE',
    ...(withFiles ? ['FILES'] : []),
    ...(withNotes ? ['NOTES'] : []),
  ];
  const table = renderTable(
    headers,
    rows.map((r) => (withNotes ? [...r.cells, r.notes] : r.cells))
  );
  // The table pads every cell, the last included; trailing spaces help no one.
  return table
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

/**
 * Implements `dorkos marketplace installed`.
 *
 * @param args - Parsed arguments.
 * @returns The intended process exit code (`0` success, `1` error).
 */
export async function runMarketplaceInstalled(args: MarketplaceInstalledArgs): Promise<number> {
  let packages: InstalledPackage[];
  try {
    const params = [
      ...(args.projectPath ? [`projectPath=${encodeURIComponent(args.projectPath)}`] : []),
      ...(args.verify ? ['verify=true'] : []),
    ];
    const query = params.length > 0 ? `?${params.join('&')}` : '';
    ({ packages } = await apiCall<InstalledResponseBody>(
      'GET',
      `/api/marketplace/installed${query}`
    ));
  } catch (err) {
    printError(err);
    return 1;
  }

  if (args.json) {
    printJson({ installed: packages } satisfies InstalledJson);
    return 0;
  }
  if (packages.length === 0) {
    console.log("No packages installed. Run 'dorkos marketplace install <name>' to install one.");
    return 0;
  }

  console.log(renderInstalledTable(packages));
  const older = packages.filter(
    (p) =>
      p.integrity?.status === 'unknown' &&
      (p.integrity.reason === 'no-record' || p.integrity.reason === 'inferred')
  );
  const checkable = older.filter(
    (p) => p.integrity?.status === 'unknown' && p.integrity.check?.source !== 'local'
  );
  const fromFolder = older.filter((p) => !checkable.includes(p));
  if (older.length > 0) {
    console.log('');
    console.log('unknown: installed by an older DorkOS, which did not record its files.');
    if (checkable.length > 0) {
      console.log(
        `  Run 'dorkos marketplace check-files ${checkable[0].name}' so updates keep your edits.`
      );
    }
    if (fromFolder.length > 0) {
      console.log(
        `  ${fromFolder.map((p) => p.name).join(', ')}: installed from a folder on this computer; reinstall to keep your edits on update.`
      );
    }
  }
  // Files an update kept because nothing proved whose they were (DOR-2322).
  const sortable = packages.filter(
    (p) =>
      p.integrity !== undefined &&
      p.integrity.status !== 'unknown' &&
      p.integrity.unproven !== undefined &&
      p.integrity.unproven.check.source !== 'local'
  );
  if (packages.some((p) => p.integrity?.status !== 'unknown' && p.integrity?.unproven)) {
    console.log('');
    console.log(
      "kept: files an update kept because DorkOS couldn't tell whether they were yours." +
        (sortable.length > 0
          ? ` Run 'dorkos marketplace check-files ${sortable[0].name}' to sort them.`
          : " Delete any you don't need.")
    );
  }
  if (packages.some((p) => p.linked)) {
    console.log('');
    console.log(
      'linked: a folder linked to a working copy on this computer. DorkOS never ' +
        'updates it; update its source instead.'
    );
  }
  return 0;
}

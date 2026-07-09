import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ARCHIVE_DIR, OUTPUT_DIR } from './config.js';

/**
 * The archive primitive: freeze the currently published product media under
 * `archive/<label>/` so a docs page or changelog entry that embeds a *past*
 * version keeps resolving forever. The live path (`/product/<file>`) always
 * shows the latest capture; an archived path (`/product/archive/<label>/<file>`)
 * is immutable once written.
 *
 * Release automation passes only the shots a release's notes actually embed
 * (`--shots a,b,c`), keeping the committed archive small — archive only what you
 * link to.
 *
 * Run with: `pnpm --filter @dorkos/e2e capture:archive <label> [--shots a,b,c]`.
 *
 * @module capture/archive
 */

/** One asset row from the published manifest (the fields the archive needs). */
interface ManifestAsset {
  file: string;
  surface: string;
  [key: string]: unknown;
}

/** The subset of the published manifest the archive reads. */
interface PublishedManifest {
  schemaVersion?: number;
  generatedAt?: string;
  runId?: string;
  assets: ManifestAsset[];
  shots?: unknown[];
}

/** Parsed archive command arguments. */
interface ArchiveArgs {
  label: string;
  /** When set, only these shot ids are archived; otherwise every published asset. */
  shots?: string[];
}

/** Parse `<label> [--shots a,b,c]` from argv, validating the label. */
function parseArgs(argv: string[]): ArchiveArgs {
  const positional: string[] = [];
  let shots: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--shots') {
      const value = argv[++i];
      if (!value) throw new Error('--shots requires a comma-separated list of shot ids');
      shots = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  const label = positional[0];
  if (!label) {
    throw new Error('archive requires a <label> (e.g. v0.45.0)');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
    throw new Error(
      `invalid archive label "${label}" — use letters, digits, dots, dashes, or underscores (e.g. v0.45.0)`
    );
  }
  return { label, shots };
}

/** Archive the currently published set (or a subset of shots) under `<label>/`. */
export async function runArchive(args: ArchiveArgs): Promise<void> {
  const manifestPath = path.join(OUTPUT_DIR, 'manifest.json');
  let manifest: PublishedManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as PublishedManifest;
  } catch {
    throw new Error(
      `no published manifest at ${manifestPath} — run \`capture\` or \`capture:process\` first`
    );
  }

  const dest = path.join(ARCHIVE_DIR, args.label);
  if (
    await fs
      .access(dest)
      .then(() => true)
      .catch(() => false)
  ) {
    throw new Error(
      `archive "${args.label}" already exists at ${dest} — archives are immutable; remove it first to re-archive`
    );
  }

  const shotFilter = args.shots ? new Set(args.shots) : undefined;
  const assets = manifest.assets.filter((a) => !shotFilter || shotFilter.has(a.surface));
  if (assets.length === 0) {
    throw new Error(
      `nothing to archive — ${shotFilter ? `no published assets match shots [${args.shots?.join(', ')}]` : 'the published manifest is empty'}`
    );
  }
  if (shotFilter) {
    const covered = new Set(assets.map((a) => a.surface));
    const missing = [...shotFilter].filter((s) => !covered.has(s));
    if (missing.length > 0) {
      throw new Error(`no published assets for requested shot(s): ${missing.join(', ')}`);
    }
  }

  await fs.mkdir(dest, { recursive: true });
  for (const asset of assets) {
    await fs.copyFile(path.join(OUTPUT_DIR, asset.file), path.join(dest, asset.file));
  }

  const archivedShotIds = new Set(assets.map((a) => a.surface));
  const archiveManifest = {
    label: args.label,
    archivedAt: new Date().toISOString(),
    source: {
      schemaVersion: manifest.schemaVersion,
      generatedAt: manifest.generatedAt,
      runId: manifest.runId,
    },
    shots: (manifest.shots ?? []).filter(
      (s): s is { id: string } =>
        typeof s === 'object' && s !== null && archivedShotIds.has((s as { id: string }).id)
    ),
    count: assets.length,
    totalBytes: assets.reduce((sum, a) => sum + (typeof a.bytes === 'number' ? a.bytes : 0), 0),
    assets,
  };
  await fs.writeFile(
    path.join(dest, 'manifest.json'),
    `${JSON.stringify(archiveManifest, null, 2)}\n`
  );

  process.stdout.write(
    `▸ Archived ${assets.length} asset(s) to archive/${args.label}/` +
      `${shotFilter ? ` (shots: ${[...archivedShotIds].join(', ')})` : ''}\n`
  );
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runArchive(parseArgs(process.argv.slice(2))).catch((err) => {
    process.stderr.write(`Archive failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

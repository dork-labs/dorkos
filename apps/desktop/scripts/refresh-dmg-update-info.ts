/**
 * Re-hash the release DMG after it was stapled, and put the new hash where
 * electron-builder wrote the old one.
 *
 * electron-builder notarizes the `.app` but never the `.dmg` around it, so the
 * release workflow notarizes and staples the DMG itself, after packaging
 * (DOR-4261). Stapling writes Apple's ticket into the DMG, which changes its
 * bytes. By then electron-builder has already hashed it: `latest-mac.yml`
 * lists the DMG's `sha512` and `size`, and `<dmg>.blockmap` describes its
 * blocks. Left alone, both describe a file nobody can download any more.
 *
 * This rebuilds the blockmap with electron-builder's own block-map builder
 * (the one `dmg-builder` called), so the format is exactly what it wrote,
 * and replaces the DMG's entry in `latest-mac.yml`. Nothing else in the
 * manifest changes: its top-level `path` and `sha512` name the `.zip`, which
 * is what the updater installs from.
 *
 * @module scripts/refresh-dmg-update-info
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, isMap, isSeq } from 'yaml';

/** What electron-builder records about one release file. */
export interface FileUpdateInfo {
  /** Base64 SHA-512 of the whole file. */
  sha512: string;
  /** Size in bytes. */
  size: number;
}

/** Writes `<file>.blockmap` and returns the file's hash and size. */
export type BlockMapBuilder = (file: string, blockMapFile: string) => Promise<FileUpdateInfo>;

/** electron-builder's suffix for a blockmap next to its file. */
const BLOCK_MAP_SUFFIX = '.blockmap';

/** The update manifest electron-builder writes for macOS. */
const MAC_MANIFEST = 'latest-mac.yml';

/**
 * electron-builder's own block-map builder, from the installed app-builder-lib.
 *
 * It is internal to app-builder-lib (no `exports` map, so a deep require
 * reaches it), resolved through electron-builder the same way the release
 * workflow finds the icons toolset. A version that moves or renames it fails
 * here, loudly, rather than writing a blockmap in some other format.
 *
 * @param fromDir - Directory to resolve electron-builder from.
 */
export function loadBlockMapBuilder(fromDir: string): BlockMapBuilder {
  const requireFromDir = createRequire(path.join(fromDir, 'package.json'));
  const builderPkg = requireFromDir.resolve('electron-builder/package.json');
  const modulePath = createRequire(builderPkg).resolve(
    'app-builder-lib/out/targets/blockmap/blockmap.js'
  );
  const mod = requireFromDir(modulePath) as {
    buildBlockMap?: (
      file: string,
      compression: 'gzip' | 'deflate',
      outFile: string
    ) => Promise<FileUpdateInfo>;
  };
  if (typeof mod.buildBlockMap !== 'function') {
    throw new Error(`${modulePath} no longer exports buildBlockMap.`);
  }
  const build = mod.buildBlockMap;
  // gzip: the format createBlockmap in app-builder-lib uses for every target.
  return (file, blockMapFile) => build(file, 'gzip', blockMapFile);
}

/**
 * Replace one file's `sha512` and `size` in a `latest-mac.yml`.
 *
 * @param manifest - The manifest's text.
 * @param fileName - The file's name as listed under `files[].url`.
 * @param info - Its new hash and size.
 * @returns The manifest with only that entry changed.
 * @throws If the manifest has no `files` list, or lists the file other than
 *   exactly once.
 */
export function rewriteManifestEntry(
  manifest: string,
  fileName: string,
  info: FileUpdateInfo
): string {
  const doc = parseDocument(manifest);
  const files = doc.get('files');
  if (!isSeq(files)) {
    throw new Error(`${MAC_MANIFEST} has no files list.`);
  }
  const entries = files.items.filter((item) => isMap(item) && item.get('url') === fileName);
  if (entries.length !== 1) {
    throw new Error(`${MAC_MANIFEST} lists ${fileName} ${entries.length} times; expected once.`);
  }
  const entry = entries[0];
  if (!isMap(entry)) throw new Error(`${MAC_MANIFEST} entry for ${fileName} is not a map.`);
  entry.set('sha512', info.sha512);
  entry.set('size', info.size);
  return doc.toString();
}

/**
 * Re-hash the one DMG in a release folder and update its blockmap and
 * manifest entry.
 *
 * @param releaseDir - electron-builder's output folder.
 * @param buildBlockMap - The block-map builder (injected in tests).
 * @returns The DMG's path with its hash and size before and after.
 * @throws If the folder holds no DMG or more than one, or no manifest.
 */
export async function refreshDmgUpdateInfo(
  releaseDir: string,
  buildBlockMap: BlockMapBuilder
): Promise<{ dmg: string; info: FileUpdateInfo }> {
  const dmgs = readdirSync(releaseDir).filter((name) => name.endsWith('.dmg'));
  if (dmgs.length !== 1) {
    throw new Error(`Expected exactly one .dmg in ${releaseDir}, found ${dmgs.length}.`);
  }
  const dmgName = dmgs[0];
  const dmg = path.join(releaseDir, dmgName);
  const manifestPath = path.join(releaseDir, MAC_MANIFEST);
  // Read before anything is written, so a missing manifest leaves the blockmap alone.
  const manifest = readFileSync(manifestPath, 'utf8');
  const info = await buildBlockMap(dmg, `${dmg}${BLOCK_MAP_SUFFIX}`);
  writeFileSync(manifestPath, rewriteManifestEntry(manifest, dmgName, info));
  return { dmg, info };
}

// Only when invoked as a script: the unit test imports the functions above.
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const releaseDir = path.resolve(desktopDir, process.argv[2] ?? 'release');
  refreshDmgUpdateInfo(releaseDir, loadBlockMapBuilder(desktopDir)).then(
    ({ dmg, info }) => {
      console.log(
        `[refresh-dmg-update-info] ${path.basename(dmg)}: ${info.size} bytes, sha512 ${info.sha512}`
      );
    },
    (err: unknown) => {
      console.error('[refresh-dmg-update-info] Failed:');
      console.error(err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    }
  );
}

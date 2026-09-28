/**
 * The record that decides whether a cached extension build is still current.
 *
 * esbuild bundles every file an extension's entry point imports, so the entry
 * file's own text says nothing about whether a cached bundle is stale: an
 * update that only touches `ui/panel.ts` leaves `index.ts` byte-identical
 * (DOR-2491). Before a build we cannot know what the entry will import, so
 * each build writes a manifest beside its output listing everything it was
 * built from, and the next load re-hashes exactly those paths and reuses the
 * output only when every one still matches. The manifest holds:
 *
 * - **Every input file esbuild read**, `node_modules` included, hashed from
 *   the exact bytes esbuild consumed ({@link createInputRecorder}). Hashing
 *   after the build instead would record an edit that landed mid-build as if
 *   the old bundle had been built from it.
 * - **The listing of each input's directory**, taken before the build where
 *   the extension's own tree is concerned. esbuild resolves `./foo` to
 *   `foo.ts` before `foo.js`, so adding a file next to an input can change
 *   what an unchanged import resolves to.
 * - **Every `package.json`, `tsconfig.json` and `jsconfig.json`** in an input
 *   directory or any directory above it, or the fact that there is none.
 *   esbuild reads these (a package's `main`, a `jsxFactory`) without listing
 *   them as inputs.
 * - **A key for the build configuration**: esbuild version, working
 *   directory and every build option ({@link computeBuildKey}).
 *
 * Accepted gaps, each of which costs a stale bundle only until the next edit
 * to a listed file or a `reload_extensions`: a new package appearing in a
 * `node_modules` directory higher up the tree than any input (the directories
 * esbuild searched and found nothing in are not recorded); a file a
 * `tsconfig.json` `extends`; and a config file or a directory outside the
 * extension's own tree edited while the build runs (those are hashed after
 * it).
 *
 * @module services/extensions/extension-build-cache
 */
import { createHash, randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { Plugin } from 'esbuild';
import { z } from 'zod';

/**
 * Bump when the manifest shape or what a build key covers changes. It is part
 * of every build key, so a bump turns every existing manifest into a miss.
 */
const MANIFEST_FORMAT_VERSION = 1;

/**
 * Most files and directories the pre-build snapshot of an extension's tree
 * will walk. Past this, a failed build is not cached at all (it simply runs
 * again next time, slower but never wrong) and a successful one hashes its
 * directory listings after the build.
 */
const MAX_TREE_ENTRIES = 2000;

/**
 * Largest single file, and most bytes in total, the pre-build snapshot will
 * read. A vendored asset past these would be re-read on every rebuild, so the
 * snapshot gives up (the same fallback as {@link MAX_TREE_ENTRIES}) before
 * reading it.
 */
const MAX_SNAPSHOT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SNAPSHOT_TOTAL_BYTES = 50 * 1024 * 1024;

/** Files esbuild reads for configuration without reporting them as inputs. */
const CONFIG_FILE_NAMES = ['package.json', 'tsconfig.json', 'jsconfig.json'];

const CompilationErrorSchema = z.object({
  code: z.literal('compilation_failed'),
  message: z.string(),
  errors: z.array(
    z.object({
      text: z.string(),
      location: z.object({ file: z.string(), line: z.number(), column: z.number() }).optional(),
    })
  ),
});

/** Structured compilation error returned to callers and cached in an error manifest. */
export type CompilationError = z.infer<typeof CompilationErrorSchema>;

const DigestSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** A path and the SHA-256 of its content (a file) or its sorted entry names (a directory). */
type Digest = z.infer<typeof DigestSchema>;

const BuildManifestSchema = z.object({
  v: z.literal(MANIFEST_FORMAT_VERSION),
  buildKey: z.string().min(1),
  entryPath: z.string().min(1),
  /** When the build started, so an older build never overwrites a newer one's record. */
  startedAt: z.number(),
  key: z.string().regex(/^[0-9a-f]{16}$/),
  files: z.array(DigestSchema),
  dirs: z.array(DigestSchema),
  /** Config files that did not exist; one appearing invalidates the build. */
  absent: z.array(z.string().min(1)),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('bundle') }),
    z.object({ kind: z.literal('error'), error: CompilationErrorSchema }),
  ]),
});

/** What one build produced, and everything it was built from. */
export type BuildManifest = z.infer<typeof BuildManifestSchema>;

/** The files, directory listings and missing config files a build depended on. */
export interface SourceDigest {
  files: Digest[];
  dirs: Digest[];
  absent: string[];
}

/** File and directory-listing hashes of an extension's tree, taken before a build. */
export interface TreeSnapshot {
  files: Map<string, string>;
  dirs: Map<string, string>;
}

/**
 * SHA-256 of `data` as lowercase hex.
 *
 * @param data - Content to hash.
 */
function sha256(data: string | Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The 16-hex-character content key used in cache file names.
 *
 * @param data - Content to hash.
 */
export function shortHash(data: string | Buffer): string {
  return sha256(data).slice(0, 16);
}

/**
 * Wall-clock start time of a build, for ordering overlapping builds.
 *
 * Wall clock rather than a monotonic one: two server processes can share one
 * DorkOS home, and a monotonic clock is per process (and stops while macOS
 * sleeps), so it cannot be compared across them. A tie or a clock step only
 * costs a rebuild, because every manifest's hashes are the bytes its own
 * build read.
 */
export function buildStartTime(): number {
  return Date.now();
}

/**
 * Key everything besides source files that decides a build's output: the
 * manifest format, the esbuild version, the working directory (inline source
 * maps record source paths relative to it), and every build option.
 *
 * The host's own version is deliberately absent: host-provided modules
 * (`react`, `@dorkos/extension-api`, `express`) are externals the bundle
 * imports at run time, so nothing from the host is baked into the output.
 *
 * @param esbuildVersion - The running esbuild's version string.
 * @param cwd - The `absWorkingDir` the build runs with.
 * @param options - Every esbuild option except the entry point.
 */
export function computeBuildKey(esbuildVersion: string, cwd: string, options: object): string {
  return sha256(JSON.stringify({ v: MANIFEST_FORMAT_VERSION, esbuildVersion, cwd, options }));
}

/**
 * An esbuild plugin that hashes the exact bytes esbuild bundles.
 *
 * It reads each file itself and hands the bytes back with `loader: 'default'`,
 * so esbuild picks the loader it would have picked anyway (including the
 * `loader` build option) and the output is byte-identical to a build without
 * the plugin. A file it cannot read is left to esbuild, so the failure still
 * carries esbuild's own "Cannot read file" wording that the environment-
 * failure classifier matches on.
 *
 * @returns The plugin, and the map it fills with absolute path → SHA-256.
 */
export function createInputRecorder(): { plugin: Plugin; hashes: Map<string, string> } {
  const hashes = new Map<string, string>();
  const plugin: Plugin = {
    name: 'dorkos-input-recorder',
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
        let contents: Buffer;
        try {
          contents = await fs.readFile(args.path);
        } catch {
          return undefined;
        }
        hashes.set(args.path, sha256(contents));
        return { contents, loader: 'default' };
      });
    },
  };
  return { plugin, hashes };
}

/**
 * Hash a file's bytes, or `null` when it cannot be read.
 *
 * @param filePath - Absolute path.
 */
async function hashFile(filePath: string): Promise<string | null> {
  try {
    return sha256(await fs.readFile(filePath));
  } catch {
    return null;
  }
}

/**
 * Hash a directory's sorted entry names, or `null` when it cannot be listed.
 *
 * @param dirPath - Absolute path.
 */
async function hashDirListing(dirPath: string): Promise<string | null> {
  try {
    const names = (await fs.readdir(dirPath)).sort();
    return sha256(names.join('\n'));
  } catch {
    return null;
  }
}

/**
 * Hash every file and directory listing under an extension's root, before a
 * build. Skips dot-entries, the contents of `node_modules` (its listing is
 * still taken, so installing or removing a package counts as a change) and
 * anything under `exclude` (the compiler's own cache, if it sits inside).
 *
 * Gives up as soon as the walk passes {@link MAX_TREE_ENTRIES} entries, a
 * file is larger than {@link MAX_SNAPSHOT_FILE_BYTES}, or the bytes read
 * would pass {@link MAX_SNAPSHOT_TOTAL_BYTES}, checking each before reading
 * any further.
 *
 * @param root - The extension's directory.
 * @param exclude - A directory never to walk into.
 * @returns The snapshot, or `null` when the tree is too large or unreadable.
 */
export async function snapshotSourceTree(
  root: string,
  exclude: string
): Promise<TreeSnapshot | null> {
  const snapshot: TreeSnapshot = { files: new Map(), dirs: new Map() };
  const tooManyEntries = () => snapshot.files.size + snapshot.dirs.size > MAX_TREE_ENTRIES;
  let totalBytes = 0;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    snapshot.dirs.set(
      dir,
      sha256(
        entries
          .map((e) => e.name)
          .sort()
          .join('\n')
      )
    );
    for (const entry of entries) {
      if (tooManyEntries()) return null;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full === exclude) continue;
        if (entry.name === 'node_modules') {
          const listing = await hashDirListing(full);
          if (listing === null) return null;
          snapshot.dirs.set(full, listing);
        } else {
          pending.push(full);
        }
      } else if (entry.isFile()) {
        let size: number;
        try {
          size = (await fs.stat(full)).size;
        } catch {
          return null;
        }
        totalBytes += size;
        if (size > MAX_SNAPSHOT_FILE_BYTES || totalBytes > MAX_SNAPSHOT_TOTAL_BYTES) return null;
        const hash = await hashFile(full);
        if (hash === null) return null;
        snapshot.files.set(full, hash);
      }
    }
    if (tooManyEntries()) return null;
  }
  return snapshot;
}

/**
 * Record the config files esbuild may have read: every `package.json`,
 * `tsconfig.json` and `jsconfig.json` in `dirs` or any directory above them.
 * One that exists is hashed (from the snapshot when it has it, so the hash
 * predates the build); one that does not is recorded as absent.
 *
 * @returns `false` when a config file exists but cannot be read.
 */
async function addConfigFiles(
  digest: SourceDigest,
  dirs: Iterable<string>,
  snapshot: TreeSnapshot | null
): Promise<boolean> {
  const ancestors = new Set<string>();
  for (let dir of dirs) {
    while (!ancestors.has(dir)) {
      ancestors.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const known = new Set(digest.files.map((f) => f.path));
  for (const dir of [...ancestors].sort()) {
    for (const name of CONFIG_FILE_NAMES) {
      const file = path.join(dir, name);
      if (known.has(file)) continue;
      const pre = snapshot?.files.get(file);
      if (pre) {
        digest.files.push({ path: file, sha256: pre });
        continue;
      }
      try {
        digest.files.push({ path: file, sha256: sha256(await fs.readFile(file)) });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        digest.absent.push(file);
      }
    }
  }
  return true;
}

/**
 * Digest a SUCCESSFUL build.
 *
 * Every metafile input must have been hashed by the input recorder: an input
 * it never saw would be a hash taken at the wrong moment, so the build goes
 * uncached instead. Directory listings come from the pre-build snapshot where
 * it covers them.
 *
 * Accepted gap: a package newly installed into a `node_modules` directory
 * higher up the tree than any input is not seen, because the directories
 * esbuild searched without finding anything are not reported to us. Any edit
 * to a recorded file, or `reload_extensions`, rebuilds.
 *
 * @param inputs - `metafile.inputs` from the build result.
 * @param cwd - The `absWorkingDir` the build ran with.
 * @param loaded - The input recorder's hashes.
 * @param snapshot - The pre-build snapshot of the extension's tree, if any.
 * @returns The digest, or `null` when it cannot be trusted.
 */
export async function digestBuildInputs(
  inputs: Record<string, unknown>,
  cwd: string,
  loaded: Map<string, string>,
  snapshot: TreeSnapshot | null
): Promise<SourceDigest | null> {
  const digest: SourceDigest = { files: [], dirs: [], absent: [] };
  const inputPaths = [...new Set(Object.keys(inputs).map((key) => path.resolve(cwd, key)))];
  if (inputPaths.length === 0) return null;
  for (const file of inputPaths.sort()) {
    const hash = loaded.get(file);
    if (!hash) return null;
    digest.files.push({ path: file, sha256: hash });
  }
  const inputDirs = [...new Set(inputPaths.map((file) => path.dirname(file)))].sort();
  for (const dir of inputDirs) {
    const listing = snapshot?.dirs.get(dir) ?? (await hashDirListing(dir));
    if (listing === null) return null;
    digest.dirs.push({ path: dir, sha256: listing });
  }
  return (await addConfigFiles(digest, inputDirs, snapshot)) ? digest : null;
}

/**
 * Digest a FAILED build, which has no metafile.
 *
 * The fix for a failed build can land anywhere: in the file that failed, in
 * a file it imports, or in a file that does not exist yet (the missing
 * module an import names). So the error is keyed on the extension's whole
 * tree as it was BEFORE the build, with each file esbuild did read taking the
 * hash of the bytes it read. A file created while the build ran changes a
 * directory listing and so rebuilds.
 *
 * @param snapshot - The pre-build snapshot of the extension's tree.
 * @param loaded - The input recorder's hashes.
 * @returns The digest, or `null` when a config file cannot be read.
 */
export async function digestFailedBuild(
  snapshot: TreeSnapshot,
  loaded: Map<string, string>
): Promise<SourceDigest | null> {
  const files = new Map(snapshot.files);
  for (const [file, hash] of loaded) files.set(file, hash);
  const digest: SourceDigest = {
    files: [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, h]) => ({ path: p, sha256: h })),
    dirs: [...snapshot.dirs]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, h]) => ({ path: p, sha256: h })),
    absent: [],
  };
  const dirs = new Set([
    ...snapshot.dirs.keys(),
    ...[...loaded.keys()].map((f) => path.dirname(f)),
  ]);
  return (await addConfigFiles(digest, dirs, snapshot)) ? digest : null;
}

/**
 * Parse a manifest file, or `null` when it is missing, unreadable, or corrupt.
 *
 * @param manifestPath - Where the manifest lives.
 */
async function readManifest(manifestPath: string): Promise<BuildManifest | null> {
  try {
    const parsed = BuildManifestSchema.safeParse(
      JSON.parse(await fs.readFile(manifestPath, 'utf-8'))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Read a manifest and decide whether the build it describes is still current.
 *
 * Current means: it parses, it was written for this build configuration and
 * this entry point, every file and directory it lists hashes the same as it
 * did at build time, and every config file it found missing is still missing.
 * A missing, corrupt, or outdated manifest is a miss.
 *
 * @param manifestPath - Where the manifest lives.
 * @param buildKey - The key for the build about to run ({@link computeBuildKey}).
 * @param entryPath - The entry point about to be built.
 * @returns The manifest when current, otherwise the reason it is not.
 */
export async function readCurrentManifest(
  manifestPath: string,
  buildKey: string,
  entryPath: string
): Promise<{ current: BuildManifest } | { stale: string }> {
  const manifest = await readManifest(manifestPath);
  if (!manifest) return { stale: 'no readable manifest' };
  if (manifest.buildKey !== buildKey) return { stale: 'build configuration changed' };
  if (manifest.entryPath !== entryPath) return { stale: 'entry point moved' };

  for (const file of manifest.files) {
    if ((await hashFile(file.path)) !== file.sha256) return { stale: `${file.path} changed` };
  }
  for (const dir of manifest.dirs) {
    if ((await hashDirListing(dir.path)) !== dir.sha256) {
      return { stale: `the files in ${dir.path} changed` };
    }
  }
  for (const file of manifest.absent) {
    try {
      await fs.lstat(file);
      return { stale: `${file} appeared` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { stale: `${file} unreadable` };
    }
  }
  return { current: manifest };
}

/**
 * Write a file so a concurrent reader sees either the old content or the new,
 * never a torn one: write a sibling temp file, then rename it into place.
 *
 * @param filePath - Destination.
 * @param content - Content to write.
 */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, 'utf-8');
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Persist a manifest atomically, unless the one already on disk records a
 * build that started later: when two builds overlap, the older one finishing
 * last must not replace the newer one's record.
 *
 * @param manifestPath - Where the manifest lives.
 * @param manifest - The manifest, minus its format version.
 * @returns `false` when a newer manifest was kept instead.
 */
export async function writeBuildManifest(
  manifestPath: string,
  manifest: Omit<BuildManifest, 'v'>
): Promise<boolean> {
  const existing = await readManifest(manifestPath);
  if (existing && existing.startedAt > manifest.startedAt) return false;
  const full: BuildManifest = { v: MANIFEST_FORMAT_VERSION, ...manifest };
  await writeFileAtomic(manifestPath, JSON.stringify(full));
  return true;
}

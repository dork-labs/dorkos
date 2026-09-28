/**
 * The record that decides whether a cached extension build is still current.
 *
 * esbuild bundles every file an extension's entry point imports, so the entry
 * file's own text says nothing about whether a cached bundle is stale: an
 * update that only touches `ui/panel.ts` leaves `index.ts` byte-identical
 * (DOR-2491). Before a build we cannot know what the entry will import, so
 * each build writes a manifest beside its output listing everything it was
 * built from — every input file esbuild actually read (from its metafile,
 * `node_modules` files included) and a hash of each input's directory
 * listing — together with a key for the build configuration itself. The next
 * load re-hashes exactly those files and directories and reuses the output
 * only when every one still matches.
 *
 * Directory listings are there for the file a build did NOT read: esbuild
 * resolves `./foo` to `foo.ts` before `foo.js`, so adding a file next to an
 * input can change what an unchanged import resolves to. A new package in a
 * `node_modules` directory higher up the tree is the one resolution change this
 * does not see; `reload_extensions` after a hand-edited dependency tree, or any
 * edit to a listed file, rebuilds.
 *
 * @module services/extensions/extension-build-cache
 */
import { createHash, randomBytes } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';

/**
 * Bump when the manifest shape or what a build key covers changes. It is part
 * of every build key, so a bump turns every existing manifest into a miss.
 */
const MANIFEST_FORMAT_VERSION = 1;

/**
 * Most files and directories an error manifest will walk. A source tree past
 * this is not cached as an error at all: the failing build simply runs again
 * next time, which is slower but never wrong.
 */
const MAX_TREE_ENTRIES = 2000;

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
  key: z.string().regex(/^[0-9a-f]{16}$/),
  files: z.array(DigestSchema),
  dirs: z.array(DigestSchema),
  outcome: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('bundle') }),
    z.object({ kind: z.literal('error'), error: CompilationErrorSchema }),
  ]),
});

/** What one build produced, and everything it was built from. */
export type BuildManifest = z.infer<typeof BuildManifestSchema>;

/** The files and directory listings a build depended on. */
export interface SourceDigest {
  files: Digest[];
  dirs: Digest[];
}

/**
 * SHA-256 of `data` as lowercase hex.
 *
 * @param data - Content to hash.
 */
function sha256(data: string | Buffer): string {
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
 * Hash the given files and directory listings. Returns `null` if any one of
 * them cannot be read: a manifest with a hole in it would vouch for a file it
 * never saw, so the build goes uncached instead.
 *
 * @param files - Absolute file paths.
 * @param dirs - Absolute directory paths.
 */
async function digestPaths(files: string[], dirs: string[]): Promise<SourceDigest | null> {
  const digest: SourceDigest = { files: [], dirs: [] };
  for (const filePath of [...new Set(files)].sort()) {
    const hash = await hashFile(filePath);
    if (hash === null) return null;
    digest.files.push({ path: filePath, sha256: hash });
  }
  for (const dirPath of [...new Set(dirs)].sort()) {
    const hash = await hashDirListing(dirPath);
    if (hash === null) return null;
    digest.dirs.push({ path: dirPath, sha256: hash });
  }
  return digest;
}

/**
 * Digest the inputs a successful build read, from esbuild's metafile.
 *
 * Metafile input keys are relative to the build's working directory. Every
 * input's directory is listed too (see the module comment).
 *
 * @param inputs - `metafile.inputs` from the build result.
 * @param cwd - The `absWorkingDir` the build ran with.
 * @returns The digest, or `null` when an input can no longer be read.
 */
export async function digestBuildInputs(
  inputs: Record<string, unknown>,
  cwd: string
): Promise<SourceDigest | null> {
  const files = Object.keys(inputs).map((key) => path.resolve(cwd, key));
  if (files.length === 0) return null;
  return digestPaths(
    files,
    files.map((file) => path.dirname(file))
  );
}

/**
 * Digest an extension's whole source tree, for a build that FAILED.
 *
 * A failed build has no metafile, and the fix for it can land anywhere: in the
 * file that failed, in a file it imports, or in a file that does not exist yet
 * (the missing module an import names). So an error is keyed on every file
 * and directory under the extension root, skipping dot-entries and the
 * contents of `node_modules` (its listing is still hashed, so installing or
 * removing a package counts as a change), plus any extra files named, such as
 * the entry point and the files esbuild's errors point at.
 *
 * @param root - The extension's directory.
 * @param extraFiles - Absolute paths to include even if outside `root`.
 * @returns The digest, or `null` when the tree is too large or unreadable.
 */
export async function digestSourceTree(
  root: string,
  extraFiles: string[]
): Promise<SourceDigest | null> {
  const files: string[] = [];
  const dirs: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    dirs.push(dir);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') dirs.push(full);
        else pending.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
    if (files.length + dirs.length > MAX_TREE_ENTRIES) return null;
  }
  const existingExtras: string[] = [];
  for (const extra of extraFiles) {
    if ((await hashFile(extra)) !== null) existingExtras.push(extra);
  }
  return digestPaths([...files, ...existingExtras], dirs);
}

/**
 * Read a manifest and decide whether the build it describes is still current.
 *
 * Current means: it parses, it was written for this build configuration and
 * this entry point, and every file and directory it lists hashes the same as
 * it did at build time. A missing, corrupt, or outdated manifest is a miss.
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
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    return { stale: 'no manifest' };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { stale: 'manifest is not valid JSON' };
  }
  const parsed = BuildManifestSchema.safeParse(json);
  if (!parsed.success) return { stale: 'manifest has an unexpected shape' };
  const manifest = parsed.data;
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
 * Persist a manifest atomically.
 *
 * @param manifestPath - Where the manifest lives.
 * @param manifest - The manifest, minus its format version.
 */
export async function writeBuildManifest(
  manifestPath: string,
  manifest: Omit<BuildManifest, 'v'>
): Promise<void> {
  const full: BuildManifest = { v: MANIFEST_FORMAT_VERSION, ...manifest };
  await writeFileAtomic(manifestPath, JSON.stringify(full));
}

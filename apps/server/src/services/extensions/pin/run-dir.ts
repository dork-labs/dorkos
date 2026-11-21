/**
 * The one folder a copy's code is built and started from. A copy pinned to
 * its files (`pinnedDigest`) runs from the verified snapshot of exactly those
 * files (`runPath`), never from the folder it was found in, which an agent or
 * an update can change. A pinned copy with no snapshot is refused rather than
 * falling back to that folder: the compiler, the in-process start and the
 * separate-process start all ask {@link runDirOf}.
 *
 * @module services/extensions/pin/run-dir
 */
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { CompilationError } from '../extension-build-cache.js';

/** A copy as far as {@link runDirOf} needs it. */
type RunDirCopy = Pick<
  ExtensionRecord,
  'path' | 'runPath' | 'pinnedDigest' | 'originPinnedDigest' | 'sourcePlugin' | 'trustedOrigin'
>;

/** The code a refusal for a pinned copy with no snapshot carries. */
export const RUN_DIR_MISSING_CODE = 'run_copy_missing';

/**
 * Where this copy's code is read from: its snapshot when it has one, its own
 * folder when nothing pins it, and nowhere (null) when it is pinned but has no
 * snapshot, so the caller refuses to build or start it.
 *
 * One pin stays on the folder itself: the plugin folder digest a copy with a
 * proven origin was judged against at discovery (`extension-trusted-origin.ts`),
 * which is re-hashed right before and after every build
 * (`extension-plugin-guard.ts`). That copy may be one nothing has approved yet,
 * or one installed for every project, and neither gets a snapshot. It is
 * recognised by its pin, never by a missing snapshot alone: `pinnedDigest` must
 * still be the digest the origin proof set (`originPinnedDigest`). A person's
 * yes for those very same files sets the same digest, so the two cannot be
 * told apart; either way the folder is re-hashed around the build. Every pin
 * an approval sets runs from a snapshot (`placeSnapshots`), so a copy pinned
 * with no snapshot and no proven origin has nowhere it may be read from.
 *
 * @param copy - The extension record.
 */
export function runDirOf(copy: RunDirCopy): string | null {
  if (copy.runPath) return copy.runPath;
  if (!copy.pinnedDigest) return copy.path;
  const originPin = !!copy.originPinnedDigest && copy.pinnedDigest === copy.originPinnedDigest;
  if (originPin && copy.sourcePlugin && copy.trustedOrigin) return copy.path;
  return null;
}

/**
 * The fixed words for a pinned copy DorkOS has no checked copy of.
 *
 * @param name - The app's name.
 */
export function runDirMissingMessage(name: string): string {
  return `${name} didn't load: DorkOS couldn't find the checked copy of its files.`;
}

/**
 * The compile refusal for a copy {@link runDirOf} has no folder for: nothing
 * is built, and the error says why.
 *
 * @param copy - The extension record.
 */
export function runDirRefusal(copy: Pick<ExtensionRecord, 'manifest'>): {
  error: CompilationError;
  sourceHash: string;
} {
  const message = runDirMissingMessage(copy.manifest.name);
  return {
    error: {
      code: 'compilation_failed',
      message,
      errors: [{ text: `${RUN_DIR_MISSING_CODE}: ${message}` }],
    },
    sourceHash: '',
  };
}

/**
 * {@link runDirOf}, for a caller that cannot go on without a folder: it
 * throws the fixed refusal instead of returning null.
 *
 * @param copy - The extension record.
 * @throws {Error} When the copy is pinned and has no snapshot.
 */
export function requireRunDir(copy: RunDirCopy & Pick<ExtensionRecord, 'manifest'>): string {
  const dir = runDirOf(copy);
  if (!dir) throw new Error(runDirMissingMessage(copy.manifest.name));
  return dir;
}

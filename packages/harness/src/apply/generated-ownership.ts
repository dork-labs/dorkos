/**
 * Ownership of the engine-generated hook files (`.codex/hooks.json` and friends).
 *
 * Codex and Cursor both document these paths as files a person may write by
 * hand, so the engine cannot claim them by path — it once did, and swept three
 * hand-written files off a Codex-first repo on the first marketplace install
 * (HK-11 / DOR-1842). Nor can it claim them with an in-file marker: a marker
 * cannot tell a file the engine wrote from a file the engine wrote and a person
 * has since edited, and the second one is theirs.
 *
 * So ownership is a **sidecar**. Beside every generated hook file the engine
 * writes `<target>.dorkos-generated` holding the sha256 of the exact bytes it
 * wrote. The engine owns the target if — and only if — that sidecar exists and
 * its digest still matches what is on disk. Everything else is somebody else's
 * file: never rewritten, never swept, reported as a conflict naming the way out.
 *
 * Two migrations exist for files the engine wrote before sidecars did, and both
 * live in `apply.ts` where the bytes are known; this module supplies the
 * predicates they need.
 *
 * @module apply/generated-ownership
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  CANONICAL_TO_CODEXCLI_EVENT_NAMES,
  CLAUDE_TO_CANONICAL_EVENT_NAMES,
} from '../vendor/rulesync-maps.js';

/**
 * The suffix of the ownership sidecar written beside every generated hook file.
 * Mirrored in `EPHEMERAL_GITIGNORE_PATTERNS` (and this repo's own `.gitignore`),
 * because a sidecar is machine-local ephemera exactly like the file it describes.
 */
export const GENERATED_SIDECAR_SUFFIX = '.dorkos-generated';

/**
 * What a person is told when their own file occupies a generated hook target.
 * It names the way out rather than just the obstacle: `.claude/settings.json` is
 * the one canonical hook source, and hooks moved there reach every harness.
 */
export const HAND_WRITTEN_HOOKS_REASON =
  'hand-written or edited outside DorkOS; move these hooks into `.claude/settings.json` so ' +
  'every harness gets them, or delete the file, then re-run';

/**
 * The sidecar path for a generated target.
 *
 * @param absTarget - absolute path of the generated file.
 * @returns the absolute path of its ownership sidecar.
 */
export function generatedSidecarPath(absTarget: string): string {
  return `${absTarget}${GENERATED_SIDECAR_SUFFIX}`;
}

/** The lowercase hex sha256 of a string, the digest a sidecar records. */
function digestOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Read a path's bytes as UTF-8, or `undefined` when it cannot be read as a file
 * (absent, a directory, a dangling symlink, unreadable). Never throws, so no
 * ownership question can turn into a crash.
 *
 * @param absPath - the absolute path to read.
 * @returns the file's content, or `undefined`.
 */
export function readFileIfPresent(absPath: string): string | undefined {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Whether a sidecar exists beside a generated target, whatever it says. A stale
 * sidecar means the engine wrote this path once, so a mismatching one is
 * evidence of a hand edit rather than of a pre-sidecar file.
 *
 * @param absTarget - absolute path of the generated file.
 * @returns `true` when a sidecar file is present.
 */
export function hasGeneratedSidecar(absTarget: string): boolean {
  try {
    lstatSync(generatedSidecarPath(absTarget));
    return true;
  } catch {
    return false;
  }
}

/**
 * Record the engine's ownership of the bytes it just wrote.
 *
 * @param absTarget - absolute path of the generated file.
 * @param content - the exact bytes written to it.
 */
export function writeGeneratedSidecar(absTarget: string, content: string): void {
  writeFileSync(generatedSidecarPath(absTarget), `${digestOf(content)}\n`);
}

/** Remove a generated target's sidecar, if it has one. */
export function removeGeneratedSidecar(absTarget: string): void {
  rmSync(generatedSidecarPath(absTarget), { force: true });
}

/**
 * Whether the engine owns what is on disk at a generated target: the sidecar
 * exists AND its digest still matches these exact bytes.
 *
 * @param absTarget - absolute path of the generated file.
 * @param onDisk - the bytes currently at that path.
 * @returns `true` when the engine wrote them and nobody has edited them since.
 */
export function ownsGeneratedFile(absTarget: string, onDisk: string): boolean {
  const recorded = readFileIfPresent(generatedSidecarPath(absTarget));
  return recorded !== undefined && recorded.trim() === digestOf(onDisk);
}

/**
 * Every hook event name the engine could have written as a key of its old bare
 * Codex map: Claude's own spellings and the Codex spellings they translate to.
 */
const KNOWN_HOOK_EVENT_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(CLAUDE_TO_CANONICAL_EVENT_NAMES),
  ...Object.values(CANONICAL_TO_CODEXCLI_EVENT_NAMES),
]);

/**
 * Whether a sidecar-less `.codex/hooks.json` is the engine's OWN pre-DOR-1842
 * output: the bare event map it used to write, before the documented
 * `{ description, hooks }` wrapper.
 *
 * The test is deliberately narrow — a top-level object with at least one key,
 * no `hooks` or `description` key (either one makes it the vendor's documented
 * shape, so a person's), and every key a known hook event name whose value is an
 * array. A hand-written file in the shape Codex documents can never match.
 *
 * @param content - the file's bytes.
 * @returns `true` when the file is the engine's own legacy output.
 */
export function isLegacyBareCodexHooks(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
  if (Object.hasOwn(parsed, 'hooks') || Object.hasOwn(parsed, 'description')) return false;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(([key, value]) => KNOWN_HOOK_EVENT_NAMES.has(key) && Array.isArray(value));
}

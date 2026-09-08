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
import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { writeFileAtomic } from './atomic-write.js';

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
  'blocked by a file DorkOS did not write — hand-written, or edited after DorkOS wrote it. ' +
  'Move these hooks into `.claude/settings.json` so every harness gets them, or delete the ' +
  'file, then re-run';
// The other case — somebody's own file where the plan writes NOTHING — carries no
// per-item reason, because it is not a fault: `applyPlan` and `checkPlan` return
// the bare path in `leftAlone` and the CLI heads the list with what it means.

/** The sidecar path for a generated target. Private: callers ask the questions below. */
function generatedSidecarPath(absTarget: string): string {
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
 * Written AFTER the file it describes, and atomically, so the two are never
 * observed disagreeing because of a write in progress: a reader sees either no
 * sidecar (the file is not yet claimed, and is left alone) or a whole one. The
 * pair is still two writes, so two PROCESSES applying DIFFERENT plans to one
 * repo at the same instant can interleave them into a sidecar describing the
 * other process's bytes — the case `services/harness/project-with-consent.ts`
 * states is not locked, and which the ownership rule then reports as a conflict
 * rather than resolving on a guess.
 *
 * @param absTarget - absolute path of the generated file.
 * @param content - the exact bytes written to it.
 */
export function writeGeneratedSidecar(absTarget: string, content: string): void {
  writeFileAtomic(generatedSidecarPath(absTarget), `${digestOf(content)}\n`);
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
 * The only keys the engine could ever have written into its old bare Codex map:
 * the ten CODEX spellings the pre-DOR-1842 generator could emit, and nothing
 * else.
 *
 * `generateCodexHooks` translated each Claude event through the canonical
 * vocabulary into Codex's own name and DROPPED every event Codex has no home
 * for, so a Claude-only name like `Notification` was never written to this file
 * by DorkOS. Admitting the Claude vocabulary here would hand rule 2 a licence
 * over files only a person could have authored.
 *
 * FROZEN ON PURPOSE, not derived from `CANONICAL_TO_CODEXCLI_EVENT_NAMES`.
 * This is a claim about what a PAST version of the engine wrote, so it cannot
 * track a map the present one extends: `SessionEnd` joined the Codex map in
 * DOR-1847, and deriving from it would make a hand-written bare `SessionEnd` map
 * — a file no DorkOS build has ever produced — adoptable and rewritable. Every
 * later map addition would widen the rule the same way, one silent step at a
 * time. Nothing may be added here; the list only ever shrinks, and only if a
 * spelling is shown never to have shipped.
 */
const CODEX_WRITABLE_EVENT_NAMES: ReadonlySet<string> = new Set<string>([
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'PermissionRequest',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
]);

/**
 * Whether a sidecar-less `.codex/hooks.json` is the engine's OWN pre-DOR-1842
 * output: the bare event map it used to write, before the documented
 * `{ description, hooks }` wrapper.
 *
 * The test is deliberately narrow, and every clause of it is load-bearing: a
 * top-level object with at least one key, every key one of the ten event names
 * the old generator could actually emit ({@link CODEX_WRITABLE_EVENT_NAMES}),
 * and every value an array.
 *
 * The vocabulary is what excludes the vendor's documented shape, so no separate
 * check for it is needed — and a separate check would be dead code, since
 * neither `hooks` nor `description` is a Codex event name and a file carrying
 * either already fails on that key. A file keyed by an event DorkOS would have
 * dropped (`Notification`) is excluded the same way.
 *
 * The caller pairs this with "no sidecar has ever been written here": once one
 * exists, the engine's authorship is already recorded, so a file that no longer
 * matches it was edited by a person and the legacy shape proves nothing.
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
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    ([key, value]) => CODEX_WRITABLE_EVENT_NAMES.has(key) && Array.isArray(value)
  );
}

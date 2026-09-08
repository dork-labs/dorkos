/**
 * Manifest scaffolding: write a default `.agents/harness.manifest.json` into a
 * repo that has none, so `harness sync` has something to project instead of
 * no-opping.
 *
 * The scaffolded file is a real, human-editable JSON document (ADR-302: manifests
 * are scaffolded, never generated). It carries only the non-derivable policy the
 * schema asks for, starting from sensible empty defaults (the scanner derives the
 * skills, bundles, and projections from the filesystem). The one decision the
 * scaffolder makes for the user is the `harnesses` set: it detects which harnesses
 * the repo already uses and enables those, falling back to a documented default
 * when it can detect none.
 *
 * Everything is WRITE-IF-ABSENT, mirroring {@link scaffoldInstructions}: an
 * existing manifest (even a hand-edited one) is left exactly as the user left it.
 *
 * @module scaffold/manifest
 */
import { existsSync, readFileSync, statSync, type Stats } from 'node:fs';
import { join, sep } from 'node:path';
import { writeFileAtomic } from '../apply/atomic-write.js';
import { HARNESS_IDS, type HarnessId, type HarnessManifest } from '../manifest/schema.js';
import type { DetectedHarness } from '../plan/types.js';

/**
 * Repo-relative path of the harness manifest the scaffolder writes.
 *
 * A forward-slash LITERAL, like every other repo-relative constant the engine
 * exports (`AGENTS_SKILLS_DIR`, `CLAUDE_SKILLS_DIR`, `PROJECT_PLUGINS_DIR`, the
 * three hook targets). It was built with `join()` until DOR-1851, which meant it
 * came out as `.agents\harness.manifest.json` on Windows — and this string is
 * PRINTED: `dorkos harness sync` puts it in the missing-manifest error, in the
 * "add it to …" notice for a harness that is not enabled, and in the line
 * `--enable` prints after writing. So a Windows user read one backslash path in
 * a report whose every other path used forward slashes (DOR-1855 settled the
 * same rule for generated text, `pluginRootText`).
 *
 * Joining it against a root still works everywhere: `path.join` normalises the
 * separator for the platform it is running on.
 */
export const HARNESS_MANIFEST_PATH = '.agents/harness.manifest.json';

/**
 * The default harness set written when the repo shows no detectable harness
 * footprint. Claude Code is the canonical authoring harness and Codex reads the
 * same `AGENTS.md` natively, so this pair is the safest portable starting point
 * (it matches the v1-supported set this repo itself ships).
 */
export const DEFAULT_HARNESSES: readonly HarnessId[] = ['claude-code', 'codex'];

/**
 * On-disk signals that a harness is already in use in a repo. The presence of any
 * one path enables that harness in a scaffolded manifest. Paths are repo-relative.
 */
const HARNESS_DETECTION_SIGNALS: Record<HarnessId, readonly string[]> = {
  'claude-code': ['.claude', 'CLAUDE.md'],
  codex: ['.codex', 'AGENTS.md'],
  cursor: ['.cursor'],
  gemini: ['GEMINI.md', '.gemini'],
  copilot: [join('.github', 'copilot-instructions.md')],
  opencode: ['.opencode'],
};

/**
 * Signal paths that are evidence of the canonical layer rather than of one
 * harness in particular, so they never make a harness "present" in a re-detection.
 *
 * `AGENTS.md` is the cross-agent instruction file five of the six harnesses read
 * (and the one this engine asks every repo to keep), so a Claude-Code-only
 * project has one — and, read as a Codex footprint, it would put
 * "AGENTS.md found; Codex is not enabled" on every single sync of every repo
 * DorkOS has ever touched, with no way to clear it. Being told a true thing
 * forever is how a person learns to stop reading the output.
 *
 * It stays in {@link HARNESS_DETECTION_SIGNALS} for the SCAFFOLD, where the
 * question is different and asked once: a repo that keeps an `AGENTS.md` and
 * nothing else really is a reasonable place to start Codex.
 */
const SHARED_SIGNAL_PATHS: ReadonlySet<string> = new Set(['AGENTS.md']);

/** Options for {@link scaffoldManifest}. */
export interface ScaffoldManifestOptions {
  /**
   * Force a specific harness set instead of detecting from the repo. When omitted,
   * the scaffolder detects harnesses present on disk and falls back to
   * {@link DEFAULT_HARNESSES} when none are detected.
   */
  harnesses?: readonly HarnessId[];
}

/** What {@link scaffoldManifest} did. */
export interface ScaffoldManifestResult {
  /** Whether a manifest was written this run (false when one already existed). */
  created: boolean;
  /** Repo-relative path of the manifest (whether written or pre-existing). */
  path: string;
  /** The harness set written, or the existing manifest's set when not created. */
  harnesses: readonly HarnessId[];
  /** Whether the harness set came from on-disk detection (false = the documented fallback). */
  detected: boolean;
}

/**
 * Detect which harnesses a repo already uses, by probing each harness's on-disk
 * signal paths under `repoRoot`.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns the detected harnesses, in canonical {@link HARNESS_IDS} order.
 */
export function detectHarnesses(repoRoot: string): HarnessId[] {
  return HARNESS_IDS.filter((id) =>
    HARNESS_DETECTION_SIGNALS[id].some((rel) => existsSync(join(repoRoot, rel)))
  );
}

/**
 * Detect each harness whose OWN files are in the repo, with the path that gave
 * it away — the re-detection every plan runs (contract TR-11).
 *
 * Two things separate it from {@link detectHarnesses}, which answers the
 * scaffolder's one-shot question:
 *
 * - it names the signal, because the line a person reads has to say what was
 *   found (`.cursor/ found; Cursor is not enabled …`), and
 * - it ignores {@link SHARED_SIGNAL_PATHS}, so the canonical `AGENTS.md` is not
 *   read as somebody running Codex.
 *
 * A directory signal is reported with a trailing `/`. The first signal a
 * harness matches wins; the order is the table's.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns one entry per harness found, in canonical {@link HARNESS_IDS} order.
 */
export function detectHarnessFootprints(repoRoot: string): DetectedHarness[] {
  const found: DetectedHarness[] = [];
  for (const harness of HARNESS_IDS) {
    for (const rel of HARNESS_DETECTION_SIGNALS[harness]) {
      if (SHARED_SIGNAL_PATHS.has(rel)) continue;
      const stats = statOrNothing(join(repoRoot, rel));
      if (!stats) continue;
      // Repo-relative and slash-joined whatever the platform: the signal is
      // printed, and `.github\copilot-instructions.md` is not a path anybody
      // wants to read (the table builds that one with `join`).
      const shown = rel.split(sep).join('/');
      found.push({ harness, signal: stats.isDirectory() ? `${shown}/` : shown });
      break;
    }
  }
  return found;
}

/**
 * What is at a path, or nothing — never a throw.
 *
 * `throwIfNoEntry: false` only suppresses ENOENT and ENOTDIR; a symlink loop
 * (ELOOP) or an unreadable parent (EACCES) still throws. This runs on EVERY
 * plan, from the CLI and from the server's unattended auto-projection, so a
 * `.cursor` that happens to be a symlink cycle would have taken down every sync
 * in the repo — to answer a question whose whole purpose is a one-line notice.
 * A path that cannot be read is a harness that cannot be detected, which is the
 * same answer as absent and a far better outcome than a broken sync.
 */
function statOrNothing(abs: string): Stats | undefined {
  try {
    return statSync(abs, { throwIfNoEntry: false });
  } catch {
    return undefined;
  }
}

/**
 * The default manifest body the scaffolder writes for a given harness set. Every
 * policy/exception array starts empty (those are derived by the scanner or filled
 * in by the user); only the `harnesses` set is decided here.
 */
function defaultManifest(harnesses: readonly HarnessId[]): HarnessManifest {
  return {
    version: 1,
    harnesses: [...harnesses],
    claudeOnlySkills: [],
    skillWrappers: [],
    commandMappings: [],
    instructionProjections: [],
    hookPolicies: [],
    skillBundles: [],
  };
}

/**
 * Scaffold a default `.agents/harness.manifest.json` into a repo when none exists.
 *
 * Write-if-absent (ADR-302): an existing manifest is never overwritten. When no
 * manifest is present, the scaffolder picks a harness set (detected from the
 * repo's on-disk footprint, or {@link DEFAULT_HARNESSES} when nothing is detected,
 * or overridden by `opts.harnesses`) and writes a valid, human-editable manifest
 * with empty policy arrays for the user to extend.
 *
 * @param repoRoot - absolute path to the repository root to scaffold into.
 * @param opts - optional explicit harness set; defaults to detection + fallback.
 * @returns whether a manifest was written, its path, the harness set, and whether
 *   that set was detected (vs the documented fallback).
 */
export function scaffoldManifest(
  repoRoot: string,
  opts?: ScaffoldManifestOptions
): ScaffoldManifestResult {
  const abs = join(repoRoot, HARNESS_MANIFEST_PATH);

  if (existsSync(abs)) {
    return {
      created: false,
      path: HARNESS_MANIFEST_PATH,
      harnesses: readExistingHarnesses(abs),
      detected: false,
    };
  }

  let harnesses: readonly HarnessId[];
  let detected: boolean;
  if (opts?.harnesses) {
    harnesses = opts.harnesses;
    detected = false;
  } else {
    const found = detectHarnesses(repoRoot);
    detected = found.length > 0;
    harnesses = detected ? found : DEFAULT_HARNESSES;
  }

  // Two-space indent + trailing newline so the file reads (and diffs) like the
  // hand-authored manifests already in the repo. Atomic, because a second
  // process scaffolding the same repo would otherwise be able to read this one
  // half-written and fail its whole projection on an unparseable manifest.
  writeFileAtomic(abs, `${JSON.stringify(defaultManifest(harnesses), null, 2)}\n`);

  return { created: true, path: HARNESS_MANIFEST_PATH, harnesses, detected };
}

/**
 * Best-effort read of the `harnesses` set from a manifest already on disk, used to
 * report what {@link scaffoldManifest} found when it skips writing. Falls back to
 * {@link DEFAULT_HARNESSES} on any read/parse failure rather than throwing (the
 * caller will load + validate the manifest properly downstream).
 */
function readExistingHarnesses(absManifestPath: string): readonly HarnessId[] {
  try {
    const raw = JSON.parse(readFileSync(absManifestPath, 'utf8')) as { harnesses?: unknown };
    if (Array.isArray(raw.harnesses)) {
      const ids = raw.harnesses.filter((h): h is HarnessId =>
        (HARNESS_IDS as readonly string[]).includes(h)
      );
      if (ids.length > 0) return ids;
    }
  } catch {
    // fall through to the documented default
  }
  return DEFAULT_HARNESSES;
}

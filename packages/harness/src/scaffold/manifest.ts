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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { HARNESS_IDS, type HarnessId, type HarnessManifest } from '../manifest/schema.js';

/** Repo-relative path of the harness manifest the scaffolder writes. */
export const HARNESS_MANIFEST_PATH = join('.agents', 'harness.manifest.json');

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
};

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

  mkdirSync(dirname(abs), { recursive: true });
  // Two-space indent + trailing newline so the file reads (and diffs) like the
  // hand-authored manifests already in the repo.
  writeFileSync(abs, `${JSON.stringify(defaultManifest(harnesses), null, 2)}\n`);

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

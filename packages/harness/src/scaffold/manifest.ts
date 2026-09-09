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
import {
  HARNESS_IDS,
  HARNESS_LABELS,
  type HarnessId,
  type HarnessManifest,
} from '../manifest/schema.js';
import { instructionPointerTarget } from '../plan/instructions.js';
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
   *
   * An explicit set is exactly the set: {@link dorkosHarness} is not added to
   * it. A caller that names the harnesses has already decided, and the one that
   * does — `projectAgentWorkspace`, with `['claude-code']` — would get the same
   * answer anyway.
   */
  harnesses?: readonly HarnessId[];
  /**
   * The harness DorkOS's OWN default runtime reads, added to the detected set
   * so a project DorkOS manages enables the tool DorkOS actually runs there.
   *
   * INJECTED, never read: this engine reads no config, and `runtimes.default`
   * is a `~/.dork/config.json` key. The server passes
   * `harnessForRuntime(configManager.get('runtimes').default)`; the CLI reads
   * the same key off disk (`--check` must not open a config store, DOR-678).
   *
   * Why it exists: detection enables the harnesses whose files are already
   * here, which is right for every OTHER tool and wrong for this one. A repo
   * that has only ever run OpenCode has left no `.claude/`, so detection could
   * not enable Claude Code — and the one thing the engine would write for it is
   * the `.claude/CLAUDE.md` pointer that makes the project's own `AGENTS.md` the
   * instructions a DorkOS session reads. Without it a person who points a DorkOS
   * agent at their project gets a managed session that has never seen their
   * house rules (DOR-1901).
   */
  dorkosHarness?: HarnessId;
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
  /**
   * The harness added to the set because DorkOS runs it here, or `null` when
   * nothing was added — it was already detected, no `dorkosHarness` was passed,
   * an explicit set was, or a manifest already existed.
   *
   * The reason it is a field rather than something a caller re-derives: it is
   * the one thing about a scaffolded manifest a person has to be TOLD, because
   * it is the one entry that is not a consequence of what is in their folder.
   * Every scaffold notice prints {@link dorkosHarnessScaffoldNotice} for it.
   */
  addedForDorkos: HarnessId | null;
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
      found.push({ harness, why: 'footprint', signal: stats.isDirectory() ? `${shown}/` : shown });
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
 * The default manifest body the scaffolder writes for a given harness set.
 *
 * Three keys, and every policy/exception array starts empty (the scanner derives
 * the skills; the user fills the rest in); only the `harnesses` set is decided
 * here. It used to write four more — `skillWrappers`, `commandMappings`,
 * `instructionProjections` and `skillBundles` — which nothing ever read, so every
 * scaffolded repo started life with four blank blocks it would never be asked
 * about again (DOR-1858). They are still ACCEPTED by the schema, so an existing
 * manifest that carries them keeps working; they are simply not written into a
 * new one.
 */
function defaultManifest(harnesses: readonly HarnessId[]): HarnessManifest {
  return {
    version: 1,
    harnesses: [...harnesses],
    claudeOnlySkills: [],
    hookPolicies: [],
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
      // Nothing was added, because nothing was written: an existing manifest is
      // the person's file (ADR-302). A manifest that predates this and lacks the
      // harness DorkOS runs is reported instead, as a `dorkos-runtime` entry in
      // every plan's `notEnabled` with the `--enable` command that adds it.
      addedForDorkos: null,
    };
  }

  let harnesses: readonly HarnessId[];
  let detected: boolean;
  let addedForDorkos: HarnessId | null = null;
  if (opts?.harnesses) {
    harnesses = opts.harnesses;
    detected = false;
  } else {
    const found = detectHarnesses(repoRoot);
    detected = found.length > 0;
    const base = detected ? found : DEFAULT_HARNESSES;
    // Appended rather than sorted into canonical order, so the file reads as
    // what it is: the harnesses this folder shows, and then the one DorkOS runs.
    const missing = opts?.dorkosHarness !== undefined && !base.includes(opts.dorkosHarness);
    harnesses = missing ? [...base, opts.dorkosHarness as HarnessId] : base;
    addedForDorkos = missing ? (opts.dorkosHarness as HarnessId) : null;
  }

  // Two-space indent + trailing newline so the file reads (and diffs) like the
  // hand-authored manifests already in the repo. Atomic, because a second
  // process scaffolding the same repo would otherwise be able to read this one
  // half-written and fail its whole projection on an unparseable manifest.
  writeFileAtomic(abs, `${JSON.stringify(defaultManifest(harnesses), null, 2)}\n`);

  return { created: true, path: HARNESS_MANIFEST_PATH, harnesses, detected, addedForDorkos };
}

/**
 * The one line every scaffold notice prints when a harness was turned on
 * because DorkOS runs it here.
 *
 * One sentence, in one place, so the CLI's `--fix` output and the server's
 * auto-projection log say the same thing about the same decision. It names the
 * consequence rather than the mechanism, because the consequence is the part a
 * person can act on: the file that will point at the `AGENTS.md` they already
 * have — or, for a harness that reads `AGENTS.md` itself, that it just does.
 *
 * @param harness - The harness {@link ScaffoldManifestResult.addedForDorkos} named.
 * @returns The line to print.
 */
export function dorkosHarnessScaffoldNotice(harness: HarnessId): string {
  const pointer = instructionPointerTarget(harness);
  const consequence =
    pointer === undefined
      ? 'it reads your AGENTS.md directly'
      : `${pointer} will point at your AGENTS.md`;
  return `${HARNESS_LABELS[harness]} is turned on because DorkOS runs it here; ${consequence}.`;
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

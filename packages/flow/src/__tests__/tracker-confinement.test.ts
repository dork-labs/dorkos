/**
 * Tracker-confinement guard (spec §3, §Security; task 1.1).
 *
 * The architectural invariant: ALL `/flow` tracker I/O is confined to the single
 * adapter skill (`linear-adapter`). Every `mcp__linear__*` /
 * `mcp__plugin_linear_linear__*` string, every `composio` invocation, and every
 * `LINEAR_*` tracker slug must appear ONLY inside that adapter skill dir — giving
 * the agnosticism win ("all Linear in one place") and a single audit surface for
 * tracker writes.
 *
 * SCOPE — the FLOW BUNDLE ONLY, not the whole repo (widened in task 5.3 to cover
 * the autonomous engine surfaces, not just the skills + commands):
 *   - `.agents/flow/skills/**`        (canonical flow stage + adapter skills)
 *   - `.claude/commands/flow/**`      (thin /flow + /flow:<stage> commands)
 *   - `packages/flow/src/**`          (the @dorkos/flow engine package)
 *   - `.dork/tasks/flow-drain/**`     (the Pulse drain cron task)
 *   - `.claude/hooks/flow-loop.mjs`   (the Stop hook — a single-file root)
 *
 * This is deliberately NOT scoped to the repo. The legacy `/pm`, `/linear:*`, and
 * `linear-loop` surfaces still contain tracker strings today; scoping wider would
 * fail on pre-existing legacy. The meaningful invariant is that the FLOW bundle —
 * skills, commands, AND the engine/cron/hook code — confines tracker I/O to the
 * adapter.
 *
 * The `'linear'` enum carve-out (task 5.3): the lowercase `z.enum(['linear'])`
 * literal in `config-schema.ts` `TrackerSchema` and `tasks-schema.ts`
 * `ProvenanceTrackerSchema` is the generic tracker *name*, not a tracker API
 * string. It is bare `linear` — it does NOT match the `mcp__linear__` /
 * `LINEAR_[A-Z_]+` / `composio` I/O patterns below, so it passes the guard
 * naturally with no allowlist entry. Only the SCAN_EXCLUSIONS files (which assert
 * ON the adapter contract as fixtures) need exclusion.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// src/__tests__ -> src -> packages/flow -> packages -> repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The one skill dir permitted to contain tracker strings. */
const ADAPTER_SKILL_DIR = path.join(repoRoot, '.agents', 'flow', 'skills', 'linear-adapter');

/**
 * Roots that make up the flow bundle surface this guard scopes to. A root may be
 * a directory (walked recursively) OR a single file (the Stop hook). Task 5.3
 * widened this from skills + commands to ALSO cover the engine package, the Pulse
 * drain task, and the Stop hook, so tracker I/O can't leak into the code layer.
 */
const FLOW_BUNDLE_ROOTS = [
  path.join(repoRoot, '.agents', 'flow', 'skills'),
  path.join(repoRoot, '.claude', 'commands', 'flow'),
  path.join(repoRoot, 'packages', 'flow', 'src'),
  path.join(repoRoot, '.dork', 'tasks', 'flow-drain'),
  path.join(repoRoot, '.claude', 'hooks', 'flow-loop.mjs'),
];

/**
 * Files inside the widened roots that LEGITIMATELY carry the pattern strings — as
 * test fixtures / assertions ABOUT the adapter contract, never as live tracker
 * I/O. Excluding them stops the guard from matching its own pattern literals
 * (`tracker-confinement.test.ts`) and the adapter-doc test's `toMatch(/composio/i)`
 * assertion (`linear-adapter-doc.test.ts`), which would otherwise self-fail.
 */
const SCAN_EXCLUSIONS = new Set([
  path.join(repoRoot, 'packages', 'flow', 'src', '__tests__', 'tracker-confinement.test.ts'),
  path.join(repoRoot, 'packages', 'flow', 'src', '__tests__', 'linear-adapter-doc.test.ts'),
]);

/**
 * Tracker-string patterns that may only live in the adapter skill. Case-sensitive
 * where it matters: `composio` is matched case-insensitively (CLI is lowercase but
 * prose may capitalize); the MCP/slug families are matched as written.
 */
const TRACKER_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'linear MCP tool', re: /mcp__(plugin_)?linear[_a-z]*__/ },
  { label: 'composio invocation', re: /\bcomposio\b/i },
  { label: 'Composio LINEAR_ slug', re: /\bLINEAR_[A-Z_]+\b/ },
];

/** Recursively collect every file path under `dir` (skips nothing — flow dirs are small). */
function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Collect every file under a root that may be a directory OR a single file. */
function collectFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return statSync(root).isFile() ? [root] : walkFiles(root);
}

function isInsideAdapterSkill(file: string): boolean {
  const rel = path.relative(ADAPTER_SKILL_DIR, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The tracker-pattern labels a given content blob trips, in pattern order. */
function trackerOffenses(content: string): string[] {
  return TRACKER_PATTERNS.filter(({ re }) => re.test(content)).map(({ label }) => label);
}

/**
 * Scan a set of (file, content) pairs and return offender descriptions, applying
 * the adapter-skill carve-out and the fixture allowlist. The real scan and the
 * planted-offender unit both run through this one function so they exercise the
 * same matching + exclusion logic.
 */
function scanForOffenders(files: { file: string; content: string }[]): string[] {
  const offenders: string[] = [];
  for (const { file, content } of files) {
    if (isInsideAdapterSkill(file)) continue;
    if (SCAN_EXCLUSIONS.has(file)) continue;
    for (const label of trackerOffenses(content)) {
      offenders.push(`${path.relative(repoRoot, file)} — contains a ${label}`);
    }
  }
  return offenders;
}

describe('tracker confinement — the flow bundle keeps all tracker I/O in linear-adapter', () => {
  it('the adapter skill exists and is the single confinement target', () => {
    expect(existsSync(path.join(ADAPTER_SKILL_DIR, 'SKILL.md'))).toBe(true);
  });

  it('no tracker string appears in the flow bundle OUTSIDE the linear-adapter skill', () => {
    const files = FLOW_BUNDLE_ROOTS.flatMap((root) =>
      collectFiles(root).map((file) => ({ file, content: readFileSync(file, 'utf8') }))
    );
    const offenders = scanForOffenders(files);

    expect(
      offenders,
      `tracker strings leaked outside linear-adapter:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the scan is non-vacuous — it actually visits files in every widened root', () => {
    // Guard against an empty or mis-rooted scan silently passing: each widened
    // root must contribute at least one scanned file.
    for (const root of FLOW_BUNDLE_ROOTS) {
      expect(collectFiles(root).length, `root produced no files: ${root}`).toBeGreaterThan(0);
    }
  });

  it('a planted mcp__linear__ string in any of the three new roots fails the guard', () => {
    // Unit on the matcher + scan logic, not real files: plant an offender directly
    // under the engine package, the drain task, and the Stop hook, and assert each
    // is caught (proving the widened roots are genuinely scanned, not allowlisted).
    const planted = 'await mcp__linear__create_issue({ title: "x" });';
    const plantedRoots = [
      path.join(repoRoot, 'packages', 'flow', 'src', '__planted-offender__.ts'),
      path.join(repoRoot, '.dork', 'tasks', 'flow-drain', '__planted-offender__.md'),
      path.join(repoRoot, '.claude', 'hooks', 'flow-loop.mjs'),
    ];
    for (const file of plantedRoots) {
      const offenders = scanForOffenders([{ file, content: planted }]);
      expect(offenders.length, `planted offender not caught at ${file}`).toBeGreaterThan(0);
    }
  });

  it('the adapter skill DOES carry tracker strings (proves the guard is meaningful, not vacuous)', () => {
    const skill = readFileSync(path.join(ADAPTER_SKILL_DIR, 'SKILL.md'), 'utf8');
    // If the adapter had no tracker strings, the "zero outside" assertion would be
    // trivially true. Pin that the adapter is where they actually live.
    expect(TRACKER_PATTERNS.some(({ re }) => re.test(skill))).toBe(true);
  });
});

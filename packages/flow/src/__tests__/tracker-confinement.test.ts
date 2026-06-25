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
 * SCOPE — the FLOW BUNDLE ONLY, not the whole repo:
 *   - `.agents/flow/skills/**`        (canonical flow stage + adapter skills)
 *   - `.claude/commands/flow/**`      (thin /flow + /flow:<stage> commands)
 *
 * This is deliberately NOT scoped to the repo. The legacy `/pm`, `/linear:*`, and
 * `linear-loop` surfaces still contain tracker strings today and are removed only
 * in task 1.5; scoping wider would fail on pre-existing legacy. The meaningful v1
 * invariant is that the FLOW bundle confines tracker I/O to the adapter.
 *
 * As P1 completes (1.2–1.5 add stage skills + flow commands), this same scope
 * naturally widens to the whole flow surface — the guard already covers
 * `.claude/commands/flow/**`, which does not exist yet, and every new flow skill
 * under `.agents/flow/skills/`. No edit needed when those land.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// src/__tests__ -> src -> packages/flow -> packages -> repo root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The one skill dir permitted to contain tracker strings. */
const ADAPTER_SKILL_DIR = path.join(repoRoot, '.agents', 'flow', 'skills', 'linear-adapter');

/** Roots that make up the flow bundle surface this guard scopes to. */
const FLOW_BUNDLE_ROOTS = [
  path.join(repoRoot, '.agents', 'flow', 'skills'),
  path.join(repoRoot, '.claude', 'commands', 'flow'),
];

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
  if (!existsSync(dir)) return [];
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

function isInsideAdapterSkill(file: string): boolean {
  const rel = path.relative(ADAPTER_SKILL_DIR, file);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

describe('tracker confinement — the flow bundle keeps all tracker I/O in linear-adapter', () => {
  it('the adapter skill exists and is the single confinement target', () => {
    expect(existsSync(path.join(ADAPTER_SKILL_DIR, 'SKILL.md'))).toBe(true);
  });

  it('no tracker string appears in the flow bundle OUTSIDE the linear-adapter skill', () => {
    const offenders: string[] = [];

    for (const root of FLOW_BUNDLE_ROOTS) {
      for (const file of walkFiles(root)) {
        if (isInsideAdapterSkill(file)) continue;
        // Skip this guard's own siblings (tests live in packages/flow, not the bundle),
        // but the bundle roots can't contain them anyway — defensive only.
        const content = readFileSync(file, 'utf8');
        for (const { label, re } of TRACKER_PATTERNS) {
          if (re.test(content)) {
            offenders.push(`${path.relative(repoRoot, file)} — contains a ${label}`);
          }
        }
      }
    }

    expect(
      offenders,
      `tracker strings leaked outside linear-adapter:\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  it('the adapter skill DOES carry tracker strings (proves the guard is meaningful, not vacuous)', () => {
    const skill = readFileSync(path.join(ADAPTER_SKILL_DIR, 'SKILL.md'), 'utf8');
    // If the adapter had no tracker strings, the "zero outside" assertion would be
    // trivially true. Pin that the adapter is where they actually live.
    expect(TRACKER_PATTERNS.some(({ re }) => re.test(skill))).toBe(true);
  });
});

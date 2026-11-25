/**
 * Reading and writing the API lint baseline (`scripts/api-lint/baseline.json`),
 * on this tree and as it was at a base commit. Every read validates the shape:
 * an unknown rule, or a count that is not a whole number above zero, is a
 * failure to measure (exit 2), never a guess.
 *
 * @module scripts/api-lint/baseline-file
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiLintError } from './document.ts';
import { RULE_IDS, type RuleId } from './rules.ts';

/** Where the baseline lives, relative to the root. */
export const BASELINE_PATH = 'scripts/api-lint/baseline.json';

/** Unit to count. */
export type UnitCounts = Record<string, number>;

/** Rule to its unit counts. */
export type Counts = Record<RuleId, UnitCounts>;

/** The baseline file. */
export interface Baseline {
  /** Why the file exists and how to change it, for whoever opens it. */
  $comment: string;
  /** Rule to unit to count, both sorted. */
  rules: Partial<Counts>;
}

const COMMENT =
  'The API lint ratchet (scripts/api-lint/check-api-lint.ts, DOR-4996). Each number is how many findings a rule has in that route group (or file, for hand-registered-path). It may only fall. Run `pnpm check:api-lint -- --update` after fixing some; never raise a number by hand.';

/**
 * A record with its keys sorted, so the baseline diffs cleanly.
 *
 * @param record - Any string-keyed record.
 */
export function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Parse and validate a baseline file's text.
 *
 * @param text - The file's text.
 * @param where - Where it came from, for errors.
 */
export function readBaseline(text: string, where: string): Partial<Counts> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiLintError(`${where} is not valid JSON`);
  }
  const rules = (parsed as Partial<Baseline> | null)?.rules;
  if (!rules || typeof rules !== 'object') throw new ApiLintError(`${where} has no rules map`);
  for (const [rule, units] of Object.entries(rules)) {
    if (!(RULE_IDS as readonly string[]).includes(rule)) {
      throw new ApiLintError(`${where}: ${rule} is not a rule this check knows`);
    }
    for (const [unit, n] of Object.entries(units ?? {})) {
      if (!Number.isInteger(n) || (n as number) < 1) {
        throw new ApiLintError(`${where}: ${rule} ${unit} must be a whole number above zero`);
      }
    }
  }
  return rules;
}

/**
 * Read the baseline on this tree.
 *
 * @param root - The tree.
 */
export function readBaselineFile(root: string): Partial<Counts> {
  let text: string;
  try {
    text = readFileSync(join(root, BASELINE_PATH), 'utf8');
  } catch {
    throw new ApiLintError(`cannot read ${BASELINE_PATH}`);
  }
  return readBaseline(text, BASELINE_PATH);
}

/**
 * Write the baseline: every rule listed, rules and units sorted.
 *
 * @param root - The tree.
 * @param counts - Rule to unit to count.
 */
export function writeBaseline(root: string, counts: Counts): void {
  const rules = sortKeys(
    Object.fromEntries(RULE_IDS.map((rule) => [rule, sortKeys(counts[rule])]))
  );
  const body: Baseline = { $comment: COMMENT, rules };
  writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(body, null, 2)}\n`);
}

function git(root: string, args: string[], what: string): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new ApiLintError(what);
  }
}

/**
 * The baseline as it was at `ref`, or `null` only when that tree has no such
 * file. A ref git cannot resolve, or a file it cannot read, is a failure to
 * measure, never a skipped check.
 *
 * @param root - The repository.
 * @param ref - The base commit.
 */
export function baselineAt(root: string, ref: string): Partial<Counts> | null {
  git(
    root,
    ['cat-file', '-e', `${ref}^{commit}`],
    `--base ${ref} is not a commit this checkout has`
  );
  const listed = git(
    root,
    ['ls-tree', '--name-only', ref, '--', BASELINE_PATH],
    `cannot list ${ref}`
  );
  if (listed.trim() === '') return null;
  const where = `${BASELINE_PATH} at ${ref}`;
  return readBaseline(
    git(root, ['show', `${ref}:${BASELINE_PATH}`], `cannot read ${where}`),
    where
  );
}

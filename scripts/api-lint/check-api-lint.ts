/**
 * Hold the HTTP API to a ratchet: the OpenAPI document and the route census
 * may only get better, one rule and one route group at a time.
 *
 * --help
 * Purpose: hold the HTTP API to a ratchet: the OpenAPI document and the route
 *          census may only get better, per rule and route group.
 * Runs in: `pnpm ratchet` (the required `typecheck` job, `--queue` in the queue); by hand.
 * To fix:  fix the new finding it names (rules: contributing/api-reference.md).
 *          After a fix, run `pnpm check:api-lint -- --update` and commit the lower
 *          baseline. A lowered count in a group you never touched is a queue
 *          leftover: `--update` and commit it with your change.
 * Usage:   pnpm check:api-lint [-- --base <ref> | --update | --queue | --init]
 * --help end
 *
 * WHY THIS EXISTS. The REST API review measured the API at `8c118b8d7f`: 0 of
 * 475 operations carried an `operationId`; 157 paths ended in a command word
 * (the `verb-path` rule here counts a command word in any static segment);
 * 60 operations declared no error response and 387 error responses used an
 * inline shape beside the shared `ErrorResponse`; 91 of 113 list GETs were
 * unpaged; 273 served routes were missing from the document and 25 documented
 * operations had no handler. Two of seven recent HTTP merges shipped routes
 * with no document entry, and no gate noticed. The plan (DOR-4977) migrates
 * old routes area by area; this gate (DOR-4996) stops the API from getting
 * worse while that happens. Failing every finding at once would red the build
 * on hundreds of them, so it is a ratchet like `check-own-mocks.ts`: today's
 * state is the baseline, and a count may only fall. Some rules here are
 * defined more narrowly or more widely than the review's counts (the
 * command-word list is exact; an error response with no body counts as a bad
 * shape), so the committed baseline, not the figures above, is the measure.
 *
 * WHAT IT READS. Committed files, no server: `docs/api/openapi.json` with its
 * internal part `docs/api/openapi-internal.json` merged in (both kept fresh by
 * `docs-openapi-check`; internal operations are documented, only not
 * published) and the route census
 * `apps/server/src/http/__tests__/route-census.baseline.json` (kept fresh by
 * the booted census test), plus the `registerPath(` calls in the hand-written
 * registry. The rules are in `rules.ts` and `contributing/api-reference.md`.
 *
 * THE UNIT IS THE ROUTE GROUP (the first segment under `/api`), so two PRs in
 * different groups never fight over the baseline. For `hand-registered-path`
 * it is the file.
 *
 * WHAT FAILS (exit 1):
 *   - duplicate: two operations share one `operationId`, whatever the baseline;
 *   - grew:      a rule found more in a group than its baseline;
 *   - new:       a rule found something in a group the baseline does not list;
 *   - stale:     a count fell and the baseline still says the old number. Run
 *                `--update`, which only lowers or removes entries, so the gain
 *                cannot be spent later. With `--queue` (the merge queue) a
 *                stale entry only prints: two queued PRs that each fix one
 *                finding in a group and each lower its entry merge to a count
 *                below the entry, and ejecting the second for that would punish
 *                a fix. The next `--update` on any PR locks the drop in;
 *   - raised:    with `--base <ref>`, a blocking rule's entry is higher than
 *                the base's or is new. A rule the base's baseline did not have
 *                at all is being introduced, and is not judged. The baseline is lowered by
 *                `--update`, never raised by hand.
 *
 * ADVISORY RULES. A rule whose `blocking` is false in `RULES` (rules.ts) is
 * measured and written to the baseline, but its findings print as advisory
 * lines and never set exit 1, and `--base` does not judge its entries.
 * `--update` sets its entries to the measured counts, up or down, so the
 * baseline tracks reality and the rule does not go red the day it starts
 * blocking. `hand-registered-path` is advisory, and skips the routes on the
 * permanent hand-route allowlist (`apps/server/src/http/hand-routes/allowlist.ts`).
 * It flips to blocking when the pending list (`pending.json` beside
 * it) is empty: from then every other route is a capability `http` surface.
 * `list-paging` never counts the lists in `list-paging-exemptions.ts`, each
 * with a reason (small or fixed views, or ones a later item reshapes).
 *
 * Exit 2 means it could not run (an unreadable input, a bad or empty `--base`,
 * a flag with no value): a gate that cannot measure must not pass.
 *
 * Usage:
 *   pnpm check:api-lint                       check against the baseline
 *   pnpm check:api-lint -- --base <ref>       also refuse a raised baseline
 *   pnpm check:api-lint -- --update           lower and remove entries
 *   pnpm check:api-lint -- --queue            a stale entry only prints (merge queue)
 *   pnpm check:api-lint -- --init             write the baseline from scratch
 *   pnpm check:api-lint -- --root <dir>       measure another tree
 *   pnpm check:api-lint -- --spec <path>      read another OpenAPI document
 *   pnpm check:api-lint -- --internal <path>  merge another internal part into it
 *   pnpm check:api-lint -- --census <path>    read another route census
 *
 * @module scripts/api-lint/check-api-lint
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BASELINE_PATH,
  baselineAt,
  readBaselineFile,
  sortKeys,
  writeBaseline,
  type Counts,
  type UnitCounts,
} from './baseline-file.ts';
import { HAND_ROUTE_ALLOWLIST } from '../../apps/server/src/http/hand-routes/allowlist.ts';
import { ApiLintError, operations, parseCensus, parseSpec } from './document.ts';
import { withoutExemptLists } from './list-paging-exemptions.ts';
import {
  duplicateOperationIds,
  errorMissingItems,
  errorShapeItems,
  isHandRegistryFile,
  listPagingItems,
  operationIdItems,
  paramNameItems,
  registerPathLines,
  RULE_IDS,
  RULES,
  undocumentedRouteItems,
  unservedOperationItems,
  verbPathItems,
  type Items,
  type RuleId,
} from './rules.ts';
import { exitOnHelp } from '../lib/gate-help.mjs';
import {
  INTERNAL_PART_PATH,
  PUBLISHED_DOCUMENT_PATH,
  mergeInternalPart,
} from '../../packages/api-client/scripts/api-document.ts';

export { BASELINE_PATH, type Counts, type UnitCounts } from './baseline-file.ts';

/** The OpenAPI document, relative to the root. */
export const SPEC_PATH = PUBLISHED_DOCUMENT_PATH;

/** The route census, relative to the root. */
export const CENSUS_PATH = 'apps/server/src/http/__tests__/route-census.baseline.json';

/** Everything one run measured. */
export interface Measurement {
  /** Rule to unit to count. */
  counts: Counts;
  /** Rule to unit to what was found, for the failure message. */
  items: Record<RuleId, Items>;
  /** Shared operation id to the operations that carry it. */
  duplicates: Record<string, string[]>;
  /**
   * How much was read. The CLI neither prints nor checks it; the repo-wide
   * test asserts on it, so a run that read nothing cannot pass that test.
   */
  scanned: {
    /** Operations in the document. */
    operations: number;
    /** Entries in the census. */
    routes: number;
    /** Hand registry files with at least one `registerPath(` call. */
    registryFiles: number;
  };
}

/** Where to read the inputs, when not the committed files. */
export interface Inputs {
  /** The OpenAPI document. */
  spec?: string;
  /**
   * The document's internal part, merged into it. Read from its committed path
   * unless `spec` names another document, when only a named one is read.
   */
  internal?: string;
  /** The route census. */
  census?: string;
}

/** One reason the check fails. */
export interface Finding {
  /** Which part of the ratchet was broken. */
  kind: 'grew' | 'new' | 'stale' | 'raised' | 'duplicate';
  /** The rule. */
  rule: RuleId;
  /** The route group or file; for `duplicate`, the shared operation id. */
  unit: string;
  /** The count now, when it has one. */
  count?: number;
  /** The number the baseline holds. */
  baseline?: number;
  /** For `duplicate`, the operations sharing the id. */
  operations?: string[];
}

const UPDATE = '`pnpm check:api-lint -- --update`';

/**
 * Whether a finding fails the check. A shared operation id always does; any
 * other finding does only when its rule is blocking ({@link RULES}), and a
 * stale entry does not in the merge queue.
 *
 * @param f - The finding.
 * @param queue - Whether the run is in the merge queue (`--queue`).
 */
export function isBlocking(f: Finding, queue = false): boolean {
  if (f.kind === 'duplicate') return true;
  if (queue && f.kind === 'stale') return false;
  return RULES[f.rule].blocking;
}

function emptyCounts(): Counts {
  return Object.fromEntries(RULE_IDS.map((rule) => [rule, {}])) as Counts;
}

function countsOf(items: Items): UnitCounts {
  return sortKeys(Object.fromEntries(Object.entries(items).map(([u, list]) => [u, list.length])));
}

function readInput(root: string, path: string): { text: string; where: string } {
  try {
    return { text: readFileSync(resolve(root, path), 'utf8'), where: path };
  } catch {
    throw new ApiLintError(`cannot read ${path}`);
  }
}

/**
 * Every `registerPath(` call in the hand registry, by file, less those that
 * document a route on the permanent hand-route allowlist.
 *
 * @param root - The tree to measure.
 */
export function handRegistryItems(root: string): Items {
  // Untracked files too, so a local run agrees with CI before `git add`.
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'apps/server/src'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
    .split('\0')
    .filter((file, i, all) => file && isHandRegistryFile(file) && all.indexOf(file) === i);
  const items: Items = {};
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    const lines = registerPathLines(text, HAND_ROUTE_ALLOWLIST).map((line) => `${file}:${line}`);
    if (lines.length > 0) items[file] = lines;
  }
  return items;
}

/**
 * Measure every rule.
 *
 * @param root - The tree to measure.
 * @param inputs - Other files to read instead of the committed ones.
 */
export function measure(root: string, inputs: Inputs = {}): Measurement {
  const spec = readInput(root, inputs.spec ?? SPEC_PATH);
  const census = readInput(root, inputs.census ?? CENSUS_PATH);
  // Internal operations are served and documented, just not published: every
  // rule holds them too, and they count as documented (DOR-4983).
  const internalPath = inputs.internal ?? (inputs.spec ? undefined : INTERNAL_PART_PATH);
  const internal = internalPath ? readInput(root, internalPath) : undefined;
  const published = parseSpec(spec.text, spec.where);
  const doc = internal
    ? mergeInternalPart(published, parseSpec(internal.text, internal.where))
    : published;
  const routes = parseCensus(census.text, census.where);
  const items: Record<RuleId, Items> = {
    'operation-id': operationIdItems(doc),
    'verb-path': verbPathItems(doc),
    'param-name': paramNameItems(doc),
    'error-missing': errorMissingItems(doc),
    'error-shape': errorShapeItems(doc),
    'list-paging': withoutExemptLists(listPagingItems(doc)),
    'undocumented-route': undocumentedRouteItems(doc, routes),
    'unserved-operation': unservedOperationItems(doc, routes),
    'hand-registered-path': handRegistryItems(root),
  };
  const counts = emptyCounts();
  for (const rule of RULE_IDS) counts[rule] = countsOf(items[rule]);
  const scanned = {
    operations: operations(doc).length,
    routes: routes.length,
    registryFiles: Object.keys(items['hand-registered-path']).length,
  };
  return { counts, items, duplicates: duplicateOperationIds(doc), scanned };
}

/**
 * The hard findings: every operation id two operations share.
 *
 * @param duplicates - What {@link measure} found.
 */
export function duplicateFindings(duplicates: Record<string, string[]>): Finding[] {
  return Object.entries(duplicates).map(([unit, operations]) => ({
    kind: 'duplicate' as const,
    rule: 'operation-id' as const,
    unit,
    operations,
  }));
}

/**
 * Compare measured counts with the baseline.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline's rules.
 */
export function compare(counts: Counts, baseline: Partial<Counts>): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULE_IDS) {
    const held = baseline[rule] ?? {};
    for (const [unit, count] of Object.entries(counts[rule])) {
      const before = held[unit];
      if (before === undefined) findings.push({ kind: 'new', rule, unit, count });
      else if (count > before) findings.push({ kind: 'grew', rule, unit, count, baseline: before });
      else if (count < before)
        findings.push({ kind: 'stale', rule, unit, count, baseline: before });
    }
    for (const [unit, before] of Object.entries(held)) {
      if (!(unit in counts[rule])) findings.push({ kind: 'stale', rule, unit, baseline: before });
    }
  }
  return findings;
}

/**
 * Entries the baseline raised against its base: higher than before, or new.
 * A rule the base did not list at all is being introduced and is skipped, and
 * so is an advisory rule, whose entries `--update` raises on purpose.
 *
 * @param current - The baseline on this tree.
 * @param base - The baseline on the base tree.
 */
export function raisedAgainst(current: Partial<Counts>, base: Partial<Counts>): Finding[] {
  const findings: Finding[] = [];
  for (const rule of RULE_IDS) {
    const before = base[rule];
    if (before === undefined || !RULES[rule].blocking) continue;
    for (const [unit, held] of Object.entries(current[rule] ?? {})) {
      const was = before[unit];
      if (was === undefined) findings.push({ kind: 'raised', rule, unit, count: held });
      else if (held > was)
        findings.push({ kind: 'raised', rule, unit, count: held, baseline: was });
    }
  }
  return findings;
}

/**
 * The baseline after `--update`: every entry of a blocking rule lowered to its
 * count, entries at zero removed, nothing raised and nothing added. An
 * advisory rule's entries become the measured counts, up or down.
 *
 * @param counts - What {@link measure} found.
 * @param baseline - The committed baseline's rules.
 */
export function lowered(counts: Counts, baseline: Partial<Counts>): Counts {
  const next = emptyCounts();
  for (const rule of RULE_IDS) {
    if (!RULES[rule].blocking) {
      next[rule] = sortKeys({ ...counts[rule] });
      continue;
    }
    const kept: UnitCounts = {};
    for (const [unit, held] of Object.entries(baseline[rule] ?? {})) {
      const count = counts[rule][unit];
      if (count !== undefined) kept[unit] = Math.min(held, count);
    }
    next[rule] = sortKeys(kept);
  }
  return next;
}

/**
 * One line a person can act on.
 *
 * @param f - The finding.
 */
export function describe(f: Finding): string {
  const where = `${f.rule} in ${f.unit}`;
  switch (f.kind) {
    case 'duplicate':
      return `operation-id: "${f.unit}" is shared by ${(f.operations ?? []).join(', ')}. Each operationId must be unique.`;
    case 'grew':
      return `${where}: ${f.count} (baseline ${f.baseline}). ${RULES[f.rule].fix}`;
    case 'new':
      return `${where}: ${f.count}, and the baseline holds none there. ${RULES[f.rule].fix}`;
    case 'stale':
      return f.count === undefined
        ? `${where}: none left. Run ${UPDATE} to drop it from the baseline.`
        : `${where}: down to ${f.count} (baseline ${f.baseline}). Run ${UPDATE} to lock that in.`;
    case 'raised':
      return f.baseline === undefined
        ? `${where}: added to the baseline at ${f.count}. The baseline is never added to by hand.`
        : `${where}: baseline raised from ${f.baseline} to ${f.count}. The baseline only goes down.`;
  }
}

/** How many items a failure prints under its line, so one bad group cannot flood the log. */
const MAX_LISTED = 25;

function printFinding(f: Finding, items: Record<RuleId, Items>, prefix: string): void {
  console.error(`  ${prefix}${describe(f)}`);
  if (f.kind !== 'grew' && f.kind !== 'new') return;
  const found = items[f.rule][f.unit] ?? [];
  for (const item of found.slice(0, MAX_LISTED)) console.error(`      ${item}`);
  if (found.length > MAX_LISTED) console.error(`      … and ${found.length - MAX_LISTED} more`);
}

/**
 * Print every finding, blocking ones first, and say whether the run fails.
 *
 * @returns 1 when any finding is blocking, else 0.
 */
function report(findings: Finding[], items: Record<RuleId, Items>, queue = false): number {
  const blocking = findings.filter((f) => isBlocking(f, queue));
  const advisory = findings.filter((f) => !isBlocking(f, queue));
  if (blocking.length) console.error(`api-lint: ${blocking.length} problem(s):`);
  for (const f of blocking) printFinding(f, items, '');
  if (advisory.length) console.error(`api-lint: ${advisory.length} advisory note(s), not failing:`);
  for (const f of advisory) printFinding(f, items, 'advisory: ');
  return blocking.length ? 1 : 0;
}

function totals(counts: Counts): string {
  return RULE_IDS.map((rule) => {
    const total = Object.values(counts[rule]).reduce((a, b) => a + b, 0);
    return `${rule} ${total}`;
  }).join(', ');
}

/**
 * The value after `name`, or undefined when the flag is absent. A flag given
 * with no value (or an empty one) is a usage error, never a silent default.
 */
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new ApiLintError(`${name} needs a value`);
  return value;
}

function main(argv: string[]): number {
  const value = (name: string) => flagValue(argv, name);
  const root = resolve(value('--root') ?? process.cwd());
  const inputs: Inputs = {};
  const [spec, census, base] = [value('--spec'), value('--census'), value('--base')];
  const internal = value('--internal');
  if (spec) inputs.spec = spec;
  if (internal) inputs.internal = internal;
  if (census) inputs.census = census;
  const m = measure(root, inputs);
  const hard = duplicateFindings(m.duplicates);

  if (argv.includes('--init')) {
    writeBaseline(root, m.counts);
    console.log(`api-lint: wrote ${BASELINE_PATH}: ${totals(m.counts)}`);
    return hard.length ? report(hard, m.items) : 0;
  }

  const baseline = readBaselineFile(root);

  if (argv.includes('--update')) {
    const next = lowered(m.counts, baseline);
    writeBaseline(root, next);
    console.log(`api-lint: baseline updated: ${totals(next)}`);
    // Lowering never excuses growth, a new group or a shared id; say so rather than hide it.
    const left = [...hard, ...compare(m.counts, next).filter((f) => f.kind !== 'stale')];
    return left.length ? report(left, m.items) : 0;
  }

  const findings = [...hard, ...compare(m.counts, baseline)];
  const before = base ? baselineAt(root, base) : null;
  if (before) findings.push(...raisedAgainst(baseline, before));
  const queue = argv.includes('--queue');
  const code = findings.length ? report(findings, m.items, queue) : 0;
  const verdict = findings.length ? 'passes, advisory notes only.' : 'clean, nothing added.';
  if (code === 0) console.log(`api-lint: ${verdict} ${totals(m.counts)}`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnHelp(import.meta.url);
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error(`api-lint: cannot run: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

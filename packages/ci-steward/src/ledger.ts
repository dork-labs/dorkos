/**
 * `ci-steward ledger-check`: validity of every `ci/ledger/<id>-<slug>.md`.
 *
 * The ledger is the pipeline's change record: one file per change, each with a
 * hypothesis a later run can compute a verdict for. Validity runs on every PR
 * and every merge group, so a malformed entry never reaches `main`, and every
 * metric an entry names is one the collector can actually compute.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Finding } from './finding.ts';
import { isTimestampId } from './ids.ts';
import type { HandFiles } from './load.ts';
import { COMPUTED_STATUSES, LedgerFrontmatterSchema, describeZodError } from './schemas.ts';

/** `<id>-<slug>.md`, with a kebab-case slug. */
export const LEDGER_FILE_RE = /^(\d{6}-\d{6})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

/**
 * Split a Markdown file into its YAML frontmatter and body.
 *
 * @param text - The file's contents.
 * @returns `null` when the file does not open with a `---` fenced block.
 */
function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  return m ? { yaml: m[1]!, body: m[2]! } : null;
}

/** What a metric id must resolve against. */
interface Catalogue {
  gateIds: ReadonlySet<string>;
  hookNames: ReadonlySet<string>;
  gateMetrics: ReadonlySet<string>;
  hookMetrics: ReadonlySet<string>;
  otherIds: ReadonlySet<string>;
  sloIds: ReadonlySet<string>;
}

/**
 * Build the metric catalogue from the hand files.
 *
 * @param files - The loaded hand files.
 */
function buildCatalogue(files: HandFiles): Catalogue {
  const gateIds = new Set((files.gates?.gates ?? []).map((g) => g.id));
  const hookNames = new Set(
    [...gateIds].filter((id) => id.startsWith('lefthook.')).map((id) => id.split('.')[1]!)
  );
  const m = files.metrics;
  return {
    gateIds,
    hookNames,
    gateMetrics: new Set((m?.gate_templates ?? []).map((t) => t.metric)),
    hookMetrics: new Set((m?.hook_templates ?? []).map((t) => t.metric)),
    otherIds: new Set([
      ...(m?.queue ?? []).map((q) => q.id),
      ...(m?.tracked ?? []).map((t) => t.id),
      ...(m?.slo_metrics ?? []),
    ]),
    sloIds: new Set((files.slos?.slos ?? []).map((s) => s.id)),
  };
}

/**
 * Explain why a metric id is not in the catalogue, or `null` when it is.
 *
 * @param id - The metric id a hypothesis names.
 * @param c - The catalogue.
 */
function metricProblem(id: string, c: Catalogue): string | null {
  if (id.startsWith('gate.')) {
    const rest = id.slice('gate.'.length);
    const cut = rest.lastIndexOf('.');
    const gate = rest.slice(0, cut);
    const metric = rest.slice(cut + 1);
    if (cut <= 0 || !c.gateMetrics.has(metric)) {
      return `"${id}" must end in one of the per-gate metrics: ${[...c.gateMetrics].join(', ')}`;
    }
    if (!c.gateIds.has(gate)) return `"${id}" names gate "${gate}", which is not in ci/gates.yaml`;
    return null;
  }
  if (id.startsWith('hook.')) {
    const [, hook, metric, ...extra] = id.split('.');
    if (extra.length || !hook || !metric || !c.hookMetrics.has(metric)) {
      return `"${id}" must be hook.<git-hook>.<${[...c.hookMetrics].join('|')}>`;
    }
    if (!c.hookNames.has(hook)) return `"${id}" names hook "${hook}", which lefthook does not run`;
    return null;
  }
  return c.otherIds.has(id) ? null : `"${id}" is not a metric id in ci/metrics.yaml`;
}

function checkOne(file: string, text: string, files: HandFiles, c: Catalogue): Finding[] {
  const out: Finding[] = [];
  const f = (code: string, message: string, fix: string, where?: string) =>
    out.push({ code, file, where, message, fix });
  const name = path.posix.basename(file);
  const nameMatch = LEDGER_FILE_RE.exec(name);
  if (!nameMatch) {
    f(
      'ledger/filename',
      `${name} is not named <YYMMDD-HHMMSS>-<kebab-slug>.md.`,
      `Rename it, or scaffold a correct one with \`${files.config.commands.ledger_new}\`.`
    );
    return out;
  }
  const split = splitFrontmatter(text);
  if (!split) {
    f(
      'ledger/frontmatter',
      'The file does not open with a `---` YAML frontmatter block.',
      'Start the file with the frontmatter shown in plan §4.3, fenced by `---` lines.'
    );
    return out;
  }
  let raw: unknown;
  try {
    raw = parseYaml(split.yaml);
  } catch (e) {
    f(
      'ledger/frontmatter',
      `The frontmatter does not parse: ${e instanceof Error ? e.message : String(e)}`,
      'Fix the YAML syntax.'
    );
    return out;
  }
  const status = (raw as { status?: unknown } | null)?.status;
  if (typeof status === 'string' && (COMPUTED_STATUSES as readonly string[]).includes(status)) {
    f(
      'ledger/computed-status',
      `status: ${status} is a computed verdict. Verdicts live only on the ci-steward-data branch (verdicts/<id>.json), written by code; on main an entry carries only proposed, active, withdrawn or reverted.`,
      'Set status to active (the change is live) or reverted/withdrawn, and leave the verdict to the collector.',
      'status'
    );
    return out;
  }
  const parsed = LedgerFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    f(
      'ledger/schema',
      `The frontmatter does not match the ledger schema: ${describeZodError(parsed.error).join('; ')}`,
      'Fix each field named above (LedgerFrontmatterSchema in packages/ci-steward/src/schemas.ts).'
    );
    return out;
  }
  const fm = parsed.data;
  if (fm.id !== nameMatch[1]) {
    f(
      'ledger/id',
      `id is ${fm.id} but the file name starts with ${nameMatch[1]}.`,
      'Make the id and the file-name prefix identical.',
      'id'
    );
  } else if (!isTimestampId(fm.id)) {
    f(
      'ledger/id',
      `${fm.id} is not a real UTC YYMMDD-HHMMSS timestamp.`,
      `Use an id from \`${files.config.commands.ledger_new}\`.`,
      'id'
    );
  }
  if (split.body.trim().length === 0) {
    f(
      'ledger/body',
      'The entry has no body.',
      'Say in a few lines why the change was made, what was tried, and what would make us revert it.'
    );
  }
  for (const g of fm.gates) {
    if (!c.gateIds.has(g))
      f(
        'ledger/gate',
        `gates lists "${g}", which is not in ci/gates.yaml.`,
        'Use an id from ci/gates.yaml (wf.<workflow>.<job>, lefthook.<hook>.<command>, claude.<Event>.<script>, ruleset.<rule>).',
        'gates'
      );
  }
  const h = fm.hypothesis;
  if (!h && fm.kind !== 'hygiene') {
    f(
      'ledger/hypothesis-missing',
      `A ${fm.kind} entry needs a hypothesis: the metric it should move, the baseline, the target and the after-window.`,
      'Add `hypothesis: {metric, baseline, baseline_source, target, after_days}` using a ci/metrics.yaml id, or set kind: hygiene if nothing measurable is expected to change.',
      'hypothesis'
    );
  }
  if (h) {
    const problem = metricProblem(h.metric, c);
    if (problem)
      f(
        'ledger/metric',
        `hypothesis.metric ${problem}.`,
        'Name a catalogue id: gate.<gate-id>.<metric>, hook.<hook>.<metric>, queue.*, tracked.*, or an SLO id (see ci/metrics.yaml).',
        'hypothesis.metric'
      );
    if (h.slo !== undefined && !c.sloIds.has(h.slo))
      f(
        'ledger/slo',
        `hypothesis.slo "${h.slo}" is not an SLO id in ci/slos.yaml.`,
        'Use an id from ci/slos.yaml, or drop the field.',
        'hypothesis.slo'
      );
    if (h.baseline_source === undefined)
      f(
        'ledger/baseline-source',
        'hypothesis has no baseline_source. No latest.json snapshot exists yet, so every baseline is copied by hand and must say where it came from.',
        'Add `baseline_source:` naming the run sample, report or PR the baseline was read from.',
        'hypothesis.baseline_source'
      );
    if (h.baseline === null && fm.status !== 'proposed')
      f(
        'ledger/baseline',
        `baseline is null on a ${fm.status} entry; only a proposed entry may defer its baseline.`,
        'Measure the baseline before the change goes live and record it.',
        'hypothesis.baseline'
      );
  }
  const ratchetIds = new Set((files.ratchets?.ratchets ?? []).map((r) => r.id));
  for (const r of fm['ratchet-release']) {
    if (!ratchetIds.has(r.ratchet))
      f(
        'ledger/ratchet',
        `ratchet-release names "${r.ratchet}", which is not in ci/ratchets.yaml.`,
        'Use a ratchet id from ci/ratchets.yaml.',
        'ratchet-release'
      );
  }
  for (const fc of fm['field-changes']) {
    if (!c.gateIds.has(fc.gate))
      f(
        'ledger/gate',
        `field-changes names gate "${fc.gate}", which is not in ci/gates.yaml.`,
        'Use an id from ci/gates.yaml.',
        'field-changes'
      );
  }
  if (
    fm.actor === 'ci-improve-tick' &&
    (fm['ratchet-release'].length > 0 || fm['field-changes'].length > 0)
  ) {
    f(
      'ledger/tick-authority',
      'An unattended ci-improve-tick change may not author a ratchet-release or a field-changes entry (plan §4.7).',
      'Leave that change to an attended PR with actor: agent.'
    );
  }
  return out;
}

/**
 * Validate every ledger entry in the ledger directory.
 *
 * @param root - Repo root.
 * @param files - The loaded hand files.
 */
export function checkLedger(root: string, files: HandFiles): Finding[] {
  const dir = files.config.ledger_dir;
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  const catalogue = buildCatalogue(files);
  const out: Finding[] = [];
  const seen = new Map<string, string>();
  for (const name of readdirSync(abs).sort()) {
    if (!name.endsWith('.md')) continue;
    const rel = `${dir}/${name}`;
    out.push(...checkOne(rel, readFileSync(path.join(abs, name), 'utf8'), files, catalogue));
    const id = LEDGER_FILE_RE.exec(name)?.[1];
    if (id && seen.has(id)) {
      out.push({
        code: 'ledger/duplicate-id',
        file: rel,
        message: `${id} is also used by ${seen.get(id)}.`,
        fix: `Give one of them a fresh id with \`${files.config.commands.ledger_new}\`.`,
      });
    }
    if (id) seen.set(id, rel);
  }
  return out;
}

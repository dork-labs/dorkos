/**
 * `ci-steward census`: proves the pipeline's stated intent in `ci/` matches
 * the pipeline that actually runs.
 *
 * It runs as a step in the required `typecheck` job on every PR and every
 * merge group, so it must be fast (it reads a few dozen small files and shells
 * out to nothing) and every failure must say exactly what to change.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { trackAllowlist } from './allowlist.ts';
import { claudeHookGates, lefthookGates, workflowGates, type DiscoveredGate } from './discover.ts';
import { blockState, renderRequiredChecksBlock, replaceBlock } from './doc-blocks.ts';
import type { Finding } from './finding.ts';
import { CONFIG_PATH, loadHandFiles, type HandFiles } from './load.ts';
import { checkRequiredContexts, checkTimeouts } from './required.ts';
import { loadWorkflows, type WorkflowModel } from './workflows.ts';

/** Inputs to one census run. */
export interface CensusOptions {
  /** Repo root. */
  root: string;
  /** The clock that decides allowlist expiry. */
  now: Date;
  /** Rewrite drifted generated doc blocks instead of reporting them. Touches nothing else. */
  fix?: boolean;
}

/** What one census run found and, with `fix`, rewrote. */
export interface CensusResult {
  findings: Finding[];
  /** Repo-relative paths `--fix` rewrote. */
  fixed: string[];
}

/** The `source` a `ruleset.*` gate records. */
function rulesetSource(rulesetId: number): string {
  return `github:ruleset/${rulesetId}`;
}

/**
 * Discover every gate from the workflows, lefthook and Claude settings.
 *
 * @param root - Repo root.
 * @param files - The loaded hand files.
 * @param workflows - The parsed workflows.
 * @param findings - Where unreadable sources are reported.
 */
export function discoverGates(
  root: string,
  files: HandFiles,
  workflows: readonly WorkflowModel[],
  findings: Finding[]
): DiscoveredGate[] {
  const { config } = files;
  const gates = workflowGates(workflows);
  const read = (rel: string, parse: (text: string) => DiscoveredGate[]) => {
    try {
      gates.push(...parse(readFileSync(path.join(root, rel), 'utf8')));
    } catch (e) {
      findings.push({
        code: 'source/unreadable',
        file: rel,
        message: `Could not read gates from ${rel}: ${e instanceof Error ? e.message : String(e)}`,
        fix: `Fix ${rel}, or point ci/config.yaml at its real location.`,
      });
    }
  };
  read(config.lefthook, (t) => lefthookGates(config.lefthook, t));
  read(config.claude_settings, (t) =>
    claudeHookGates(config.claude_settings, t, config.claude_hook_wrappers)
  );
  return gates;
}

function checkGates(files: HandFiles, discovered: readonly DiscoveredGate[]): Finding[] {
  const out: Finding[] = [];
  const { config, gates } = files;
  if (!gates) return out;
  const gatesPath = config.hand_files.gates;
  const declared = new Map<string, (typeof gates.gates)[number]>();
  for (const g of gates.gates) {
    if (declared.has(g.id)) {
      out.push({
        code: 'gates/duplicate',
        file: gatesPath,
        where: g.id,
        message: `${g.id} is listed more than once.`,
        fix: 'Keep one entry per gate id.',
      });
    }
    declared.set(g.id, g);
  }
  const expected = new Map(discovered.map((g) => [g.id, g.source]));
  for (const rule of config.ruleset.rules) {
    expected.set(`ruleset.${rule}`, rulesetSource(config.ruleset.id));
  }
  for (const [id, source] of expected) {
    const d = declared.get(id);
    if (!d) {
      out.push({
        code: 'gates/missing',
        file: gatesPath,
        where: id,
        message: `The gate ${id} runs (defined in ${source}) but ${gatesPath} has no entry for it, so nothing states what it is for.`,
        fix: `Add \`- { id: ${id}, source: ${source}, purpose: <one plain sentence: what it catches> }\` to ${gatesPath}.`,
      });
    } else if (d.source !== source) {
      out.push({
        code: 'gates/source',
        file: gatesPath,
        where: id,
        message: `${id} records source ${d.source}, but it is defined in ${source}.`,
        fix: `Set \`source: ${source}\` on ${id}.`,
      });
    }
  }
  for (const id of declared.keys()) {
    if (expected.has(id)) continue;
    out.push({
      code: 'gates/stale',
      file: gatesPath,
      where: id,
      message: id.startsWith('ruleset.')
        ? `${id} is not a rule ci/config.yaml lists under ruleset.rules.`
        : `${id} is listed but no workflow job, lefthook command or Claude hook by that id exists any more.`,
      fix: id.startsWith('ruleset.')
        ? `Remove ${id}, or add the rule name to ruleset.rules in ci/config.yaml if the live ruleset has it.`
        : `Remove ${id} from ${gatesPath}; if the gate was renamed, rename the id to match.`,
    });
  }
  return out;
}

function checkCrossFile(root: string, files: HandFiles): Finding[] {
  const out: Finding[] = [];
  const { config, requiredChecks, slos, metrics, ratchets } = files;
  if (requiredChecks && requiredChecks.ruleset !== config.ruleset.id) {
    out.push({
      code: 'xfile/ruleset-id',
      file: config.hand_files.required_checks,
      message: `ruleset is ${requiredChecks.ruleset} but ci/config.yaml names ruleset ${config.ruleset.id}.`,
      fix: 'Make the two ids agree with the live "main: merge queue" ruleset.',
    });
  }
  if (slos && metrics) {
    const sloIds = slos.slos.map((s) => s.id).sort();
    const listed = [...metrics.slo_metrics].sort();
    if (sloIds.join('\n') !== listed.join('\n')) {
      const missing = sloIds.filter((id) => !listed.includes(id));
      const extra = listed.filter((id) => !sloIds.includes(id));
      out.push({
        code: 'xfile/slo-metrics',
        file: config.hand_files.metrics,
        where: 'slo_metrics',
        message: `slo_metrics must list exactly the SLO ids in ${config.hand_files.slos}. Missing: [${missing.join(', ')}]. Not an SLO: [${extra.join(', ')}].`,
        fix: `Edit slo_metrics in ${config.hand_files.metrics} to match the ids in ${config.hand_files.slos}.`,
      });
    }
  }
  for (const r of ratchets?.ratchets ?? []) {
    if (r.file !== undefined && !existsSync(path.join(root, r.file))) {
      out.push({
        code: 'xfile/ratchet-file',
        file: config.hand_files.ratchets,
        where: r.id,
        message: `Content ratchet ${r.id} guards ${r.file}, which does not exist.`,
        fix: `Point ${r.id}.file at the real file.`,
      });
    }
  }
  return out;
}

/**
 * The main canary's list and the workflows it names must agree (DOR-2150).
 *
 * `ci/config.yaml`'s `canary.workflows` is what the collector reads a run's
 * event against; the `schedule:` and `workflow_dispatch:` triggers are what
 * make the runs happen. Nothing joins the two at runtime, so either half can be
 * removed without the other noticing — and a canary that stopped running reads
 * exactly like a healthy `main` in every number on the report. This is the
 * registry that makes the pair conform, rather than opting in by name twice.
 *
 * It binds in BOTH directions:
 *
 *   * a name in `canary.workflows` must be a real workflow that carries both
 *     triggers, with at least one cron and at least one job that can actually
 *     run on a schedule — a `schedule: []`, or a workflow whose every job skips
 *     on that event, would report green while running nothing;
 *   * every workflow that owns a required context must be in `canary.workflows`
 *     or in `canary.exempt` with a reason. Without that half, deleting a name
 *     from the list leaves the census green while collection and the silence
 *     arm both stop, which is the failure mode with no symptom.
 *
 * @param files - The hand files.
 * @param workflows - The parsed workflows.
 */
function checkCanary(files: HandFiles, workflows: readonly WorkflowModel[]): Finding[] {
  const out: Finding[] = [];
  const { canary } = files.config;
  const byFile = new Map(workflows.map((w) => [w.file, w]));
  for (const file of canary.workflows) {
    const wf = byFile.get(file);
    if (!wf) {
      out.push({
        code: 'canary/missing-workflow',
        file: CONFIG_PATH,
        where: file,
        message: `canary.workflows names ${file}, which is not in ${files.config.workflows_dir}.`,
        fix: `Remove it from canary.workflows in ${CONFIG_PATH}, or restore the workflow.`,
      });
      continue;
    }
    const missing = ['schedule', 'workflow_dispatch'].filter((t) => !wf.triggers.has(t));
    if (missing.length) {
      out.push({
        code: 'canary/missing-trigger',
        file: wf.path,
        message: `${file} is a main-canary workflow but has no ${missing.join(' and no ')} trigger, so it never runs against main.`,
        fix: `Add the missing trigger(s) to ${wf.path}, or drop ${file} from canary.workflows in ${CONFIG_PATH}.`,
      });
      continue;
    }
    if ((wf.triggers.get('schedule')?.crons?.length ?? 0) === 0)
      out.push({
        code: 'canary/no-cron',
        file: wf.path,
        message: `${file} declares schedule: with no cron, so the canary never fires for it. A trigger with an empty list reports green and runs nothing.`,
        fix: `Give the schedule at least one cron in ${wf.path}, or drop ${file} from canary.workflows in ${CONFIG_PATH}.`,
      });
    if (!wf.jobs.some((j) => j.if === undefined || canRunOnSchedule(j.if)))
      out.push({
        code: 'canary/no-job-runs',
        file: wf.path,
        message: `${file} is a main-canary workflow but every job's if: skips on a scheduled run, so the canary reports green having run nothing.`,
        fix: `Let at least one job run on schedule in ${wf.path}, or drop ${file} from canary.workflows in ${CONFIG_PATH}.`,
      });
  }
  const listed = new Set(canary.workflows);
  for (const [file, reason] of Object.entries(canary.exempt))
    if (listed.has(file))
      out.push({
        code: 'canary/exempt-and-listed',
        file: CONFIG_PATH,
        where: file,
        message: `${file} is in canary.workflows AND canary.exempt ("${reason.slice(0, 40)}…"). One of the two is a lie.`,
        fix: `Delete the entry from whichever list is wrong in ${CONFIG_PATH}.`,
      });
  for (const context of files.requiredChecks?.contexts ?? []) {
    const owners = workflows.filter((wf) => wf.jobs.some((j) => j.checkName === context));
    for (const wf of owners) {
      if (listed.has(wf.file) || wf.file in canary.exempt) continue;
      out.push({
        code: 'canary/required-unwatched',
        file: CONFIG_PATH,
        where: wf.file,
        message: `${wf.file} owns the required context "${context}" but is in neither canary.workflows nor canary.exempt, so nothing runs it against main and nothing says why.`,
        fix: `Add ${wf.file} to canary.workflows in ${CONFIG_PATH} (and give it schedule: and workflow_dispatch: triggers), or add it to canary.exempt with the reason it cannot run on main.`,
      });
    }
  }
  return out;
}

/**
 * Whether a job-level `if:` can be true on a scheduled run.
 *
 * The census's expression evaluator only knows the two gating events, so a
 * condition naming `merge_group` or `pull_request` positively is read here as
 * false on a schedule. Anything it cannot decide counts as runnable: this
 * finding exists to catch a workflow that provably runs nothing, never to
 * guess.
 *
 * @param cond - The job's `if:`.
 */
function canRunOnSchedule(cond: string | boolean): boolean {
  if (typeof cond === 'boolean') return cond;
  const text = cond.replace(/\s+/g, ' ');
  // Decidably event-gated to the merge path, with no `||` offering another way
  // in: `github.event_name == 'merge_group'` and friends.
  const positive = /github\.event_name\s*==\s*'(pull_request|merge_group)'/.test(text);
  return !(positive && !text.includes('||'));
}

function checkDocBlocks(root: string, files: HandFiles, fix: boolean, fixed: string[]): Finding[] {
  const out: Finding[] = [];
  const { config, requiredChecks } = files;
  if (!requiredChecks) return out;
  const rendered = renderRequiredChecksBlock(requiredChecks.contexts);
  for (const rel of config.generated_blocks.required_checks) {
    const abs = path.join(root, rel);
    if (!existsSync(abs)) {
      out.push({
        code: 'docs/missing-file',
        file: rel,
        message: `ci/config.yaml lists ${rel} as carrying the generated required-checks block, but the file does not exist.`,
        fix: `Create ${rel} with the block below, or remove it from generated_blocks.required_checks in ci/config.yaml:\n${rendered}`,
      });
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    const state = blockState(text, rendered);
    if (state === 'ok') continue;
    if (state === 'drift' && fix) {
      writeFileSync(abs, replaceBlock(text, rendered)!);
      fixed.push(rel);
      continue;
    }
    out.push({
      code: `docs/${state === 'drift' ? 'drift' : state === 'missing' ? 'missing-block' : 'malformed-block'}`,
      file: rel,
      message:
        state === 'drift'
          ? `The generated required-checks block differs from ${config.hand_files.required_checks}.`
          : state === 'missing'
            ? 'The file has no generated required-checks block.'
            : 'The file has more than one start or end marker, or they are out of order.',
      fix:
        state === 'drift'
          ? `Run \`${config.commands.census_fix}\`; it rewrites only the block.`
          : `Put exactly one copy of this block where the required checks are listed, then run \`${config.commands.census_fix}\` whenever the list changes:\n${rendered}`,
    });
  }
  return out;
}

/**
 * Run every census check.
 *
 * @param opts - Root, clock and fix mode.
 */
export function runCensus(opts: CensusOptions): CensusResult {
  const fixed: string[] = [];
  const { files, findings } = loadHandFiles(opts.root);
  if (!files) return { findings, fixed };
  const { config } = files;
  const workflows = loadWorkflows(opts.root, config.workflows_dir, (file, message) =>
    findings.push({
      code: 'source/unreadable',
      file,
      message: `The workflow does not parse: ${message}`,
      fix: 'Fix the YAML (actionlint names the line).',
    })
  );
  const allowPath = config.hand_files.census_allowlist;
  const allow = trackAllowlist(files.allowlist?.entries ?? [], opts.now, allowPath);
  const discovered = discoverGates(opts.root, files, workflows, findings);
  findings.push(...checkGates(files, discovered));
  findings.push(...checkTimeouts(workflows, allow));
  if (files.requiredChecks) {
    findings.push(
      ...checkRequiredContexts(
        workflows,
        files.requiredChecks.contexts,
        config.hand_files.required_checks,
        config.default_branch,
        allow
      )
    );
  }
  if (files.allowlist) findings.push(...allow.leftovers());
  findings.push(...checkCrossFile(opts.root, files));
  findings.push(...checkCanary(files, workflows));
  findings.push(...checkDocBlocks(opts.root, files, opts.fix === true, fixed));
  return { findings, fixed };
}

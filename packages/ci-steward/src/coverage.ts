/**
 * `ci-steward ledger-check --coverage`: a PR that changes the pipeline must
 * record the change in the ledger, and an unattended `ci-improve/*` branch may
 * not touch what judges it.
 *
 * Runs on `pull_request` only: it needs the PR's diff against its base and
 * its branch name, and neither can change between the PR and the merge queue.
 */
import type { DiscoveredGate } from './discover.ts';
import { invokedScripts } from './discover.ts';
import type { Finding } from './finding.ts';
import { matchesAny } from './glob.ts';
import type { HandFiles } from './load.ts';
import type { WorkflowModel } from './workflows.ts';

/** One changed path, as `git diff --name-status --no-renames` reports it. */
export interface ChangedFile {
  status: string;
  path: string;
}

/** Inputs to the coverage check. */
export interface CoverageInput {
  root: string;
  files: HandFiles;
  workflows: readonly WorkflowModel[];
  gates: readonly DiscoveredGate[];
  rootScripts: Readonly<Record<string, string>>;
  changed: readonly ChangedFile[];
  /** The PR's head branch name. */
  branch: string;
}

/**
 * Every path that counts as pipeline source: the configured globs, each gate's
 * defining file, and every repo script a gate invokes.
 *
 * @param input - The coverage inputs.
 */
function pipelinePaths(input: Omit<CoverageInput, 'changed' | 'branch'>): {
  globs: string[];
  files: Set<string>;
} {
  const { config } = input.files;
  const files = new Set<string>([
    config.lefthook,
    config.claude_settings,
    ...input.workflows.map((w) => w.path),
    ...invokedScripts(
      input.root,
      input.gates.flatMap((g) => g.commands),
      input.rootScripts
    ),
  ]);
  return { globs: config.coverage_paths, files };
}

/**
 * Run the coverage and fence checks over a PR's changed files.
 *
 * @param input - The PR's diff, branch and the repo's gates.
 */
export function checkCoverage(input: CoverageInput): Finding[] {
  const out: Finding[] = [];
  const { config, stewardOwnedPaths } = input.files;
  const { globs, files } = pipelinePaths(input);
  const ledgerGlob = `${config.ledger_dir}/*.md`;
  const touched = input.changed.filter((c) => files.has(c.path) || matchesAny(c.path, globs));
  const ledgerTouched = input.changed.some(
    (c) => c.status !== 'D' && matchesAny(c.path, [ledgerGlob])
  );
  const pipelineTouched = touched.filter((c) => !matchesAny(c.path, [ledgerGlob]));
  if (pipelineTouched.length > 0 && !ledgerTouched) {
    const list = pipelineTouched.slice(0, 10).map((c) => c.path);
    const more = pipelineTouched.length > 10 ? ` and ${pipelineTouched.length - 10} more` : '';
    out.push({
      code: 'coverage/missing-entry',
      file: config.ledger_dir,
      message: `This PR changes the pipeline (${list.join(', ')}${more}) but adds or edits no ${ledgerGlob} entry, so nobody will be able to tell later whether the change worked.`,
      fix: `Run \`${config.commands.ledger_new} --slug <what-changed> --kind <experiment|incident-fix|hygiene>\`, fill in the hypothesis (a ci/metrics.yaml id, baseline with baseline_source, target, after_days) or use kind: hygiene when nothing measurable should move, and commit it with this PR.`,
    });
  }
  if (input.branch.startsWith(config.fence_branch_prefix) && stewardOwnedPaths) {
    const fenced = input.changed.filter((c) => matchesAny(c.path, stewardOwnedPaths.paths));
    for (const c of fenced) {
      out.push({
        code: 'fence/steward-owned',
        file: c.path,
        where: `branch ${input.branch}`,
        message: `A ${config.fence_branch_prefix}* branch is an unattended pipeline change, and it may change gates but never the steward or the judge; ${c.path} is on the fence list (${config.hand_files.steward_owned_paths}).`,
        fix: `Drop the change to ${c.path} from this branch. If it is really needed, make it in a separate PR from a branch not named ${config.fence_branch_prefix}*, where a person reviews it.`,
      });
    }
  }
  return out;
}

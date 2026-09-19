/**
 * The census rules about jobs: timeouts, the deadlock invariant for required
 * contexts, and the no-silent-pass rules for required jobs.
 *
 * Two GitHub facts shape every rule here. A required context that never
 * reports on `merge_group` (or on `pull_request`) stalls every PR. And a
 * required job that is SKIPPED reports success, so a job-level `if:` that is
 * false on an event, or a `needs:` failure that skips the job, is not a
 * deadlock but a silent hole: the context passes while asserting nothing.
 */
import type { AllowlistTracker } from './allowlist.ts';
import { evaluateCondition, ignoresNeedsResult, type GateEvent } from './expr.ts';
import type { Finding } from './finding.ts';
import { globToRegExp } from './glob.ts';
import type { JobModel, WorkflowModel } from './workflows.ts';

const EVENTS: readonly GateEvent[] = ['pull_request', 'merge_group'];

/**
 * Every job must bound its runtime; GitHub's default is six hours.
 *
 * @param workflows - The parsed workflows.
 * @param allow - The allowlist tracker (kind `no-timeout`).
 */
export function checkTimeouts(
  workflows: readonly WorkflowModel[],
  allow: AllowlistTracker
): Finding[] {
  const out: Finding[] = [];
  for (const wf of workflows) {
    for (const job of wf.jobs) {
      if (job.isReusableCall || job.timeoutMinutes !== undefined) continue;
      if (allow.covers({ workflow: wf.file, job: job.id, kind: 'no-timeout' })) continue;
      out.push({
        code: 'timeout/missing',
        file: wf.path,
        where: `job ${job.id}`,
        message:
          'This job has no timeout-minutes, so a hung run holds a runner for GitHub’s six-hour default.',
        fix: `Add \`timeout-minutes: N\` to job ${job.id}, with N = max(10, ceil(3 × p95)) of its job durations over the last 30 days (gh run list --workflow ${wf.file}, then each run's jobs). With fewer than 5 runs, add a ci/census-allowlist.yaml entry {workflow: ${wf.file}, job: ${job.id}, kind: no-timeout, reason, expires} dated 30 days out.`,
      });
    }
  }
  return out;
}

function branchesAllowDefault(branches: string[] | undefined, defaultBranch: string): boolean {
  if (branches === undefined) return true;
  return branches.some((b) => !b.startsWith('!') && globToRegExp(b).test(defaultBranch));
}

function where(job: JobModel, context: string): string {
  return `job ${job.id}, required context "${context}"`;
}

function checkTriggers(
  wf: WorkflowModel,
  job: JobModel,
  context: string,
  defaultBranch: string
): Finding[] {
  const out: Finding[] = [];
  for (const event of EVENTS) {
    const t = wf.triggers.get(event);
    if (!t) {
      out.push({
        code: 'deadlock/missing-trigger',
        file: wf.path,
        where: where(job, context),
        message: `The workflow has no \`${event}:\` trigger, so the required check "${context}" never reports on ${event}. ${event === 'merge_group' ? 'Every queued PR waits for it until the queue times out and ejects it.' : 'No PR can enter the merge queue, because a required check must pass on the PR first.'}`,
        fix: `Add \`${event}:\` to the workflow's \`on:\` block.`,
      });
      continue;
    }
    for (const [key, value] of [
      ['paths', t.paths],
      ['paths-ignore', t.pathsIgnore],
    ] as const) {
      if (value === undefined) continue;
      out.push({
        code: 'deadlock/paths-filter',
        file: wf.path,
        where: where(job, context),
        message: `\`on.${event}\` has a \`${key}:\` filter. A path-filtered workflow reports nothing at all when the filter misses, and a required check that never reports keeps the PR out of the queue, or holds a queued PR until check_response_timeout ejects it.`,
        fix: `Remove \`${key}:\` from \`on.${event}\`. If the job should skip unrelated changes, decide that inside the job with a scope step (see site-build.yml), so the check still reports.`,
      });
    }
    if (!branchesAllowDefault(t.branches, defaultBranch) || t.branchesIgnore !== undefined) {
      out.push({
        code: 'deadlock/branches-filter',
        file: wf.path,
        where: where(job, context),
        message: `\`on.${event}\` filters branches in a way that can exclude \`${defaultBranch}\`, so the required check "${context}" may never report for PRs into it.`,
        fix: `Remove the branches filter from \`on.${event}\`, or make it include \`${defaultBranch}\`.`,
      });
    }
    if (event === 'pull_request' && t.types !== undefined && !t.types.includes('synchronize')) {
      out.push({
        code: 'deadlock/types-no-synchronize',
        file: wf.path,
        where: where(job, context),
        message: `\`on.pull_request.types\` is [${t.types.join(', ')}] without \`synchronize\`, so a push to the PR does not re-run "${context}" and the new head commit never gets the required check.`,
        fix: 'Add `synchronize` to `on.pull_request.types` (or drop `types:` to take the defaults).',
      });
    }
  }
  return out;
}

function checkJobCondition(
  wf: WorkflowModel,
  job: JobModel,
  context: string,
  allow: AllowlistTracker
): Finding[] {
  const out: Finding[] = [];
  if (job.needs.length > 0 && !ignoresNeedsResult(job.if)) {
    out.push({
      code: 'required/needs-without-always',
      file: wf.path,
      where: where(job, context),
      message: `Job ${job.id} needs [${job.needs.join(', ')}] and its \`if:\` has no always() or !cancelled(). When a needed job fails, GitHub SKIPS this job, and a skipped required check reports success: a red dependency merges green.`,
      fix: `Give job ${job.id} \`if: \${{ always() }}\` and a first step that fails unless every \`needs.<job>.result\` is 'success' (see the \`test\` fan-in in test.yml).`,
    });
  }
  if (job.if === undefined) return out;
  const results = EVENTS.map((e) => [e, evaluateCondition(job.if!, e)] as const);
  if (results.every(([, r]) => r === 'true')) return out;
  if (allow.covers({ workflow: wf.file, job: job.id, kind: 'job-if' })) return out;
  for (const [event, r] of results) {
    if (r === 'false') {
      out.push({
        code: 'deadlock/job-if-false',
        file: wf.path,
        where: where(job, context),
        message: `The job-level \`if: ${String(job.if)}\` is always false on ${event}, so the job is SKIPPED there, and a skipped required check reports success: "${context}" passes on ${event} while checking nothing.`,
        fix: `Make the job run on ${event} (move the event branching into steps), or, if skipping there is deliberate, add a ci/census-allowlist.yaml entry {workflow: ${wf.file}, job: ${job.id}, kind: job-if, reason} that says why a pass-by-skip is safe.`,
      });
    } else if (r === 'unknown') {
      out.push({
        code: 'deadlock/job-if-undecidable',
        file: wf.path,
        where: where(job, context),
        message: `The census cannot decide whether the job-level \`if: ${String(job.if)}\` can be true on ${event}; if it is false there, the job is skipped and "${context}" passes while checking nothing.`,
        fix: `Simplify the condition to github.event_name comparisons, or add a ci/census-allowlist.yaml entry {workflow: ${wf.file}, job: ${job.id}, kind: job-if, reason} explaining why it is true on both events.`,
      });
    }
  }
  return out;
}

function isSet(v: unknown): boolean {
  return v !== undefined && v !== false && v !== 'false';
}

function checkRequiredJobBody(
  wf: WorkflowModel,
  job: JobModel,
  context: string,
  allow: AllowlistTracker
): Finding[] {
  const out: Finding[] = [];
  const coe = (step?: string) =>
    allow.covers({ workflow: wf.file, job: job.id, step, kind: 'continue-on-error' });
  if (isSet(job.continueOnError) && !coe()) {
    out.push({
      code: 'required/continue-on-error',
      file: wf.path,
      where: where(job, context),
      message: `Required job ${job.id} sets continue-on-error, so it can report success after failing.`,
      fix: `Remove \`continue-on-error\` from job ${job.id}, or add a ci/census-allowlist.yaml entry {workflow: ${wf.file}, job: ${job.id}, kind: continue-on-error, reason, expires}.`,
    });
  }
  for (const step of job.steps) {
    if (isSet(step.continueOnError) && !coe(step.key)) {
      out.push({
        code: 'required/continue-on-error',
        file: wf.path,
        where: `${where(job, context)}, step "${step.key}"`,
        message: `A step in required job ${job.id} sets continue-on-error, so its failure cannot fail "${context}".`,
        fix: `Remove \`continue-on-error\` from the step, or add a ci/census-allowlist.yaml entry {workflow: ${wf.file}, job: ${job.id}, step: "${step.key}", kind: continue-on-error, reason, expires}.`,
      });
    }
    if (step.if === undefined) continue;
    // A condition that is true on both events on the success path (e.g.
    // `!cancelled()`) never skips the step on a green run; it is not event
    // branching and needs no exception.
    if (EVENTS.every((e) => evaluateCondition(step.if!, e) === 'true')) continue;
    if (allow.covers({ workflow: wf.file, job: job.id, step: step.key, kind: 'step-if' })) continue;
    out.push({
      code: 'required/step-if',
      file: wf.path,
      where: `${where(job, context)}, step "${step.key}"`,
      message: `A step in required job ${job.id} runs only when \`${String(step.if)}\`, which is not true on both pull_request and merge_group. A check that silently skips on one event is how a required context comes to assert nothing.`,
      fix: `Remove the condition, or add a ci/census-allowlist.yaml entry {workflow: ${wf.file}, job: ${job.id}, step: "${step.key}", kind: step-if, reason} saying why skipping is safe.`,
    });
  }
  return out;
}

/**
 * The deadlock invariant and the no-silent-pass rules, for every required context.
 *
 * @param workflows - The parsed workflows.
 * @param contexts - Required contexts from `ci/required-checks.json`.
 * @param requiredChecksPath - Repo-relative path, for findings.
 * @param defaultBranch - The branch the ruleset protects.
 * @param allow - The allowlist tracker.
 */
export function checkRequiredContexts(
  workflows: readonly WorkflowModel[],
  contexts: readonly string[],
  requiredChecksPath: string,
  defaultBranch: string,
  allow: AllowlistTracker
): Finding[] {
  const out: Finding[] = [];
  for (const context of contexts) {
    const matches = workflows.flatMap((wf) =>
      wf.jobs.filter((j) => j.checkName === context).map((job) => ({ wf, job }))
    );
    if (matches.length === 0) {
      const matrix = workflows.flatMap((wf) =>
        wf.jobs.filter((j) => j.id === context && j.checkName === null).map(() => wf.file)
      );
      out.push({
        code: 'deadlock/no-job',
        file: requiredChecksPath,
        where: `context "${context}"`,
        message: `No workflow job reports a check named exactly "${context}"${matrix.length ? ` (${matrix.join(', ')} has a job with that id, but it is a matrix job or has a templated name, so its check names carry a suffix)` : ''}. The queue waits for it until check_response_timeout and ejects every PR.`,
        fix: `Name a non-matrix job "${context}" (its id, or \`name:\`) in a workflow triggered on pull_request and merge_group, or remove "${context}" from the ruleset first and then from ${requiredChecksPath}.`,
      });
      continue;
    }
    for (const { wf, job } of matches) {
      out.push(...checkTriggers(wf, job, context, defaultBranch));
      out.push(...checkJobCondition(wf, job, context, allow));
      out.push(...checkRequiredJobBody(wf, job, context, allow));
    }
  }
  return out;
}

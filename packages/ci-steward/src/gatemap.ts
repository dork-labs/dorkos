/**
 * Maps a check run, as the API reports it, back to its gate id
 * `wf.<workflow-stem>.<job-id>`.
 *
 * GitHub names a check run after the job's `name:` (or its id), with the matrix
 * values appended in parentheses for a matrix job and any `${{ }}` expression
 * already expanded. So a fixed name matches exactly, and a matrix or templated
 * name matches a pattern built from the YAML.
 */
import type { WorkflowModel } from './workflows.ts';

interface Matcher {
  gate: string;
  exact?: string;
  pattern?: RegExp;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function matchersFor(wf: WorkflowModel): Matcher[] {
  const out: Matcher[] = [];
  for (const job of wf.jobs) {
    const gate = `wf.${wf.stem}.${job.id}`;
    const reported = job.name ?? job.id;
    if (job.isReusableCall) {
      out.push({ gate, pattern: new RegExp(`^${escape(reported)} / `) });
      continue;
    }
    if (job.checkName !== null) {
      out.push({ gate, exact: job.checkName });
      continue;
    }
    // A templated name arrives expanded; a matrix job whose name does not use
    // the matrix gets its values appended in parentheses. Accept both shapes.
    const body = reported
      .split(/\$\{\{[\s\S]*?\}\}/)
      .map(escape)
      .join('.+');
    out.push({ gate, pattern: new RegExp(`^${body}(?: \\(.+\\))?$`) });
  }
  return out;
}

/** Resolves `(workflow path, check-run name)` to a gate id, or `null`. */
export type GateMapper = (workflowPath: string, checkName: string) => string | null;

/**
 * Build a mapper for every workflow.
 *
 * @param workflows - The parsed workflows.
 */
export function gateMapper(workflows: readonly WorkflowModel[]): GateMapper {
  const byPath = new Map(workflows.map((wf) => [wf.path, matchersFor(wf)]));
  return (workflowPath, checkName) => {
    const ms = byPath.get(workflowPath);
    if (!ms) return null;
    const exact = ms.find((m) => m.exact === checkName);
    if (exact) return exact.gate;
    return ms.find((m) => m.pattern?.test(checkName))?.gate ?? null;
  };
}

/**
 * The workflow files that host a required context, which is what "the
 * required workflows" means for pr-feedback, queue-green and queue builds.
 *
 * @param workflows - The parsed workflows.
 * @param contexts - The required contexts.
 */
export function requiredWorkflowPaths(
  workflows: readonly WorkflowModel[],
  contexts: readonly string[]
): string[] {
  const want = new Set(contexts);
  return workflows
    .filter((wf) => wf.jobs.some((j) => j.checkName !== null && want.has(j.checkName)))
    .map((wf) => wf.path)
    .sort();
}

/**
 * Every job's `timeout-minutes`, by gate id, where it is a plain number.
 *
 * @param workflows - The parsed workflows.
 */
export function gateTimeouts(workflows: readonly WorkflowModel[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const wf of workflows) {
    for (const job of wf.jobs) {
      if (typeof job.timeoutMinutes === 'number')
        out[`wf.${wf.stem}.${job.id}`] = job.timeoutMinutes;
    }
  }
  return out;
}

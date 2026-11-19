/**
 * The census's environment-job checks (DOR-4030, Security M2 and M3), over
 * every workflow:
 *
 * - **Pins.** Every `uses:` in a job that names an environment is pinned to a
 *   full commit SHA (or a `docker://` image to a digest), with no exceptions.
 *   The action's code runs in the same job as the environment's secrets, and
 *   a tag can be moved by whoever controls the action's repository.
 * - **Placement.** A job that reads a secret listed under
 *   `secret_environments` names that secret's environment. Outside it the
 *   secret reads as empty (it is not at repository level), and a job that
 *   quietly gets nothing (arm-door's App token before this) fails open.
 */
import type { Finding } from './finding.ts';
import type { HandFiles } from './load.ts';
import type { JobModel, WorkflowModel } from './workflows.ts';

const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;
const PINNED_IMAGE = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;

/**
 * Whether an action reference is pinned to something that cannot move.
 *
 * @param uses - The step's `uses:` as written.
 */
export function isPinned(uses: string): boolean {
  return PINNED.test(uses) || PINNED_IMAGE.test(uses);
}

/** Whether the job names any environment at all (an expression counts). */
const hasEnvironment = (job: JobModel): boolean =>
  job.environment !== undefined && job.environment.trim() !== '';

/**
 * Whether the job's `environment:` names `name`: exactly, or as a quoted
 * literal inside an expression.
 */
function names(job: JobModel, name: string): boolean {
  const env = job.environment;
  if (env === undefined) return false;
  return env === name || (env.includes('${{') && env.includes(`'${name}'`));
}

/** Escape a string for use inside a RegExp. */
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Check pins and secret placement across every workflow.
 *
 * @param files - The hand files.
 * @param workflows - The parsed workflows.
 */
export function checkEnvironmentJobs(
  files: HandFiles,
  workflows: readonly WorkflowModel[]
): Finding[] {
  const out: Finding[] = [];
  const wants = files.config.secret_environments;

  for (const wf of workflows) {
    for (const job of wf.jobs) {
      if (hasEnvironment(job)) {
        for (const step of job.steps) {
          if (step.uses === undefined || isPinned(step.uses)) continue;
          out.push({
            code: 'environment-pins/unpinned',
            file: wf.path,
            where: `${job.id}: ${step.uses}`,
            message: `Job ${job.id} names the ${job.environment} environment, but its step uses ${step.uses}, which is not pinned to a commit SHA. Whoever can move that tag can run code beside the environment's secrets.`,
            fix: `Pin it to the full commit SHA with the version as a comment (\`uses: owner/repo@<40 hex> # vX.Y.Z\`); reuse a SHA already pinned in .github/workflows for the same version.`,
          });
        }
      }
      for (const want of wants) {
        if (names(job, want.name)) continue;
        const read = want.secrets.filter((s) =>
          new RegExp(`secrets\\.${escape(s)}\\b|secrets\\[\\s*['"]${escape(s)}['"]\\s*\\]`).test(
            job.text
          )
        );
        if (read.length === 0) continue;
        out.push({
          code: 'environment-secrets/outside-environment',
          file: wf.path,
          where: job.id,
          message: `Job ${job.id} reads ${read.join(', ')}, which live only in the ${want.name} environment, but it does not name ${want.name}. There they read as empty, and the job runs without them.`,
          fix: `Give ${job.id} \`environment: ${want.name}\` (and whatever that environment's refs need), or stop reading ${read.join(', ')}.`,
        });
      }
    }
  }
  return out;
}

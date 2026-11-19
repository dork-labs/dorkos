/**
 * The census's tag gate (DOR-4030): in the release workflows, a job that can
 * publish runs only from a gated ref, and says so in structure, not in what
 * its steps do. Two shapes:
 *
 * - A job that names a secret environment (`release`, `release-mirrors`), or
 *   names its environment with an expression, runs only as main's own copy of
 *   the file, dispatched on main: its `if:` opens with the dispatch condition,
 *   and its first step refuses any other `GITHUB_WORKFLOW_REF`. On a tag push
 *   or a branch run GitHub runs that ref's own copy of the file, which could
 *   drop every check in it (Security M1, Nov 19), so no tag is a way in here.
 * - Any other job whose GITHUB_TOKEN may write contents (a release, its
 *   assets) or packages (an image) opens its `if:` with the `v*` tag
 *   condition (publish-community.yml, until its release identity moves to
 *   main in its own PR) or the dispatch condition; a job on the dispatch also
 *   refuses, in its first step, any copy of the file but main's.
 *
 * This check is not the lock (the environments' reviewer and deployment refs
 * are); it keeps a later edit from quietly dropping the gate.
 */
import type { Finding } from './finding.ts';
import { CONFIG_PATH, type HandFiles } from './load.ts';
import type { JobModel, WorkflowModel } from './workflows.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether a `permissions:` value lets GITHUB_TOKEN write contents or packages.
 * Absent means the repository default, which may be write-all, so it counts.
 *
 * @param perms - The job's `permissions:`, else the workflow's.
 */
function mayWrite(perms: unknown): boolean {
  if (perms === undefined || perms === null) return true;
  if (typeof perms === 'string') return perms !== 'read-all' && perms !== '{}';
  if (!isObj(perms)) return true;
  return perms.contents === 'write' || perms.packages === 'write';
}

/** Strip a `${{ … }}` wrapper and collapse whitespace. */
function normalise(cond: string): string {
  const t = cond.trim();
  const inner = /^\$\{\{([\s\S]*)\}\}$/.exec(t);
  return (inner ? inner[1]! : t).replace(/\s+/g, ' ').trim();
}

/** True when `||` appears outside every parenthesis, which would let a second way in. */
function hasTopLevelOr(text: string): boolean {
  let depth = 0;
  let quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") quote = !quote;
    if (quote) continue;
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && text[i + 1] === '|' && depth === 0) return true;
  }
  return false;
}

/**
 * Whether a job-level `if:` opens with `condition`, with nothing that can
 * route around it.
 *
 * @param cond - The job's `if:`.
 * @param condition - The required opening condition.
 */
export function opensWith(cond: JobModel['if'], condition: string): boolean {
  if (typeof cond !== 'string') return false;
  const text = normalise(cond);
  const want = normalise(condition);
  if (text !== want && !text.startsWith(`${want} && `)) return false;
  return !hasTopLevelOr(text);
}

/**
 * Which of `known` a job's `environment:` may name. A plain name names itself;
 * an expression may compute any name, so it counts as naming every one of
 * `known` (fail closed).
 *
 * @param env - The job's environment as written.
 * @param known - The environment names that matter here.
 */
export function namedEnvironments(env: string | undefined, known: readonly string[]): string[] {
  if (env === undefined || env.trim() === '') return [];
  if (env.includes('${{')) return [...known];
  return known.includes(env) ? [env] : [];
}

/**
 * Whether a job's first step refuses any run but `file`'s own copy on main.
 *
 * @param job - The job.
 * @param file - The workflow file name, e.g. `desktop-release.yml`.
 */
export function refusesAllButMain(job: JobModel, file: string): boolean {
  const run = job.steps[0]?.run;
  if (typeof run !== 'string') return false;
  const want = `"$GITHUB_WORKFLOW_REF" == "$GITHUB_REPOSITORY/.github/workflows/${file}@refs/heads/main"`;
  return (
    run.includes(want) &&
    run.includes('"$GITHUB_REF" == refs/heads/main') &&
    run.includes('"$GITHUB_EVENT_NAME" == workflow_dispatch')
  );
}

/**
 * Check every publishing job in the tag-gated workflows.
 *
 * @param files - The hand files; nothing is checked without `tag_gate`.
 * @param workflows - The parsed workflows.
 */
export function checkTagGate(files: HandFiles, workflows: readonly WorkflowModel[]): Finding[] {
  const gate = files.config.tag_gate;
  if (!gate) return [];
  const out: Finding[] = [];
  const byFile = new Map(workflows.map((w) => [w.file, w]));
  for (const file of gate.workflows) {
    const wf = byFile.get(file);
    if (!wf) {
      out.push({
        code: 'tag-gate/missing-workflow',
        file: CONFIG_PATH,
        where: file,
        message: `tag_gate.workflows names ${file}, which is not in ${files.config.workflows_dir}.`,
        fix: `Remove it from tag_gate.workflows in ${CONFIG_PATH}, or restore the workflow.`,
      });
      continue;
    }
    for (const job of wf.jobs) {
      const envs = namedEnvironments(job.environment, gate.environments);
      const writes = mayWrite(job.permissions ?? wf.permissions);
      if (envs.length === 0 && !writes) continue;
      const what =
        envs.length === 0
          ? 'lets GITHUB_TOKEN write contents or packages (or sets no permissions)'
          : job.environment!.includes('${{')
            ? `may name ${envs.join(' or ')} (its environment is an expression)`
            : `names the ${envs[0]} environment`;
      const onDispatch = opensWith(job.if, gate.dispatch_condition);
      // A job that only writes with GITHUB_TOKEN may run on the `v*` tag push
      // instead. There it cannot refuse every copy but main's: it is the tag's.
      if (envs.length === 0 && !onDispatch && opensWith(job.if, gate.condition)) continue;
      if (!onDispatch) {
        out.push(
          envs.length
            ? {
                code: 'tag-gate/environment-not-main-dispatch',
                file: wf.path,
                where: job.id,
                message: `Job ${job.id} ${what}, but its job-level if: does not open with \`${gate.dispatch_condition}\`, so a tag push or a branch run (which runs that ref's own copy of ${file}) can ask to enter it.`,
                fix: `Give ${job.id} \`if: ${gate.dispatch_condition}\` (add other conditions after it with &&, never a top-level ||). A \`v*\` tag is not a way into a secret environment.`,
              }
            : {
                code: 'tag-gate/ungated-job',
                file: wf.path,
                where: job.id,
                message: `Job ${job.id} ${what}, but its job-level if: opens with neither \`${gate.condition}\` nor \`${gate.dispatch_condition}\`, so a run on a branch can reach it.`,
                fix: `Give ${job.id} \`if: ${gate.condition}\` or \`if: ${gate.dispatch_condition}\` (add other conditions after it with &&, never a top-level ||), or drop the write permission.`,
              }
        );
      }
      if (!refusesAllButMain(job, file)) {
        out.push({
          code: envs.length
            ? 'tag-gate/environment-no-main-refusal'
            : 'tag-gate/write-no-main-refusal',
          file: wf.path,
          where: job.id,
          message: `Job ${job.id} ${what}, but its first step does not refuse every run except ${file}'s own copy on main.`,
          fix: `Make ${job.id}'s first step a \`run:\` that checks \`[[ "$GITHUB_REF" == refs/heads/main ]]\`, \`[[ "$GITHUB_EVENT_NAME" == workflow_dispatch ]]\` and \`[[ "$GITHUB_WORKFLOW_REF" == "$GITHUB_REPOSITORY/.github/workflows/${file}@refs/heads/main" ]]\`, as publish-docker.yml's jobs do.`,
        });
      }
    }
  }
  return out;
}

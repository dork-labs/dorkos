/**
 * The census's tag gate (DOR-4030): in the release workflows, a job that can
 * publish runs only on a release tag, and says so in its own job-level `if:`.
 *
 * "Can publish" is read from structure, not from what the steps do: the job
 * names a publishing environment, or its GITHUB_TOKEN may write contents (a
 * release, its assets) or packages (an image). A `release/*` rehearsal, or a
 * manual run from a branch, then reaches no such job, whatever its steps'
 * `if:`s say. This check is not the lock (the environments are); it keeps a
 * later edit from quietly dropping the gate.
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
 * Whether a job-level `if:` gates on `condition` first, with nothing that can
 * route around it.
 *
 * @param cond - The job's `if:`.
 * @param condition - The required opening condition.
 */
export function gatesOnTag(cond: JobModel['if'], condition: string): boolean {
  if (typeof cond !== 'string') return false;
  const text = normalise(cond);
  const want = normalise(condition);
  if (text !== want && !text.startsWith(`${want} && `)) return false;
  return !hasTopLevelOr(text);
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
      const env = job.environment;
      const publishesTo = env !== undefined && gate.environments.includes(env);
      const writes = mayWrite(job.permissions ?? wf.permissions);
      if (!publishesTo && !writes) continue;
      if (gatesOnTag(job.if, gate.condition)) continue;
      const why = publishesTo
        ? `names the ${env} environment`
        : 'lets GITHUB_TOKEN write contents or packages (or sets no permissions)';
      out.push({
        code: 'tag-gate/ungated-job',
        file: wf.path,
        where: job.id,
        message: `Job ${job.id} ${why}, but its job-level if: does not open with \`${gate.condition}\`, so a run on a branch can reach it.`,
        fix: `Give ${job.id} \`if: ${gate.condition}\` (add other conditions after it with &&, never a top-level ||), or drop the write permission or the environment.`,
      });
    }
  }
  return out;
}

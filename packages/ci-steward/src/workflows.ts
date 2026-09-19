/**
 * Reads `.github/workflows/*.yml` into the small model the census reasons over.
 *
 * Only the facts a check needs are kept: triggers and their filters, and per
 * job its check-run name, condition, `needs`, timeout, `continue-on-error`,
 * and each step's condition and command. Everything else in the YAML is left
 * where it is.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/** One step of a job. */
interface StepModel {
  /** How the allowlist names the step: `name`, else `id`, else `uses` without its ref, else `run[<n>]`. */
  key: string;
  if?: string | boolean;
  continueOnError?: unknown;
  run?: string;
  /** The whole step as JSON, for "does this step read X" questions. */
  text: string;
}

/** One job of a workflow. */
export interface JobModel {
  id: string;
  /** The `name:` as written, if any. */
  name?: string;
  /**
   * The check-run name GitHub reports, when it is fixed: `name:` if set, else
   * the job id. `null` for a matrix job or a templated name, whose reported
   * names carry a suffix or an expression and so can never equal a context.
   */
  checkName: string | null;
  isMatrix: boolean;
  /** True for a job that calls a reusable workflow (`uses:`), which cannot set a timeout. */
  isReusableCall: boolean;
  if?: string | boolean;
  needs: string[];
  timeoutMinutes?: unknown;
  continueOnError?: unknown;
  steps: StepModel[];
}

/** One trigger block, e.g. `pull_request: { types, paths }`. */
interface TriggerModel {
  types?: string[];
  paths?: unknown;
  pathsIgnore?: unknown;
  branches?: string[];
  branchesIgnore?: unknown;
}

/** One workflow file. */
export interface WorkflowModel {
  /** File name, e.g. `typecheck.yml`. */
  file: string;
  /** File name without extension; the middle of a `wf.<stem>.<job>` gate id. */
  stem: string;
  /** Repo-relative path. */
  path: string;
  triggers: Map<string, TriggerModel>;
  jobs: JobModel[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const asStrings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : undefined;

function stepKey(step: Obj, index: number): string {
  if (typeof step.name === 'string') return step.name;
  if (typeof step.id === 'string') return step.id;
  if (typeof step.uses === 'string') return step.uses.replace(/@.*$/, '');
  return `run[${index}]`;
}

function parseTriggers(on: unknown): Map<string, TriggerModel> {
  const out = new Map<string, TriggerModel>();
  if (typeof on === 'string') out.set(on, {});
  else if (Array.isArray(on)) for (const e of on) out.set(String(e), {});
  else if (isObj(on)) {
    for (const [event, cfg] of Object.entries(on)) {
      const c = isObj(cfg) ? cfg : {};
      out.set(event, {
        types: asStrings(c.types),
        paths: c.paths,
        pathsIgnore: c['paths-ignore'],
        branches: asStrings(c.branches),
        branchesIgnore: c['branches-ignore'],
      });
    }
  }
  return out;
}

/**
 * Parse one workflow's YAML text.
 *
 * @param file - The file name, e.g. `lint.yml`.
 * @param relPath - Its repo-relative path.
 * @param text - The YAML source.
 */
function parseWorkflow(file: string, relPath: string, text: string): WorkflowModel {
  const doc: unknown = parseYaml(text);
  if (!isObj(doc)) throw new Error('the file is not a YAML mapping');
  const jobs: JobModel[] = [];
  for (const [id, raw] of Object.entries(isObj(doc.jobs) ? doc.jobs : {})) {
    const job = isObj(raw) ? raw : {};
    const strategy = isObj(job.strategy) ? job.strategy : {};
    const isMatrix = strategy.matrix !== undefined;
    const name = typeof job.name === 'string' ? job.name : undefined;
    const reported = name ?? id;
    const checkName = isMatrix || reported.includes('${{') ? null : reported;
    const steps = (Array.isArray(job.steps) ? job.steps : []).map((s, i): StepModel => {
      const step = isObj(s) ? s : {};
      return {
        key: stepKey(step, i),
        if: typeof step.if === 'string' || typeof step.if === 'boolean' ? step.if : undefined,
        continueOnError: step['continue-on-error'],
        run: typeof step.run === 'string' ? step.run : undefined,
        text: JSON.stringify(step),
      };
    });
    jobs.push({
      id,
      name,
      checkName,
      isMatrix,
      isReusableCall: typeof job.uses === 'string',
      if: typeof job.if === 'string' || typeof job.if === 'boolean' ? job.if : undefined,
      needs: asStrings(job.needs) ?? [],
      timeoutMinutes: job['timeout-minutes'],
      continueOnError: job['continue-on-error'],
      steps,
    });
  }
  return {
    file,
    stem: file.replace(/\.ya?ml$/, ''),
    path: relPath,
    triggers: parseTriggers(doc.on),
    jobs,
  };
}

/**
 * Load every workflow in a directory, sorted by file name.
 *
 * @param root - Repo root.
 * @param workflowsDir - Repo-relative workflows directory.
 * @param onError - Called with the path and message of a file that does not parse.
 */
export function loadWorkflows(
  root: string,
  workflowsDir: string,
  onError: (relPath: string, message: string) => void
): WorkflowModel[] {
  const dir = path.join(root, workflowsDir);
  const out: WorkflowModel[] = [];
  for (const file of readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort()) {
    const relPath = `${workflowsDir}/${file}`;
    try {
      out.push(parseWorkflow(file, relPath, readFileSync(path.join(dir, file), 'utf8')));
    } catch (e) {
      onError(relPath, e instanceof Error ? e.message : String(e));
    }
  }
  return out;
}

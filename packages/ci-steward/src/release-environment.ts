/**
 * The release-secrets alarm (DOR-4030): the signing, notarization, tap and
 * Docker Hub secrets live only in a deployment environment that needs a
 * reviewer and deploys only release tags. A secret back at repository level, or
 * an environment that lost its reviewer or its tag policy, means any branch's
 * workflow can read the release secrets again, so either turns the day red.
 *
 * Only names and settings are read; the API never returns secret values.
 */
import { BudgetExhausted, type Gh } from './gh.ts';
import type { HandFiles } from './load.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What the alarm found: `failures` turn the day red, `warnings` do not. */
export interface ReleaseEnvironmentResult {
  failures: string[];
  warnings: string[];
}

const errorText = (e: unknown): string =>
  `${e instanceof Error ? e.message : String(e)} ${String((e as { stderr?: unknown }).stderr ?? '')}`;
const NOT_FOUND = /HTTP 404|Not Found/i;
const FORBIDDEN = /HTTP 403|Resource not accessible by integration/i;

/** One GET; a 404 is `null`, a 403 is `'forbidden'`, anything else throws. */
function read(gh: Gh, path: string): unknown {
  try {
    return gh.rest(path);
  } catch (e) {
    if (e instanceof BudgetExhausted) throw e;
    const text = errorText(e);
    if (NOT_FOUND.test(text)) return null;
    if (FORBIDDEN.test(text)) return 'forbidden';
    throw e;
  }
}

/** Every repository-level secret name, or `'forbidden'` when this token may not list them. */
function repoSecretNames(gh: Gh, repo: string): string[] | 'forbidden' {
  const names: string[] = [];
  for (let page = 1; ; page++) {
    const body = read(gh, `repos/${repo}/actions/secrets?per_page=100&page=${page}`);
    if (body === 'forbidden') return 'forbidden';
    if (!isObj(body) || !Array.isArray(body.secrets))
      throw new Error('Malformed repository secrets list');
    const batch = body.secrets.filter(isObj).map((s) => String(s.name));
    names.push(...batch);
    if (batch.length < 100) return names;
  }
}

/**
 * What is wrong with the environment's protection, or `'forbidden'` when this
 * token may not read it.
 */
function environmentProblems(
  gh: Gh,
  repo: string,
  name: string,
  tagPattern: string
): string[] | 'forbidden' {
  const env = read(gh, `repos/${repo}/environments/${encodeURIComponent(name)}`);
  if (env === 'forbidden') return 'forbidden';
  if (env === null) return ['it does not exist'];
  if (!isObj(env)) throw new Error(`Malformed environment ${name}`);
  const problems: string[] = [];
  const rules = (Array.isArray(env.protection_rules) ? env.protection_rules : []).filter(isObj);
  const reviewers = rules
    .filter((r) => r.type === 'required_reviewers')
    .flatMap((r) => (Array.isArray(r.reviewers) ? r.reviewers : []));
  if (reviewers.length === 0) problems.push('it no longer needs a reviewer');
  const policy = isObj(env.deployment_branch_policy) ? env.deployment_branch_policy : null;
  if (!policy || policy.custom_branch_policies !== true) {
    problems.push(`it no longer limits deployments to tags matching ${tagPattern}`);
    return problems;
  }
  const list = read(
    gh,
    `repos/${repo}/environments/${encodeURIComponent(name)}/deployment-branch-policies?per_page=100`
  );
  if (list === 'forbidden') return 'forbidden';
  if (!isObj(list) || !Array.isArray(list.branch_policies))
    throw new Error(`Malformed deployment policies for environment ${name}`);
  const hasTag = list.branch_policies
    .filter(isObj)
    .some((p) => p.name === tagPattern && p.type === 'tag');
  if (!hasTag) problems.push(`it no longer has the ${tagPattern} tag policy`);
  return problems;
}

/**
 * Check that the release secrets are reachable only through the protected
 * release environment. A token that may not read secrets or environments is a
 * warning that names the missing access, never a red day.
 *
 * @param gh - The client.
 * @param files - The hand files; nothing is checked without `release_environment`.
 */
export function checkReleaseEnvironment(gh: Gh, files: HandFiles): ReleaseEnvironmentResult {
  const out: ReleaseEnvironmentResult = { failures: [], warnings: [] };
  if (!files.config.release_environment) return out;
  try {
    check(gh, files, out);
  } catch (e) {
    if (e instanceof BudgetExhausted) throw e;
    // A read that went wrong is not a pass: fail closed, as the ruleset checks do.
    out.failures.push(
      `Release secrets check failed: ${e instanceof Error ? e.message : String(e)}.`
    );
  }
  return out;
}

/** The two reads behind {@link checkReleaseEnvironment}, filling `out`. */
function check(gh: Gh, files: HandFiles, out: ReleaseEnvironmentResult): void {
  const want = files.config.release_environment!;
  const repo = files.config.github_repo;

  const names = repoSecretNames(gh, repo);
  if (names === 'forbidden') {
    out.warnings.push(
      `Release secrets: this token may not list repository secrets, so nobody checked that ${want.secrets.join(', ')} stay out of repository level. The check needs a token with Secrets: read; CI's own token has none.`
    );
  } else {
    const leaked = want.secrets.filter((s) => names.includes(s));
    if (leaked.length) {
      out.failures.push(
        `Release secrets are at repository level again: ${leaked.join(', ')}. Any branch's workflow can read them there. Delete them from the repository's secrets; they belong only in the ${want.name} environment (DOR-4030).`
      );
    }
  }

  const problems = environmentProblems(gh, repo, want.name, want.tag_pattern);
  if (problems === 'forbidden') {
    out.warnings.push(
      `Release secrets: this token may not read the ${want.name} environment, so nobody checked its reviewer and tag policy.`
    );
  } else if (problems.length) {
    out.failures.push(
      `The ${want.name} environment is no longer protected: ${problems.join('; ')}. Put back a required reviewer and the ${want.tag_pattern} tag policy in the repository's environment settings (DOR-4030).`
    );
  }
}

/**
 * The secret-environments alarm (DOR-4030): the signing, publishing and
 * automation secrets live only in deployment environments that deploy only
 * their own refs, and the release ones need a reviewer. A secret back at
 * repository level, or an environment that is gone, lost its reviewer, or
 * deploys a ref it should not, means a workflow outside that path can read the
 * secret again, so each turns the day red.
 *
 * Only names and settings are read; the API never returns secret values.
 */
import { BudgetExhausted, type Gh } from './gh.ts';
import type { HandFiles } from './load.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

type Want = HandFiles['config']['secret_environments'][number];

/** What the alarm found: `failures` turn the day red, `warnings` do not. */
export interface SecretEnvironmentsResult {
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

const refLabel = (r: { name: string; type: string }) => `${r.type} ${r.name}`;

/**
 * What is wrong with one environment's protection, or `'forbidden'` when this
 * token may not read it.
 */
function environmentProblems(gh: Gh, repo: string, want: Want): string[] | 'forbidden' {
  const path = `repos/${repo}/environments/${encodeURIComponent(want.name)}`;
  const env = read(gh, path);
  if (env === 'forbidden') return 'forbidden';
  if (env === null) return ['it does not exist'];
  if (!isObj(env)) throw new Error(`Malformed environment ${want.name}`);
  const problems: string[] = [];
  if (want.reviewers.length > 0) {
    const logins = (Array.isArray(env.protection_rules) ? env.protection_rules : [])
      .filter(isObj)
      .filter((r) => r.type === 'required_reviewers')
      .flatMap((r) => (Array.isArray(r.reviewers) ? r.reviewers : []))
      .filter(isObj)
      .filter((r) => r.type === 'User' && isObj(r.reviewer))
      .map((r) => String((r.reviewer as Obj).login).toLowerCase());
    const missing = want.reviewers.filter((l) => !logins.includes(l.toLowerCase()));
    if (missing.length) problems.push(`it no longer needs ${missing.join(', ')} to approve`);
  }
  const policy = isObj(env.deployment_branch_policy) ? env.deployment_branch_policy : null;
  if (!policy || policy.custom_branch_policies !== true) {
    problems.push(`it no longer limits deployments to ${want.refs.map(refLabel).join(', ')}`);
    return problems;
  }
  const list = read(gh, `${path}/deployment-branch-policies?per_page=100`);
  if (list === 'forbidden') return 'forbidden';
  if (!isObj(list) || !Array.isArray(list.branch_policies))
    throw new Error(`Malformed deployment policies for environment ${want.name}`);
  const live = list.branch_policies.filter(isObj).map((p) => ({
    name: String(p.name),
    // GitHub omits `type` on policies made before tag policies existed: those are branches.
    type: String(p.type ?? 'branch'),
  }));
  const same = (a: { name: string; type: string }) => (b: { name: string; type: string }) =>
    a.name === b.name && a.type === b.type;
  const missing = want.refs.filter((r) => !live.some(same(r)));
  const extra = live.filter((p) => !want.refs.some(same(p)));
  if (missing.length) problems.push(`it no longer deploys ${missing.map(refLabel).join(', ')}`);
  if (extra.length)
    problems.push(
      `it also deploys ${extra.map(refLabel).join(', ')}, which ci/config.yaml does not allow`
    );
  return problems;
}

/**
 * Check that each environment's secrets are reachable only through that
 * environment, and that it is still protected. A token that may not read
 * secrets or environments is a warning that names the missing access, never a
 * red day; any other failed read fails closed.
 *
 * @param gh - The client.
 * @param files - The hand files; nothing is checked without `secret_environments`.
 */
export function checkSecretEnvironments(gh: Gh, files: HandFiles): SecretEnvironmentsResult {
  const out: SecretEnvironmentsResult = { failures: [], warnings: [] };
  const wants = files.config.secret_environments;
  if (wants.length === 0) return out;
  try {
    check(gh, files.config.github_repo, wants, out);
  } catch (e) {
    if (e instanceof BudgetExhausted) throw e;
    out.failures.push(
      `Secret environments check failed: ${e instanceof Error ? e.message : String(e)}.`
    );
  }
  return out;
}

/** The reads behind {@link checkSecretEnvironments}, filling `out`. */
function check(gh: Gh, repo: string, wants: readonly Want[], out: SecretEnvironmentsResult): void {
  const names = repoSecretNames(gh, repo);
  if (names === 'forbidden') {
    out.warnings.push(
      `Secret environments: this token may not list repository secrets, so nobody checked that ${wants.flatMap((w) => w.secrets).join(', ')} stay out of repository level. The check needs a token with Secrets: read; CI's own token has none.`
    );
  } else {
    for (const want of wants) {
      const leaked = want.secrets.filter((s) => names.includes(s));
      if (leaked.length) {
        out.failures.push(
          `Secrets are at repository level again: ${leaked.join(', ')}. Any branch's workflow can read them there. Delete them from the repository's secrets; they belong only in the ${want.name} environment (DOR-4030).`
        );
      }
    }
  }

  for (const want of wants) {
    const problems = environmentProblems(gh, repo, want);
    if (problems === 'forbidden') {
      out.warnings.push(
        `Secret environments: this token may not read the ${want.name} environment, so nobody checked its reviewer and deployment rules.`
      );
    } else if (problems.length) {
      out.failures.push(
        `The ${want.name} environment is no longer protected as ci/config.yaml says: ${problems.join('; ')}. Put its settings back in the repository's environment settings (DOR-4030).`
      );
    }
  }
}

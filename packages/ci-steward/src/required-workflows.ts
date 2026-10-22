/** Required workflow intent and read-only organization-rule reconciliation. */
import { trackAllowlist } from './allowlist.ts';
import type { Finding } from './finding.ts';
import { BudgetExhausted, type Gh } from './gh.ts';
import type { HandFiles } from './load.ts';
import { checkRequiredContexts } from './required.ts';
import type { RequiredChecks } from './schemas.ts';
import type { WorkflowModel } from './workflows.ts';

type Source = RequiredChecks['workflows'][number];
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const finding = (message: string): Finding => ({
  code: 'required-workflow/drift',
  file: 'ci/required-checks.json',
  message,
  fix: 'Restore the reviewed organization rule or land a ledgered intent change. Promotion requires a clean census --live; this command never edits GitHub.',
});

/** Local source identity and all required jobs, without silent-skip exceptions. */
export function checkWorkflowIntent(
  files: HandFiles,
  workflows: readonly WorkflowModel[],
  now: Date
): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const s of files.requiredChecks?.workflows ?? []) {
    const key = `${s.repository}:${s.path}`;
    if (seen.has(key)) out.push(finding(`Duplicate required workflow ${key}.`));
    seen.add(key);
    if (
      s.repository !== files.config.github_repo ||
      s.ref !== `refs/heads/${files.config.default_branch}`
    )
      out.push(
        finding(
          `Required workflow ${key} must come from ${files.config.github_repo} at refs/heads/${files.config.default_branch}.`
        )
      );
    const wf = workflows.find((w) => w.path === s.path);
    if (!wf || wf.jobs.length === 0) {
      out.push(finding(`Required workflow ${s.path} is missing or has no jobs.`));
      continue;
    }
    // Inspect every job, including matrix jobs, by assigning temporary unique
    // context names to the model. Real named contexts cannot identify those jobs.
    const model = { ...wf, jobs: wf.jobs.map((j) => ({ ...j, checkName: j.id })) };
    out.push(
      ...checkRequiredContexts(
        [model],
        model.jobs.map((j) => j.id),
        files.config.hand_files.required_checks,
        files.config.default_branch,
        trackAllowlist([], now, files.config.hand_files.census_allowlist)
      )
    );
    for (const event of ['pull_request', 'merge_group']) {
      const t = wf.triggers.get(event);
      if (
        t &&
        (t.branches !== undefined ||
          t.branchesIgnore !== undefined ||
          (t.types !== undefined &&
            !(
              event === 'pull_request' &&
              ['opened', 'synchronize', 'reopened'].every((v) => t.types!.includes(v))
            )))
      )
        out.push(finding(`${s.path} has a restrictive ${event} trigger filter.`));
    }
  }
  return out;
}

function compareRule(rs: Obj, s: Source, repoName: string, defaultBranch: string): string[] {
  const errors: string[] = [];
  if (rs.target !== 'branch' || rs.enforcement !== 'active')
    errors.push('rule must be active and target branches');
  if (!Array.isArray(rs.bypass_actors) || rs.bypass_actors.length !== 0)
    errors.push('bypass_actors must be visible and empty');
  if (rs.current_user_can_bypass !== undefined && rs.current_user_can_bypass !== 'never')
    errors.push('current token can bypass rule');
  const cond = obj(rs.conditions) ? rs.conditions : {};
  const names = obj(cond.repository_name) ? cond.repository_name : {};
  const refs = obj(cond.ref_name) ? cond.ref_name : {};
  if (
    !same(names.include, [repoName]) ||
    !same(names.exclude, []) ||
    (names.protected !== undefined && typeof names.protected !== 'boolean') ||
    Object.keys(names).some((k) => !['include', 'exclude', 'protected'].includes(k)) ||
    Object.keys(cond).some((k) => !['repository_name', 'ref_name'].includes(k))
  )
    errors.push('repository conditions must target only this repository');
  if (!same(refs.include, [`refs/heads/${defaultBranch}`]) || !same(refs.exclude, []))
    errors.push('ref conditions must target only the protected branch');
  const rules = Array.isArray(rs.rules)
    ? rs.rules.filter(obj).filter((r) => r.type === 'workflows')
    : [];
  if (rules.length !== 1) errors.push('exactly one workflows rule is required');
  const params = obj(rules[0]?.parameters) ? rules[0].parameters : {};
  const expected = { repository_id: s.repository_id, path: s.path, ref: s.ref };
  const sources = Array.isArray(params.workflows) ? params.workflows : [];
  if (
    sources.length !== 1 ||
    !obj(sources[0]) ||
    Object.entries(expected).some(([k, v]) => sources[0]![k] !== v) ||
    Object.keys(sources[0] ?? {}).some((k) => !Object.hasOwn(expected, k))
  )
    errors.push('workflow repository_id/path/ref differ from intent (SHA overrides are forbidden)');
  if (params.do_not_enforce_on_create !== false) errors.push('rule must enforce on creation');
  return errors;
}

/** Read org rules directly; hidden bypass lists and all API errors fail closed. */
export function checkLiveWorkflows(gh: Gh, files: HandFiles): Finding[] {
  const sources = files.requiredChecks?.workflows ?? [];
  if (sources.length === 0) return [];
  const [owner, repoName] = files.config.github_repo.split('/') as [string, string];
  const out: Finding[] = [];
  try {
    const rules: Obj[] = [];
    for (let page = 1; ; page++) {
      const batch = gh.rest(`orgs/${owner}/rulesets?per_page=100&page=${page}`);
      if (!Array.isArray(batch) || batch.some((r) => !obj(r)))
        throw new Error('Malformed org ruleset list');
      rules.push(...(batch as Obj[]));
      if (batch.length < 100) break;
    }
    for (const s of sources) {
      const repo = gh.rest(`repos/${s.repository}`);
      if (!obj(repo) || repo.id !== s.repository_id || repo.full_name !== s.repository)
        out.push(
          finding(`Source repository identity differs from ${s.repository} / ${s.repository_id}.`)
        );
      const matches = rules.filter((r) => r.name === s.ruleset_name);
      if (matches.length !== 1) {
        out.push(
          finding(
            `Expected one organization ruleset named ${s.ruleset_name}; found ${matches.length}.`
          )
        );
        continue;
      }
      const id = matches[0]!.id;
      if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new Error('Malformed org ruleset ID');
      const rs = gh.rest(`orgs/${owner}/rulesets/${id}`);
      if (
        !obj(rs) ||
        rs.id !== id ||
        rs.name !== s.ruleset_name ||
        rs.source_type !== 'Organization' ||
        rs.source !== owner
      )
        throw new Error('Org ruleset identity/source is missing or different');
      const errors = compareRule(rs, s, repoName, files.config.default_branch);
      if (errors.length)
        out.push(finding(`Organization rule ${s.ruleset_name}: ${errors.join('; ')}.`));
    }
  } catch (e) {
    if (e instanceof BudgetExhausted) throw e;
    out.push(
      finding(
        `Required workflow live comparison failed: ${e instanceof Error ? e.message : String(e)}. Org rule and bypass-list read access is required; no extra credential is requested or installed by CI.`
      )
    );
  }
  return out;
}

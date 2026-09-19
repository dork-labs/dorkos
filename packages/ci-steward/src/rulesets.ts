/**
 * The run-wide checks: the merge-queue ruleset reconciled against
 * `ci/required-checks.json`, the two data-branch safeguard rulesets, and the
 * cache and release reads every snapshot of the run shares.
 */
import type { Health, Snapshot } from './data.ts';
import { BudgetExhausted, type Gh } from './gh.ts';
import type { HandFiles } from './load.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The run-wide checks attached to every snapshot this run writes. */
export interface GlobalChecks {
  ruleset: Health['ruleset'];
  dataRulesets: Health['data_rulesets'];
  cache: Snapshot['cache'];
  releases: { tag: string; published_at: string }[];
  failures: string[];
}

function readRuleset(gh: Gh, repo: string, id: number): Obj | null {
  try {
    return gh.rest(`repos/${repo}/rulesets/${id}`) as Obj;
  } catch (e) {
    if (e instanceof BudgetExhausted) throw e;
    if (
      /HTTP 404|Not Found/i.test(String((e as { stderr?: unknown }).stderr ?? (e as Error).message))
    )
      return null;
    throw e;
  }
}

function ruleTypes(rs: Obj): string[] {
  return (Array.isArray(rs.rules) ? rs.rules : []).filter(isObj).map((r) => String(r.type));
}

/**
 * Reconcile the merge-queue ruleset with `ci/required-checks.json` and the
 * rule list in `ci/config.yaml`.
 *
 * @param rs - The ruleset as the API returns it, or `null` when it is gone.
 * @param files - The hand files.
 */
function reconcileRuleset(rs: Obj | null, files: HandFiles): NonNullable<Health['ruleset']> {
  const { config, requiredChecks } = files;
  const id = config.ruleset.id;
  if (!rs) return { id, ok: false, problems: [`ruleset ${id} does not exist`] };
  const problems: string[] = [];
  if (rs.enforcement !== 'active')
    problems.push(`enforcement is ${String(rs.enforcement)}, not active`);
  const types = ruleTypes(rs);
  for (const rule of config.ruleset.rules) {
    if (rule === 'bypass') continue; // bypass actors are visible to admins only; checked when present
    if (!types.includes(rule)) problems.push(`rule ${rule} is missing`);
  }
  if (Array.isArray(rs.bypass_actors)) {
    for (const a of rs.bypass_actors.filter(isObj)) {
      if (a.bypass_mode !== 'pull_request')
        problems.push(`a bypass actor has bypass_mode ${String(a.bypass_mode)}, not pull_request`);
    }
  }
  const rsc = (Array.isArray(rs.rules) ? rs.rules : [])
    .filter(isObj)
    .find((r) => r.type === 'required_status_checks');
  const params = rsc && isObj(rsc.parameters) ? rsc.parameters : {};
  const checks = (
    Array.isArray(params.required_status_checks) ? params.required_status_checks : []
  ).filter(isObj);
  const live = checks.map((c) => String(c.context));
  const want = requiredChecks?.contexts ?? [];
  const missing = want.filter((c) => !live.includes(c));
  const extra = live.filter((c) => !want.includes(c));
  if (missing.length)
    problems.push(
      `required in ci/required-checks.json but not in the ruleset: ${missing.join(', ')}`
    );
  if (extra.length)
    problems.push(
      `required by the ruleset but not in ci/required-checks.json: ${extra.join(', ')}`
    );
  for (const c of checks) {
    if (c.integration_id !== config.ruleset.integration_id) {
      problems.push(
        `context ${String(c.context)} is pinned to integration ${String(c.integration_id)}, not ${config.ruleset.integration_id}`
      );
    }
  }
  return { id, ok: problems.length === 0, problems };
}

/**
 * Check a data-branch safeguard ruleset: present, active, targeting what it
 * should, with at least the rules it was created with.
 *
 * @param rs - The ruleset, or `null` when it is gone.
 * @param id - Its id.
 * @param target - `branch` or `tag`.
 * @param include - The ref pattern it must include.
 * @param rules - Rule types it must carry.
 */
function checkSafeguard(
  rs: Obj | null,
  id: number,
  target: 'branch' | 'tag',
  include: string,
  rules: readonly string[]
): Health['data_rulesets'][number] {
  if (!rs) return { id, ok: false, problems: [`ruleset ${id} does not exist`] };
  const problems: string[] = [];
  if (rs.enforcement !== 'active')
    problems.push(`enforcement is ${String(rs.enforcement)}, not active`);
  if (rs.target !== target) problems.push(`target is ${String(rs.target)}, not ${target}`);
  const cond = isObj(rs.conditions) && isObj(rs.conditions.ref_name) ? rs.conditions.ref_name : {};
  const inc = Array.isArray(cond.include) ? cond.include.map(String) : [];
  if (!inc.includes(include)) problems.push(`it no longer includes ${include}`);
  const types = ruleTypes(rs);
  for (const r of rules) if (!types.includes(r)) problems.push(`rule ${r} is missing`);
  // Nobody may bypass a safeguard. An admin token sees the list; any token
  // sees whether it could bypass itself (GITHUB_TOKEN sees only the latter).
  if (Array.isArray(rs.bypass_actors) && rs.bypass_actors.length > 0) {
    problems.push(`it has ${rs.bypass_actors.length} bypass actor(s); it must have none`);
  }
  if (typeof rs.current_user_can_bypass === 'string' && rs.current_user_can_bypass !== 'never') {
    problems.push(`this token can bypass it (${rs.current_user_can_bypass}); nobody may`);
  }
  return { id, ok: problems.length === 0, problems };
}

/**
 * Read the rulesets, the cache and the releases once for the whole run.
 *
 * @param gh - The client.
 * @param files - The hand files.
 */
export function globalChecks(gh: Gh, files: HandFiles): GlobalChecks {
  const { config } = files;
  const repo = config.github_repo;
  const failures: string[] = [];
  const ruleset = reconcileRuleset(readRuleset(gh, repo, config.ruleset.id), files);
  if (!ruleset.ok) {
    failures.push(
      `Ruleset ${ruleset.id} has drifted from ci/: ${ruleset.problems.join('; ')}. Either the ruleset was edited by hand (put it back) or ci/required-checks.json and ci/config.yaml need a ledgered PR that matches it.`
    );
  }
  const dataRulesets = [
    checkSafeguard(
      readRuleset(gh, repo, config.data_ruleset_id),
      config.data_ruleset_id,
      'branch',
      `refs/heads/${config.data_branch}`,
      ['deletion', 'non_fast_forward']
    ),
    checkSafeguard(
      readRuleset(gh, repo, config.data_tag_ruleset_id),
      config.data_tag_ruleset_id,
      'tag',
      `refs/tags/${config.data_tag_prefix}**`,
      ['deletion', 'update', 'non_fast_forward']
    ),
  ];
  for (const d of dataRulesets) {
    if (!d.ok) {
      failures.push(
        `Data-branch safeguard ruleset ${d.id}: ${d.problems.join('; ')}. The data branch is the only copy of the history; restore the ruleset (plans/ci-steward-status.md §3 records how it was created).`
      );
    }
  }
  const usage = gh.rest(`repos/${repo}/actions/cache/usage`) as Obj;
  const cache = {
    bytes: Number(usage.active_caches_size_in_bytes ?? 0),
    count: Number(usage.active_caches_count ?? 0),
  };
  const rel = gh.rest(`repos/${repo}/releases?per_page=30`) as Obj[];
  const releases = rel
    .filter((r) => typeof r.published_at === 'string' && r.draft !== true)
    .map((r) => ({ tag: String(r.tag_name), published_at: String(r.published_at) }));
  return { ruleset, dataRulesets, cache, releases, failures };
}

/**
 * Delete the Neon preview databases that no git branch will ever come back for.
 *
 * WHY. The Vercel-Neon integration gives every git branch Vercel deploys its own
 * Neon branch, `preview/<git-branch>`. It deletes that branch again only when
 * the git branch is deleted or its Vercel deployments are removed, so a git
 * branch that never becomes a pull request (a losing Codex attempt, a working
 * branch nobody deleted) keeps a database forever. The project reached 52 on
 * 2026-09-25 against a plan that includes 10, with the rest billed.
 * `apps/site/vercel.json` stops the deployments that never needed a preview;
 * this sweep catches everything else, once a night.
 *
 * WHAT IT DELETES. A Neon branch only when every one of these holds:
 *   - its name starts with `preview/` and names a git branch after it;
 *   - the integration made it (`creation_source: vercel`);
 *   - it is not the default branch, not protected, not primary;
 *   - no other branch has it as its parent;
 *   - it was created more than `minAgeDays` ago, AND every compute on it is
 *     suspended (`idle`) and was last active more than `minAgeDays` ago (a
 *     branch with no compute, or one that never ran, counts as idle);
 *   - no OPEN pull request has the git branch after `preview/` as its head.
 *
 * KEEP ON UNKNOWN. This is code whose failure mode is deleting a database, so
 * every unknown keeps: an unreadable date keeps, a failed or truncated listing
 * of branches, computes or pull requests keeps EVERYTHING (the plan is never
 * built from half an answer), and more candidates than `maxDeletions` in one
 * run deletes only the oldest `maxDeletions`. Production is safe on three counts
 * (no `preview/` prefix, made by `console`, the default flag) and `vercel-dev`
 * on the prefix.
 *
 * Usage (the nightly workflow is .github/workflows/neon-preview-sweep.yml):
 *   NEON_API_KEY=… NEON_PROJECT_ID=… GITHUB_TOKEN=… GITHUB_REPOSITORY=owner/repo \
 *     node scripts/neon-preview-sweep.ts [--dry-run]
 *
 * With no NEON_API_KEY or NEON_PROJECT_ID it prints a notice and exits 0: the
 * workflow ships before the operator adds the secret. Any listing failure or
 * failed deletion exits 1, so a sweep that stopped working is red, not quietly
 * green. The markdown summary goes to stdout and to $GITHUB_STEP_SUMMARY.
 *
 * Pinned by scripts/__tests__/neon-preview-sweep.test.ts against a stubbed API.
 *
 * @module neon-preview-sweep
 */
import { appendFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The fields of a Neon branch this sweep reads (Neon API v2, `GET /projects/{id}/branches`). */
export interface NeonBranch {
  id: string;
  name: string;
  creation_source?: string | undefined;
  default?: boolean | undefined;
  protected?: boolean | undefined;
  primary?: boolean | undefined;
  parent_id?: string | undefined;
  created_at?: string | undefined;
}

/** The fields of a Neon compute endpoint this sweep reads (`GET /projects/{id}/endpoints`). */
export interface NeonEndpoint {
  branch_id: string;
  last_active?: string | undefined;
  /** `idle` when suspended; anything else means it may be serving right now. */
  current_state?: string | undefined;
}

/** Everything the decision needs; `null` means that source could not be read. */
export interface SweepInput {
  branches: NeonBranch[] | null;
  endpoints: NeonEndpoint[] | null;
  /** Head ref names of every open pull request, or null when they could not be listed. */
  openPrHeads: Set<string> | null;
  now: Date;
  minAgeDays: number;
  maxDeletions: number;
}

/** One branch's verdict and the reason for it. */
export interface Decision {
  branch: NeonBranch;
  action: 'delete' | 'keep';
  reason: string;
}

/** The sweep's plan: a decision for every branch, or a refusal to plan at all. */
export interface SweepPlan {
  decisions: Decision[];
  /** Set when an input could not be read; then every decision is `keep`. */
  refused?: string;
}

const PREFIX = 'preview/';
const DAY_MS = 86_400_000;

function ageDays(iso: string | undefined, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / DAY_MS;
}

/** Why the branch's own fields rule it out, or null when they do not. */
function whyKeepByShape(branch: NeonBranch, parents: Set<string | undefined>): string | null {
  if (!branch.name.startsWith(PREFIX)) return 'not a preview branch';
  if (branch.name.length === PREFIX.length) return 'no git branch after preview/';
  if (branch.creation_source !== 'vercel') return 'not made by the Vercel integration';
  if (branch.default !== false) return 'default branch, or default unknown';
  if (branch.protected !== false) return 'protected, or protection unknown';
  if (branch.primary === true) return 'primary branch';
  if (parents.has(branch.id)) return 'has child branches';
  return null;
}

/** Why the branch is too young or too recently used, or null when it is neither. */
function whyKeepByAge(
  branch: NeonBranch,
  computes: NeonEndpoint[],
  now: Date,
  minAgeDays: number
): string | null {
  const created = ageDays(branch.created_at, now);
  if (created === null) return 'creation date unreadable';
  if (created < minAgeDays) return `created ${created.toFixed(1)} days ago`;
  for (const c of computes) {
    if (c.current_state !== undefined && c.current_state !== 'idle') {
      return `compute is ${c.current_state}`;
    }
    if (!c.last_active) continue; // a compute that never ran has no activity to protect
    const idle = ageDays(c.last_active, now);
    if (idle === null) return 'compute activity unreadable';
    if (idle < minAgeDays) return `compute active ${idle.toFixed(1)} days ago`;
  }
  return null;
}

/**
 * Decide, for every Neon branch, whether it is safe to delete. Pure: no I/O.
 *
 * @param input - the three listings, the clock and the limits
 * @returns one decision per branch, oldest deletions first
 */
export function planSweep(input: SweepInput): SweepPlan {
  const { branches, endpoints, openPrHeads, now, minAgeDays, maxDeletions } = input;
  if (branches === null) return { decisions: [], refused: 'could not list Neon branches' };
  const refuse = (why: string): SweepPlan => ({
    refused: why,
    decisions: branches.map((branch) => ({ branch, action: 'keep', reason: why })),
  });
  if (endpoints === null) return refuse('could not list Neon computes');
  if (openPrHeads === null) return refuse('could not list open pull requests');

  const parents = new Set(branches.map((b) => b.parent_id).filter(Boolean));
  const computes = new Map<string, NeonEndpoint[]>();
  for (const e of endpoints) computes.set(e.branch_id, [...(computes.get(e.branch_id) ?? []), e]);

  const decisions: Decision[] = branches.map((branch) => {
    const why =
      whyKeepByShape(branch, parents) ??
      whyKeepByAge(branch, computes.get(branch.id) ?? [], now, minAgeDays) ??
      (openPrHeads.has(branch.name.slice(PREFIX.length)) ? 'open pull request' : null);
    if (why) return { branch, action: 'keep', reason: why };
    return { branch, action: 'delete', reason: `idle ${minAgeDays}+ days, no open PR` };
  });

  // Oldest first, so a capped run always makes progress on the worst leak.
  const deletions = decisions
    .filter((d) => d.action === 'delete')
    .sort((a, b) => Date.parse(a.branch.created_at ?? '') - Date.parse(b.branch.created_at ?? ''));
  for (const d of deletions.slice(maxDeletions)) {
    d.action = 'keep';
    d.reason = `over this run's limit of ${maxDeletions}; next run`;
  }
  return { decisions };
}

/** A minimal fetch, so tests can stub the network without a mocking library. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const NEON_API = 'https://console.neon.tech/api/v2';
const MAX_PAGES = 50;

/** List every branch in a Neon project, following cursors; null on any failure or truncation. */
export async function listNeonBranches(
  fetchFn: Fetch,
  apiKey: string,
  projectId: string
): Promise<NeonBranch[] | null> {
  const out: NeonBranch[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ limit: '100', sort_by: 'created_at' });
    if (cursor) q.set('cursor', cursor);
    const body = await neonGet(fetchFn, apiKey, `/projects/${projectId}/branches?${q}`);
    if (!body || !Array.isArray(body.branches)) return null;
    out.push(...(body.branches as NeonBranch[]));
    const next = (body.pagination as { next?: string } | undefined)?.next;
    if (!next || body.branches.length === 0) return out;
    cursor = next;
  }
  return null; // more pages than the cap: a truncated list must never be planned from
}

/** List every compute endpoint in a Neon project; null on failure. */
export async function listNeonEndpoints(
  fetchFn: Fetch,
  apiKey: string,
  projectId: string
): Promise<NeonEndpoint[] | null> {
  const body = await neonGet(fetchFn, apiKey, `/projects/${projectId}/endpoints`);
  if (!body || !Array.isArray(body.endpoints)) return null;
  return body.endpoints as NeonEndpoint[];
}

async function neonGet(
  fetchFn: Fetch,
  apiKey: string,
  path: string
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchFn(`${NEON_API}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const OPEN_PRS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, after: $after) {
      nodes { headRefName }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

interface OpenPrPage {
  nodes: { headRefName?: unknown }[];
  pageInfo: { hasNextPage?: unknown; endCursor?: unknown };
}

async function openPrPage(
  fetchFn: Fetch,
  token: string,
  variables: { owner: string; name: string; after: string | null }
): Promise<OpenPrPage | null> {
  try {
    const res = await fetchFn('https://api.github.com/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: OPEN_PRS_QUERY, variables }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      errors?: unknown;
      data?: { repository?: { pullRequests?: OpenPrPage } };
    };
    const page = body.data?.repository?.pullRequests;
    if (body.errors || !page || !Array.isArray(page.nodes) || !page.pageInfo) return null;
    return page;
  } catch {
    return null;
  }
}

/**
 * Head ref names of every open pull request in `repo`; null on any failure or truncation.
 * Cursor-paged through GraphQL, so a PR closing mid-listing cannot shift another out of view
 * the way offset pages can.
 *
 * @param fetchFn - the network
 * @param token - a GitHub token that can read pull requests
 * @param repo - `owner/name`
 */
export async function listOpenPrHeads(
  fetchFn: Fetch,
  token: string,
  repo: string
): Promise<Set<string> | null> {
  const [owner = '', name = ''] = repo.split('/');
  if (!owner || !name) return null;
  const heads = new Set<string>();
  let after: string | null = null;
  for (let n = 0; n < MAX_PAGES; n++) {
    const page: OpenPrPage | null = await openPrPage(fetchFn, token, { owner, name, after });
    if (!page) return null;
    for (const pr of page.nodes) {
      if (typeof pr.headRefName !== 'string') return null;
      heads.add(pr.headRefName);
    }
    if (page.pageInfo.hasNextPage === false) return heads;
    if (page.pageInfo.hasNextPage !== true || typeof page.pageInfo.endCursor !== 'string') {
      return null;
    }
    after = page.pageInfo.endCursor;
  }
  return null;
}

/** Delete one Neon branch; true on success. */
export async function deleteNeonBranch(
  fetchFn: Fetch,
  apiKey: string,
  projectId: string,
  branchId: string
): Promise<boolean> {
  try {
    const res = await fetchFn(`${NEON_API}/projects/${projectId}/branches/${branchId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Options for one sweep run. */
export interface RunOptions {
  env: Record<string, string | undefined>;
  fetchFn: Fetch;
  now: Date;
  dryRun: boolean;
  log: (line: string) => void;
}

/** How long a preview database must sit unused, and how many one run may delete. */
const MIN_AGE_DAYS = 7;
const MAX_DELETIONS = 25;

/** Write the job summary for a plan that ran; returns nothing, the caller owns the exit code. */
function report(plan: SweepPlan, failed: Set<string>, dryRun: boolean, log: RunOptions['log']) {
  const verb = dryRun ? 'would delete' : 'deleted';
  const total = plan.decisions.length;
  const gone = plan.decisions.filter((d) => d.action === 'delete').length - failed.size;
  const failures = failed.size ? `, ${failed.size} failed to delete` : '';
  log(`${total} branches before, ${verb} ${gone}, ${total - gone} remain${failures}.`);
  log('');
  log('| Branch | Action | Why |');
  log('| --- | --- | --- |');
  for (const d of plan.decisions) {
    let action = d.action === 'keep' ? 'keep' : verb;
    if (failed.has(d.branch.id)) action = 'FAILED';
    log(`| \`${d.branch.name}\` | ${action} | ${d.reason} |`);
  }
}

/**
 * One sweep: read, plan, delete (unless dry run), and report.
 *
 * @param opts - environment, network, clock, mode and log sink
 * @returns the exit code: 0 when it did its job or has no credentials yet, 1 when it could not
 */
export async function runSweep(opts: RunOptions): Promise<number> {
  const { env, fetchFn, now, dryRun, log } = opts;
  const apiKey = env.NEON_API_KEY ?? '';
  const projectId = env.NEON_PROJECT_ID ?? '';
  if (!apiKey || !projectId) {
    const missing = apiKey ? 'the NEON_PROJECT_ID variable' : 'the NEON_API_KEY secret';
    log('## Neon preview sweep: not configured');
    log('');
    log(`Skipped: ${missing} is not set, so nothing was read or deleted.`);
    return 0;
  }
  const token = env.GITHUB_TOKEN ?? '';
  const repo = env.GITHUB_REPOSITORY ?? '';

  const [branches, endpoints, openPrHeads] = await Promise.all([
    listNeonBranches(fetchFn, apiKey, projectId),
    listNeonEndpoints(fetchFn, apiKey, projectId),
    token && repo ? listOpenPrHeads(fetchFn, token, repo) : Promise.resolve(null),
  ]);
  const plan = planSweep({
    branches,
    endpoints,
    openPrHeads,
    now,
    minAgeDays: MIN_AGE_DAYS,
    maxDeletions: MAX_DELETIONS,
  });

  log(`## Neon preview sweep${dryRun ? ' (dry run)' : ''}`);
  log('');
  if (plan.refused) {
    log(`Deleted nothing: ${plan.refused}.`);
    return 1;
  }
  const failed = new Set<string>();
  if (!dryRun) {
    for (const d of plan.decisions.filter((x) => x.action === 'delete')) {
      if (!(await deleteNeonBranch(fetchFn, apiKey, projectId, d.branch.id))) {
        failed.add(d.branch.id);
      }
    }
  }
  report(plan, failed, dryRun, log);
  return failed.size > 0 ? 1 : 0;
}

/** True when node was started on this file; resolves symlinks so a linked checkout still runs. */
function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  const code = await runSweep({
    env: process.env,
    fetchFn: fetch,
    now: new Date(),
    dryRun: process.argv.includes('--dry-run'),
    log: (line) => {
      console.log(line);
      if (summary) appendFileSync(summary, `${line}\n`);
    },
  });
  process.exit(code);
}

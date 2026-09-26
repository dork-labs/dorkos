/**
 * PR timelines for the collector: every PR merged in a day, reduced to the
 * facts the SLOs read (lead time, queue wait, clean queue builds, ejections and
 * whether a new commit followed each one).
 */
import type { Gh } from './gh.ts';
import { dayOf, minutesBetween, round } from './time.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Removal reasons that mean the queue build's checks failed. */
const EJECTED_FOR_CHECKS = new Set(['failed_checks', 'checks_timed_out']);

const TIMELINE_TYPES =
  'READY_FOR_REVIEW_EVENT, ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT';

const TIMELINE_PAGE = `pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on ReadyForReviewEvent { createdAt }
      ... on AddedToMergeQueueEvent { createdAt }
      ... on RemovedFromMergeQueueEvent { createdAt reason }
      ... on PullRequestCommit { commit { committedDate } }
      ... on HeadRefForcePushedEvent { createdAt }
    }`;

const PR_FIELDS = `number createdAt mergedAt headRefName
  timelineItems(first: 100, itemTypes: [${TIMELINE_TYPES}]) { ${TIMELINE_PAGE} }`;

/**
 * The next page of one PR's timeline. A timeline comes oldest first, so the
 * merge and the last queue events are exactly what a cut-off first page loses.
 *
 * @param repo - `owner/name`.
 * @param pr - The PR number.
 * @param after - The cursor the previous page ended on.
 */
export function timelinePageQuery(repo: string, pr: number, after: string): string {
  const [owner, name] = repo.split('/') as [string, string];
  return `query { repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${pr}) { timelineItems(first: 100, after: "${after}", itemTypes: [${TIMELINE_TYPES}]) { ${TIMELINE_PAGE} } } } }`;
}

/**
 * The GraphQL search for PRs merged in a span.
 *
 * @param repo - `owner/name`.
 * @param from - Start, an ISO instant.
 * @param to - End, an ISO instant.
 * @param after - Pagination cursor.
 */
export function mergedPrQuery(
  repo: string,
  from: string,
  to: string,
  after: string | null
): string {
  const cursor = after ? `, after: "${after}"` : '';
  const range = `${from.replace('Z', '+00:00')}..${to.replace('Z', '+00:00')}`;
  return `query { search(query: "repo:${repo} is:pr is:merged merged:${range}", type: ISSUE, first: 50${cursor}) { issueCount pageInfo { hasNextPage endCursor } nodes { ... on PullRequest { ${PR_FIELDS} } } } }`;
}

/** A merged PR's timeline, reduced to what the SLOs read. */
export interface PrFacts {
  number: number;
  mergedAt: string;
  leadTimeMin: number;
  queueWaitMin: number | null;
  /** Entry to merge, for a PR never removed from the queue except by merging. */
  queueBuildMin: number | null;
  /**
   * Each removal for failed or timed-out checks: when, whether a new commit
   * followed before re-queue, and `head`, how many pushes came before it. Two
   * ejections with the same `head` happened to the same unchanged head.
   */
  ejections: { at: string; newCommit: boolean; head: number }[];
}

/**
 * Reduce one PR node to its facts.
 *
 * @param p - The GraphQL PullRequest node.
 */
function prFacts(p: Obj): PrFacts {
  const tl = isObj(p.timelineItems) ? p.timelineItems : {};
  const nodes = (Array.isArray(tl.nodes) ? tl.nodes : []).filter(isObj);
  const at = (n: Obj) => String(n.createdAt);
  const of = (t: string) => nodes.filter((n) => n.__typename === t);
  const mergedAt = String(p.mergedAt);
  const ready = of('ReadyForReviewEvent').map(at).sort().at(-1);
  const adds = of('AddedToMergeQueueEvent').map(at).sort();
  const removals = of('RemovedFromMergeQueueEvent').filter((n) => n.reason !== 'merged');
  const pushes = [
    ...of('PullRequestCommit').map((n) => String((isObj(n.commit) ? n.commit : {}).committedDate)),
    ...of('HeadRefForcePushedEvent').map(at),
  ];
  const ejections = removals
    .filter((n) => EJECTED_FOR_CHECKS.has(String(n.reason)))
    .map((n) => {
      const r = at(n);
      const next = adds.find((a) => a > r) ?? mergedAt;
      return {
        at: r,
        newCommit: pushes.some((c) => c > r && c <= next),
        head: pushes.filter((c) => c <= r).length,
      };
    });
  return {
    number: Number(p.number),
    mergedAt,
    leadTimeMin: round(minutesBetween(ready ?? String(p.createdAt), mergedAt), 1),
    queueWaitMin: adds.length ? round(minutesBetween(adds[0]!, mergedAt), 1) : null,
    queueBuildMin:
      adds.length && removals.length === 0
        ? round(minutesBetween(adds.at(-1)!, mergedAt), 1)
        : null,
    ejections,
  };
}

/**
 * Fetch the rest of a PR node's timeline in place, page by page.
 *
 * @param gh - The client (a spent budget throws BudgetExhausted: the day is late).
 * @param repo - `owner/name`.
 * @param p - The PR node from the search, whose first page may be cut off.
 */
function completeTimeline(gh: Gh, repo: string, p: Obj): void {
  const tl = isObj(p.timelineItems) ? p.timelineItems : {};
  const nodes = (Array.isArray(tl.nodes) ? tl.nodes : []).filter(isObj);
  let info = isObj(tl.pageInfo) ? tl.pageInfo : {};
  while (info.hasNextPage === true && typeof info.endCursor === 'string') {
    const res = gh.graphql(timelinePageQuery(repo, Number(p.number), info.endCursor)) as {
      data?: {
        repository?: { pullRequest?: { timelineItems?: { pageInfo: Obj; nodes: unknown[] } } };
      };
    };
    const page = res.data?.repository?.pullRequest?.timelineItems;
    if (!page) throw new Error(`the timeline of PR #${String(p.number)} returned no data`);
    nodes.push(...page.nodes.filter(isObj));
    info = page.pageInfo;
  }
  p.timelineItems = { pageInfo: info, nodes };
}

/**
 * Every PR merged on a day, asserted against the search's own count.
 *
 * @param gh - The client.
 * @param repo - `owner/name`.
 * @param day - The UTC day.
 * @param until - For a day in progress, stop here.
 * @param failures - Where a truncated search is reported.
 */
export function fetchMergedPrs(
  gh: Gh,
  repo: string,
  day: string,
  until: Date | undefined,
  failures: string[]
): PrFacts[] {
  const from = `${day}T00:00:00Z`;
  const to =
    until && dayOf(until) === day
      ? until.toISOString().replace(/\.\d+Z$/, 'Z')
      : `${day}T23:59:59Z`;
  const out: PrFacts[] = [];
  let after: string | null = null;
  let count: number | undefined;
  for (;;) {
    const res = gh.graphql(mergedPrQuery(repo, from, to, after)) as {
      data?: {
        search?: {
          issueCount: number;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Obj[];
        };
      };
    };
    const s = res.data?.search;
    if (!s) throw new Error(`the merged-PR search for ${day} returned no data`);
    count = s.issueCount;
    for (const n of s.nodes) {
      if (!isObj(n) || n.number === undefined) continue;
      completeTimeline(gh, repo, n);
      out.push(prFacts(n));
    }
    if (!s.pageInfo.hasNextPage || !s.pageInfo.endCursor) break;
    after = s.pageInfo.endCursor;
  }
  if (count !== undefined && out.length < count) {
    failures.push(
      `Truncated: the search for PRs merged on ${day} reports ${count} but returned ${out.length}. Queue and lead-time numbers for the day would be wrong; re-run the collector.`
    );
  }
  return out;
}

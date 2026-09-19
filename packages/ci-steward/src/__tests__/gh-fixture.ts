/**
 * A recorded GitHub for one small day, shaped like the real API responses the
 * collector was dry-run against on 2026-09-19 (only the fields it reads).
 *
 * The day, 2026-09-18, on the fixture repo (fixture.ts: lint.yml and test.yml,
 * required contexts `lint` and `test`):
 *
 * - PR head `aaa`: lint and test ran on pull_request, both green.
 * - Queue build `bbb` for PR #7: test's shard failed, so the build is red.
 * - PR #7 was ejected for failed checks, got a new commit, re-queued, and its
 *   second build `ccc` went green and merged: one real catch, by test-shard.
 * - `ccc` then became main and its push run went green.
 */
import { mergedPrQuery } from '../prs.ts';
import { normaliseQuery, type Recording } from '../gh.ts';

export const DAY = '2026-09-18';
const REPO = 'o/r';
export const RUNS_PATH = `repos/${REPO}/actions/runs?created=${DAY}T00:00:00Z..${DAY}T23:59:59Z&per_page=100`;

type Obj = Record<string, unknown>;

function run(
  id: number,
  file: string,
  event: string,
  sha: string,
  created: string,
  conclusion: string,
  branch = 'feat/x',
  attempt = 1
): Obj {
  return {
    id,
    name: file.replace('.yml', ''),
    path: `.github/workflows/${file}`,
    event,
    status: 'completed',
    conclusion,
    created_at: `${DAY}T${created}Z`,
    // Every run in this day takes ten minutes, start to finish.
    updated_at: new Date(Date.parse(`${DAY}T${created}Z`) + 600_000)
      .toISOString()
      .replace('.000Z', 'Z'),
    run_attempt: attempt,
    head_branch: branch,
    head_sha: sha,
  };
}

export const RUNS: Obj[] = [
  run(101, 'lint.yml', 'pull_request', 'aaa', '10:00:00', 'success'),
  run(102, 'test.yml', 'pull_request', 'aaa', '10:00:05', 'success'),
  run(
    201,
    'lint.yml',
    'merge_group',
    'bbb',
    '11:00:00',
    'success',
    'gh-readonly-queue/main/pr-7-base1'
  ),
  run(
    202,
    'test.yml',
    'merge_group',
    'bbb',
    '11:00:02',
    'failure',
    'gh-readonly-queue/main/pr-7-base1'
  ),
  run(
    301,
    'lint.yml',
    'merge_group',
    'ccc',
    '12:30:00',
    'success',
    'gh-readonly-queue/main/pr-7-base2'
  ),
  run(
    302,
    'test.yml',
    'merge_group',
    'ccc',
    '12:30:02',
    'success',
    'gh-readonly-queue/main/pr-7-base2'
  ),
  run(401, 'lint.yml', 'push', 'ccc', '13:00:00', 'success', 'main'),
];

function check(
  name: string,
  runId: number,
  conclusion: string,
  start: string,
  end: string,
  app = 'github-actions'
): Obj {
  return {
    name,
    status: 'completed',
    conclusion,
    started_at: `${DAY}T${start}Z`,
    completed_at: `${DAY}T${end}Z`,
    details_url: `https://github.com/${REPO}/actions/runs/${runId}/job/${runId}0`,
    app: { slug: app },
  };
}

const CHECKS: Record<string, Obj[]> = {
  aaa: [
    check('lint', 101, 'success', '10:00:10', '10:04:10'),
    check('test-shard (1/2)', 102, 'success', '10:00:10', '10:10:10'),
    check('test-shard (2/2)', 102, 'success', '10:00:10', '10:12:10'),
    check('test', 102, 'success', '10:12:20', '10:13:20'),
    check('Vercel', 999, 'success', '10:00:10', '10:01:10', 'vercel'),
  ],
  bbb: [
    check('lint', 201, 'success', '11:00:10', '11:04:10'),
    check('test-shard (1/2)', 202, 'failure', '11:00:10', '11:08:10'),
    check('test-shard (2/2)', 202, 'success', '11:00:10', '11:11:10'),
    check('test', 202, 'failure', '11:11:20', '11:11:50'),
  ],
  ccc: [
    check('lint', 301, 'success', '12:30:10', '12:34:10'),
    check('test-shard (1/2)', 302, 'success', '12:30:10', '12:40:10'),
    check('test-shard (2/2)', 302, 'success', '12:30:10', '12:41:10'),
    check('test', 302, 'success', '12:41:20', '12:42:20'),
    check('lint', 401, 'success', '13:00:10', '13:03:10'),
  ],
};

const PR7 = {
  number: 7,
  createdAt: `${DAY}T09:00:00Z`,
  mergedAt: `${DAY}T12:45:00Z`,
  headRefName: 'feat/x',
  timelineItems: {
    pageInfo: { hasNextPage: false },
    nodes: [
      { __typename: 'AddedToMergeQueueEvent', createdAt: `${DAY}T10:59:00Z` },
      {
        __typename: 'RemovedFromMergeQueueEvent',
        createdAt: `${DAY}T11:12:00Z`,
        reason: 'failed_checks',
      },
      { __typename: 'PullRequestCommit', commit: { committedDate: `${DAY}T12:00:00Z` } },
      { __typename: 'AddedToMergeQueueEvent', createdAt: `${DAY}T12:29:00Z` },
      { __typename: 'RemovedFromMergeQueueEvent', createdAt: `${DAY}T12:45:00Z`, reason: 'merged' },
    ],
  },
};

function ruleset(
  id: number,
  target: string,
  include: string,
  rules: string[],
  extra: Obj = {}
): Obj {
  return {
    id,
    target,
    enforcement: 'active',
    conditions: { ref_name: { include: [include], exclude: [] } },
    rules: rules.map((type) => ({ type })),
    ...extra,
  };
}

/** The whole recording; tests mutate a copy to plant one defect each. */
export function dayRecording(): Recording {
  const rest: Record<string, unknown> = {
    [`${RUNS_PATH}&page=1`]: { total_count: RUNS.length, workflow_runs: RUNS },
    [`repos/${REPO}/rulesets/1`]: ruleset(1, 'branch', '~DEFAULT_BRANCH', ['merge_queue'], {
      rules: [
        { type: 'merge_queue' },
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [
              { context: 'lint', integration_id: 15368 },
              { context: 'test', integration_id: 15368 },
            ],
          },
        },
      ],
    }),
    [`repos/${REPO}/rulesets/2`]: ruleset(2, 'branch', 'refs/heads/ci-steward-data', [
      'deletion',
      'non_fast_forward',
    ]),
    [`repos/${REPO}/rulesets/3`]: ruleset(3, 'tag', 'refs/tags/ci-steward-data/**', [
      'deletion',
      'update',
      'non_fast_forward',
    ]),
    [`repos/${REPO}/actions/cache/usage`]: {
      active_caches_size_in_bytes: 123,
      active_caches_count: 4,
    },
    [`repos/${REPO}/releases?per_page=30`]: [
      { tag_name: 'v1.0.0', published_at: `${DAY}T15:00:00Z`, draft: false },
    ],
  };
  for (const [sha, runs] of Object.entries(CHECKS)) {
    rest[`repos/${REPO}/commits/${sha}/check-runs?filter=all&per_page=100&page=1`] = {
      total_count: runs.length,
      check_runs: runs,
    };
  }
  const q = normaliseQuery(mergedPrQuery(REPO, `${DAY}T00:00:00Z`, `${DAY}T23:59:59Z`, null));
  return structuredClone({
    rest,
    graphql: {
      [q]: {
        data: {
          search: {
            issueCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [PR7],
          },
        },
      },
    },
  });
}

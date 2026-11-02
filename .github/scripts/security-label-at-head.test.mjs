/* global URL, Response */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';
import { checkMergeGroup, checkPullRequest, DEEP_LABEL, githubApi } from './security-gate.mjs';
import { approvalMode, labelAtHead } from './security-label-at-head.mjs';

const pattern = '^apps/server/src/(http|services/tasks)/';
const deepPattern = '^apps/server/src/services/tasks/';
const SENSITIVE = 'apps/server/src/http/gate.ts';
const DEEP = 'apps/server/src/services/tasks/create-task.ts';
const SHA = 'head1';
const REF = 'fix/thing';
const EARLY = '2026-10-30T10:00:00Z';
const LATE = '2026-10-30T11:00:00Z';
const event = { pull_request: { number: 1, head: { sha: SHA } } };
const group = {
  merge_group: { base_ref: 'refs/heads/main', base_sha: 'base', head_sha: 'group1' },
};

const labelled = (at, type = 'User', name = 'security-reviewed') => ({
  event: 'labeled',
  label: { name },
  created_at: at,
  actor: { login: 'someone', type },
});
const push = (at, after = SHA, ref = `refs/heads/${REF}`) => ({ after, ref, timestamp: at });

function gate({
  files = [SENSITIVE],
  labels = ['security-reviewed'],
  timeline = [],
  activity = [],
  statuses = [],
} = {}) {
  return {
    pr: async () => ({
      head: { sha: SHA, ref: REF },
      base: { ref: 'main', sha: 'base' },
      changed_files: files.length,
      labels: labels.map((name) => ({ name })),
    }),
    files: async () => files.map((filename) => ({ filename })),
    statuses: async () => statuses,
    timeline: async () => timeline,
    activity: async () => activity,
    compare: async (base) => ({
      base_commit: { sha: base },
      merge_base_commit: { sha: base },
      files: files.map((filename) => ({ filename })),
    }),
    queue: async () => [
      {
        baseCommit: { oid: 'base' },
        headCommit: { oid: 'group1' },
        pullRequest: { number: 1, headRefOid: SHA },
      },
    ],
  };
}
const check = (api, botUserId = '0') =>
  checkPullRequest(api, event, pattern, { botUserId, deepPattern });
const queued = (api, botUserId = '0') =>
  checkMergeGroup(api, group, pattern, botUserId, deepPattern);

test('label then push fails: a new push voids the label', async () => {
  const api = gate({ timeline: [labelled(EARLY)], activity: [push(LATE)] });
  await assert.rejects(check(api), /older than the last push; remove it and add it again/);
  await assert.rejects(queued(api), /no security-review success/);
});

test('push then label passes, in the PR run and in the queue', async () => {
  const api = gate({ timeline: [labelled(LATE)], activity: [push(EARLY)] });
  assert.equal(await check(api), 'Security status verified');
  assert.match(await queued(api), /Security status verified/);
});

test('label and hold fails', async () => {
  const api = gate({
    labels: ['security-reviewed', 'hold'],
    timeline: [labelled(LATE)],
    activity: [push(EARLY)],
  });
  await assert.rejects(check(api), /hold label is on/);
  await assert.rejects(queued(api), /hold label is on/);
});

test('no label fails', async () => {
  await assert.rejects(
    check(gate({ labels: [], activity: [push(EARLY)] })),
    /no security-reviewed/
  );
});

test('docs-only passes without a label', async () => {
  const api = gate({ files: ['docs/a.mdx'], labels: [] });
  assert.equal(await check(api), 'no security paths (computed)');
  assert.match(await queued(api), /no security paths \(computed\)/);
});

test('bot id set: the label alone fails, the App status passes', async () => {
  const botUserId = '424242';
  const proof = { timeline: [labelled(LATE)], activity: [push(EARLY)] };
  await assert.rejects(check(gate(proof), botUserId), /security-review pending/);
  await assert.rejects(queued(gate(proof), botUserId), /no security-review success/);
  const statuses = [
    { context: 'security-review', state: 'success', creator: { id: Number(botUserId) } },
  ];
  const api = gate({ labels: [], statuses });
  assert.equal(await check(api, botUserId), 'Security status verified');
  assert.match(await queued(api, botUserId), /Security status verified/);
});

test('only the placeholder is label mode; garbage or a missing id never is', async () => {
  assert.equal(approvalMode('0'), 'label-at-head');
  assert.equal(approvalMode(0), 'label-at-head');
  for (const id of ['424242', '', 'abc', '-1', '00', undefined, null]) {
    assert.equal(approvalMode(id), 'app', String(id));
    const api = gate({ timeline: [labelled(LATE)], activity: [push(EARLY)] });
    await assert.rejects(
      checkPullRequest(api, event, pattern, { botUserId: id, deepPattern }),
      /pending/
    );
  }
});

test('an explicit refusal still refuses; the initializer pending does not', async () => {
  const proof = { timeline: [labelled(LATE)], activity: [push(EARLY)] };
  for (const state of ['failure', 'error']) {
    const api = gate({ ...proof, statuses: [{ context: 'security-review', state }] });
    await assert.rejects(check(api), new RegExp(`security-review is ${state}`));
  }
  const api = gate({ ...proof, statuses: [{ context: 'security-review', state: 'pending' }] });
  assert.equal(await check(api), 'Security status verified');
});

test('a bot cannot label a PR through', () => {
  const verdict = labelAtHead({
    sha: SHA,
    ref: REF,
    labels: [{ name: 'security-reviewed' }],
    timeline: [labelled(LATE, 'Bot')],
    activity: [push(EARLY)],
  });
  assert.equal(verdict.passed, false);
});

test('a bot cannot bring back a label a person removed', () => {
  const verdict = labelAtHead({
    sha: SHA,
    ref: REF,
    labels: [{ name: 'security-reviewed' }],
    timeline: [
      labelled('2026-10-30T10:30:00Z'),
      { event: 'unlabeled', label: { name: 'security-reviewed' }, created_at: LATE },
      labelled('2026-10-30T11:30:00Z', 'Bot'),
    ],
    activity: [push(EARLY)],
  });
  assert.equal(verdict.passed, false);
  assert.match(verdict.reason, /newest security-reviewed event is not from a person/);
});

test('the newest label event and the newest push decide', () => {
  const run = (timeline, activity) =>
    labelAtHead({
      sha: SHA,
      ref: REF,
      labels: [{ name: 'security-reviewed' }],
      timeline,
      activity,
    }).passed;
  // Removed and added again after the push: covered, whatever order GitHub lists them in.
  assert.equal(run([labelled(LATE), labelled(EARLY)], [push(EARLY)]), true);
  // Pushed back to an already-labelled SHA: the second push voids it.
  assert.equal(run([labelled(EARLY)], [push(LATE), push('2026-10-30T09:00:00Z')]), false);
  // A later force push on the timeline voids it, even with an older feed entry.
  const forced = { event: 'head_ref_force_pushed', created_at: LATE };
  assert.equal(run([labelled(EARLY), forced], [push('2026-10-30T09:00:00Z')]), false);
  // The same second is not newer.
  assert.equal(run([labelled(EARLY)], [push(EARLY)]), false);
  // A push of another SHA or to another branch is not this head's push time: refuse.
  assert.equal(run([labelled(LATE)], [push(EARLY, 'other')]), false);
  assert.equal(run([labelled(LATE)], [push(EARLY, SHA, 'refs/heads/other')]), false);
  // No feed entry, or an unreadable time: refuse.
  assert.equal(run([labelled(LATE)], []), false);
  assert.equal(run([labelled('nonsense')], [push(EARLY)]), false);
  assert.equal(run([labelled(LATE)], [push('nonsense')]), false);
});

test('GitHub client reads the timeline and a branch-scoped activity feed', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(url);
    return Response.json([]);
  });
  const api = githubApi('owner/repo', 'fake');
  await api.timeline(7);
  await api.activity('fix/a&b');
  assert.match(urls[0], /\/issues\/7\/timeline\?per_page=100$/);
  assert.match(urls[1], /\/activity\?ref=fix%2Fa%26b&per_page=100$/);
});

test('the verifier reruns when a label changes', () => {
  const workflow = readFileSync(new URL('../workflows/security-gate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /types: \[[^\]]*\blabeled, unlabeled\]/);
  assert.match(workflow, /^ {2}SECURITY_APPROVAL_BOT_USER_ID: '0'$/m);
});

describe('security-deep-reviewed on a P0 identity path (#dorkos, 2026-11-02)', () => {
  const both = (at) => [labelled(at), labelled(at, 'User', DEEP_LABEL)];

  test('a P0 path with only security-reviewed fails, in the PR run and in the queue', async () => {
    const api = gate({ files: [DEEP], timeline: [labelled(LATE)], activity: [push(EARLY)] });
    await assert.rejects(check(api), /no security-deep-reviewed label/);
    await assert.rejects(queued(api), /no security-deep-reviewed label/);
  });

  test('a P0 path with both labels after the push passes', async () => {
    const api = gate({
      files: [DEEP],
      labels: ['security-reviewed', DEEP_LABEL],
      timeline: both(LATE),
      activity: [push(EARLY)],
    });
    assert.equal(await check(api), 'Security status verified');
    assert.match(await queued(api), /Security status verified/);
  });

  test('a push voids the deep label too', async () => {
    const api = gate({
      files: [DEEP],
      labels: ['security-reviewed', DEEP_LABEL],
      timeline: [labelled(LATE), labelled(EARLY, 'User', DEEP_LABEL)],
      activity: [push('2026-10-30T10:30:00Z')],
    });
    await assert.rejects(
      check(api),
      /security-deep-reviewed is older than the last push; remove it and add it again/
    );
  });

  test('only a person can add it', async () => {
    const api = gate({
      files: [DEEP],
      labels: ['security-reviewed', DEEP_LABEL],
      timeline: [labelled(LATE), labelled(LATE, 'Bot', DEEP_LABEL)],
      activity: [push(EARLY)],
    });
    await assert.rejects(check(api), /newest security-deep-reviewed event is not from a person/);
  });

  test('the deep label never stands in for security-reviewed, and hold still wins', async () => {
    const deepOnly = gate({
      files: [DEEP],
      labels: [DEEP_LABEL],
      timeline: [labelled(LATE, 'User', DEEP_LABEL)],
      activity: [push(EARLY)],
    });
    await assert.rejects(check(deepOnly), /no security-reviewed label/);
    const held = gate({
      files: [DEEP],
      labels: ['security-reviewed', DEEP_LABEL, 'hold'],
      timeline: both(LATE),
      activity: [push(EARLY)],
    });
    await assert.rejects(check(held), /hold label is on/);
  });

  test('a sensitive path outside the P0 list needs only security-reviewed', async () => {
    const api = gate({ files: [SENSITIVE], timeline: [labelled(LATE)], activity: [push(EARLY)] });
    assert.equal(await check(api), 'Security status verified');
    assert.match(await queued(api), /Security status verified/);
  });

  test('a mixed diff takes the stricter rule', async () => {
    const api = gate({
      files: [SENSITIVE, DEEP],
      timeline: [labelled(LATE)],
      activity: [push(EARLY)],
    });
    await assert.rejects(check(api), /no security-deep-reviewed label/);
  });

  test('a missing P0 list refuses a sensitive diff rather than reading it as none', async () => {
    const api = gate({ files: [SENSITIVE], timeline: [labelled(LATE)], activity: [push(EARLY)] });
    await assert.rejects(
      checkPullRequest(api, event, pattern, { botUserId: '0' }),
      /deep-review path list missing/
    );
    await assert.rejects(
      checkMergeGroup(api, group, pattern, '0'),
      /deep-review path list missing/
    );
  });
});

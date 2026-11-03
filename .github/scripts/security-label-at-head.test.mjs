/* global URL, Response */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';
import {
  checkMergeGroup,
  checkPullRequest,
  DEEP_LABEL,
  githubApi,
  VERDICT_POLL,
} from './security-gate.mjs';
import { approvalMode, labelAtHead } from './security-label-at-head.mjs';

const pattern = '^apps/server/src/(http|services/tasks)/';
const deepPattern = '^apps/server/src/services/tasks/';
const SENSITIVE = 'apps/server/src/http/gate.ts';
const DEEP = 'apps/server/src/services/tasks/create-task.ts';
const SHA = 'head1';
const REF = 'fix/thing';
const EARLY = '2026-10-30T10:00:00Z';
const LATE = '2026-10-30T11:00:00Z';
/** When main's verdict wrote, after every label and push above unless a test says otherwise. */
const VERDICT = '2026-10-30T12:00:00Z';
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
const review = (state, at = VERDICT, extra = {}) => ({
  context: 'security-review',
  state,
  created_at: at,
  ...extra,
});

/**
 * A fake GitHub. `bases` is the PR base each successive `pr()` read returns,
 * so a parent branch pushed mid-run is one more entry; `pr` adds PR fields.
 */
function gate({
  files = [SENSITIVE],
  labels = ['security-reviewed'],
  timeline = [],
  activity = [],
  statuses = [review('success')],
  bases = ['base'],
  pr = {},
} = {}) {
  let reads = 0;
  const api = {
    fileReads: 0,
    pr: async () => ({
      head: { sha: SHA, ref: REF },
      base: { ref: 'main', sha: bases[Math.min(reads++, bases.length - 1)] },
      changed_files: files.length,
      labels: labels.map((name) => ({ name })),
      ...pr,
    }),
    files: async () => {
      api.fileReads += 1;
      return files.map((filename) => ({ filename }));
    },
    statusReads: 0,
    statuses: async (sha) => {
      api.statusReads += 1;
      return sha === SHA ? statuses : [];
    },
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
  return api;
}
/** No real waiting in tests: each poll is a no-op sleep that `onSleep` can act on. */
const fastPoll = (onSleep = () => {}) => ({
  intervalMs: 5000,
  polls: 18,
  sleep: async () => onSleep(),
});
const check = (api, botUserId = '0', poll = fastPoll()) =>
  checkPullRequest(api, event, pattern, { botUserId, deepPattern, poll });
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

const WAITING =
  /^Waiting for Security: no security-reviewed label yet on head1\. security-review decides/;

test('no label waits in the PR run, and fails in the queue', async () => {
  const api = gate({ labels: [], activity: [push(EARLY)] });
  assert.match(await check(api), WAITING);
  await assert.rejects(queued(api), /no security-reviewed/);
});

test('docs-only passes without a label', async () => {
  const api = gate({ files: ['docs/a.mdx'], labels: [], statuses: [] });
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

test('an explicit refusal still refuses; a pending is waited out, never judged on', async () => {
  const proof = { timeline: [labelled(LATE)], activity: [push(EARLY)] };
  for (const state of ['failure', 'error']) {
    const api = gate({ ...proof, statuses: [review(state)] });
    await assert.rejects(check(api), new RegExp(`security-review is ${state}`));
  }
  const api = gate({ ...proof, statuses: [review('pending')] });
  await assert.rejects(check(api), /verdict not yet written for this head/);
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

  test('a P0 path with only security-reviewed waits in the PR run, and fails in the queue', async () => {
    const api = gate({ files: [DEEP], timeline: [labelled(LATE)], activity: [push(EARLY)] });
    assert.match(await check(api), /^Waiting for Security: no security-deep-reviewed label yet/);
    await assert.rejects(queued(api), /no security-deep-reviewed label/);
  });

  test('a stale security-reviewed on a P0 path fails, never waits for the deep label', async () => {
    const api = gate({ files: [DEEP], timeline: [labelled(EARLY)], activity: [push(LATE)] });
    await assert.rejects(check(api), /security-reviewed is older than the last push/);
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
    assert.match(await check(deepOnly), WAITING);
    await assert.rejects(queued(deepOnly), /no security-reviewed label/);
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
    assert.match(await check(api), /^Waiting for Security: no security-deep-reviewed label yet/);
    await assert.rejects(queued(api), /no security-deep-reviewed label/);
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

describe('an unlabelled PR waits; anything wrong still fails (Security, step 4)', () => {
  test("main's failure verdict on a merely unlabelled PR waits too", async () => {
    const statuses = [review('failure')];
    assert.match(await check(gate({ labels: [], statuses, activity: [push(EARLY)] })), WAITING);
  });

  test('a stale label fails', async () => {
    const api = gate({ timeline: [labelled(EARLY)], activity: [push(LATE)] });
    await assert.rejects(check(api), /older than the last push/);
  });

  test('a label a bot added fails', async () => {
    const api = gate({ timeline: [labelled(LATE, 'Bot')], activity: [push(EARLY)] });
    await assert.rejects(check(api), /not from a person/);
  });

  test('hold fails, with or without the label', async () => {
    for (const labels of [['hold'], ['security-reviewed', 'hold']]) {
      const api = gate({ labels, timeline: [labelled(LATE)], activity: [push(EARLY)] });
      await assert.rejects(check(api), /hold label is on/, labels.join(','));
    }
  });

  test('a label added after the merge fails', async () => {
    for (const name of ['security-reviewed', DEEP_LABEL]) {
      const api = gate({
        labels: ['security-reviewed', DEEP_LABEL],
        timeline: [labelled(EARLY), labelled(LATE, 'User', name)],
        activity: [push('2026-10-30T09:00:00Z')],
        pr: { merged_at: '2026-10-30T10:30:00Z', state: 'closed' },
      });
      await assert.rejects(check(api), new RegExp(`${name} was added after the merge`));
    }
  });

  test('a merged or closed PR with no label never waits', async () => {
    for (const pr of [{ merged_at: LATE, state: 'closed' }, { state: 'closed' }]) {
      const api = gate({ labels: [], activity: [push(EARLY)], pr });
      await assert.rejects(check(api), /no security-reviewed label/);
    }
  });

  test('a fresh label with a refusal from main still refuses', async () => {
    const statuses = [review('failure')];
    const api = gate({ statuses, timeline: [labelled(LATE)], activity: [push(EARLY)] });
    await assert.rejects(check(api), /security-review is failure/);
  });
});

describe('a stacked layer whose parent moves mid-run (DOR-3680)', () => {
  const moving = { bases: ['parent1', 'parent2'] };

  test('it is judged on the new base: a fresh label passes, and the files are read again', async () => {
    const api = gate({ ...moving, timeline: [labelled(LATE)], activity: [push(EARLY)] });
    assert.equal(await check(api), 'Security status verified');
    assert.equal(api.fileReads, 2);
  });

  test('a stale label still fails, and no label waits, rather than "base moved"', async () => {
    const stale = gate({ ...moving, timeline: [labelled(EARLY)], activity: [push(LATE)] });
    await assert.rejects(check(stale), /older than the last push/);
    assert.match(await check(gate({ ...moving, labels: [], activity: [push(EARLY)] })), WAITING);
  });

  test('a base that never settles refuses after three runs', async () => {
    const bases = Array.from({ length: 20 }, (_, i) => `parent${i}`);
    const api = gate({ bases, timeline: [labelled(LATE)], activity: [push(EARLY)] });
    await assert.rejects(check(api), /base kept moving/);
    assert.equal(api.fileReads, 3);
  });

  test('a head that moves mid-run still refuses', async () => {
    const api = gate({ timeline: [labelled(LATE)], activity: [push(EARLY)] });
    const original = api.pr;
    let reads = 0;
    api.pr = async () => {
      const pr = await original();
      return ++reads > 1 ? { ...pr, head: { ...pr.head, sha: 'head2' } } : pr;
    };
    await assert.rejects(check(api), /head moved/);
  });
});

describe("main's failure for any reason but a missing label still fails (Security, 16:42Z)", () => {
  // The gate never reads a status description: anyone with statuses: write can
  // set one. It decides "only waiting" from the PR's own labels, and consults
  // main's verdict only once the labels it can see are all there.
  const withGithub = '^(apps/server/src/http/|\\.github/)';
  const refused = (description) => [review('failure', VERDICT, { description })];

  test('a workflow edit with a fresh security-reviewed and no deep label fails, never waits', async () => {
    const api = gate({
      files: ['.github/workflows/lint.yml'],
      statuses: refused(
        'no security-deep-reviewed label; .github/workflows/lint.yml is a workflow'
      ),
      timeline: [labelled(LATE)],
      activity: [push(EARLY)],
    });
    await assert.rejects(
      checkPullRequest(api, event, withGithub, { botUserId: '0', deepPattern, poll: fastPoll() }),
      /security-review is failure/
    );
  });

  test('a description that claims only a missing label changes nothing', async () => {
    const api = gate({
      statuses: refused('no security-reviewed label'),
      timeline: [labelled(LATE)],
      activity: [push(EARLY)],
    });
    await assert.rejects(check(api), /security-review is failure/);
  });

  test('an errored verdict on a fully labelled PR fails', async () => {
    const api = gate({
      statuses: refused('verdict errored: GitHub API 502 at /timeline'),
      timeline: [labelled(LATE)],
      activity: [push(EARLY)],
    });
    await assert.rejects(check(api), /security-review is failure/);
  });
});

describe("the PR run waits for main's verdict on a label change (DOR-3710)", () => {
  // The gate and main's verdict start on the same label event. The gate read the
  // old status 1-5s before the verdict wrote the new one (marketplace, 3 of 3).
  const STALE = '2026-10-30T10:30:00Z';
  const covered = { timeline: [labelled(LATE)], activity: [push(EARLY)] };
  /** The verdict writes `later` on the head after `after` polls. */
  const writes = (statuses, after, later) => {
    let sleeps = 0;
    return fastPoll(() => {
      if (++sleeps === after) statuses.unshift(...later);
    });
  };

  test('a stale failure, then a fresh pending and success: passes', async () => {
    const statuses = [review('failure', STALE)];
    const api = gate({ ...covered, statuses });
    const poll = writes(statuses, 2, [review('success'), review('pending', VERDICT)]);
    assert.equal(await check(api, '0', poll), 'Security status verified');
    // One read before judging, then three polls.
    assert.equal(api.statusReads, 4);
  });

  test('a fresh pending is never judged on: it waits for the success', async () => {
    const statuses = [review('pending', VERDICT), review('failure', STALE)];
    const api = gate({ ...covered, statuses });
    const poll = writes(statuses, 1, [review('success', '2026-10-30T12:00:05Z')]);
    assert.equal(await check(api, '0', poll), 'Security status verified');
  });

  test('a stale success, then hold added: fails without polling', async () => {
    const api = gate({
      labels: ['security-reviewed', 'hold'],
      timeline: [labelled(LATE), labelled('2026-10-30T12:30:00Z', 'User', 'hold')],
      activity: [push(EARLY)],
      statuses: [review('success')],
    });
    await assert.rejects(check(api), /hold label is on/);
    // Only the read before judging; no polling.
    assert.equal(api.statusReads, 1);
  });

  test('a stale success, then a fresh failure: fails', async () => {
    // The label went off and on again after the old success; only main's verdict
    // knows the diff now needs more (a workflow edit, say).
    const statuses = [review('success', STALE)];
    const api = gate({
      timeline: [
        labelled(EARLY),
        {
          event: 'unlabeled',
          label: { name: 'security-reviewed' },
          created_at: '2026-10-30T10:45:00Z',
        },
        labelled(LATE),
      ],
      activity: [push('2026-10-30T09:00:00Z')],
      statuses,
    });
    const poll = writes(statuses, 3, [review('failure')]);
    await assert.rejects(check(api, '0', poll), /security-review is failure/);
  });

  test('a stale success after hold came off is not judged on', async () => {
    const statuses = [review('success', '2026-10-30T11:15:00Z')];
    const api = gate({
      timeline: [
        labelled(LATE),
        labelled('2026-10-30T11:10:00Z', 'User', 'hold'),
        { event: 'unlabeled', label: { name: 'hold' }, created_at: '2026-10-30T11:30:00Z' },
      ],
      activity: [push(EARLY)],
      statuses,
    });
    const poll = writes(statuses, 1, [review('failure')]);
    await assert.rejects(check(api, '0', poll), /security-review is failure/);
  });

  test('the bound runs out: fails closed, never passes on the stale status', async () => {
    for (const state of ['success', 'failure', 'pending']) {
      const api = gate({ ...covered, statuses: [review(state, STALE)] });
      await assert.rejects(
        check(api),
        /verdict not yet written for this head \(none newer than 2026-10-30T11:00:00\.000Z\); rerun security-gate/,
        state
      );
      assert.equal(api.statusReads, 1 + 19, state);
    }
  });

  test('no status, an undated one, or one in the same second fails closed', async () => {
    for (const statuses of [[], [review('success', null)], [review('success', LATE)]]) {
      await assert.rejects(check(gate({ ...covered, statuses })), /verdict not yet written/);
    }
  });

  test('a status on an earlier head is ignored, however fresh', async () => {
    const api = gate({ ...covered, statuses: [review('failure', STALE)] });
    const own = api.statuses;
    const shas = [];
    api.statuses = async (sha) => {
      shas.push(sha);
      return sha === SHA ? own(sha) : [review('success', '2026-10-30T13:00:00Z')];
    };
    await assert.rejects(check(api), /verdict not yet written/);
    assert.deepEqual([...new Set(shas)], [SHA]);
  });

  test('a base change or force push after the verdict makes it stale', async () => {
    for (const change of ['base_ref_changed', 'head_ref_force_pushed']) {
      const api = gate({
        timeline: [{ event: change, created_at: '2026-10-30T10:30:00Z' }, labelled(LATE)],
        activity: [push(EARLY)],
        statuses: [review('success', '2026-10-30T10:15:00Z')],
      });
      await assert.rejects(check(api), /verdict not yet written/, change);
    }
    const moved = gate({
      timeline: [labelled(LATE), { event: 'base_ref_changed', created_at: '2026-10-30T12:30:00Z' }],
      activity: [push(EARLY)],
    });
    await assert.rejects(check(moved), /verdict not yet written/);
  });

  test('an unrelated label change does not make the verdict stale', async () => {
    const api = gate({
      timeline: [labelled(LATE), labelled('2026-10-30T12:30:00Z', 'User', 'documentation')],
      activity: [push(EARLY)],
    });
    assert.equal(await check(api), 'Security status verified');
    assert.equal(api.statusReads, 2);
  });

  test('the merge queue never waits and still refuses a stale failure', async () => {
    const api = gate({ ...covered, statuses: [review('failure', STALE)] });
    await assert.rejects(queued(api), /security-review is failure/);
    assert.equal(api.statusReads, 1);
  });

  test('the real bound is about 90s, inside the job limit', () => {
    assert.equal(VERDICT_POLL.intervalMs * VERDICT_POLL.polls, 90_000);
    const workflow = readFileSync(
      new URL('../workflows/security-gate.yml', import.meta.url),
      'utf8'
    );
    const minutes = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(workflow)?.[1]);
    assert.ok(minutes * 60_000 > VERDICT_POLL.intervalMs * VERDICT_POLL.polls * 3, String(minutes));
  });
});

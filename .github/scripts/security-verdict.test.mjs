/* global URL */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';
import { checkMergeGroup } from './security-gate.mjs';
import { REQUIRED_RULESET_NAME } from './security-required-checks.mjs';
import { trustedLists, verdictForMergeGroup, verdictForPullRequest } from './security-verdict.mjs';

const lists = {
  pattern: '^(apps/server/src/(http|services/tasks)/|\\.github/)',
  deepPattern: '^apps/server/src/services/tasks/',
  botUserId: '0',
};
const SENSITIVE = 'apps/server/src/http/gate.ts';
const DEEP = 'apps/server/src/services/tasks/create-task.ts';
const SHA = 'head1';
const REF = 'fix/thing';
const EARLY = '2026-11-02T10:00:00Z';
const CHECKED = '2026-11-02T10:30:00Z';
const LATE = '2026-11-02T11:00:00Z';
const event = {
  pull_request: { number: 1, head: { sha: SHA }, base: { ref: 'main', sha: 'base' } },
};
const group = {
  merge_group: { base_ref: 'refs/heads/main', base_sha: 'base', head_sha: 'group1' },
};

const labelled = (at, name = 'security-reviewed', type = 'User') => ({
  event: 'labeled',
  label: { name },
  created_at: at,
  actor: { login: 'someone', type },
});
const push = (at) => ({ after: SHA, ref: `refs/heads/${REF}`, timestamp: at });

/**
 * A fake GitHub. `heads` is the PR head each successive `pr()` read returns, so
 * a push mid-run is one more entry. `failOn` names an API call that throws.
 * `texts` is each workflow's YAML at the head: the verdict must not need it, so a
 * grant spelled any way at all still needs the deep label.
 */
function fakeGitHub({
  files = [SENSITIVE],
  labels = ['security-reviewed'],
  timeline = [labelled(LATE)],
  activity = [push(EARLY)],
  heads = [SHA],
  base = 'main',
  failOn,
  texts = {},
  statuses = [],
  state = 'open',
  mergedAt = null,
} = {}) {
  const written = [];
  let reads = 0;
  const api = {
    pr: async () => {
      const sha = heads[Math.min(reads, heads.length - 1)];
      reads += 1;
      return {
        number: 1,
        head: { sha, ref: REF },
        base: { ref: base, sha: 'base' },
        state,
        merged_at: mergedAt,
        changed_files: files.length,
        labels: labels.map((name) => ({ name })),
      };
    },
    files: async () =>
      files.map((file) =>
        typeof file === 'string'
          ? { filename: file, status: 'modified' }
          : { status: 'modified', ...file }
      ),
    content: async (path) => texts[path],
    statuses: async () => {
      if (failOn === 'statuses') throw new Error('GitHub API 502 at /statuses');
      return statuses;
    },
    setStatus: async (sha, state, description) => {
      const status = {
        context: 'security-review',
        state,
        description,
        creator: { login: 'github-actions[bot]' },
      };
      written.push({ sha, state, description });
      statuses.unshift(status);
      return status;
    },
    timeline: async () => {
      if (failOn === 'timeline') throw new Error('GitHub API 502 at /timeline');
      return timeline;
    },
    activity: async () => activity,
    comments: async () => [],
    comment: async () => {},
    compare: async (base) => ({
      base_commit: { sha: base },
      merge_base_commit: { sha: base },
      files: files.map((filename) => ({ filename })),
    }),
    // The gate's required-check reads: one required check, finished before LATE.
    rulesets: async () => [{ id: 7, name: REQUIRED_RULESET_NAME }],
    ruleset: async () => ({
      rules: [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'test' }] },
        },
      ],
    }),
    checkRuns: async () => [
      { name: 'test', status: 'completed', conclusion: 'success', completed_at: CHECKED },
    ],
    queue: async () => [
      {
        baseCommit: { oid: 'base' },
        headCommit: { oid: 'group1' },
        pullRequest: { number: 1, headRefOid: SHA },
      },
    ],
  };
  return { api, written };
}

/** The last status the run wrote on the head: the verdict. */
const verdictOf = (written) => written.at(-1);

describe('the base-copy verdict on a pull request', () => {
  test('a head with no security path is success, "no security paths"', async () => {
    const gh = fakeGitHub({ files: ['docs/a.mdx'], labels: [], timeline: [] });
    await verdictForPullRequest(gh.api, event, lists);
    assert.deepEqual(verdictOf(gh.written), {
      sha: SHA,
      state: 'success',
      description: 'no security paths',
    });
  });

  test('a security head labelled after its last push is success', async () => {
    const gh = fakeGitHub();
    await verdictForPullRequest(gh.api, event, lists);
    assert.equal(verdictOf(gh.written).state, 'success');
  });

  test('no label is pending, after the initializer pending (DOR-4459)', async () => {
    const gh = fakeGitHub({ labels: [], timeline: [] });
    await verdictForPullRequest(gh.api, event, lists);
    assert.deepEqual(
      gh.written.map((w) => w.state),
      ['pending', 'pending']
    );
    assert.match(verdictOf(gh.written).description, /no security-reviewed label/);
  });

  test('label, then a push: the push run ends as failure', async () => {
    const gh = fakeGitHub({ timeline: [labelled(EARLY)], activity: [push(LATE)] });
    await verdictForPullRequest(gh.api, event, lists);
    assert.equal(verdictOf(gh.written).state, 'failure');
    assert.match(verdictOf(gh.written).description, /older than the last push/);
  });

  test('a label a bot added is failure', async () => {
    const gh = fakeGitHub({ timeline: [labelled(LATE, 'security-reviewed', 'Bot')] });
    await verdictForPullRequest(gh.api, event, lists);
    assert.equal(verdictOf(gh.written).state, 'failure');
    assert.match(verdictOf(gh.written).description, /not from a person/);
  });

  test('hold is pending, never success, even with a fresh label', async () => {
    const gh = fakeGitHub({ labels: ['security-reviewed', 'hold'] });
    await verdictForPullRequest(gh.api, event, lists);
    assert.equal(verdictOf(gh.written).state, 'pending');
    assert.equal(verdictOf(gh.written).description, 'the hold label is on');
  });

  test('a P0 path needs security-deep-reviewed too', async () => {
    const only = fakeGitHub({ files: [DEEP] });
    await verdictForPullRequest(only.api, event, lists);
    assert.equal(verdictOf(only.written).state, 'pending');
    assert.match(verdictOf(only.written).description, /no security-deep-reviewed label/);
    const both = fakeGitHub({
      files: [DEEP],
      labels: ['security-reviewed', 'security-deep-reviewed'],
      timeline: [labelled(LATE), labelled(LATE, 'security-deep-reviewed')],
    });
    await verdictForPullRequest(both.api, event, lists);
    assert.equal(verdictOf(both.written).state, 'success');
  });

  test('a head that moved mid-run writes no verdict; the newer run decides', async () => {
    const gh = fakeGitHub({ heads: [SHA, 'head2'] });
    const said = await verdictForPullRequest(gh.api, event, lists);
    assert.match(said, /moved past head1/);
    assert.ok(gh.written.every((w) => w.state !== 'success'));
  });

  test('App mode leaves the verdict to the App', async () => {
    const gh = fakeGitHub();
    await verdictForPullRequest(gh.api, event, { ...lists, botUserId: '424242' });
    assert.ok(gh.written.every((w) => w.state === 'pending'));
  });
});

describe('any workflow edit needs security-deep-reviewed (interim, until the App)', () => {
  const deepLabels = {
    labels: ['security-reviewed', 'security-deep-reviewed'],
    timeline: [labelled(LATE), labelled(LATE, 'security-deep-reviewed')],
  };

  // Every spelling of the grant, and none at all: the file's text is never read.
  for (const [what, filename, yaml] of [
    ["quoted 'write'", '.github/workflows/quoted.yml', "permissions:\n  statuses: 'write'\n"],
    ['"write-all"', '.github/workflows/write-all.yaml', 'permissions: "write-all"\n'],
    ['a flow map', '.github/workflows/flow.yml', 'permissions: { statuses: write }\n'],
    ['a quoted key', '.github/workflows/key.yml', 'permissions:\n  "checks": write\n'],
    [
      'an anchor',
      '.github/workflows/anchor.yml',
      'x: &w write\njobs:\n  a:\n    permissions:\n      statuses: *w\n',
    ],
    ['a plain edit with no grant', '.github/workflows/lint.yml', 'on: pull_request\n'],
  ]) {
    test(`${what}: failure with only security-reviewed, success with the deep label`, async () => {
      const texts = { [filename]: yaml };
      const only = fakeGitHub({ files: [filename], texts });
      await verdictForPullRequest(only.api, event, lists);
      assert.equal(verdictOf(only.written).state, 'failure');
      assert.match(verdictOf(only.written).description, /security-deep-reviewed/);
      assert.match(verdictOf(only.written).description, /is a workflow/);

      const both = fakeGitHub({ files: [filename], texts, ...deepLabels });
      await verdictForPullRequest(both.api, event, lists);
      assert.equal(verdictOf(both.written).state, 'success');
    });
  }

  test('a workflow renamed out of, or removed from, .github/workflows counts too', async () => {
    for (const file of [
      { filename: 'ci/old.yml', previous_filename: '.github/workflows/old.yml', status: 'renamed' },
      { filename: '.github/workflows/gone.yml', status: 'removed' },
    ]) {
      const gh = fakeGitHub({ files: [file] });
      await verdictForPullRequest(gh.api, event, lists);
      assert.equal(verdictOf(gh.written).state, 'failure', file.filename);
    }
  });

  test('a workflow edit is a security head even outside the path list', async () => {
    const gh = fakeGitHub({
      files: ['.github/workflows/lint.yml'],
      labels: [],
      timeline: [],
    });
    await verdictForPullRequest(gh.api, event, { ...lists, pattern: '^apps/server/src/http/' });
    // Unlabelled, so only waiting; a workflow still never reads as no security paths.
    assert.equal(verdictOf(gh.written).state, 'pending');
    assert.match(verdictOf(gh.written).description, /lint\.yml is a workflow/);
  });
});

describe('an error is a refusal', () => {
  for (const failOn of ['statuses', 'timeline']) {
    test(`a ${failOn} read that throws writes failure on the head, then rethrows`, async () => {
      const gh = fakeGitHub({ failOn });
      await assert.rejects(verdictForPullRequest(gh.api, event, lists), /502/);
      assert.equal(verdictOf(gh.written).sha, SHA);
      assert.equal(verdictOf(gh.written).state, 'failure');
      assert.match(verdictOf(gh.written).description, /^verdict errored: GitHub API 502/);
    });
  }
});

describe('a PR that edits the job that judges it (Security, 2026-11-02)', () => {
  const deepLabels = {
    labels: ['security-reviewed', 'security-deep-reviewed'],
    timeline: [labelled(LATE), labelled(LATE, 'security-deep-reviewed')],
  };

  test('editing security-review-initialize.yml with only security-reviewed is failure', async () => {
    const file = '.github/workflows/security-review-initialize.yml';
    const gh = fakeGitHub({ files: [file] });
    await verdictForPullRequest(gh.api, event, lists);
    assert.equal(verdictOf(gh.written).state, 'failure');
    assert.match(
      verdictOf(gh.written).description,
      /security-review-initialize\.yml judges this PR/
    );
  });

  test('editing a gate script needs the deep label, and passes with it', async () => {
    const files = ['.github/scripts/security-verdict.mjs'];
    const only = fakeGitHub({ files });
    await verdictForPullRequest(only.api, event, lists);
    assert.equal(verdictOf(only.written).state, 'failure');
    assert.match(verdictOf(only.written).description, /security-verdict\.mjs judges this PR/);
    const both = fakeGitHub({ files, ...deepLabels });
    await verdictForPullRequest(both.api, event, lists);
    assert.equal(verdictOf(both.written).state, 'success');
  });

  test('the gate workflow and a rename out of a gate script count too', async () => {
    for (const file of [
      { filename: '.github/workflows/security-gate.yml' },
      {
        filename: '.github/scripts/old-gate.mjs',
        previous_filename: '.github/scripts/security-gate.mjs',
      },
    ]) {
      const gh = fakeGitHub({ files: [file] });
      await verdictForPullRequest(gh.api, event, lists);
      assert.equal(verdictOf(gh.written).state, 'failure', file.filename);
    }
  });

  test('a look-alike script is a security path, but not a judge', async () => {
    const gh = fakeGitHub({ files: ['.github/scripts/run-tests.mjs'] });
    await verdictForPullRequest(gh.api, event, lists);
    assert.equal(verdictOf(gh.written).state, 'success');
  });
});

describe('the base-copy verdict on the merge queue', () => {
  test('a labelled queue posts success on the group SHA', async () => {
    const gh = fakeGitHub();
    await verdictForMergeGroup(gh.api, group, lists);
    assert.deepEqual(verdictOf(gh.written), {
      sha: 'group1',
      state: 'success',
      description: 'Security label covers every queued PR',
    });
  });

  test('an unlabelled queued PR posts failure on the group SHA', async () => {
    const gh = fakeGitHub({ labels: [], timeline: [] });
    await verdictForMergeGroup(gh.api, group, lists);
    assert.equal(verdictOf(gh.written).sha, 'group1');
    assert.equal(verdictOf(gh.written).state, 'failure');
  });

  test('a queued PR that edits a workflow without the deep label fails', async () => {
    const gh = fakeGitHub({ files: ['.github/workflows/forge.yml'] });
    await verdictForMergeGroup(gh.api, group, lists);
    assert.equal(verdictOf(gh.written).state, 'failure');
  });
});

describe('main decides, never the PR', () => {
  test('the lists come from the checked-out gate workflow, not the environment', () => {
    const workflow = readFileSync(
      new URL('../workflows/security-gate.yml', import.meta.url),
      'utf8'
    );
    const listed = trustedLists();
    assert.equal(listed.pattern, /^ {2}SECURITY_PATH_PATTERN: '(.+)'$/m.exec(workflow)[1]);
    assert.equal(listed.deepPattern, /^ {2}SECURITY_DEEP_PATH_PATTERN: '(.+)'$/m.exec(workflow)[1]);
    assert.equal(
      listed.botUserId,
      /^ {2}SECURITY_APPROVAL_BOT_USER_ID: '([^']+)'$/m.exec(workflow)[1]
    );
  });

  test('the workflow checks out main or the group base, never base.sha, and runs no PR code', () => {
    const yaml = readFileSync(
      new URL('../workflows/security-review-initialize.yml', import.meta.url),
      'utf8'
    );
    assert.match(
      yaml,
      /^ {2}pull_request_target:\n {4}types: \[opened, synchronize, reopened, edited, labeled, unlabeled\]$/m
    );
    assert.match(yaml, /^ {2}merge_group:$/m);
    assert.doesNotMatch(yaml, /^ {2}pull_request:/m);
    const refs = [...yaml.matchAll(/^\s+ref: (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(refs, ['refs/heads/main', '${{ github.event.merge_group.base_sha }}']);
    // Only PRs into main run it; the queue path is unchanged.
    assert.match(
      yaml,
      /^ {2}pull_request_target:\n {4}types: \[[^\]]+\]\n {4}branches: \[main\]$/m
    );
    assert.doesNotMatch(yaml, /pull_request\.base\.sha/);
    assert.equal([...yaml.matchAll(/persist-credentials: false/g)].length, 2);
    // No PR head anywhere, and no package install: the job runs only the base checkout's node script.
    assert.doesNotMatch(yaml, /pull_request\.head|\bnpm\b|\bpnpm\b/);
    assert.equal(
      [...yaml.matchAll(/run: node \.github\/scripts\/security-verdict\.mjs/g)].length,
      2
    );
  });
});

describe('only a PR into main is judged (Security, 2026-11-02 17:25Z)', () => {
  const into = (ref, sha = 'base') => ({
    pull_request: { number: 1, head: { sha: SHA }, base: { ref, sha } },
  });

  test('a PR aimed at another branch gets failure, "base is not main", and nothing else', async () => {
    const gh = fakeGitHub({ base: 'feat/parent-layer' });
    await verdictForPullRequest(gh.api, into('feat/parent-layer'), lists);
    assert.deepEqual(gh.written, [
      {
        sha: SHA,
        state: 'failure',
        description: 'base is not main (feat/parent-layer); retarget to main to be judged',
      },
    ]);
  });

  test('a PR retargeted away from main after the event is refused the same way', async () => {
    const gh = fakeGitHub({ base: 'feat/parent-layer' });
    await verdictForPullRequest(gh.api, into('main'), lists);
    assert.deepEqual(
      gh.written.map((w) => w.state),
      ['failure']
    );
    assert.match(verdictOf(gh.written).description, /^base is not main \(feat\/parent-layer\)/);
  });

  test('no base at all refuses rather than reading as main', async () => {
    const gh = fakeGitHub();
    await verdictForPullRequest(gh.api, { pull_request: { number: 1, head: { sha: SHA } } }, lists);
    assert.match(verdictOf(gh.written).description, /^base is not main \(unknown\)/);
  });

  test('an old base (like #3425 at 526b745025) still gets a written verdict from current rules', async () => {
    for (const [labels, timeline, state] of [
      [['security-reviewed'], [labelled(LATE)], 'success'],
      [[], [], 'pending'],
    ]) {
      const gh = fakeGitHub({ labels, timeline });
      await verdictForPullRequest(gh.api, into('main', '526b745025'), lists);
      assert.equal(verdictOf(gh.written).sha, SHA);
      assert.equal(verdictOf(gh.written).state, state);
    }
  });
});

/**
 * DOR-4459: on an open PR's head, a state that is only waiting for Security posts
 * `pending`; a state that is wrong still posts `failure`. Each fixture is one
 * PR head; `why` is the description the status must carry.
 */
const WAITING = {
  'no label yet': { labels: [], timeline: [], why: /^no security-reviewed label$/ },
  'hold on, fresh label': {
    labels: ['security-reviewed', 'hold'],
    why: /^the hold label is on$/,
  },
  'hold on, no label': { labels: ['hold'], timeline: [], why: /^the hold label is on$/ },
  'hold on, label older than the last push': {
    labels: ['security-reviewed', 'hold'],
    timeline: [labelled(EARLY)],
    activity: [push(LATE)],
    why: /^the hold label is on$/,
  },
  'P0 path, fresh label, no deep label yet': {
    files: [DEEP],
    why: /^no security-deep-reviewed label$/,
  },
  'P0 path plus a workflow, no deep label yet': {
    files: [DEEP, '.github/workflows/lint.yml'],
    why: /^no security-deep-reviewed label; .*lint\.yml is a workflow$/,
  },
  'a workflow edit, no label yet': {
    files: ['.github/workflows/lint.yml'],
    labels: [],
    timeline: [],
    why: /^no security-reviewed label; .*lint\.yml is a workflow$/,
  },
};

const WRONG = {
  'label older than the last push, no hold': {
    timeline: [labelled(EARLY)],
    activity: [push(LATE)],
    why: /older than the last push/,
  },
  'a label a bot added': {
    timeline: [labelled(LATE, 'security-reviewed', 'Bot')],
    why: /not from a person/,
  },
  'hold on, but a bot added the label': {
    labels: ['security-reviewed', 'hold'],
    timeline: [labelled(LATE, 'security-reviewed', 'Bot')],
    why: /^the hold label is on$/,
  },
  'a label with no labelled event': { timeline: [], why: /no security-reviewed event/ },
  'an unreadable push time (a fork)': { activity: [], why: /cannot read the push time/ },
  'P0 path, deep label older than the last push': {
    files: [DEEP],
    labels: ['security-reviewed', 'security-deep-reviewed'],
    timeline: [labelled(LATE), labelled(EARLY, 'security-deep-reviewed')],
    activity: [push(CHECKED)],
    why: /security-deep-reviewed is older than the last push/,
  },
  'a workflow edit with only security-reviewed': {
    files: ['.github/workflows/lint.yml'],
    why: /security-deep-reviewed.*lint\.yml is a workflow/,
  },
  'a judge-file edit with only security-reviewed': {
    files: ['.github/scripts/security-verdict.mjs'],
    why: /security-verdict\.mjs judges this PR/,
  },
  'a closed PR with no label': { labels: [], timeline: [], state: 'closed', why: /no security/ },
  'a merged PR with no label': {
    labels: [],
    timeline: [],
    state: 'closed',
    mergedAt: LATE,
    why: /no security/,
  },
};

describe('waiting posts pending, wrong posts failure (DOR-4459)', () => {
  for (const [what, { why, ...fixture }] of Object.entries(WAITING)) {
    test(`waiting, ${what}: pending`, async () => {
      const gh = fakeGitHub(fixture);
      await verdictForPullRequest(gh.api, event, lists);
      assert.equal(verdictOf(gh.written).sha, SHA);
      assert.equal(verdictOf(gh.written).state, 'pending');
      assert.match(verdictOf(gh.written).description, why);
      assert.ok(gh.written.every((w) => w.state === 'pending'));
    });
  }
  for (const [what, { why, ...fixture }] of Object.entries(WRONG)) {
    test(`wrong, ${what}: failure`, async () => {
      const gh = fakeGitHub(fixture);
      await verdictForPullRequest(gh.api, event, lists);
      assert.equal(verdictOf(gh.written).state, 'failure');
      assert.match(verdictOf(gh.written).description, why);
    });
  }
});

describe('the merge queue is unchanged by pending (DOR-4459)', () => {
  for (const [what, { why, ...fixture }] of Object.entries(WAITING)) {
    test(`waiting, ${what}: the group SHA still gets failure`, async () => {
      const head = fakeGitHub(fixture);
      await verdictForPullRequest(head.api, event, lists);
      const gh = fakeGitHub(fixture);
      await verdictForMergeGroup(gh.api, group, lists);
      assert.equal(verdictOf(gh.written).sha, 'group1');
      assert.equal(verdictOf(gh.written).state, 'failure');
      // The reason the PR head shows as pending is the reason the group fails.
      assert.match(verdictOf(head.written).description, why);
      const reason = verdictOf(head.written).description.split('; ')[0];
      assert.match(verdictOf(gh.written).description, /^PR #1: /);
      assert.ok(verdictOf(gh.written).description.includes(reason), reason);
    });

    test(`waiting, ${what}: security-gate's queue leg still refuses the pending head`, async () => {
      for (const requiredChecks of [true, false]) {
        const gh = fakeGitHub(fixture);
        // The head carries the pending verdict this change now writes.
        await verdictForPullRequest(gh.api, event, lists);
        assert.equal(verdictOf(gh.written).state, 'pending');
        await assert.rejects(
          checkMergeGroup(gh.api, group, lists.pattern, lists.botUserId, lists.deepPattern, {
            requiredChecks,
          }),
          /no security-review success/
        );
      }
    });
  }

  test('control: the same fake queue passes a fully labelled PR in both legs', async () => {
    const gh = fakeGitHub();
    await verdictForPullRequest(gh.api, event, lists);
    assert.equal(verdictOf(gh.written).state, 'success');
    assert.match(
      await checkMergeGroup(gh.api, group, lists.pattern, lists.botUserId, lists.deepPattern),
      /PR #1: Security status verified/
    );
    await verdictForMergeGroup(gh.api, group, lists);
    assert.equal(verdictOf(gh.written).state, 'success');
  });
});

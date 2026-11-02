/* global URL */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { describe } from 'node:test';
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
const LATE = '2026-11-02T11:00:00Z';
const event = { pull_request: { number: 1, head: { sha: SHA } } };
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
  failOn,
  texts = {},
  statuses = [],
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
        base: { ref: 'main', sha: 'base' },
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

  test('no label is failure, after the initializer pending', async () => {
    const gh = fakeGitHub({ labels: [], timeline: [] });
    await verdictForPullRequest(gh.api, event, lists);
    assert.deepEqual(
      gh.written.map((w) => w.state),
      ['pending', 'failure']
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

  test('hold is failure, even with a fresh label', async () => {
    const gh = fakeGitHub({ labels: ['security-reviewed', 'hold'] });
    await verdictForPullRequest(gh.api, event, lists);
    assert.equal(verdictOf(gh.written).state, 'failure');
  });

  test('a P0 path needs security-deep-reviewed too', async () => {
    const only = fakeGitHub({ files: [DEEP] });
    await verdictForPullRequest(only.api, event, lists);
    assert.equal(verdictOf(only.written).state, 'failure');
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
    assert.equal(verdictOf(gh.written).state, 'failure');
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

  test('the workflow checks out only the base commit, on both events, and runs no PR code', () => {
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
    assert.deepEqual(refs, [
      '${{ github.event.pull_request.base.sha }}',
      '${{ github.event.merge_group.base_sha }}',
    ]);
    assert.equal([...yaml.matchAll(/persist-credentials: false/g)].length, 2);
    // No PR head anywhere, and no package install: the job runs only the base checkout's node script.
    assert.doesNotMatch(yaml, /pull_request\.head|\bnpm\b|\bpnpm\b/);
    assert.equal(
      [...yaml.matchAll(/run: node \.github\/scripts\/security-verdict\.mjs/g)].length,
      2
    );
  });
});

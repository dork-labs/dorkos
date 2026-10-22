/* global URL, structuredClone, Response, process */
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkPullRequest,
  checkMergeGroup,
  groupMembers,
  touchesSecurity,
  latestReview,
  githubApi,
} from './security-gate.mjs';

const workflow = readFileSync(new URL('../workflows/security-gate.yml', import.meta.url), 'utf8');
const initializerWorkflow = readFileSync(
  new URL('../workflows/security-review-initialize.yml', import.meta.url),
  'utf8'
);
const pattern = /^ {2}SECURITY_PATH_PATTERN: '(.*)'$/m.exec(workflow)[1];
const approved = {
  context: 'security-review',
  state: 'success',
  creator: { login: 'security' },
  id: 123,
};
const prEvent = { pull_request: { number: 1, head: { sha: 'head1' } } };
const groupEvent = {
  merge_group: { base_ref: 'refs/heads/main', base_sha: 'base', head_sha: 'group2' },
};
const entries = [
  {
    baseCommit: { oid: 'base' },
    headCommit: { oid: 'group1' },
    pullRequest: { number: 1, headRefOid: 'head1' },
  },
  {
    baseCommit: { oid: 'group1' },
    headCommit: { oid: 'group2' },
    pullRequest: { number: 2, headRefOid: 'head2' },
  },
];
function fixture({ files = ['apps/server/src/http/gate.ts'], statuses = {} } = {}) {
  const comments = [];
  const writes = [];
  const heads = { 1: 'head1', 2: 'head2' };
  const api = {
    pr: async (number) => ({
      head: { sha: heads[number] },
      base: { ref: 'main' },
      changed_files: files.length,
      labels: [{ name: 'security-reviewed' }],
    }),
    files: async () => files.map((filename) => ({ filename })),
    statuses: async (sha) => statuses[sha] ?? [],
    setStatus: async (sha, state, description) => {
      writes.push({ sha, state });
      const review = {
        context: 'security-review',
        state,
        description,
        creator: { login: 'github-actions[bot]' },
        id: 124,
      };
      statuses[sha] = [review];
      return review;
    },
    comments: async (number) => comments.filter((c) => c.number === number),
    comment: async (number, body) => {
      comments.push({ number, body, user: { login: 'github-actions[bot]' } });
    },
    queue: async () => structuredClone(entries),
  };
  return { api, comments, writes, heads, statuses };
}

test('labelled, same approved head: passes without overwriting Security', async () => {
  const { api, writes, comments } = fixture({ statuses: { head1: [approved] } });
  await checkPullRequest(api, prEvent, pattern);
  assert.deepEqual(writes, []);
  assert.deepEqual(comments, []);
});

test('labelled, new push: pending, then fails in the queue despite old success', async () => {
  const f = fixture({ statuses: { oldHead: [approved] } });
  await checkPullRequest(f.api, prEvent, pattern, { write: true, requireApproval: false });
  await assert.rejects(checkPullRequest(f.api, prEvent, pattern), /pending on head1/);
  assert.deepEqual(f.writes, [{ sha: 'head1', state: 'pending' }]);
  await assert.rejects(
    checkMergeGroup(f.api, groupEvent, pattern),
    /no security-review success on head1/
  );
});

test('unlabelled, no security paths: automatically approved', async () => {
  const f = fixture({ files: ['apps/client/src/example.ts'] });
  const pr = f.api.pr;
  f.api.pr = async (n) => ({ ...(await pr(n)), labels: [] });
  await checkPullRequest(f.api, prEvent, pattern, { write: true, requireApproval: false });
  await checkPullRequest(f.api, prEvent, pattern);
  assert.equal(f.statuses.head1[0].description, 'no security paths');
  assert.match(f.comments[0].body, /github-actions\[bot\]/);
});

test('Security approval followed by a rerun clears the PR gate', async () => {
  const f = fixture();
  await checkPullRequest(f.api, prEvent, pattern, { write: true, requireApproval: false });
  await assert.rejects(checkPullRequest(f.api, prEvent, pattern), /pending/);
  f.statuses.head1 = [approved];
  await checkPullRequest(f.api, prEvent, pattern);
  assert.equal(f.writes.length, 1);
});

test('merge_group with a moved head fails even if the old head was approved', async () => {
  const f = fixture({ statuses: { head1: [approved], head2: [approved] } });
  f.heads[1] = 'newHead';
  await assert.rejects(checkMergeGroup(f.api, groupEvent, pattern), /head moved/);
});

test('merge_group with two PRs: one missing status fails', async () => {
  const f = fixture({ statuses: { head1: [approved] } });
  await assert.rejects(
    checkMergeGroup(f.api, groupEvent, pattern),
    /PR #2: no security-review success/
  );
  assert.deepEqual(
    f.comments.map((c) => c.number),
    []
  );
});

test('merge_group with all exact heads approved passes', async () => {
  const f = fixture({ statuses: { head1: [approved], head2: [approved] } });
  await checkMergeGroup(f.api, groupEvent, pattern);
  assert.deepEqual(f.writes, []);
});

test('a push while reading a status fails', async () => {
  const f = fixture({ statuses: { head1: [approved], head2: [approved] } });
  f.api.statuses = async () => {
    f.heads[1] = 'moved';
    return [approved];
  };
  await assert.rejects(checkMergeGroup(f.api, groupEvent, pattern), /head moved/);
});

test('rebuilt/dequeued group fails even if the replacement head is approved', async () => {
  const f = fixture({ statuses: { head1: [approved], head2: [approved] } });
  let reads = 0;
  f.api.queue = async () => (++reads === 1 ? entries : []);
  await assert.rejects(checkMergeGroup(f.api, groupEvent, pattern), /Cannot resolve queued commit/);
});

test('incomplete file listing and stale PR events fail closed', async () => {
  const f = fixture();
  f.api.files = async () => [];
  await assert.rejects(checkPullRequest(f.api, prEvent, pattern), /Incomplete PR file list/);
  f.heads[1] = 'newHead';
  await assert.rejects(checkPullRequest(f.api, prEvent, pattern), /head moved/);
});

test('latest refusal defeats an older success; other contexts grant nothing', () => {
  const refused = { context: 'security-review', state: 'failure' };
  assert.equal(latestReview([refused, approved]), refused);
  assert.equal(latestReview([{ context: 'test', state: 'success' }]), undefined);
});

test('workflow path list covers Security’s complete list and both sides of renames', () => {
  for (const filename of [
    'apps/server/src/services/core/auth/a.ts',
    'apps/server/src/services/core/turn-power/a.ts',
    'apps/server/src/services/core/capabilities/a.ts',
    'apps/server/src/services/core/session-relay/a.ts',
    'apps/server/src/http/a.ts',
    'apps/server/src/routes/a.ts',
    ...['connectors', 'relay', 'extensions', 'mesh', 'browser', 'session/local-browser'].map(
      (p) => `apps/server/src/services/${p}/a.ts`
    ),
    'apps/server/src/db/migrations/a.sql',
    'drizzle/a.sql',
    'packages/shared/src/schemas.ts',
    'packages/cli/src/lib/agent-browser/a.ts',
    '.github/workflows/security-gate.yml',
    '.github/scripts/security-gate.mjs',
    'scripts/release-test.sh',
    'scripts/publish-test.sh',
    'any/turn-ceiling.ts',
    'any/continuation-hold.ts',
    'any/agent-level.ts',
  ]) {
    assert.ok(touchesSecurity([{ filename }], pattern), filename);
    assert.ok(
      touchesSecurity([{ filename: 'docs/moved.md', previous_filename: filename }], pattern),
      `rename: ${filename}`
    );
  }
  assert.equal(touchesSecurity([{ filename: 'packages/shared/src/schemas.tsx' }], pattern), false);
});

test('group resolution rejects empty, missing, cyclic and ambiguous membership', () => {
  assert.throws(() => groupMembers([], groupEvent.merge_group), /Cannot resolve/);
  assert.throws(() => groupMembers(entries, { base_sha: 'base', head_sha: 'base' }), /Empty/);
  assert.throws(
    () => groupMembers([...entries, entries[1]], groupEvent.merge_group),
    /Cannot resolve/
  );
  const cycle = structuredClone(entries);
  cycle[0].baseCommit.oid = 'group2';
  assert.throws(() => groupMembers(cycle, groupEvent.merge_group), /Cycle/);
});

test('GitHub client paginates statuses, files and queue entries; API failures throw', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/graphql')) {
      const { variables } = JSON.parse(options.body);
      return Response.json({
        data: {
          repository: {
            mergeQueue: {
              entries: {
                nodes: [entries[variables.after ? 1 : 0]],
                pageInfo: { hasNextPage: !variables.after, endCursor: 'next' },
              },
            },
          },
        },
      });
    }
    return Response.json(url.includes('page=2') ? [approved] : [], {
      headers: url.includes('page=2') ? {} : { link: `<${url}&page=2>; rel="next"` },
    });
  });
  const api = githubApi('owner/repo', 'fake-test-token');
  assert.deepEqual(await api.statuses('head1'), [approved]);
  assert.deepEqual(await api.files(1), [approved]);
  assert.deepEqual(await api.queue('refs/heads/main'), entries);
  assert.equal(calls.length, 6);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  await assert.rejects(api.statuses('head1'), /GitHub API 403/);
});

test('same SHA with a different base cannot reuse a no-security-paths approval', async () => {
  const automatic = { ...approved, description: 'no security paths' };
  const f = fixture({ statuses: { head1: [automatic], head2: [approved] } });
  await checkPullRequest(f.api, prEvent, pattern, { write: true, requireApproval: false });
  await assert.rejects(checkPullRequest(f.api, prEvent, pattern), /pending/);
  assert.deepEqual(f.writes, [{ sha: 'head1', state: 'pending' }]);
  f.statuses.head1 = [automatic];
  await assert.rejects(checkMergeGroup(f.api, groupEvent, pattern), /no security-review success/);
});

test('fork verifier never writes: an approved sensitive head passes read-only', async () => {
  const f = fixture({ statuses: { head1: [approved] } });
  f.api.setStatus = async () => {
    throw new Error('read-only token');
  };
  f.api.comment = async () => {
    throw new Error('read-only token');
  };
  await checkPullRequest(f.api, prEvent, pattern, { write: false });
});

test('fork verifier cannot manufacture approval, including a reused automatic status', async () => {
  const f = fixture({ statuses: { head1: [{ ...approved, description: 'no security paths' }] } });
  await assert.rejects(checkPullRequest(f.api, prEvent, pattern, { write: false }), /pending/);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.comments, []);
});

test('trusted initializer leaves a sensitive head pending without failing initialization', async () => {
  const f = fixture();
  await checkPullRequest(f.api, prEvent, pattern, { write: true, requireApproval: false });
  assert.deepEqual(f.writes, [{ sha: 'head1', state: 'pending' }]);
});

test('fork verifier passes docs-only status written by trusted initializer', async () => {
  const f = fixture({ files: ['docs/example.mdx'] });
  await checkPullRequest(f.api, prEvent, pattern, { write: true, requireApproval: false });
  await checkPullRequest(f.api, prEvent, pattern, { write: false });
  assert.equal(f.writes.length, 1);
  assert.equal(f.comments.length, 1);
});

test('privileged fork initializer is confined to the base SHA, never the fork head', () => {
  const initializer = initializerWorkflow;
  assert.match(initializer, /^ {2}pull_request_target:/m);
  assert.doesNotMatch(workflow, /^ {2}pull_request_target:/m);
  assert.match(initializer, /ref: \$\{\{ github.event.pull_request.base.sha \}\}/);
  assert.doesNotMatch(initializer, /pull_request.head|npm|pnpm/);
  assert.match(
    initializer,
    /pull_request_target:\n {4}types: \[opened, synchronize, reopened, edited\]/
  );
});

test('docs-only fork verifier can beat initialization without a permanent red check', async () => {
  const f = fixture({ files: ['docs/example.mdx'] });
  f.api.setStatus = async () => {
    throw new Error('read-only token');
  };
  f.api.comment = async () => {
    throw new Error('read-only token');
  };
  await checkPullRequest(f.api, prEvent, pattern, { write: false });
  await assert.rejects(checkMergeGroup(f.api, groupEvent, pattern), /no security-review success/);
});

test('all verifier runs are read-only, including same-repo PRs and merge groups', async () => {
  const f = fixture({ statuses: { head1: [approved], head2: [approved] } });
  f.api.setStatus = f.api.comment = async () => {
    throw new Error('write attempted');
  };
  await checkPullRequest(f.api, prEvent, pattern);
  await checkMergeGroup(f.api, groupEvent, pattern);
  const verifier = workflow.slice(workflow.indexOf('  security-gate:'));
  assert.match(
    verifier,
    /permissions:\n {6}contents: read\n {6}statuses: read\n {6}pull-requests: read/
  );
  assert.doesNotMatch(verifier, /github.sha|: write/);
  assert.match(
    verifier,
    /SECURITY_BASE_SHA: \$\{\{ github.event.pull_request.base.sha \|\| github.event.merge_group.base_sha \}\}/
  );
  assert.match(verifier, /ref: \$\{\{ env.SECURITY_BASE_SHA \}\}/);
  assert.doesNotMatch(verifier, /^ {4}if:/m);
});

test('initializer audits only observed state changes, without rendering target_url', async () => {
  const f = fixture();
  const initialize = () =>
    checkPullRequest(f.api, prEvent, pattern, { write: true, requireApproval: false });
  await initialize();
  await initialize();
  assert.equal(f.comments.length, 1);
  f.statuses.head1 = [{ ...approved, target_url: 'https://untrusted.example/FAKE_APPROVAL' }];
  await initialize();
  await initialize();
  assert.equal(f.comments.length, 2);
  assert.match(f.comments[1].body, /head1.*@security/);
  assert.doesNotMatch(f.comments[1].body, /untrusted|FAKE_APPROVAL/);
});

/** Local model of GitHub selecting main's workflow, followed by base checkout.
 * Hosted rule selection and a real multi-entry queue remain promotion proofs.
 */
test('pinned-main fixture blocks a branch whose workflow and script both exit 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'security-gate-source-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      { cwd: dir, encoding: 'utf8' }
    ).trim();
  git('init', '-b', 'main');
  mkdirSync(join(dir, '.github/scripts'), { recursive: true });
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  const script = '.github/scripts/security-gate.mjs';
  const workflowPath = '.github/workflows/security-gate.yml';
  writeFileSync(join(dir, script), readFileSync(new URL('./security-gate.mjs', import.meta.url)));
  writeFileSync(join(dir, workflowPath), workflow);
  git('add', '.');
  git('commit', '-qm', 'trusted main gate');
  const base = git('rev-parse', 'HEAD');
  git('switch', '-qc', 'candidate-exit-zero');
  writeFileSync(join(dir, script), 'process.exit(0);\n');
  writeFileSync(
    join(dir, workflowPath),
    'name: security-gate\non: [pull_request, merge_group]\njobs:\n  security-gate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n'
  );
  git('add', '.');
  git('commit', '-qm', 'candidate replaces verifier and workflow');
  assert.equal(execFileSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' }), '');
  // The required-workflow rule selects this file from main, not candidate YAML.
  const trustedWorkflow = git('show', `main:${workflowPath}`);
  assert.match(trustedWorkflow, /ref: \$\{\{ env.SECURITY_BASE_SHA \}\}/);
  assert.doesNotMatch(
    trustedWorkflow.slice(trustedWorkflow.indexOf('  security-gate:')),
    /github.sha/
  );
  git('switch', '-q', '--detach', base);

  const writes = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let data;
    if (req.url === '/graphql') {
      assert.doesNotMatch(JSON.parse(body).query, /mutation/);
      data = {
        data: {
          repository: {
            mergeQueue: { entries: { nodes: entries, pageInfo: { hasNextPage: false } } },
          },
        },
      };
    } else if (req.method !== 'GET') {
      writes.push(req.url);
      res.writeHead(403).end();
      return;
    } else if (/\/pulls\/1$/.test(req.url)) {
      data = { head: { sha: 'head1' }, base: { ref: 'main' }, changed_files: 1 };
    } else if (/\/pulls\/1\/files\?/.test(req.url)) {
      data = [{ filename: script }];
    } else if (/\/commits\/head1\/statuses\?/.test(req.url)) {
      data = [{ context: 'security-review', state: 'pending' }];
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const eventPath = join(dir, 'event.json');
  writeFileSync(eventPath, JSON.stringify(groupEvent));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: dir,
      env: {
        GITHUB_REPOSITORY: 'owner/repo',
        GH_TOKEN: 'fixture-read-only',
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_EVENT_PATH: eventPath,
        SECURITY_PATH_PATTERN: pattern,
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /no security-review success on head1/);
  assert.deepEqual(writes, []);
});

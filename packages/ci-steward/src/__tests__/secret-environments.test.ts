/** The secret-environments alarm (DOR-4030): plant each defect; each must turn the day red. */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { replayGh, type Recording } from '../gh.ts';
import { loadHandFiles, type HandFiles } from '../load.ts';
import { checkSecretEnvironments } from '../secret-environments.ts';
import { globalChecks } from '../rulesets.ts';
import { baseSpec, writeRepo } from './fixture.ts';
import { dayRecording } from './gh-fixture.ts';

const SECRETS = 'repos/o/r/actions/secrets?per_page=100&page=1';
const env = (name: string) => `repos/o/r/environments/${name}`;
const policies = (name: string) => `${env(name)}/deployment-branch-policies?per_page=100`;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function files(withEnvironments = true): HandFiles {
  const root = writeRepo(baseSpec());
  dirs.push(root);
  const f = loadHandFiles(root).files!;
  if (withEnvironments) {
    f.config.secret_environments = [
      {
        name: 'release',
        reviewer: true,
        refs: [
          { name: 'v*', type: 'tag' },
          { name: 'release/*', type: 'branch' },
        ],
        secrets: ['CSC_LINK'],
      },
      {
        name: 'automation',
        reviewer: false,
        refs: [{ name: 'main', type: 'branch' }],
        secrets: ['MERGE_TAIL_APP_PRIVATE_KEY'],
      },
    ];
  }
  return f;
}

const httpError = (status: number, text: string) =>
  Object.assign(new Error(`gh: ${text} (HTTP ${status})`), {
    stderr: `gh: ${text} (HTTP ${status})`,
  });

const reviewerRule = {
  type: 'required_reviewers',
  reviewers: [{ type: 'User', reviewer: { login: 'd' } }],
};
const custom = { protected_branches: false, custom_branch_policies: true };

/** A healthy repository: no listed secret at repo level, both environments as configured. */
function healthy(): Recording['rest'] {
  return {
    [SECRETS]: { total_count: 1, secrets: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN' }] },
    [env('release')]: {
      name: 'release',
      protection_rules: [reviewerRule, { type: 'branch_policy' }],
      deployment_branch_policy: custom,
    },
    [policies('release')]: {
      total_count: 2,
      branch_policies: [
        { id: 1, name: 'v*', type: 'tag' },
        { id: 2, name: 'release/*', type: 'branch' },
      ],
    },
    [env('automation')]: {
      name: 'automation',
      protection_rules: [{ type: 'branch_policy' }],
      deployment_branch_policy: custom,
    },
    [policies('automation')]: {
      total_count: 1,
      branch_policies: [{ id: 3, name: 'main', type: 'branch' }],
    },
  };
}

const run = (rest: Recording['rest'], f = files()) =>
  checkSecretEnvironments(replayGh({ rest }), f);

describe('checkSecretEnvironments', () => {
  it('passes when every environment is as configured and no listed secret is at repo level', () => {
    expect(run(healthy())).toEqual({ failures: [], warnings: [] });
  });

  it('checks nothing, and asks nothing, when ci/config.yaml names no environment', () => {
    expect(run({}, files(false))).toEqual({ failures: [], warnings: [] });
  });

  it('goes red when a listed secret is back at repository level, naming only listed names', () => {
    const rest = healthy();
    rest[SECRETS] = {
      total_count: 3,
      secrets: [
        { name: 'CSC_LINK' },
        { name: 'MERGE_TAIL_APP_PRIVATE_KEY' },
        { name: 'CLAUDE_CODE_OAUTH_TOKEN' },
      ],
    };
    const r = run(rest);
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]).toContain('repository level again: CSC_LINK.');
    expect(r.failures[0]).toContain('only in the release environment');
    expect(r.failures[1]).toContain('only in the automation environment');
    expect(r.failures.join(' ')).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('reads every page of repository secrets', () => {
    const rest = healthy();
    const filler = Array.from({ length: 100 }, (_, i) => ({ name: `OTHER_${i}` }));
    rest[SECRETS] = { total_count: 101, secrets: filler };
    rest['repos/o/r/actions/secrets?per_page=100&page=2'] = {
      total_count: 101,
      secrets: [{ name: 'CSC_LINK' }],
    };
    expect(run(rest).failures[0]).toContain('CSC_LINK');
  });

  it('goes red when an environment is gone', () => {
    const rest = healthy();
    rest[env('release')] = httpError(404, 'Not Found');
    expect(run(rest).failures[0]).toContain('The release environment');
    expect(run(rest).failures[0]).toContain('it does not exist');
  });

  it('goes red when a release environment loses its required reviewer', () => {
    const rest = healthy();
    (rest[env('release')] as { protection_rules: unknown[] }).protection_rules = [
      { type: 'branch_policy' },
    ];
    expect(run(rest).failures[0]).toContain('it no longer needs a reviewer');
  });

  it('does not ask for a reviewer where ci/config.yaml says none', () => {
    // automation has no reviewer in healthy(); that alone must not red.
    expect(run(healthy()).failures).toEqual([]);
  });

  it('goes red when an environment deploys from any branch again', () => {
    const rest = healthy();
    (rest[env('release')] as { deployment_branch_policy: unknown }).deployment_branch_policy = null;
    expect(run(rest).failures[0]).toContain('no longer limits deployments to tag v*');
  });

  it('goes red when the v* tag policy is gone, even with a branch v* in its place', () => {
    const rest = healthy();
    rest[policies('release')] = {
      total_count: 2,
      branch_policies: [
        { id: 1, name: 'v*', type: 'branch' },
        { id: 2, name: 'release/*', type: 'branch' },
      ],
    };
    const f = run(rest).failures[0]!;
    expect(f).toContain('it no longer deploys tag v*');
    expect(f).toContain('it also deploys branch v*');
  });

  it('goes red when automation also deploys a merge-queue ref', () => {
    const rest = healthy();
    rest[policies('automation')] = {
      total_count: 2,
      branch_policies: [
        { id: 3, name: 'main', type: 'branch' },
        { id: 4, name: 'gh-readonly-queue/main/*', type: 'branch' },
      ],
    };
    expect(run(rest).failures[0]).toContain(
      'it also deploys branch gh-readonly-queue/main/*, which ci/config.yaml does not allow'
    );
  });

  it('reads a policy with no type as a branch policy', () => {
    const rest = healthy();
    rest[policies('automation')] = { total_count: 1, branch_policies: [{ id: 3, name: 'main' }] };
    expect(run(rest).failures).toEqual([]);
  });

  it('warns, never reds, when the token may not list secrets or read an environment', () => {
    const rest = healthy();
    rest[SECRETS] = httpError(403, 'Resource not accessible by integration');
    rest[env('release')] = httpError(403, 'Resource not accessible by integration');
    const r = run(rest);
    expect(r.failures).toEqual([]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain('Secrets: read');
    expect(r.warnings[1]).toContain('the release environment');
  });

  it('fails closed on a read that went wrong', () => {
    const rest = healthy();
    rest[env('release')] = httpError(500, 'Server Error');
    expect(run(rest).failures[0]).toContain('Secret environments check failed');
  });
});

describe('globalChecks', () => {
  it('carries the alarm into the run-wide failures that mark the day unhealthy', () => {
    const rec = dayRecording();
    Object.assign(rec.rest, healthy());
    rec.rest[SECRETS] = { total_count: 1, secrets: [{ name: 'CSC_LINK' }] };
    const g = globalChecks(replayGh(rec), files());
    expect(g.failures.some((f) => f.includes('repository level again: CSC_LINK'))).toBe(true);
  });
});

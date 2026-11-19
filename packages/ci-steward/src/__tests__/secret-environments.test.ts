/**
 * The secret-environments alarm (DOR-4030): plant each defect; each must turn
 * the day red. A token without Secrets: read skips only the repository-secrets
 * check, as not checked; it is never red and never a pass.
 */
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
        reviewers: ['doriancollier'],
        prevent_self_review: false,
        refs: [{ name: 'main', type: 'branch' }],
        secrets: ['CSC_LINK'],
      },
      {
        name: 'automation',
        reviewers: [],
        prevent_self_review: false,
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

/** The pilot's rule: Dorian alone, "Prevent self-review" off (GitHub sends false). */
const reviewerRule = {
  type: 'required_reviewers',
  prevent_self_review: false,
  reviewers: [{ type: 'User', reviewer: { login: 'DorianCollier' } }],
};
const custom = { protected_branches: false, custom_branch_policies: true };

/** A healthy repository: no listed secret at repo level, both environments as configured. */
function healthy(): Recording['rest'] {
  return {
    [SECRETS]: { total_count: 1, secrets: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN' }] },
    [env('release')]: {
      name: 'release',
      can_admins_bypass: false,
      protection_rules: [reviewerRule, { type: 'branch_policy' }],
      deployment_branch_policy: custom,
    },
    [policies('release')]: {
      total_count: 1,
      branch_policies: [{ id: 2, name: 'main', type: 'branch' }],
    },
    [env('automation')]: {
      name: 'automation',
      can_admins_bypass: false,
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
    expect(run(healthy())).toEqual({ failures: [], notChecked: [] });
  });

  it('checks nothing, and asks nothing, when ci/config.yaml names no environment', () => {
    expect(run({}, files(false))).toEqual({ failures: [], notChecked: [] });
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
    expect(run(rest).failures[0]).toContain('it no longer needs doriancollier to approve');
  });

  it('goes red when the required reviewer is someone other than Dorian', () => {
    const rest = healthy();
    (rest[env('release')] as { protection_rules: unknown[] }).protection_rules = [
      { type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'bot' } }] },
    ];
    expect(run(rest).failures[0]).toContain('it no longer needs doriancollier to approve');
  });

  it('does not count a team reviewer as the named person', () => {
    const rest = healthy();
    (rest[env('release')] as { protection_rules: unknown[] }).protection_rules = [
      {
        type: 'required_reviewers',
        prevent_self_review: false,
        reviewers: [{ type: 'Team', reviewer: { login: 'doriancollier', slug: 'x' } }],
      },
    ];
    const f = run(rest).failures[0]!;
    expect(f).toContain('it no longer needs doriancollier to approve');
    expect(f).toContain('it also lets team x approve');
  });

  it('goes red when someone else may approve as well as the named person', () => {
    const rest = healthy();
    (rest[env('release')] as { protection_rules: unknown[] }).protection_rules = [
      {
        ...reviewerRule,
        reviewers: [...reviewerRule.reviewers, { type: 'User', reviewer: { login: 'agent-bot' } }],
      },
    ];
    const r = run(rest);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain(
      'it also lets agent-bot approve, which ci/config.yaml does not list'
    );
    expect(r.failures[0]).not.toContain('no longer needs');
  });

  it('goes red when Prevent self-review is on but ci/config.yaml says off (the pilot)', () => {
    const rest = healthy();
    (rest[env('release')] as { protection_rules: unknown[] }).protection_rules = [
      { ...reviewerRule, prevent_self_review: true },
    ];
    const f = run(rest).failures;
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('it has Prevent self-review on, which ci/config.yaml says is off');
  });

  it('passes the pilot with Prevent self-review missing (GitHub omits it when off)', () => {
    const rest = healthy();
    (rest[env('release')] as { protection_rules: unknown[] }).protection_rules = [
      { type: reviewerRule.type, reviewers: reviewerRule.reviewers },
    ];
    expect(run(rest).failures).toEqual([]);
  });

  it.each([
    ['is false', false],
    ['is missing', undefined],
  ])(
    'goes red, once DOR-4036 sets it to true in ci/config.yaml, when Prevent self-review %s',
    (_label, value) => {
      const f = files();
      f.config.secret_environments[0]!.prevent_self_review = true;
      const rest = healthy();
      (rest[env('release')] as { protection_rules: unknown[] }).protection_rules = [
        { ...reviewerRule, prevent_self_review: value },
      ];
      expect(run(rest, f).failures[0]).toContain('it lets whoever started a run approve it');
    }
  );

  it('passes once DOR-4036 sets it to true and the environment has it on', () => {
    const f = files();
    f.config.secret_environments[0]!.prevent_self_review = true;
    const rest = healthy();
    (rest[env('release')] as { protection_rules: unknown[] }).protection_rules = [
      { ...reviewerRule, prevent_self_review: true },
    ];
    expect(run(rest, f).failures).toEqual([]);
  });

  it.each([
    ['true', true],
    ['missing (GitHub defaults it to true)', undefined],
  ])('goes red when admin bypass is %s, on every environment', (_label, value) => {
    const rest = healthy();
    (rest[env('automation')] as { can_admins_bypass: unknown }).can_admins_bypass = value;
    const f = run(rest).failures;
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('The automation environment');
    expect(f[0]).toContain('it lets admins bypass its rules');
  });

  it('does not ask for a reviewer where ci/config.yaml says none', () => {
    // automation has no reviewer in healthy(); that alone must not red.
    expect(run(healthy()).failures).toEqual([]);
  });

  it('goes red when an environment ci/config.yaml gives no reviewer gains one', () => {
    const rest = healthy();
    (rest[env('automation')] as { protection_rules: unknown[] }).protection_rules = [
      { type: 'branch_policy' },
      reviewerRule,
    ];
    const f = run(rest).failures;
    expect(f).toHaveLength(1);
    expect(f[0]).toContain('The automation environment');
    expect(f[0]).toContain(
      'it also lets doriancollier approve, which ci/config.yaml does not list'
    );
  });

  it('goes red when an environment deploys from any branch again', () => {
    const rest = healthy();
    (rest[env('release')] as { deployment_branch_policy: unknown }).deployment_branch_policy = null;
    expect(run(rest).failures[0]).toContain('no longer limits deployments to branch main');
  });

  it('goes red when release deploys v* tags again (a tag runs its own copy of the workflow)', () => {
    const rest = healthy();
    rest[policies('release')] = {
      total_count: 2,
      branch_policies: [
        { id: 1, name: 'v*', type: 'tag' },
        { id: 2, name: 'main', type: 'branch' },
      ],
    };
    expect(run(rest).failures[0]).toContain(
      'it also deploys tag v*, which ci/config.yaml does not allow'
    );
  });

  it('goes red when the main policy is a tag named main, not the branch', () => {
    const rest = healthy();
    rest[policies('release')] = {
      total_count: 1,
      branch_policies: [{ id: 2, name: 'main', type: 'tag' }],
    };
    const f = run(rest).failures[0]!;
    expect(f).toContain('it no longer deploys branch main');
    expect(f).toContain('it also deploys tag main');
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

  it('reports repository secrets as not checked, never red or a pass, without Secrets: read', () => {
    const rest = healthy();
    rest[SECRETS] = httpError(403, 'Resource not accessible by integration');
    const r = run(rest);
    expect(r.failures).toEqual([]);
    expect(r.notChecked).toHaveLength(1);
    expect(r.notChecked[0]).toContain('not checked');
    expect(r.notChecked[0]).toContain('CSC_LINK, MERGE_TAIL_APP_PRIVATE_KEY');
    expect(r.notChecked[0]).toContain('Secrets: read');
    expect(r.notChecked[0]).toContain('Security owns this check');
  });

  it('still checks every environment setting when repository secrets are not checked', () => {
    const rest = healthy();
    rest[SECRETS] = httpError(403, 'Resource not accessible by integration');
    const release = rest[env('release')] as Record<string, unknown>;
    release.can_admins_bypass = true;
    release.protection_rules = [
      { ...reviewerRule, reviewers: [{ type: 'User', reviewer: { login: 'agent-bot' } }] },
    ];
    const r = run(rest);
    expect(r.notChecked).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('it lets admins bypass its rules');
    expect(r.failures[0]).toContain('it no longer needs doriancollier to approve');
    expect(r.failures[0]).toContain('it also lets agent-bot approve');
  });

  it('goes red, never passes, when the token may not read an environment', () => {
    const rest = healthy();
    rest[env('release')] = httpError(403, 'Resource not accessible by integration');
    const r = run(rest);
    expect(r.notChecked).toEqual([]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('may not read the release environment');
    expect(r.failures[0]).toContain('nobody checked');
  });

  it('goes red when the token may not read deployment policies', () => {
    const rest = healthy();
    rest[policies('automation')] = httpError(403, 'Resource not accessible by integration');
    const r = run(rest);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('the automation environment');
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

  it('carries a not-checked secrets read as a warning, not a failure', () => {
    const rec = dayRecording();
    Object.assign(rec.rest, healthy());
    rec.rest[SECRETS] = httpError(403, 'Resource not accessible by integration');
    const g = globalChecks(replayGh(rec), files());
    expect(g.failures.some((f) => f.includes('Secret environments'))).toBe(false);
    expect(g.warnings.some((w) => w.includes('not checked') && w.includes('Security'))).toBe(true);
  });
});

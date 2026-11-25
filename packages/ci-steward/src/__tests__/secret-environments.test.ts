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

type Rest = Recording['rest'];
const SECRETS = 'repos/o/r/actions/secrets?per_page=100&page=1';
const env = (name: string) => `repos/o/r/environments/${name}`;
const policies = (name: string) => `${env(name)}/deployment-branch-policies?per_page=100`;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const configured = (name: string, reviewers: string[], secret: string) => ({
  name,
  reviewers,
  prevent_self_review: false,
  refs: [{ name: 'main', type: 'branch' as const }],
  secrets: [secret],
});

/** ci/config.yaml: release needs Dorian's approval, automation needs nobody's. */
function files(withEnvironments = true): HandFiles {
  const root = writeRepo(baseSpec());
  dirs.push(root);
  const f = loadHandFiles(root).files!;
  if (withEnvironments)
    f.config.secret_environments = [
      configured('release', ['doriancollier'], 'CSC_LINK'),
      configured('automation', [], 'MERGE_TAIL_APP_PRIVATE_KEY'),
    ];
  return f;
}

const httpError = (status: number, text: string) =>
  Object.assign(new Error(`gh: ${text} (HTTP ${status})`), {
    stderr: `gh: ${text} (HTTP ${status})`,
  });
const NO_ACCESS = httpError(403, 'Resource not accessible by integration');

/** The pilot's rule: Dorian alone, "Prevent self-review" off (GitHub sends false). */
const reviewerRule = {
  type: 'required_reviewers',
  prevent_self_review: false,
  reviewers: [{ type: 'User', reviewer: { login: 'DorianCollier' } }],
};
const BRANCH_RULE = { type: 'branch_policy' };
const environment = (name: string, rules: unknown[]) => ({
  name,
  can_admins_bypass: false,
  protection_rules: rules,
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
});
/** A deployment-policy list; a ref given without a type is sent with none. */
const refs = (...list: [string, string?][]) => ({
  total_count: list.length,
  branch_policies: list.map(([name, type], id) => (type ? { id, name, type } : { id, name })),
});

/** A healthy repository: no listed secret at repo level, both environments as configured. */
function healthy(): Rest {
  return {
    [SECRETS]: { total_count: 1, secrets: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN' }] },
    [env('release')]: environment('release', [reviewerRule, BRANCH_RULE]),
    [policies('release')]: refs(['main', 'branch']),
    [env('automation')]: environment('automation', [BRANCH_RULE]),
    [policies('automation')]: refs(['main', 'branch']),
  };
}

const answer = (key: string, value: unknown) => (rest: Rest) => {
  rest[key] = value;
};
const setEnv = (name: string, key: string, value: unknown) => (rest: Rest) => {
  (rest[env(name)] as Record<string, unknown>)[key] = value;
};
const releaseRules = (...rules: unknown[]) => setEnv('release', 'protection_rules', rules);
const user = (login: string) => ({ type: 'User', reviewer: { login } });
const NEEDS_DORIAN = /it no longer needs doriancollier to approve/;

const filler = Array.from({ length: 100 }, (_, i) => ({ name: `OTHER_${i}` }));
const secretsOnPage2 = (rest: Rest) => {
  rest[SECRETS] = { total_count: 101, secrets: filler };
  rest[SECRETS.replace(/page=1$/, 'page=2')] = {
    total_count: 101,
    secrets: [{ name: 'CSC_LINK' }],
  };
};

const run = (rest: Rest, f = files()) => checkSecretEnvironments(replayGh({ rest }), f);

describe('checkSecretEnvironments', () => {
  it('checks nothing, and asks nothing, when ci/config.yaml names no environment', () => {
    expect(run({}, files(false))).toEqual({ failures: [], notChecked: [] });
  });

  // Each row edits healthy(): null means it still passes; a red is one
  // failure, for the one environment edited. Repository secrets read fine.
  it.each<[string, (rest: Rest) => void, RegExp | null]>([
    ['gone', answer(env('release'), httpError(404, 'Not Found')), /release .*it does not exist/],
    ['no reviewer', releaseRules(BRANCH_RULE), NEEDS_DORIAN],
    [
      'a team with the named login',
      releaseRules({
        ...reviewerRule,
        reviewers: [{ type: 'Team', reviewer: { login: 'doriancollier', slug: 'x' } }],
      }),
      /it no longer needs doriancollier to approve.*it also lets team x approve/,
    ],
    [
      'a second reviewer',
      releaseRules({ ...reviewerRule, reviewers: [...reviewerRule.reviewers, user('agent-bot')] }),
      /^(?!.*no longer needs).*it also lets agent-bot approve, which ci\/config.yaml does not list/,
    ],
    [
      'a reviewer where ci/config.yaml gives none',
      setEnv('automation', 'protection_rules', [BRANCH_RULE, reviewerRule]),
      /automation .*it also lets doriancollier approve, which ci\/config.yaml does not list/,
    ],
    ['admin bypass', setEnv('automation', 'can_admins_bypass', true), /automation .*bypass/],
    // GitHub's default when the field is missing is true.
    ['admin bypass missing', setEnv('automation', 'can_admins_bypass', undefined), /bypass/],
    [
      'any branch',
      setEnv('release', 'deployment_branch_policy', null),
      /no longer limits deployments to branch main/,
    ],
    [
      // A tag runs its own copy of the workflow.
      'v* tags as well',
      answer(policies('release'), refs(['v*', 'tag'], ['main', 'branch'])),
      /it also deploys tag v\*, which ci\/config.yaml does not allow/,
    ],
    [
      'a tag named main, not the branch',
      answer(policies('release'), refs(['main', 'tag'])),
      /it no longer deploys branch main.*it also deploys tag main/,
    ],
    [
      'a merge-queue ref as well',
      answer(
        policies('automation'),
        refs(['main', 'branch'], ['gh-readonly-queue/main/*', 'branch'])
      ),
      /it also deploys branch gh-readonly-queue\/main\/\*, which ci\/config.yaml does not allow/,
    ],
    ['a listed secret on the second page', secretsOnPage2, /CSC_LINK/],
    ['a policy with no type (a branch)', answer(policies('automation'), refs(['main'])), null],
    [
      'an environment this token may not read (red, never a pass)',
      answer(env('release'), NO_ACCESS),
      /may not read the release environment.*nobody checked/,
    ],
    ['policies it may not read', answer(policies('automation'), NO_ACCESS), /the automation env/],
    [
      'a read that went wrong',
      answer(env('release'), httpError(500, 'Server Error')),
      /check failed/,
    ],
  ])('%s', (_label, edit, want) => {
    const rest = healthy();
    edit(rest);
    const r = run(rest);
    expect(r.notChecked).toEqual([]);
    expect(r.failures).toHaveLength(want ? 1 : 0);
    if (want) expect(r.failures[0]).toMatch(want);
  });

  // GitHub omits prevent_self_review when it is off. DOR-4036 will set it to
  // true in ci/config.yaml. The first row is healthy() itself: automation has
  // no reviewer there, and that alone must not red.
  it.each([
    [false, false, null],
    [undefined, false, null],
    [true, false, 'it has Prevent self-review on, which ci/config.yaml says is off'],
    [false, true, 'it lets whoever started a run approve it'],
    [undefined, true, 'it lets whoever started a run approve it'],
    [true, true, null],
  ])('Prevent self-review %s on GitHub, %s in ci/config.yaml: %s', (onGitHub, inConfig, want) => {
    const f = files();
    f.config.secret_environments[0]!.prevent_self_review = inConfig;
    const rest = healthy();
    releaseRules({ ...reviewerRule, prevent_self_review: onGitHub }, BRANCH_RULE)(rest);
    const r = run(rest, f);
    expect(r.failures).toHaveLength(want ? 1 : 0);
    if (want) expect(r.failures[0]).toContain(want);
  });

  it('goes red when a listed secret is back at repository level, naming only listed names', () => {
    const rest = healthy();
    const names = ['CSC_LINK', 'MERGE_TAIL_APP_PRIVATE_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
    rest[SECRETS] = { total_count: 3, secrets: names.map((name) => ({ name })) };
    const r = run(rest);
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]).toContain('repository level again: CSC_LINK.');
    expect(r.failures[0]).toContain('only in the release environment');
    expect(r.failures[1]).toContain('only in the automation environment');
    expect(r.failures.join(' ')).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('reports repository secrets as not checked, never red or a pass, without Secrets: read', () => {
    const rest = healthy();
    rest[SECRETS] = NO_ACCESS;
    const r = run(rest);
    expect(r.failures).toEqual([]);
    expect(r.notChecked).toHaveLength(1);
    expect(r.notChecked[0]).toMatch(
      /not checked that CSC_LINK, MERGE_TAIL_APP_PRIVATE_KEY .*Secrets: read.*Security owns this check/
    );
  });

  it('still checks every environment setting when repository secrets are not checked', () => {
    const rest = healthy();
    rest[SECRETS] = NO_ACCESS;
    setEnv('release', 'can_admins_bypass', true)(rest);
    releaseRules({ ...reviewerRule, reviewers: [user('agent-bot')] })(rest);
    const r = run(rest);
    expect(r.notChecked).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(
      /it lets admins bypass its rules.*it no longer needs doriancollier to approve.*it also lets agent-bot approve/
    );
  });
});

describe('globalChecks', () => {
  it('carries the alarm into the run-wide failures, and a not-checked read into warnings', () => {
    const red = dayRecording();
    Object.assign(red.rest, healthy(), {
      [SECRETS]: { total_count: 1, secrets: [{ name: 'CSC_LINK' }] },
    });
    const g = globalChecks(replayGh(red), files());
    expect(g.failures.some((f) => f.includes('repository level again: CSC_LINK'))).toBe(true);

    const unread = dayRecording();
    Object.assign(unread.rest, healthy(), { [SECRETS]: NO_ACCESS });
    const w = globalChecks(replayGh(unread), files());
    expect(w.failures.some((f) => f.includes('Secret environments'))).toBe(false);
    expect(w.warnings.some((x) => x.includes('not checked') && x.includes('Security'))).toBe(true);
  });
});

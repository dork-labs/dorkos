/** The release-secrets alarm (DOR-4030): plant each defect; each must turn the day red. */
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { replayGh, type Recording } from '../gh.ts';
import { loadHandFiles, type HandFiles } from '../load.ts';
import { checkReleaseEnvironment } from '../release-environment.ts';
import { globalChecks } from '../rulesets.ts';
import { baseSpec, writeRepo } from './fixture.ts';
import { dayRecording } from './gh-fixture.ts';

const SECRETS = 'repos/o/r/actions/secrets?per_page=100&page=1';
const ENV = 'repos/o/r/environments/release';
const POLICIES = 'repos/o/r/environments/release/deployment-branch-policies?per_page=100';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function files(withEnvironment = true): HandFiles {
  const root = writeRepo(baseSpec());
  dirs.push(root);
  const f = loadHandFiles(root).files!;
  if (withEnvironment) {
    f.config.release_environment = {
      name: 'release',
      tag_pattern: 'v*',
      secrets: ['CSC_LINK', 'HOMEBREW_TAP_TOKEN'],
    };
  }
  return f;
}

const httpError = (status: number, text: string) =>
  Object.assign(new Error(`gh: ${text} (HTTP ${status})`), {
    stderr: `gh: ${text} (HTTP ${status})`,
  });

/** A healthy repository: no release secret at repo level, a protected tag-only environment. */
function healthy(): Recording['rest'] {
  return {
    [SECRETS]: { total_count: 1, secrets: [{ name: 'CI_STEWARD_PUSH_TOKEN' }] },
    [ENV]: {
      name: 'release',
      protection_rules: [
        { type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'd' } }] },
        { type: 'branch_policy' },
      ],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    },
    [POLICIES]: { total_count: 1, branch_policies: [{ id: 1, name: 'v*', type: 'tag' }] },
  };
}

const run = (rest: Recording['rest'], f = files()) =>
  checkReleaseEnvironment(replayGh({ rest }), f);

describe('checkReleaseEnvironment', () => {
  it('passes a protected, tag-only environment with no release secret at repo level', () => {
    expect(run(healthy())).toEqual({ failures: [], warnings: [] });
  });

  it('checks nothing, and asks nothing, when ci/config.yaml names no environment', () => {
    expect(run({}, files(false))).toEqual({ failures: [], warnings: [] });
  });

  it('goes red when a release secret is back at repository level, naming only the names', () => {
    const rest = healthy();
    rest[SECRETS] = {
      total_count: 2,
      secrets: [{ name: 'CSC_LINK' }, { name: 'CI_STEWARD_PUSH_TOKEN' }],
    };
    const r = run(rest);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('repository level again: CSC_LINK.');
    expect(r.failures[0]).not.toContain('CI_STEWARD_PUSH_TOKEN');
  });

  it('reads every page of repository secrets', () => {
    const rest = healthy();
    const filler = Array.from({ length: 100 }, (_, i) => ({ name: `OTHER_${i}` }));
    rest[SECRETS] = { total_count: 101, secrets: filler };
    rest['repos/o/r/actions/secrets?per_page=100&page=2'] = {
      total_count: 101,
      secrets: [{ name: 'HOMEBREW_TAP_TOKEN' }],
    };
    expect(run(rest).failures[0]).toContain('HOMEBREW_TAP_TOKEN');
  });

  it('goes red when the environment is gone', () => {
    const rest = healthy();
    rest[ENV] = httpError(404, 'Not Found');
    expect(run(rest).failures[0]).toContain('it does not exist');
  });

  it('goes red when the environment loses its required reviewer', () => {
    const rest = healthy();
    (rest[ENV] as { protection_rules: unknown[] }).protection_rules = [{ type: 'branch_policy' }];
    expect(run(rest).failures[0]).toContain('it no longer needs a reviewer');
  });

  it('goes red when the environment deploys from any branch again', () => {
    const rest = healthy();
    (rest[ENV] as { deployment_branch_policy: unknown }).deployment_branch_policy = null;
    const r = run(rest);
    expect(r.failures[0]).toContain('no longer limits deployments to tags matching v*');
  });

  it('goes red when the v* tag policy is gone, even with a branch policy in its place', () => {
    const rest = healthy();
    rest[POLICIES] = { total_count: 1, branch_policies: [{ id: 2, name: 'v*', type: 'branch' }] };
    expect(run(rest).failures[0]).toContain('no longer has the v* tag policy');
  });

  it('warns, never reds, when the token may not list secrets or read the environment', () => {
    const rest = healthy();
    rest[SECRETS] = httpError(403, 'Resource not accessible by integration');
    rest[ENV] = httpError(403, 'Resource not accessible by integration');
    const r = run(rest);
    expect(r.failures).toEqual([]);
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain('Secrets: read');
  });

  it('fails closed on a read that went wrong', () => {
    const rest = healthy();
    rest[ENV] = httpError(500, 'Server Error');
    expect(run(rest).failures[0]).toContain('Release secrets check failed');
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

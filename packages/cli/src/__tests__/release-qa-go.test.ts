/**
 * The QA-GO gate the tag and publish steps run themselves (DOR-5050), against a
 * real throwaway git repo, a local bare remote and a made-up QA ledger.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkQaGo,
  lastQaGoRow,
  qaGoLedgerPath,
  QA_GO_LEDGER_ENV,
} from '../../scripts/release-gate/qa-go.js';
import { releaseTag } from '../../scripts/release-gate/release-tag.js';
import { releaseDispatch } from '../../scripts/release-gate/release-dispatch.js';
import { checkPackagePublish, publishPackage } from '../../scripts/release-gate/publish-package.js';

let root = '';
let repo = '';
let remote = '';
let qa = '';
let ledger = '';
let release = '';
let sameTree = '';
let other = '';
const env = {
  PATH: process.env.PATH ?? '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...env, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
const HEADER =
  '| time | version | SHA | tree | verdict | scope | rows file | by |\n|---|---|---|---|---|---|---|---|\n';
const row = (version: string, sha: string, verdict: string, rows = 'evidence/rel/summary.txt') =>
  `| 2026-11-22T10:00Z | ${version} | ${sha} | t | ${verdict} | rows | ${rows} | QA |\n`;
const writeLedger = (...rows: string[]) =>
  writeFile(ledger, '# ledger\n\n' + HEADER + rows.join(''));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'release-qa-go-'));
  // The scripts run git with the process's own environment: seal it off from this machine's
  // git config (a global tag.gpgSign, a session's GIT_CONFIG_*) and give its tags an author.
  for (const [key, value] of Object.entries(env)) if (key !== 'PATH') vi.stubEnv(key, value);
  vi.stubEnv('HOME', root);
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_COUNT', '0');
  repo = join(root, 'repo');
  remote = join(root, 'remote.git');
  qa = join(root, 'qa');
  ledger = join(qa, 'evidence', 'GO-LEDGER.md');
  await mkdir(join(qa, 'evidence', 'rel'), { recursive: true });
  await writeFile(join(qa, 'evidence', 'rel', 'summary.txt'), 'all rows PASS\n');
  await mkdir(repo);
  execFileSync('git', ['init', '-q', '--bare', remote], {
    env: { ...env, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', remote);
  await writeFile(join(repo, 'VERSION'), '1.2.3\n');
  await writeFile(join(repo, 'app.ts'), 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore(release): v1.2.3');
  release = git('rev-parse', 'HEAD');
  // A different commit with the same tree: what a squash of QA's exact pin looks like.
  sameTree = git('commit-tree', `${release}^{tree}`, '-m', 'same tree, other commit');
  await writeFile(join(repo, 'app.ts'), 'export const a = 2;\n');
  git('commit', '-q', '-am', 'fix: after the GO');
  other = git('rev-parse', 'HEAD');
  git('reset', '-q', '--hard', release);
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('checkQaGo', () => {
  it('passes a GO for the exact SHA, and for another commit with the same tree', async () => {
    await writeLedger(row('1.2.3', release, '**GO**'));
    expect(checkQaGo({ ledgerPath: ledger, version: '1.2.3', target: release, cwd: repo })).toMatch(
      `PASS: ${release}`
    );
    expect(
      checkQaGo({ ledgerPath: ledger, version: '1.2.3', target: sameTree, cwd: repo })
    ).toMatch('PASS');
  });

  it('refuses a commit with no GO row, naming the version and the SHA', async () => {
    await writeLedger(row('1.2.2', release, 'GO'));
    expect(() =>
      checkQaGo({ ledgerPath: ledger, version: '1.2.3', target: release, cwd: repo })
    ).toThrow(`No QA GO for 1.2.3 at ${release}: the QA ledger has no row for this version`);
  });

  it('refuses a GO for a different tree', async () => {
    await writeLedger(row('1.2.3', release, 'GO'));
    expect(() =>
      checkQaGo({ ledgerPath: ledger, version: '1.2.3', target: other, cwd: repo })
    ).toThrow(`No QA GO for 1.2.3 at ${other}: its tree is not the tree QA said GO on`);
  });

  it.each([
    [
      'a later NO-GO row',
      () => [row('1.2.3', release, 'GO'), row('1.2.3', release, '**NO-GO**')],
      'its verdict is not GO',
    ],
    [
      'a GO only reported',
      () => [row('1.2.3', release, 'GO as reported by Security')],
      'says "reported"',
    ],
    ['a pending row', () => [row('1.2.3', release, 'GO, PENDING rows')], 'says "PENDING"'],
    [
      'a row with no full SHA',
      () => [row('1.2.3', release.slice(0, 10), 'GO')],
      'no full 40-hex SHA',
    ],
    [
      'a rows file that does not exist',
      () => [row('1.2.3', release, 'GO', 'evidence/missing.txt')],
      'no rows file that exists',
    ],
    [
      'a row naming no rows file',
      () => [row('1.2.3', release, 'GO', '(unknown)')],
      'no rows file that exists',
    ],
    [
      'a rows path that climbs out',
      () => [row('1.2.3', release, 'GO', 'evidence/../../repo/VERSION')],
      'no rows file that exists',
    ],
    [
      'a later short row',
      () => [row('1.2.3', release, 'GO'), '| 2026-11-22T11:00Z | 1.2.3 (retest) |\n'],
      'its verdict is not GO',
    ],
    // Rows are built per case: `release` is only known once beforeAll has run.
  ])('refuses %s, saying why', async (_label, rows, why) => {
    await writeLedger(...rows());
    expect(() =>
      checkQaGo({ ledgerPath: ledger, version: '1.2.3', target: release, cwd: repo })
    ).toThrow(new RegExp(`^No QA GO for 1\\.2\\.3 at ${release}: .*${why.replace(/"/g, '"')}`));
  });

  it("refuses a ledger that is not QA's GO-LEDGER.md in an evidence folder", async () => {
    const stray = join(qa, 'evidence', 'other.md');
    await writeFile(stray, HEADER + row('1.2.3', release, 'GO'));
    expect(() =>
      checkQaGo({ ledgerPath: stray, version: '1.2.3', target: release, cwd: repo })
    ).toThrow('is not a QA ledger');
  });

  it('refuses a missing, unreadable or empty ledger', async () => {
    for (const ledgerPath of [join(qa, 'nowhere.md'), join(qa, 'evidence')]) {
      expect(() => checkQaGo({ ledgerPath, version: '1.2.3', target: release, cwd: repo })).toThrow(
        'cannot be read'
      );
    }
    await writeFile(ledger, '');
    expect(() =>
      checkQaGo({ ledgerPath: ledger, version: '1.2.3', target: release, cwd: repo })
    ).toThrow('no row for this version');
  });

  it('matches a version cell with a note after it, but not a longer version', () => {
    const text = HEADER + row('1.2.3 (candidate)', release, 'GO') + row('1.2.30', other, 'GO');
    expect(lastQaGoRow(text, '1.2.3')?.sha).toBe(release);
  });
});

describe('qaGoLedgerPath', () => {
  it('needs a ledger named by the flag or the environment, never a default', () => {
    expect(() => qaGoLedgerPath(undefined, {})).toThrow('No QA GO ledger was named');
    expect(qaGoLedgerPath(undefined, { [QA_GO_LEDGER_ENV]: '/env/ledger.md' })).toBe(
      '/env/ledger.md'
    );
    expect(qaGoLedgerPath('/flag/ledger.md', { [QA_GO_LEDGER_ENV]: '/env/ledger.md' })).toBe(
      '/flag/ledger.md'
    );
  });
});

describe('release:tag', () => {
  it('never moves an existing tag', async () => {
    await writeLedger(row('1.2.3', release, 'GO'));
    git('tag', '-a', 'v1.2.3', '-m', 'Release v1.2.3', other);
    expect(() =>
      releaseTag({ version: '1.2.3', sha: release, ledgerPath: ledger, cwd: repo })
    ).toThrow('v1.2.3 already exists here. Never move a release tag.');
    expect(git('rev-parse', 'v1.2.3^{commit}')).toBe(other);
    git('tag', '-d', 'v1.2.3');
  });

  it('removes the local tag when the push is refused, so a retry can run', async () => {
    await writeLedger(row('1.2.3', release, 'GO'));
    const hook = join(remote, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    try {
      expect(() =>
        releaseTag({ version: '1.2.3', sha: release, ledgerPath: ledger, cwd: repo })
      ).toThrow();
      expect(git('tag', '--list', 'v1.2.3')).toBe('');
    } finally {
      await rm(hook);
    }
  });

  beforeEach(() => {
    if (git('tag', '--list', 'v1.2.3')) git('tag', '-d', 'v1.2.3');
    if (git('ls-remote', '--tags', 'origin', 'refs/tags/v1.2.3'))
      git('push', '-q', 'origin', ':refs/tags/v1.2.3');
  });

  it('tags and pushes nothing without a GO for the commit', async () => {
    await writeLedger(row('1.2.3', other, 'GO'));
    expect(() =>
      releaseTag({ version: '1.2.3', sha: release, ledgerPath: ledger, cwd: repo })
    ).toThrow(`No QA GO for 1.2.3 at ${release}`);
    expect(git('tag', '--list', 'v1.2.3')).toBe('');
    expect(git('ls-remote', '--tags', 'origin')).toBe('');
  });

  it('tags the exact commit and pushes the tag once QA said GO', async () => {
    await writeLedger(row('1.2.3', release, 'GO'));
    const lines = releaseTag({ version: '1.2.3', sha: release, ledgerPath: ledger, cwd: repo });
    expect(lines[0]).toMatch('PASS');
    expect(git('rev-parse', 'v1.2.3^{commit}')).toBe(release);
    expect(git('ls-remote', '--tags', 'origin', 'refs/tags/v1.2.3')).toMatch('refs/tags/v1.2.3');
    expect(() =>
      releaseTag({ version: '1.2.3', sha: release, ledgerPath: ledger, cwd: repo })
    ).toThrow('already exists');
  });

  it('refuses a commit whose VERSION is another version', async () => {
    await writeLedger(row('1.2.4', release, 'GO'));
    expect(() =>
      releaseTag({ version: '1.2.4', sha: release, ledgerPath: ledger, cwd: repo })
    ).toThrow('is version 1.2.3, not 1.2.4');
  });
});

describe('release:dispatch', () => {
  it('starts Release Publish only after a GO for the exact expected tip', async () => {
    const gh = vi.fn();
    await writeLedger(row('1.2.3', release, 'GO'));
    expect(() =>
      releaseDispatch(
        { version: '1.2.3', expectedSha: other, base: release, ledgerPath: ledger, cwd: repo },
        gh
      )
    ).toThrow(`No QA GO for 1.2.3 at ${other}`);
    expect(gh).not.toHaveBeenCalled();
    releaseDispatch(
      { version: '1.2.3', expectedSha: release, base: release, ledgerPath: ledger, cwd: repo },
      gh
    );
    expect(gh).toHaveBeenCalledWith(
      expect.arrayContaining(['release-publish.yml', `expected_sha=${release}`, 'mode=routine'])
    );
  });
});

describe('the publish:cli gate', () => {
  it('runs in releaseCLI before anything is fetched, built or published', async () => {
    const source = await readFile(new URL('../../scripts/release-cli.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export async function releaseCLI('));
    const gate = body.indexOf('checkQaGo({');
    expect(gate, 'publish:cli runs the QA-GO gate').toBeGreaterThan(0);
    expect(body.slice(body.lastIndexOf('if (publish)', gate), gate)).toMatch(/^if \(publish\)/);
    expect(gate, 'before the merge proof and any gh call').toBeLessThan(
      body.indexOf('proveMerged();')
    );
  });
});

describe('publish of the other release packages', () => {
  it('runs pnpm publish only after the gate passes', async () => {
    const pnpm = vi.fn();
    await writeLedger(row('1.2.3', release, 'NO-GO'));
    git('tag', '-f', 'v1.2.3', release);
    expect(() => publishPackage('@dork-labs/cloud-api', ledger, repo, pnpm)).toThrow(
      `No QA GO for 1.2.3 at ${release}`
    );
    expect(pnpm).not.toHaveBeenCalled();
    await writeLedger(row('1.2.3', release, 'GO'));
    await writeFile(join(repo, 'stray.txt'), 'not in the tag\n');
    expect(() => publishPackage('@dork-labs/cloud-api', ledger, repo, pnpm)).toThrow('has changes');
    await rm(join(repo, 'stray.txt'));
    publishPackage('@dork-labs/cloud-api', ledger, repo, pnpm);
    expect(pnpm).toHaveBeenCalledWith(['publish', '--filter=@dork-labs/cloud-api']);
    git('tag', '-d', 'v1.2.3');
  });

  it('publishes only from the GO tag', async () => {
    await writeLedger(row('1.2.3', release, 'GO'));
    expect(() => checkPackagePublish('@dork-labs/cloud-api', ledger, repo)).toThrow(
      'v1.2.3 is not tagged here'
    );
    git('tag', '-f', 'v1.2.3', other);
    expect(() => checkPackagePublish('@dork-labs/cloud-api', ledger, repo)).toThrow(
      `HEAD ${release} is not v1.2.3`
    );
    git('tag', '-f', 'v1.2.3', release);
    expect(checkPackagePublish('@dork-labs/cloud-api', ledger, repo)).toMatch('PASS');
    await writeLedger(row('1.2.3', release, 'NO-GO'));
    expect(() => checkPackagePublish('@dork-labs/connector-providers', ledger, repo)).toThrow(
      `No QA GO for 1.2.3 at ${release}`
    );
    expect(() => checkPackagePublish('left-pad', ledger, repo)).toThrow('is not one of');
    git('tag', '-d', 'v1.2.3');
  });
});

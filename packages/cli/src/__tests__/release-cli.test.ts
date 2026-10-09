import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  assertCLIReleaseBinding,
  assertCLIMergedRelease,
  assertCLIUnselectedVMRelease,
} from '../../scripts/release-cli.js';
const commit = 'a'.repeat(40);
it.each(['version', 'tag', 'commit'] as const)(
  'refuses release %s mismatch before original producer or publication',
  (kind) => {
    expect(() =>
      assertCLIReleaseBinding(
        '1.2.3',
        kind === 'version' ? '1.2.4' : '1.2.3',
        kind === 'commit' ? 'unknown' : commit,
        kind === 'tag' ? 'b'.repeat(40) : commit
      )
    ).toThrow('exact merged version tag');
  }
);
const comparisonUrl = (head: string, main: string) =>
  `https://api.github.com/repos/dork-labs/dorkos/compare/${head}...${main}`;
const comparison = (head: string, main: string) => ({
  url: comparisonUrl(head, main),
  status: main === head ? 'identical' : 'ahead',
  ahead_by: main === head ? 0 : 3,
  behind_by: 0,
  total_commits: main === head ? 0 : 3,
  base_commit: { sha: head },
  merge_base_commit: { sha: head },
});
it.each(['ahead', 'identical'] as const)(
  'accepts the real GitHub %s response shape without an invented head_commit field',
  (status) => {
    const main = status === 'identical' ? commit : 'b'.repeat(40);
    expect(() =>
      assertCLIMergedRelease(commit, main, comparisonUrl(commit, main), comparison(commit, main))
    ).not.toThrow();
  }
);
it.each([
  'unmerged-tag',
  'changed-main',
  'changed-base',
  'diverged',
  'behind',
  'counter-mismatch',
] as const)('refuses %s remote ancestry despite a clean local release tag', (kind) => {
  const main = 'b'.repeat(40);
  const value = comparison(commit, main);
  if (kind === 'unmerged-tag') value.merge_base_commit.sha = 'e'.repeat(40);
  if (kind === 'changed-main') value.url = comparisonUrl(commit, 'd'.repeat(40));
  if (kind === 'changed-base') value.base_commit.sha = 'c'.repeat(40);
  if (kind === 'diverged') value.status = 'diverged';
  if (kind === 'behind') value.behind_by = 1;
  if (kind === 'counter-mismatch') value.total_commits = 4;
  expect(() => assertCLIMergedRelease(commit, main, comparisonUrl(commit, main), value)).toThrow(
    'not proven merged'
  );
});

// Captured read-only original GitHub API projection; no nonexistent head_commit field.
it('accepts the independently captured SHA-pinned repository comparison projection', () => {
  const value = {
    ahead_by: 3,
    base_commit: { sha: '38809285b668440c6fdb3d5744c5f0f75e17504c' },
    behind_by: 0,
    merge_base_commit: { sha: '38809285b668440c6fdb3d5744c5f0f75e17504c' },
    status: 'ahead',
    total_commits: 3,
    url: 'https://api.github.com/repos/dork-labs/dorkos/compare/38809285b668440c6fdb3d5744c5f0f75e17504c...aaae7418bf704cc331b5dba2ed8d3c794ef829b7',
  };
  expect(() =>
    assertCLIMergedRelease(
      '38809285b668440c6fdb3d5744c5f0f75e17504c',
      'aaae7418bf704cc331b5dba2ed8d3c794ef829b7',
      'https://api.github.com/repos/dork-labs/dorkos/compare/38809285b668440c6fdb3d5744c5f0f75e17504c...aaae7418bf704cc331b5dba2ed8d3c794ef829b7',
      value
    )
  ).not.toThrow();
});

it('the fixed release selection remains empty and unavailable', async () => {
  const path = fileURLToPath(
    new URL('../../../../scripts/browser-vm-release.json', import.meta.url)
  );
  const selection: unknown = JSON.parse(await readFile(path, 'utf8'));
  expect(() => assertCLIUnselectedVMRelease(selection)).not.toThrow();
});
it.each([
  null,
  {},
  { v: 1, release: {} },
  { v: 1, release: null, accepted: true },
  { v: 2, release: null },
  { v: 1, release: { directory: 'candidate', manifestSHA256: 'a'.repeat(64) } },
])(
  'does not promote a copied or future candidate release into publisher qualification',
  (value) => {
    expect(() => assertCLIUnselectedVMRelease(value)).toThrow('not qualified');
  }
);
it('release entry no longer dispatches or consumes the retired observer workflow', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../scripts/release-cli.ts', import.meta.url)),
    'utf8'
  );
  for (const retired of [
    'workflow_dispatch',
    'browser-native-release-artifact.yml',
    'browser-darwin-arm64-',
    'DORKOS_BROWSER_DARWIN_ARTIFACT_DIRECTORY',
    'DORKOS_BROWSER_DARWIN_ARTIFACT_SHA256',
  ])
    expect(source).not.toContain(retired);
  expect(source).toContain("['publish', '--filter=dorkos']");
  expect(source).toContain("['--filter', 'dorkos', 'build']");
});

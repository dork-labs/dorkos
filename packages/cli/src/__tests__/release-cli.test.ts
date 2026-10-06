import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import {
  assertBrowserNativeArtifactAttestation,
  assertBrowserNativeMergedRelease,
  assertBrowserNativeReleaseBinding,
  selectBrowserNativeArtifactRun,
  retainBrowserNativeDispatch,
  discoverBrowserNativeProducer,
} from '../../scripts/release-cli.js';
const commit = 'a'.repeat(40);
it('selects only a completed successful producer from the exact merged release commit', () => {
  expect(
    selectBrowserNativeArtifactRun(
      [
        { databaseId: 1, headSha: commit, status: 'completed', conclusion: 'success' },
        { databaseId: 9, headSha: 'b'.repeat(40), status: 'completed', conclusion: 'success' },
        { databaseId: 8, headSha: commit, status: 'in_progress', conclusion: 'success' },
        { databaseId: 7, headSha: commit, status: 'completed', conclusion: 'failure' },
      ],
      commit
    )
  ).toBe(1);
  expect(() => selectBrowserNativeArtifactRun([], commit)).toThrow('exact release commit');
});
it.each(['version', 'tag', 'commit'] as const)(
  'refuses release %s mismatch before original producer or publication',
  (kind) => {
    expect(() =>
      assertBrowserNativeReleaseBinding(
        '1.2.3',
        kind === 'version' ? '1.2.4' : '1.2.3',
        kind === 'commit' ? 'unknown' : commit,
        kind === 'tag' ? 'b'.repeat(40) : commit
      )
    ).toThrow('exact merged version tag');
  }
);
it('requires actual successful gh verification output to correlate the exact originally read manifest hash', () => {
  const pin = 'a'.repeat(64);
  expect(() =>
    assertBrowserNativeArtifactAttestation(
      [{ verificationResult: { statement: { subject: [{ digest: { sha256: pin } }] } } }],
      pin
    )
  ).not.toThrow();
  expect(() =>
    assertBrowserNativeArtifactAttestation(
      [
        {
          verificationResult: { statement: { subject: [{ digest: { sha256: 'b'.repeat(64) } }] } },
        },
      ],
      pin
    )
  ).toThrow('did not match');
  expect(() => assertBrowserNativeArtifactAttestation([], pin)).toThrow('unavailable');
});

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
      assertBrowserNativeMergedRelease(
        commit,
        main,
        comparisonUrl(commit, main),
        comparison(commit, main)
      )
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
  expect(() =>
    assertBrowserNativeMergedRelease(commit, main, comparisonUrl(commit, main), value)
  ).toThrow('not proven merged');
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
    assertBrowserNativeMergedRelease(
      '38809285b668440c6fdb3d5744c5f0f75e17504c',
      'aaae7418bf704cc331b5dba2ed8d3c794ef829b7',
      'https://api.github.com/repos/dork-labs/dorkos/compare/38809285b668440c6fdb3d5744c5f0f75e17504c...aaae7418bf704cc331b5dba2ed8d3c794ef829b7',
      value
    )
  ).not.toThrow();
});

const dispatchBinding = {
  head: commit,
  tag: 'v1.2.3',
  repository: 'dork-labs/dorkos',
  workflow: 'browser-native-release-artifact.yml',
};
async function dispatchFixture() {
  const home = await mkdtemp(join(tmpdir(), 'native-dispatch-retry-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  return { home, marker: join(home, 'dispatch.json') };
}
it('resumes original discovery after ambiguous dispatch failure without entering a second dispatch', async () => {
  const f = await dispatchFixture();
  const failure = new Error('transport failed after possible acceptance');
  let calls = 0;
  await expect(
    retainBrowserNativeDispatch(f.marker, dispatchBinding, () => {
      calls++;
      throw failure;
    })
  ).rejects.toMatchObject({ cause: failure });
  const original = await readFile(f.marker, 'utf8');
  await expect(
    retainBrowserNativeDispatch(f.marker, dispatchBinding, () => {
      calls++;
    })
  ).resolves.toBe('retained');
  expect(calls).toBe(1);
  expect(await readFile(f.marker, 'utf8')).toBe(original);
});
it('retains a successful original dispatch across delayed Actions discovery', async () => {
  const f = await dispatchFixture();
  let calls = 0;
  await expect(
    retainBrowserNativeDispatch(f.marker, dispatchBinding, () => {
      calls++;
    })
  ).resolves.toBe('entered');
  await expect(
    retainBrowserNativeDispatch(f.marker, dispatchBinding, () => {
      calls++;
    })
  ).resolves.toBe('retained');
  expect(calls).toBe(1);
});
it.each(['foreign', 'malformed', 'oversize', 'symlink'] as const)(
  'refuses %s retained dispatch without acquiring another producer',
  async (kind) => {
    const f = await dispatchFixture();
    if (kind === 'symlink') {
      const target = join(f.home, 'target.json');
      await writeFile(target, '{}');
      await symlink(target, f.marker);
    } else
      await writeFile(
        f.marker,
        kind === 'foreign'
          ? JSON.stringify({
              version: 1,
              ...dispatchBinding,
              head: 'b'.repeat(40),
              status: 'original-dispatch-entering',
            })
          : kind === 'oversize'
            ? 'x'.repeat(4097)
            : '{'
      );
    let calls = 0;
    await expect(
      retainBrowserNativeDispatch(f.marker, dispatchBinding, () => {
        calls++;
      })
    ).rejects.toBeDefined();
    expect(calls).toBe(0);
  }
);

it('retries discovery after delayed Actions visibility using the same original dispatch record', async () => {
  const f = await dispatchFixture();
  let dispatches = 0;
  let visible = false;
  let waits = 0;
  const run = { databaseId: 42, headSha: commit, status: 'completed', conclusion: 'success' };
  const originals = {
    list: () => (visible ? [run] : []),
    admit: () => {},
    dispatch: () => {
      dispatches++;
    },
    wait: async () => {
      waits++;
    },
  };
  await expect(discoverBrowserNativeProducer(f.marker, dispatchBinding, originals)).rejects.toThrow(
    'resume Actions discovery'
  );
  expect(waits).toBe(30);
  const bytes = await readFile(f.marker, 'utf8');
  originals.wait = async () => {
    visible = true;
  };
  await expect(
    discoverBrowserNativeProducer(f.marker, dispatchBinding, originals)
  ).resolves.toEqual([run]);
  expect(dispatches).toBe(1);
  expect(await readFile(f.marker, 'utf8')).toBe(bytes);
});
it('known admission refusal reserves no dispatch and cannot prevent a later admitted original', async () => {
  const f = await dispatchFixture();
  let calls = 0;
  const failure = new Error('actual main ancestry unavailable');
  await expect(
    discoverBrowserNativeProducer(f.marker, dispatchBinding, {
      list: () => [],
      admit: () => {
        throw failure;
      },
      dispatch: () => {
        calls++;
      },
      wait: async () => {},
    })
  ).rejects.toBe(failure);
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  let visible = false;
  const run = { databaseId: 2, headSha: commit, status: 'completed', conclusion: 'success' };
  await expect(
    discoverBrowserNativeProducer(f.marker, dispatchBinding, {
      list: () => (visible ? [run] : []),
      admit: () => {},
      dispatch: () => {
        calls++;
      },
      wait: async () => {
        visible = true;
      },
    })
  ).resolves.toEqual([run]);
  expect(calls).toBe(1);
});

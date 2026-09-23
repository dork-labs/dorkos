/**
 * The git source resolver hands every git form to one fetch, with the clone
 * URL, ref and subpath `sourceKeyOf` computes, so what is fetched is exactly
 * what an install records and the update check looks up (DOR-2248).
 */
import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { resolvePluginSource, sourceKeyOf, type PluginSource } from '@dorkos/marketplace';
import { gitResolver } from '../git.js';
import type { FetcherDeps } from '../../package-fetcher.js';

const SHA = 'c'.repeat(40);

function deps(): FetcherDeps & { fetchGitTree: ReturnType<typeof vi.fn> } {
  return {
    fetchGitTree: vi
      .fn()
      .mockResolvedValue({ path: '/cache/trees/pkg@x', commitSha: SHA, fromCache: false }),
  };
}

/** Resolve a plugin source the way `PackageFetcher.fetchPackage` does. */
function resolved(source: PluginSource) {
  const r = resolvePluginSource(source, {});
  if (r.type !== 'github' && r.type !== 'url' && r.type !== 'git-subdir') throw new Error(r.type);
  return r;
}

describe('gitResolver', () => {
  it.each<[string, PluginSource]>([
    ['github with no ref', { source: 'github', repo: 'o/r' }],
    ['github with a ref', { source: 'github', repo: 'o/r', ref: 'develop' }],
    ['github pinned to a sha', { source: 'github', repo: 'o/r', ref: 'develop', sha: SHA }],
    ['url with a tag', { source: 'url', url: 'https://gitlab.com/o/r.git', ref: 'v1.2.0' }],
    [
      'git-subdir',
      { source: 'git-subdir', url: 'https://github.com/o/mono.git', path: 'plugins/p' },
    ],
  ])('fetches %s at the key sourceKeyOf computes', async (_label, source) => {
    // Purpose: whole-repo forms used to drop the ref; every form must now
    // fetch the key's ref (and a pin must beat a ref).
    const d = deps();
    const r = resolved(source);
    await gitResolver(r, { packageName: 'pkg', force: true }, d);

    const key = sourceKeyOf(r);
    expect(d.fetchGitTree).toHaveBeenCalledWith({
      packageName: 'pkg',
      cloneUrl: key.cloneUrl,
      ref: key.ref,
      subpath: key.subpath,
      force: true,
    });
  });

  it('returns the package directory inside a git-subdir entry', async () => {
    // Purpose: a sparse entry holds the repository root; the package is below it.
    const d = deps();
    const r = resolved({
      source: 'git-subdir',
      url: 'https://github.com/o/mono.git',
      path: 'plugins/p',
    });
    const result = await gitResolver(r, { packageName: 'pkg' }, d);
    expect(result).toEqual({
      path: path.join('/cache/trees/pkg@x', 'plugins/p'),
      commitSha: SHA,
      fromCache: false,
    });
  });

  it('returns the entry itself for a whole-repo source', async () => {
    const d = deps();
    const result = await gitResolver(
      resolved({ source: 'github', repo: 'o/r' }),
      { packageName: 'pkg' },
      d
    );
    expect(result.path).toBe('/cache/trees/pkg@x');
  });
});

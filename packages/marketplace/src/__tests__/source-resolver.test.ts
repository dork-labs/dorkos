import { describe, it, expect } from 'vitest';
import { resolvePluginSource, ResolvePluginSourceError, sourceKeyOf } from '../source-resolver.js';

describe('resolvePluginSource — relative-path source', () => {
  it('prepends pluginRoot to a bare name', () => {
    const result = resolvePluginSource('code-reviewer', {
      marketplaceRoot: '/mp',
      pluginRoot: './plugins',
    });
    expect(result).toEqual({
      type: 'relative-path',
      path: 'plugins/code-reviewer',
      marketplaceRoot: '/mp',
    });
  });

  it('ignores pluginRoot when source already starts with ./', () => {
    const result = resolvePluginSource('./code-reviewer', {
      marketplaceRoot: '/mp',
      pluginRoot: './plugins',
    });
    expect(result).toEqual({
      type: 'relative-path',
      path: 'code-reviewer',
      marketplaceRoot: '/mp',
    });
  });

  it('normalizes trailing slash on pluginRoot', () => {
    const result = resolvePluginSource('foo', {
      marketplaceRoot: '/mp',
      pluginRoot: './plugins/',
    });
    expect(result).toEqual({
      type: 'relative-path',
      path: 'plugins/foo',
      marketplaceRoot: '/mp',
    });
  });

  // `pluginRoot` arrives in a manifest fetched from whatever marketplace the
  // operator added, and the guards check its shape but never its length. The
  // trailing-slash strip was `/\/+$/`, which retries at every offset of the run
  // (CodeQL js/polynomial-redos); the lookbehind form pins the attempt to the
  // run's start, which is where the leftmost match already began.
  it.each([
    ['./plugins//', 'plugins/foo'],
    ['./plugins///', 'plugins/foo'],
    ['plugins/', 'plugins/foo'],
    ['./a/b//', 'a/b/foo'],
  ])('normalizes every trailing slash on pluginRoot %j', (pluginRoot, path) => {
    expect(resolvePluginSource('foo', { marketplaceRoot: '/mp', pluginRoot })).toEqual({
      type: 'relative-path',
      path,
      marketplaceRoot: '/mp',
    });
  });

  it('resolves a pluginRoot with a huge INTERNAL slash run quickly', () => {
    // The run must NOT be at the end. A trailing run is the cheap case for both
    // forms (`$` pins the engine straight to it), so timing one measures
    // nothing — an earlier version of this test did exactly that and passed at
    // 0.06ms against the unfixed regex. With the run followed by one more
    // character every start position has to fail, which is the quadratic the
    // alert names: 3868ms before the lookbehind, 0.32ms after.
    const pluginRoot = `./plugins${'/'.repeat(100_000)}x`;
    const started = performance.now();
    const result = resolvePluginSource('foo', { marketplaceRoot: '/mp', pluginRoot });
    expect(performance.now() - started).toBeLessThan(100);
    expect(result).toEqual({
      type: 'relative-path',
      path: `plugins${'/'.repeat(100_000)}x/foo`,
      marketplaceRoot: '/mp',
    });
  });

  it('throws on absolute pluginRoot', () => {
    expect(() =>
      resolvePluginSource('foo', {
        marketplaceRoot: '/mp',
        pluginRoot: '/etc',
      })
    ).toThrow(ResolvePluginSourceError);
  });

  it('throws on pluginRoot containing ..', () => {
    expect(() =>
      resolvePluginSource('foo', {
        marketplaceRoot: '/mp',
        pluginRoot: './../escape',
      })
    ).toThrow(ResolvePluginSourceError);
  });

  it('throws on source containing ..', () => {
    expect(() =>
      resolvePluginSource('./../evil', {
        marketplaceRoot: '/mp',
      })
    ).toThrow(ResolvePluginSourceError);
  });

  it('throws when marketplaceRoot is missing', () => {
    expect(() => resolvePluginSource('./foo', {})).toThrow(ResolvePluginSourceError);
  });

  it('returns the bare source when pluginRoot is undefined', () => {
    const result = resolvePluginSource('./foo', {
      marketplaceRoot: '/mp',
    });
    expect(result).toEqual({
      type: 'relative-path',
      path: 'foo',
      marketplaceRoot: '/mp',
    });
  });
});

describe('resolvePluginSource — object-form sources ignore pluginRoot', () => {
  it('github source ignores pluginRoot', () => {
    const result = resolvePluginSource(
      { source: 'github', repo: 'foo/bar' },
      { pluginRoot: './plugins' }
    );
    expect(result).toEqual({
      type: 'github',
      repo: 'foo/bar',
      ref: undefined,
      sha: undefined,
      cloneUrl: 'https://github.com/foo/bar.git',
    });
  });

  it('github source preserves ref and sha', () => {
    const result = resolvePluginSource(
      { source: 'github', repo: 'foo/bar', ref: 'v1', sha: 'a'.repeat(40) },
      {}
    );
    expect(result).toMatchObject({
      type: 'github',
      repo: 'foo/bar',
      ref: 'v1',
      sha: 'a'.repeat(40),
    });
  });

  it('url source passes url through', () => {
    const result = resolvePluginSource(
      { source: 'url', url: 'https://gitlab.com/foo/bar.git' },
      {}
    );
    expect(result).toEqual({
      type: 'url',
      url: 'https://gitlab.com/foo/bar.git',
      ref: undefined,
      sha: undefined,
    });
  });

  it('git-subdir source returns cloneUrl and subpath', () => {
    const result = resolvePluginSource(
      {
        source: 'git-subdir',
        url: 'https://github.com/foo/monorepo.git',
        path: 'plugins/qa',
      },
      {}
    );
    expect(result).toMatchObject({
      type: 'git-subdir',
      cloneUrl: 'https://github.com/foo/monorepo.git',
      subpath: 'plugins/qa',
    });
  });

  it('npm source returns package, version, registry', () => {
    const result = resolvePluginSource(
      { source: 'npm', package: '@dorkos/foo', version: '1.2.3' },
      {}
    );
    expect(result).toEqual({
      type: 'npm',
      package: '@dorkos/foo',
      version: '1.2.3',
      registry: undefined,
    });
  });
});

describe('sourceKeyOf', () => {
  it("gives a github source resolvePluginSource's .git clone URL and the 'main' default ref", () => {
    // Purpose: install and the update check must name the same place; the
    // github form's URL is built once, in resolvePluginSource, with `.git`.
    const descriptor = resolvePluginSource({ source: 'github', repo: 'o/r' }, {});
    expect(sourceKeyOf(descriptor)).toEqual({
      cloneUrl: 'https://github.com/o/r.git',
      subpath: '',
      ref: 'main',
    });
  });

  it('lets a pinned sha beat a ref', () => {
    // Purpose: a pinned package is fetched at its sha, so that is its ref.
    const sha = 'c'.repeat(40);
    const descriptor = resolvePluginSource(
      { source: 'url', url: 'https://example.com/r.git', ref: 'dev', sha },
      {}
    );
    expect(sourceKeyOf(descriptor)).toEqual({
      cloneUrl: 'https://example.com/r.git',
      subpath: '',
      ref: sha,
    });
  });

  it('keeps the ref and subpath of a git-subdir source', () => {
    // Purpose: two packages from one monorepo differ only by subpath; the key
    // must tell them apart.
    const descriptor = resolvePluginSource(
      { source: 'git-subdir', url: 'https://example.com/mono.git', path: 'plugins/a', ref: 'v2' },
      {}
    );
    expect(sourceKeyOf(descriptor)).toEqual({
      cloneUrl: 'https://example.com/mono.git',
      subpath: 'plugins/a',
      ref: 'v2',
    });
  });

  it('returns undefined for sources with no clone URL', () => {
    // Purpose: a file:// relative path and an npm package have no git place to
    // compare, so no key may be invented for them.
    expect(
      sourceKeyOf(resolvePluginSource('./plugins/a', { marketplaceRoot: '/mp' }))
    ).toBeUndefined();
    expect(sourceKeyOf(resolvePluginSource({ source: 'npm', package: 'x' }, {}))).toBeUndefined();
  });
});

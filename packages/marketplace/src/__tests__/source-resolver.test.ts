import { describe, it, expect } from 'vitest';
import { resolvePluginSource, ResolvePluginSourceError } from '../source-resolver.js';

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

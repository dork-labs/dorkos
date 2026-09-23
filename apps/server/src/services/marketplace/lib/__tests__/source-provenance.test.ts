import { describe, it, expect } from 'vitest';
import { hostOf, matchesRecordedKey, resolvedFromSourceKey } from '../source-provenance.js';

describe('hostOf', () => {
  it('names the host of an https URL, an scp-style address, and falls back to the input', () => {
    // Purpose: the "couldn't reach <host>" note must name a host a person
    // recognizes for every address form git accepts, never throw.
    expect(hostOf('https://github.com/dork-labs/marketplace')).toBe('github.com');
    expect(hostOf('git@gitlab.example.com:team/repo.git')).toBe('gitlab.example.com');
    expect(hostOf('not a url')).toBe('not a url');
  });
});

describe('resolvedFromSourceKey', () => {
  it('rebuilds a whole-repo key as a url source and a subdirectory key as git-subdir', () => {
    // Purpose: a direct install is re-checked from its recorded key; the
    // rebuilt source must carry the recorded ref and subpath.
    const whole = resolvedFromSourceKey('tool', {
      cloneUrl: 'https://example.com/tool.git',
      subpath: '',
      ref: 'release',
    });
    expect(whole.pluginSource).toEqual({
      source: 'url',
      url: 'https://example.com/tool.git',
      ref: 'release',
    });
    const sub = resolvedFromSourceKey('tool', {
      cloneUrl: 'https://example.com/mono.git',
      subpath: 'plugins/tool',
      ref: 'release',
    });
    expect(sub.pluginSource).toEqual({
      source: 'git-subdir',
      url: 'https://example.com/mono.git',
      path: 'plugins/tool',
      ref: 'release',
    });
  });

  it("rebuilds a pre-DOR-2248 'main' as the default branch", () => {
    // Purpose: a direct install cannot name a ref; its recorded `main` was the
    // old assumed default, and checking `main` fails on a `master` repository.
    const legacy = resolvedFromSourceKey('tool', {
      cloneUrl: 'https://example.com/tool.git',
      subpath: '',
      ref: 'main',
    });
    expect(legacy.pluginSource).toMatchObject({ ref: 'HEAD' });
  });
});

describe('matchesRecordedKey', () => {
  const key = { cloneUrl: 'https://example.com/mono.git', subpath: 'plugins/p', ref: 'HEAD' };

  it('matches the same place, and HEAD against a legacy main record', () => {
    // Purpose: records written before DOR-2248 say `main` for the default
    // branch; without this every check of them restages forever.
    expect(matchesRecordedKey(key, key)).toBe(true);
    expect(matchesRecordedKey(key, { ...key, ref: 'main' })).toBe(true);
  });

  it.each([
    ['another clone URL', { ...key, cloneUrl: 'https://example.com/other.git' }],
    ['another subpath', { ...key, subpath: 'plugins/q' }],
    ['another ref', { ...key, ref: 'release' }],
  ])('refuses %s', (_label, recorded) => {
    expect(matchesRecordedKey(key, recorded)).toBe(false);
  });

  it('never reads main as HEAD the other way round', () => {
    // An explicit `main` now against a `HEAD` record is a real change of ref.
    expect(matchesRecordedKey({ ...key, ref: 'main' }, key)).toBe(false);
  });
});

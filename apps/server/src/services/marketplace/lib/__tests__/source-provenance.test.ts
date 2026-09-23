import { describe, it, expect } from 'vitest';
import { hostOf, resolvedFromSourceKey } from '../source-provenance.js';

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
      ref: 'main',
    });
    expect(sub.pluginSource).toEqual({
      source: 'git-subdir',
      url: 'https://example.com/mono.git',
      path: 'plugins/tool',
      ref: 'main',
    });
  });
});

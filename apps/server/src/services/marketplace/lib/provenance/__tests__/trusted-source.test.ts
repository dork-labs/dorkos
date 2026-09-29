import { describe, expect, it } from 'vitest';
import {
  isTrustableRef,
  normalizeTrustedSource,
  trustedSourceOfInstall,
} from '../trusted-source.js';

describe('normalizeTrustedSource (spec flow-multiproject §9.1)', () => {
  it.each([
    ['https://github.com/dork-labs/marketplace', 'dork-labs/marketplace'],
    ['https://github.com/Dork-Labs/Marketplace.git', 'dork-labs/marketplace'],
    ['https://token@github.com/dork-labs/marketplace/', 'dork-labs/marketplace'],
    ['git@github.com:Dork-Labs/marketplace.git', 'dork-labs/marketplace'],
    ['ssh://git@github.com/dork-labs/marketplace.git', 'dork-labs/marketplace'],
    ['dork-labs/marketplace', 'dork-labs/marketplace'],
    ['Dork-Labs/Marketplace', 'dork-labs/marketplace'],
  ])('reduces %s to %s', (input, expected) => {
    expect(normalizeTrustedSource(input)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    '',
    'https://gitlab.com/dork-labs/marketplace',
    'https://example.com/valid-plugin.git',
    'file:///Users/me/marketplace',
    './plugins/flow',
    '../flow',
    'dork.labs/marketplace',
  ])('gives %s no trusted source', (input) => {
    expect(normalizeTrustedSource(input)).toBeNull();
  });
});

describe('only branches and tags prove a source (security review, DOR-2527)', () => {
  it.each([
    ['HEAD', true],
    ['main', true],
    ['feature/x', true],
    ['v1.2.0', true],
    ['refs/heads/main', true],
    ['refs/tags/v1.2.0', true],
    ['refs/pull/7/head', false],
    ['refs/pull/7/merge', false],
    ['refs/remotes/origin/main', false],
    ['0123456789abcdef0123456789abcdef01234567', false],
    ['abc1234', false],
    ['', false],
    [undefined, false],
  ])('%s → %s', (ref, trusted) => {
    expect(isTrustableRef(ref)).toBe(trusted);
  });

  it('needs both a GitHub source and a branch or tag', () => {
    const sourceRepo = 'https://github.com/dork-labs/marketplace';
    expect(trustedSourceOfInstall({ sourceRepo, sourceKey: { ref: 'HEAD' } })).toBe(
      'dork-labs/marketplace'
    );
    expect(
      trustedSourceOfInstall({ sourceRepo, sourceKey: { ref: 'refs/pull/1/head' } })
    ).toBeNull();
    expect(trustedSourceOfInstall({ sourceRepo })).toBeNull();
    expect(trustedSourceOfInstall({ sourceKey: { ref: 'HEAD' } })).toBeNull();
  });
});

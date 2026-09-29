import { describe, expect, it } from 'vitest';
import { normalizeTrustedSource } from '../trusted-source.js';

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

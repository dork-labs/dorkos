/**
 * The repository normaliser's fixtures.
 *
 * The first two cases are the two real pairs measured on the operator's machine
 * on 2026-09-08: Claude Code calls one marketplace `dorkos` and DorkOS calls the
 * same repository `dorkos-community`, and both sides carry
 * `claude-plugins-official` under its own name. Those pairs are the reason the
 * offer matches on the repository rather than on the marketplace's local name,
 * so they are pinned here rather than described anywhere.
 */
import { describe, it, expect } from 'vitest';

import { marketplaceRepoKey } from '../marketplace-repo-key.js';

describe('marketplaceRepoKey', () => {
  it('folds the dorkos / dorkos-community pair to one key', () => {
    expect(
      marketplaceRepoKey({ kind: 'url', url: 'https://github.com/dork-labs/marketplace' })
    ).toBe('dork-labs/marketplace');
    expect(
      marketplaceRepoKey({ kind: 'claude-source', source: 'github', repo: 'dork-labs/marketplace' })
    ).toBe('dork-labs/marketplace');
  });

  it('folds the claude-plugins-official pair to one key', () => {
    const fromDorkos = marketplaceRepoKey({
      kind: 'url',
      url: 'https://github.com/anthropics/claude-plugins-official',
    });
    const fromClaude = marketplaceRepoKey({
      kind: 'claude-source',
      source: 'github',
      repo: 'anthropics/claude-plugins-official',
    });
    expect(fromDorkos).toBe('anthropics/claude-plugins-official');
    expect(fromClaude).toBe(fromDorkos);
  });

  it('strips a trailing .git, a trailing slash, and a www. host', () => {
    for (const url of [
      'https://github.com/dork-labs/marketplace.git',
      'https://github.com/dork-labs/marketplace/',
      'https://github.com/dork-labs/marketplace.git/',
      'https://www.github.com/dork-labs/marketplace',
    ]) {
      expect(marketplaceRepoKey({ kind: 'url', url })).toBe('dork-labs/marketplace');
    }
  });

  // The seeded defect: lower-case the whole key. An upper-case owner then equals
  // a lower-case one, which is a false positive on a case-sensitive host — the
  // one thing a key used to offer somebody an install must never do.
  it('preserves the case of the owner segment, so two owners stay two owners', () => {
    expect(
      marketplaceRepoKey({ kind: 'url', url: 'https://github.com/Dork-Labs/Marketplace' })
    ).toBe('Dork-Labs/Marketplace');
    expect(
      marketplaceRepoKey({ kind: 'url', url: 'https://github.com/Dork-Labs/Marketplace' })
    ).not.toBe(
      marketplaceRepoKey({ kind: 'url', url: 'https://github.com/dork-labs/marketplace' })
    );
  });

  it('answers null for a Claude Code source that is not github', () => {
    expect(
      marketplaceRepoKey({ kind: 'claude-source', source: 'git', repo: 'acme/tool' })
    ).toBeNull();
    expect(
      marketplaceRepoKey({ kind: 'claude-source', source: 'directory', repo: 'acme/tool' })
    ).toBeNull();
    expect(marketplaceRepoKey({ kind: 'claude-source', source: 'github' })).toBeNull();
  });

  it('answers null for an address it cannot compare against a github repo', () => {
    for (const url of [
      'file:///Users/someone/.dork/personal-marketplace',
      'https://gitlab.com/acme/tool',
      'git@github.com:acme/tool.git',
      'https://github.com/acme',
      'https://github.com/acme/tool/tree/main',
      'not a url at all',
    ]) {
      expect(marketplaceRepoKey({ kind: 'url', url })).toBeNull();
    }
  });
});

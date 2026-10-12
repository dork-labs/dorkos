import { describe, expect, it } from 'vitest';

import {
  createInstallRefToken,
  formatInstallRef,
  installRefDistinctId,
  INSTALL_REF_TOKEN_PATTERN,
  sanitizeUtm,
  withInstallRef,
} from '../install-ref';

describe('site install ref (DOR-2862)', () => {
  it('mints a 12-character base-36 token', () => {
    expect(createInstallRefToken()).toMatch(INSTALL_REF_TOKEN_PATTERN);
    expect(createInstallRefToken((bytes) => bytes.fill(0))).toBe('aaaaaaaaaaaa');
  });

  it('folds campaign tags into plain characters, capped at 32', () => {
    expect(sanitizeUtm('Hacker News')).toBe('hacker-news');
    expect(sanitizeUtm('a'.repeat(40))).toBe('a'.repeat(32));
    expect(sanitizeUtm('')).toBeUndefined();
    expect(sanitizeUtm(null)).toBeUndefined();
  });

  it('formats the wire form, dropping empty trailing tags', () => {
    expect(formatInstallRef('k3j4mnb8x2qa', { source: 'hn', campaign: 'launch' })).toBe(
      'k3j4mnb8x2qa.hn.launch'
    );
    expect(formatInstallRef('k3j4mnb8x2qa', { source: 'hn' })).toBe('k3j4mnb8x2qa.hn');
    expect(formatInstallRef('k3j4mnb8x2qa', { campaign: 'launch' })).toBe('k3j4mnb8x2qa..launch');
    expect(formatInstallRef('k3j4mnb8x2qa')).toBe('k3j4mnb8x2qa');
  });

  it('adds the ref only to commands that run code able to record it', () => {
    expect(withInstallRef('curl -fsSL https://dorkos.ai/install | bash', 'k3j4mnb8x2qa')).toBe(
      'curl -fsSL https://dorkos.ai/install | bash -s -- --ref=k3j4mnb8x2qa'
    );
    expect(withInstallRef('npx dorkos@latest', 'k3j4mnb8x2qa')).toBe(
      'npx dorkos@latest --ref=k3j4mnb8x2qa'
    );
    expect(withInstallRef('npm install -g dorkos', 'k3j4mnb8x2qa')).toBeNull();
    expect(withInstallRef('npm install -g dorkos@latest', 'k3j4mnb8x2qa')).toBeNull();
  });

  it('namespaces the alias distinct id', () => {
    expect(installRefDistinctId('k3j4mnb8x2qa')).toBe('install_ref:k3j4mnb8x2qa');
  });
});

import { describe, expect, it } from 'vitest';
import { isSecretName, isUnpinnedPackage } from '../global-mcp-schemas.js';

describe('isSecretName', () => {
  it('a name matching the rule is secret, whatever a person marked', () => {
    expect(isSecretName('GITHUB_TOKEN')).toBe(true);
    expect(isSecretName('GITHUB_TOKEN', [])).toBe(true);
    expect(isSecretName('GITHUB_TOKEN', ['OTHER'])).toBe(true);
    expect(isSecretName('Authorization')).toBe(true);
    expect(isSecretName('DATABASE_URL')).toBe(true);
  });

  it('marking can only add a secret', () => {
    expect(isSecretName('MADE_UP_SETTING')).toBe(false);
    expect(isSecretName('MADE_UP_SETTING', ['MADE_UP_SETTING'])).toBe(true);
  });
});

describe('isUnpinnedPackage', () => {
  it('a program that fetches nothing is never unpinned', () => {
    expect(isUnpinnedPackage('node', ['server.js'])).toBe(false);
  });

  it('an exact version is pinned, scoped or not, with quiet flags before it', () => {
    expect(isUnpinnedPackage('npx', ['-y', 'made-up-mcp@1.2.3'])).toBe(false);
    expect(isUnpinnedPackage('npx', ['--yes', '@made-up/server@2025.4.8'])).toBe(false);
    expect(isUnpinnedPackage('uvx', ['made-up==1.2.3'])).toBe(false);
  });

  it('no version, a tag, or a flag that can change what runs is unpinned', () => {
    expect(isUnpinnedPackage('npx', ['-y', 'made-up-mcp'])).toBe(true);
    expect(isUnpinnedPackage('npx', ['-y', '@made-up/server'])).toBe(true);
    expect(isUnpinnedPackage('npx', ['made-up-mcp@latest'])).toBe(true);
    expect(isUnpinnedPackage('npx', ['--package=other', 'made-up-mcp@1.2.3'])).toBe(true);
    expect(isUnpinnedPackage('npx', [])).toBe(true);
  });
});

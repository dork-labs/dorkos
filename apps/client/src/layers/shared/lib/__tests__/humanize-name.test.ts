import { describe, it, expect } from 'vitest';
import { humanizePackageName, packageDisplayLabel, isSingleEmoji } from '../humanize-name';

describe('humanizePackageName', () => {
  it('strips a leading @scope/ and title-cases', () => {
    expect(humanizePackageName('@dorkos/code-reviewer')).toBe('Code Reviewer');
  });

  it('humanizes a bare kebab slug', () => {
    expect(humanizePackageName('eslint-plugin')).toBe('Eslint Plugin');
  });

  it('treats underscores as word breaks', () => {
    expect(humanizePackageName('linear_keeper')).toBe('Linear Keeper');
  });

  it('drops any remaining path segment', () => {
    expect(humanizePackageName('org/repo/my-agent')).toBe('My Agent');
  });
});

describe('packageDisplayLabel', () => {
  it('prefers the author-supplied displayName', () => {
    expect(packageDisplayLabel({ name: 'security-scanner', displayName: 'PR Guardian' })).toBe(
      'PR Guardian'
    );
  });

  it('humanizes the slug when no displayName is present', () => {
    expect(packageDisplayLabel({ name: '@dorkos/code-reviewer' })).toBe('Code Reviewer');
  });
});

describe('isSingleEmoji', () => {
  it('accepts a single emoji', () => {
    expect(isSingleEmoji('🔍')).toBe(true);
    expect(isSingleEmoji('🤖')).toBe(true);
  });

  it('accepts an emoji with a variation selector', () => {
    expect(isSingleEmoji('🛰️')).toBe(true);
  });

  it('rejects plain text and empty strings', () => {
    expect(isSingleEmoji('agent')).toBe(false);
    expect(isSingleEmoji('')).toBe(false);
    expect(isSingleEmoji('  ')).toBe(false);
  });
});

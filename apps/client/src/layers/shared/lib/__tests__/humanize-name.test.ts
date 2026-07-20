import { describe, it, expect } from 'vitest';
import { humanizeAgentName, isSingleEmoji } from '../humanize-name';

describe('humanizeAgentName', () => {
  it('strips a leading @scope/ and title-cases', () => {
    expect(humanizeAgentName('@dorkos/code-reviewer')).toBe('Code Reviewer');
  });

  it('humanizes a bare kebab slug', () => {
    expect(humanizeAgentName('eslint-plugin')).toBe('Eslint Plugin');
  });

  it('treats underscores as word breaks', () => {
    expect(humanizeAgentName('linear_keeper')).toBe('Linear Keeper');
  });

  it('drops any remaining path segment', () => {
    expect(humanizeAgentName('org/repo/my-agent')).toBe('My Agent');
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

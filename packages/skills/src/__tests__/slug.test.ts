import { describe, it, expect } from 'vitest';
import { validateSlug, slugify, humanize } from '../slug.js';

describe('validateSlug', () => {
  it('accepts valid kebab-case slugs', () => {
    expect(validateSlug('daily-health-check')).toBe(true);
    expect(validateSlug('a')).toBe(true);
    expect(validateSlug('a1b2')).toBe(true);
    expect(validateSlug('my-skill')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(validateSlug('')).toBe(false);
  });

  it('rejects strings longer than 64 chars', () => {
    expect(validateSlug('a'.repeat(65))).toBe(false);
  });

  it('rejects uppercase', () => {
    expect(validateSlug('Daily')).toBe(false);
  });

  it('rejects leading hyphen', () => {
    expect(validateSlug('-daily')).toBe(false);
  });

  it('rejects trailing hyphen', () => {
    expect(validateSlug('daily-')).toBe(false);
  });

  it('rejects consecutive hyphens', () => {
    expect(validateSlug('daily--check')).toBe(false);
  });

  it('rejects special characters', () => {
    expect(validateSlug('daily_check')).toBe(false);
    expect(validateSlug('daily.check')).toBe(false);
    expect(validateSlug('daily check')).toBe(false);
  });
});

describe('slugify', () => {
  it('converts a display name to kebab-case', () => {
    expect(slugify('Daily Health Check')).toBe('daily-health-check');
  });

  it('strips special characters', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
  });

  it('handles leading/trailing whitespace', () => {
    expect(slugify('  My Skill  ')).toBe('my-skill');
  });

  it('truncates to 64 characters', () => {
    const long = 'a '.repeat(40);
    expect(slugify(long).length).toBeLessThanOrEqual(64);
  });

  it('cleans up leading/trailing hyphens from substitution', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('collapses consecutive hyphens', () => {
    expect(slugify('hello   world')).toBe('hello-world');
  });

  it('produces a valid slug', () => {
    const result = slugify('My Cool Skill #1');
    expect(validateSlug(result)).toBe(true);
  });

  it('produces a valid slug even when truncation would leave a trailing hyphen', () => {
    // 'a '.repeat(33) → 'a-a-a-...' (65 chars before slice) → slice(0,64) could leave trailing '-'
    const result = slugify('a '.repeat(33));
    expect(result.length).toBeLessThanOrEqual(64);
    expect(validateSlug(result)).toBe(true);
    expect(result).not.toMatch(/-$/);
  });
});

describe('humanize', () => {
  it('converts kebab-case to title case', () => {
    expect(humanize('daily-health-check')).toBe('Daily Health Check');
  });

  it('handles single word', () => {
    expect(humanize('deploy')).toBe('Deploy');
  });

  it('handles multiple hyphens', () => {
    expect(humanize('run-all-tests-now')).toBe('Run All Tests Now');
  });

  it('round-trips with slugify (approximately)', () => {
    const original = 'Daily Health Check';
    const slug = slugify(original);
    expect(humanize(slug)).toBe(original);
  });
});

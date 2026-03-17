import { describe, it, expect } from 'vitest';
import { slugify } from '../slugify';

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Semantic Colors')).toBe('semantic-colors');
  });

  it('converts em-dashes to hyphens', () => {
    expect(slugify('ToolCallCard \u2014 Extended Labels')).toBe('toolcallcard-extended-labels');
  });

  it('converts en-dashes to hyphens', () => {
    expect(slugify('Foo \u2013 Bar')).toBe('foo-bar');
  });

  it('converts ampersands to "and"', () => {
    expect(slugify('Icon & Button Sizes')).toBe('icon-and-button-sizes');
  });

  it('strips other special characters', () => {
    expect(slugify('Hello! @World #2')).toBe('hello-world-2');
  });

  it('collapses multiple hyphens', () => {
    expect(slugify('A --- B')).toBe('a-b');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('handles mixed special characters', () => {
    expect(slugify('ToolCallCard \u2014 Hook Lifecycle')).toBe('toolcallcard-hook-lifecycle');
  });
});

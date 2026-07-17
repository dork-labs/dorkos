import { describe, expect, it } from 'vitest';
import { releaseVersion, sortBlogPagesNewestFirst } from '../blog-order';

type BlogPage = Parameters<typeof sortBlogPagesNewestFirst>[0][number];

function page(title: string, date: string): BlogPage {
  return { data: { title, date } } as BlogPage;
}

describe('sortBlogPagesNewestFirst', () => {
  it('sorts by date, newest first', () => {
    const sorted = sortBlogPagesNewestFirst([
      page('DorkOS 0.48.0', '2026-07-13'),
      page('DorkOS 0.50.0', '2026-07-17'),
      page('DorkOS 0.49.0', '2026-07-14'),
    ]);
    expect(sorted.map((p) => p.data.title)).toEqual([
      'DorkOS 0.50.0',
      'DorkOS 0.49.0',
      'DorkOS 0.48.0',
    ]);
  });

  it('breaks same-day ties by version, highest first', () => {
    const sorted = sortBlogPagesNewestFirst([
      page('DorkOS 0.45.0', '2026-07-09'),
      page('DorkOS 0.45.1', '2026-07-09'),
    ]);
    expect(sorted.map((p) => p.data.title)).toEqual(['DorkOS 0.45.1', 'DorkOS 0.45.0']);
  });

  it('compares versions numerically, not lexically', () => {
    const sorted = sortBlogPagesNewestFirst([
      page('DorkOS 0.9.0', '2026-07-09'),
      page('DorkOS 0.10.0', '2026-07-09'),
    ]);
    expect(sorted.map((p) => p.data.title)).toEqual(['DorkOS 0.10.0', 'DorkOS 0.9.0']);
  });

  it('falls back to title order for same-day posts without versions', () => {
    const sorted = sortBlogPagesNewestFirst([
      page('Meet the fleet', '2026-07-09'),
      page('Agents at work', '2026-07-09'),
    ]);
    expect(sorted.map((p) => p.data.title)).toEqual(['Agents at work', 'Meet the fleet']);
  });

  it('does not mutate its input', () => {
    const pages = [page('DorkOS 0.45.0', '2026-07-09'), page('DorkOS 0.45.1', '2026-07-09')];
    sortBlogPagesNewestFirst(pages);
    expect(pages[0].data.title).toBe('DorkOS 0.45.0');
  });
});

describe('releaseVersion', () => {
  it('extracts the version from a title', () => {
    expect(releaseVersion('DorkOS 0.50.0')).toBe('0.50.0');
  });

  it('falls back to the slug when the title has no version', () => {
    expect(releaseVersion('The big one', 'dorkos-0-50-0')).toBe('0.50.0');
  });

  it('returns null when neither title nor slug carries a version', () => {
    expect(releaseVersion('Meet the fleet', 'meet-the-fleet')).toBeNull();
  });
});

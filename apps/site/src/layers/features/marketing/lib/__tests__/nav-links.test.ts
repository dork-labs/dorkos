import { describe, expect, it } from 'vitest';
import { NAV_LINKS, isNavLinkActive } from '../nav-links';

describe('NAV_LINKS', () => {
  it('offers Compare, directly after Features', () => {
    const labels = NAV_LINKS.map((link) => link.label);

    expect(labels).toEqual(['home', 'features', 'compare', 'marketplace', 'blog', 'docs']);
    expect(NAV_LINKS.find((link) => link.label === 'compare')?.href).toBe('/compare');
  });

  it('points every destination at a real section', () => {
    for (const link of NAV_LINKS) {
      expect(link.href.startsWith('/')).toBe(true);
    }
  });

  it('keeps the pill to five words on a phone', () => {
    expect(NAV_LINKS.filter((link) => !link.yieldsOnMobile)).toHaveLength(5);
  });
});

describe('isNavLinkActive', () => {
  it('lights up the section a detail page belongs to', () => {
    expect(isNavLinkActive('/compare/cursor', '/compare')).toBe(true);
    expect(isNavLinkActive('/features/task-scheduler', '/features')).toBe(true);
  });

  it('lights up the section index itself', () => {
    expect(isNavLinkActive('/compare', '/compare')).toBe(true);
  });

  it('leaves other sections dark', () => {
    expect(isNavLinkActive('/compare/cursor', '/features')).toBe(false);
    expect(isNavLinkActive('/features', '/compare')).toBe(false);
  });

  it('does not treat a longer name as the same section', () => {
    expect(isNavLinkActive('/compare-tools', '/compare')).toBe(false);
  });

  it('matches home only on the homepage', () => {
    expect(isNavLinkActive('/', '/')).toBe(true);
    expect(isNavLinkActive('/compare', '/')).toBe(false);
  });

  it('stays dark before the path is known', () => {
    expect(isNavLinkActive(null, '/compare')).toBe(false);
  });
});

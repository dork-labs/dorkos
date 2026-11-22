import { describe, expect, it } from 'vitest';

import { toBrowseVisit } from '../browse-visit';

describe('toBrowseVisit (DOR-4992)', () => {
  it('keeps a real package type and catalog category', () => {
    expect(toBrowseVisit({ type: 'plugin', category: 'security' }, 3)).toEqual({
      type: 'plugin',
      category: 'security',
      hasQuery: false,
      resultCount: 3,
    });
  });

  it('turns any other type or category typed into the URL into other', () => {
    const visit = toBrowseVisit({ type: 'acme invoices', category: 'my secret plan' }, 0);

    expect(visit).toMatchObject({ type: 'other', category: 'other' });
    expect(JSON.stringify(visit)).not.toMatch(/acme|secret/);
  });

  it('reduces the search to whether there was one', () => {
    const visit = toBrowseVisit({ q: 'acme invoices' }, 2);

    expect(visit).toEqual({ type: undefined, category: undefined, hasQuery: true, resultCount: 2 });
    expect(JSON.stringify(visit)).not.toContain('acme');
    expect(toBrowseVisit({ q: '   ' }, 2).hasQuery).toBe(false);
  });

  it('leaves a missing or empty filter out', () => {
    expect(toBrowseVisit({ type: '', category: undefined }, null)).toEqual({
      type: undefined,
      category: undefined,
      hasQuery: false,
      resultCount: null,
    });
  });
});

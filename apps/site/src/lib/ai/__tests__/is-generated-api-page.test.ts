import { describe, expect, it } from 'vitest';
import type { InferPageType } from 'fumadocs-core/source';
import { isGeneratedApiPage } from '@/lib/ai/is-generated-api-page';
import { source } from '@/lib/source';

/**
 * Build a fake fumadocs page shaped like the loader's page type, without
 * needing a real `.source` build. Only the fields `isGeneratedApiPage` reads
 * are populated.
 */
function fakePage(options: { slugs: string[]; openapi?: { method?: string } }) {
  return {
    slugs: options.slugs,
    data: {
      _openapi: options.openapi,
    },
  } as unknown as InferPageType<typeof source>;
}

describe('isGeneratedApiPage', () => {
  it('is true for a page carrying the _openapi marker (a generated operation page)', () => {
    const page = fakePage({ slugs: ['api', 'tasks', 'post'], openapi: { method: 'POST' } });

    expect(isGeneratedApiPage(page)).toBe(true);
  });

  it('is false for a hand-authored prose page with no _openapi marker', () => {
    const page = fakePage({ slugs: ['guides', 'foo'] });

    expect(isGeneratedApiPage(page)).toBe(false);
  });

  it('is false for a hand-written docs/api overview page (slugs.length === 1, no marker)', () => {
    const page = fakePage({ slugs: ['api'] });

    expect(isGeneratedApiPage(page)).toBe(false);
  });
});

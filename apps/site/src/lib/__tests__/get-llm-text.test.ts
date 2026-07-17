import { describe, expect, it } from 'vitest';
import type { InferPageType } from 'fumadocs-core/source';
import { getLLMText } from '@/lib/get-llm-text';
import { source } from '@/lib/source';
import { siteConfig } from '@/config/site';

/**
 * Build a fake fumadocs page shaped like the loader's page type, without
 * needing a real `.source` build. Only the fields `getLLMText` reads are
 * populated.
 */
function fakePage(options: {
  url: string;
  title: string;
  description?: string;
  processed: string;
}): InferPageType<typeof source> {
  return {
    url: options.url,
    data: {
      title: options.title,
      description: options.description,
      getText: async (type: 'raw' | 'processed') => {
        if (type !== 'processed') throw new Error('fake page only serves processed text');
        return options.processed;
      },
    },
  } as unknown as InferPageType<typeof source>;
}

describe('getLLMText', () => {
  it('orders the header as H1 title, then Source line, then the processed body after a blank line', async () => {
    const page = fakePage({
      url: '/docs/guides/foo',
      title: 'Foo Guide',
      processed: '## Body heading\n\nBody text.',
    });

    const text = await getLLMText(page);

    expect(text).toBe(
      `# Foo Guide\nSource: ${siteConfig.url}/docs/guides/foo\n\n## Body heading\n\nBody text.`
    );
  });

  it('emits an absolute Source URL built from siteConfig.url + page.url', async () => {
    const page = fakePage({
      url: '/docs/guides/foo',
      title: 'Foo Guide',
      processed: 'Body.',
    });

    const text = await getLLMText(page);
    const sourceLine = text.split('\n').find((line) => line.startsWith('Source: '));

    expect(sourceLine).toBe(`Source: ${siteConfig.url}/docs/guides/foo`);
    expect(sourceLine).toMatch(new RegExp(`^Source: ${siteConfig.url}.*/docs/guides/foo$`));
  });

  it('omits the description paragraph when data.description is absent', async () => {
    const page = fakePage({
      url: '/docs/guides/foo',
      title: 'Foo Guide',
      processed: 'Body.',
    });

    const text = await getLLMText(page);

    // Header is title + Source only, then a blank line, then the body — no
    // extra description paragraph in between.
    expect(text).toBe(`# Foo Guide\nSource: ${siteConfig.url}/docs/guides/foo\n\nBody.`);
  });

  it('inserts the description paragraph between the Source line and the body when present', async () => {
    const page = fakePage({
      url: '/docs/guides/foo',
      title: 'Foo Guide',
      description: 'A short description of the page.',
      processed: 'Body.',
    });

    const text = await getLLMText(page);

    expect(text).toBe(
      `# Foo Guide\nSource: ${siteConfig.url}/docs/guides/foo\n\nA short description of the page.\n\nBody.`
    );
  });
});

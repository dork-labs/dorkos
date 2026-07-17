import type { InferPageType } from 'fumadocs-core/source';
import { source } from '@/lib/source';
import { siteConfig } from '@/config/site';

/**
 * Serialize one docs page to clean markdown for AI consumption.
 *
 * Emits a stable header — the page title and its absolute canonical URL — then
 * the page's processed markdown body (frontmatter stripped, MDX compiled to
 * plain markdown). Used by the per-page raw route and by llms-full.txt so both
 * surfaces share one format.
 *
 * @param page - A docs page from the fumadocs source loader.
 */
export async function getLLMText(page: InferPageType<typeof source>): Promise<string> {
  const processed = await page.data.getText('processed');
  const url = `${siteConfig.url}${page.url}`;
  const header = page.data.description
    ? `# ${page.data.title}\nSource: ${url}\n\n${page.data.description}`
    : `# ${page.data.title}\nSource: ${url}`;
  return `${header}\n\n${processed}`;
}

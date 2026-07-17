import type { InferPageType } from 'fumadocs-core/source';
import type { source } from '@/lib/source';

/**
 * True when a docs page is a Fumadocs-OpenAPI-generated operation page (no
 * hand-written prose) rather than a hand-authored docs page.
 *
 * Generated pages carry the `_openapi` frontmatter marker that
 * `openapiPlugin()` (wired into `source`, see `lib/source.ts`) surfaces on
 * `page.data`. Used to filter llms-full.txt (Decision D3) and to gate the
 * page-action row (Decision D-A1) off the same generated pages, so both
 * surfaces share one signal.
 *
 * @param page - A docs page from the fumadocs source loader.
 */
export function isGeneratedApiPage(page: InferPageType<typeof source>): boolean {
  return Boolean(page.data._openapi);
}

import { getLLMText } from '@/lib/ai/get-llm-text';
import { isGeneratedApiPage } from '@/lib/ai/is-generated-api-page';
import { source } from '@/lib/source';

export const dynamic = 'force-static';

/**
 * Build-time full-corpus dump: every hand-authored docs page as one markdown
 * blob. Generated OpenAPI operation pages are filtered out (they carry an
 * _openapi marker and no prose); the API surface stays represented by
 * docs/api/openapi.json and the /docs/api links in llms.txt.
 */
export async function GET() {
  const pages = source.getPages().filter((page) => !isGeneratedApiPage(page));
  const parts = await Promise.all(pages.map(getLLMText));
  return new Response(parts.join('\n\n'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

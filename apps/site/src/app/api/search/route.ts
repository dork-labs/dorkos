import { docsSearchOptions, resolveSearchLimit } from './docs-search';
import { source } from '@/lib/source';
import { createFromSource } from 'fumadocs-core/search/server';

const server = createFromSource(source, docsSearchOptions);

/**
 * Documentation search.
 *
 * fumadocs ships its own route handler, but it forwards an absent `?limit=` as
 * an explicit `undefined`, which overwrites the engine's own ceiling and lets a
 * single answer grow to hundreds of kilobytes (DOR-701). Reading the parameters
 * here is what makes the ceiling real.
 *
 * @param request - The incoming search request.
 */
export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('query');
  if (!query) return Response.json([]);

  return Response.json(
    await server.search(query, {
      tag: searchParams.get('tag')?.split(','),
      locale: searchParams.get('locale'),
      limit: resolveSearchLimit(searchParams.get('limit')),
    })
  );
}

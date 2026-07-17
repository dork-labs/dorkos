import { getLLMText } from '@/lib/ai/get-llm-text';
import { source } from '@/lib/source';
import { notFound } from 'next/navigation';

export const dynamic = 'force-static';

/**
 * Serve a docs page as raw markdown for AI consumption.
 *
 * Lives at /llms.mdx/docs/[[...slug]] rather than co-located with the docs
 * page as a [[...slug]].mdx sibling segment — that placement fails to
 * statically export (Next.js cannot resolve generateStaticParams for a
 * segment mixing the [[...slug]] catch-all syntax with a literal .mdx
 * suffix). `next.config.ts` rewrites the public /docs/<slug>.mdx URL to
 * this route, so callers never see the difference.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  return new Response(await getLLMText(page), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}

/** Prerender one .mdx route per docs page. */
export function generateStaticParams() {
  return source.generateParams();
}

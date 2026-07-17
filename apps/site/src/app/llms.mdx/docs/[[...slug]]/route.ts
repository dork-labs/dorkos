import { getLLMText } from '@/lib/ai/get-llm-text';
import { source } from '@/lib/source';
import { siteConfig } from '@/config/site';
import { notFound } from 'next/navigation';

export const dynamic = 'force-static';

/** Rough token estimate for the `x-markdown-tokens` hint: ~4 chars per token. */
const CHARS_PER_TOKEN = 4;

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

  const markdown = await getLLMText(page);
  const canonicalUrl = `${siteConfig.url}${page.url}`;

  return new Response(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      // Markdown is an alternate of the canonical HTML page, never an
      // indexable duplicate: keep it out of the index and point search
      // engines at the HTML.
      'X-Robots-Tag': 'noindex',
      Link: `<${canonicalUrl}>; rel="canonical"`,
      // Cloudflare-style token-count hint so agents can budget before fetching.
      'x-markdown-tokens': String(Math.ceil(markdown.length / CHARS_PER_TOKEN)),
    },
  });
}

/** Prerender one .mdx route per docs page. */
export function generateStaticParams() {
  return source.generateParams();
}

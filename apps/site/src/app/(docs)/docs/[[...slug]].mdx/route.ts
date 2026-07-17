import { getLLMText } from '@/lib/get-llm-text';
import { source } from '@/lib/source';
import { notFound } from 'next/navigation';

export const dynamic = 'force-static';

/**
 * Serve a docs page as raw markdown at /docs/<slug>.mdx for AI consumption.
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

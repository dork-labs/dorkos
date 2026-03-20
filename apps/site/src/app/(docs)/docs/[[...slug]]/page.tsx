import { source } from '@/lib/source';
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from 'fumadocs-ui/page';
import { getMDXComponents } from '@/components/mdx-components';
import { notFound } from 'next/navigation';
import { APIPage } from '@/components/api-page';

/**
 * Generate static params for all documentation pages.
 */
export function generateStaticParams() {
  return source.generateParams();
}

/**
 * Generate metadata for each documentation page from frontmatter.
 */
export async function generateMetadata(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
  };
}

/**
 * Catch-all docs page that renders MDX content from the docs/ directory.
 *
 * OpenAPI-generated MDX pages include the APIPage component directly in their
 * content (with full: true in frontmatter). The APIPage component is provided
 * via the MDX components prop so it can be rendered inline.
 */
export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const Mdx = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <Mdx components={getMDXComponents({ APIPage })} />
      </DocsBody>
    </DocsPage>
  );
}

import { source } from '@/lib/source';
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from 'fumadocs-ui/page';
import { getMDXComponents } from '@/components/mdx-components';
import { notFound } from 'next/navigation';
import { APIPage } from '@/components/api-page';
import { LLMCopyButton, ViewOptions } from '@/components/ai/page-actions';
import { isGeneratedApiPage } from '@/lib/ai/is-generated-api-page';
import { siteConfig } from '@/config/site';

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
  const markdownUrl = `${page.url}.mdx`;
  const githubUrl = `${siteConfig.github}/blob/main/docs/${page.path}`;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      {!isGeneratedApiPage(page) && (
        <div className="flex flex-row items-center gap-2 border-b pb-4">
          <LLMCopyButton markdownUrl={markdownUrl} />
          <ViewOptions markdownUrl={markdownUrl} githubUrl={githubUrl} />
        </div>
      )}
      <DocsBody>
        <Mdx components={getMDXComponents({ APIPage })} />
      </DocsBody>
    </DocsPage>
  );
}

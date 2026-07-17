import { source } from '@/lib/source';
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from 'fumadocs-ui/page';
import { getMDXComponents } from '@/components/mdx-components';
import { notFound } from 'next/navigation';
import { APIPage } from '@/components/api-page';
import { openapi } from '@/lib/openapi';
import { LLMCopyButton, ViewOptions } from '@/components/ai/page-actions';
import { isGeneratedApiPage } from '@/lib/ai/is-generated-api-page';
import { siteConfig } from '@/config/site';
import type { GeneratedPageProps } from 'fumadocs-openapi';

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
 * OpenAPI-generated MDX pages embed the APIPage component (via `full: true`
 * frontmatter). Under fumadocs-openapi v11 that APIPage is a client component
 * that renders from serialized props, so for those pages we bundle the OpenAPI
 * schema on the server here — build-time file I/O — and bind it into APIPage as
 * `preloaded`; the client never reads a filesystem path. Hand-authored pages
 * additionally show the AI page-action row (Copy Markdown + View Options) above
 * the body; generated API pages omit it (no prose to copy).
 */
export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const Mdx = page.data.body;
  const markdownUrl = `${page.url}.mdx`;
  const githubUrl = `${siteConfig.github}/blob/main/docs/${page.path}`;
  const isApi = isGeneratedApiPage(page);

  // Bundle the OpenAPI schema server-side for generated API pages and bind it
  // into the client APIPage via `preloaded`, so it renders from serialized data
  // rather than reading the relative spec path at runtime. Non-API pages don't
  // render APIPage, so the bundling is skipped for them.
  const preloaded = isApi ? await openapi.preloadOpenAPIPage(page) : undefined;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      {!isApi && (
        <div className="flex flex-row items-center gap-2 border-b pb-4">
          <LLMCopyButton markdownUrl={markdownUrl} />
          <ViewOptions markdownUrl={markdownUrl} githubUrl={githubUrl} />
        </div>
      )}
      <DocsBody>
        <Mdx
          components={getMDXComponents(
            preloaded
              ? {
                  APIPage: (apiPageProps: GeneratedPageProps) => (
                    <APIPage {...apiPageProps} {...preloaded} />
                  ),
                }
              : undefined
          )}
        />
      </DocsBody>
    </DocsPage>
  );
}

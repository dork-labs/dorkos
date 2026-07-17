import { source } from '@/lib/source';
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from 'fumadocs-ui/page';
import { getMDXComponents } from '@/components/mdx-components';
import { notFound } from 'next/navigation';
import { APIPage } from '@/components/api-page';
import { openapi } from '@/lib/openapi';
import { LLMCopyButton, ViewOptions } from '@/components/ai/page-actions';
import { isGeneratedApiPage } from '@/lib/ai/is-generated-api-page';
import { siteConfig } from '@/config/site';
import { docsSectionTrail, twitterFromOpenGraph } from '@/lib/metadata';
import { OG_SIZE } from '@/lib/og';
import type { Metadata } from 'next';
import type { GeneratedPageProps } from 'fumadocs-openapi';

/**
 * Generate static params for all documentation pages.
 */
export function generateStaticParams() {
  return source.generateParams();
}

/**
 * Generate metadata for each documentation page from frontmatter.
 *
 * Sets a page-specific canonical, an Open Graph block with the per-page docs OG
 * card, and a derived Twitter card so shared docs links carry page-specific
 * previews instead of the sitewide root default. `alternates.types` advertises
 * the markdown twin agents can fetch.
 */
export async function generateMetadata(props: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const title = page.data.title;
  const description = page.data.description ?? `${siteConfig.name} documentation`;

  // The docs OG card is a route handler (`/og/docs/...`), not the file-based
  // `opengraph-image` convention: Next forbids that convention inside an optional
  // catch-all. Reference it explicitly so the per-page image (and its alt) attach.
  const sections = docsSectionTrail({ url: page.url, slugs: page.slugs }, source.pageTree);
  const eyebrow = ['Docs', ...sections.map((section) => section.name)].join(' / ');

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'website',
      url: page.url,
      siteName: siteConfig.name,
      images: [
        {
          url: `/og${page.url}`,
          width: OG_SIZE.width,
          height: OG_SIZE.height,
          alt: `${title} (${eyebrow})`,
        },
      ],
    },
    twitter: twitterFromOpenGraph({ title, description }),
    alternates: {
      canonical: page.url,
      // The `.mdx` twin returns real text/markdown today (the `.md` alias lands
      // with the content-negotiation PR); advertise the URL that resolves now.
      types: { 'text/markdown': `${page.url}.mdx` },
    },
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

  const canonicalUrl = `${siteConfig.url}${page.url}`;

  // TechArticle JSON-LD marks each page as technical documentation and links it
  // to the DorkOS organization (docs are our most-cited surface for AI answers).
  const techArticleJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: page.data.title,
    description: page.data.description,
    author: { '@type': 'Organization', name: siteConfig.name, url: siteConfig.url },
    publisher: { '@type': 'Organization', name: siteConfig.name, url: siteConfig.url },
    url: canonicalUrl,
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
  };

  // BreadcrumbList JSON-LD: Home > Docs > section(s) > page. The docs index is
  // its own root, so it collapses to Home > Documentation to avoid a duplicate.
  const sections = docsSectionTrail({ url: page.url, slugs: page.slugs }, source.pageTree);
  const breadcrumbTrail =
    page.url === '/docs'
      ? [
          { name: 'Home', item: siteConfig.url },
          { name: page.data.title, item: canonicalUrl },
        ]
      : [
          { name: 'Home', item: siteConfig.url },
          { name: 'Docs', item: `${siteConfig.url}/docs` },
          ...sections.map((section) => ({
            name: section.name,
            item: `${siteConfig.url}${section.url}`,
          })),
          { name: page.data.title, item: canonicalUrl },
        ];
  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbTrail.map((entry, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: entry.name,
      item: entry.item,
    })),
  };

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(techArticleJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbJsonLd).replace(/</g, '\\u003c'),
        }}
      />
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

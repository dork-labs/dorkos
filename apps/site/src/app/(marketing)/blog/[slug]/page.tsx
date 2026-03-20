import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { blog } from '@/lib/source';
import { getMDXComponents } from '@/components/mdx-components';
import { siteConfig } from '@/config/site';
import { BlogTOCSidebar } from './_components/BlogTOCSidebar';

export function generateStaticParams() {
  return blog.getPages().map((page) => ({
    slug: page.slugs[0],
  }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = blog.getPage([params.slug]);
  if (!page) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    openGraph: {
      title: page.data.title,
      description: page.data.description,
      type: 'article',
      publishedTime: new Date(page.data.date).toISOString(),
      url: `/blog/${params.slug}`,
      siteName: siteConfig.name,
      tags: page.data.tags,
    },
    alternates: {
      canonical: `/blog/${params.slug}`,
    },
  };
}

const categoryColors: Record<string, string> = {
  release: 'bg-emerald-100/60 text-emerald-900',
  tutorial: 'bg-blue-100/60 text-blue-900',
  announcement: 'bg-amber-100/60 text-amber-900',
  news: 'bg-purple-100/60 text-purple-900',
};

export default async function BlogPost(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const page = blog.getPage([params.slug]);
  if (!page) notFound();

  const Mdx = page.data.body;

  // Sorted posts for prev/next navigation (newest-first, same as index)
  const allPosts = blog
    .getPages()
    .sort((a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime());

  const currentIndex = allPosts.findIndex((p) => p.slugs[0] === params.slug);
  const prevPost = currentIndex < allPosts.length - 1 ? allPosts[currentIndex + 1] : null;
  const nextPost = currentIndex > 0 ? allPosts[currentIndex - 1] : null;

  // BlogPosting JSON-LD structured data
  const blogPostingJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: page.data.title,
    description: page.data.description,
    datePublished: new Date(page.data.date).toISOString(),
    dateModified: new Date(page.data.date).toISOString(),
    author: page.data.author
      ? { '@type': 'Person', name: page.data.author }
      : { '@type': 'Organization', name: siteConfig.name },
    publisher: {
      '@type': 'Organization',
      name: siteConfig.name,
      url: siteConfig.url,
    },
    url: `${siteConfig.url}/blog/${params.slug}`,
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `${siteConfig.url}/blog/${params.slug}`,
    },
  };

  // BreadcrumbList JSON-LD for richer search snippets
  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Blog',
        item: `${siteConfig.url}/blog`,
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: page.data.title,
        item: `${siteConfig.url}/blog/${params.slug}`,
      },
    ],
  };

  return (
    <div className="mx-auto max-w-6xl px-6 pt-32 pb-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(blogPostingJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <div className="flex gap-12">
        <article className="max-w-3xl min-w-0 flex-1">
          {/* Breadcrumb */}
          <Link
            href="/blog"
            className="text-2xs text-warm-gray-light hover:text-brand-orange transition-smooth mb-8 inline-flex items-center gap-1 font-mono tracking-[0.04em]"
          >
            <ArrowLeft size={12} /> Blog
          </Link>

          <header className="mb-8">
            <div className="text-warm-gray-light flex items-center gap-3 text-sm">
              <time dateTime={new Date(page.data.date).toISOString()}>
                {new Date(page.data.date).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </time>
              {page.data.author && <span>{page.data.author}</span>}
              {page.data.category && (
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${categoryColors[page.data.category] ?? 'bg-warm-gray/10 text-warm-gray'}`}
                >
                  {page.data.category}
                </span>
              )}
            </div>
            <h1 className="text-charcoal mt-2 font-mono text-3xl font-bold tracking-tight">
              {page.data.title}
            </h1>
            {page.data.description && (
              <p className="text-warm-gray mt-2 text-lg">{page.data.description}</p>
            )}
            {page.data.tags && page.data.tags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {page.data.tags.map((tag) => (
                  <span
                    key={tag}
                    className="bg-warm-gray/10 text-warm-gray-light rounded-full px-2 py-0.5 font-mono text-xs"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </header>

          <div className="prose prose-headings:text-charcoal prose-p:text-warm-gray prose-li:text-warm-gray prose-strong:text-charcoal prose-code:text-charcoal prose-a:text-charcoal prose-a:underline max-w-none">
            <Mdx components={getMDXComponents()} />
          </div>

          {/* Previous / Next post navigation */}
          {(prevPost || nextPost) && (
            <nav
              className="border-warm-gray-light/30 mt-16 flex items-start justify-between gap-8 border-t pt-8"
              aria-label="Post navigation"
            >
              {prevPost ? (
                <Link href={prevPost.url} className="group flex flex-col gap-1">
                  <span className="text-2xs text-warm-gray-light group-hover:text-brand-orange transition-smooth font-mono tracking-[0.08em] uppercase">
                    ← Older
                  </span>
                  <span className="text-charcoal text-sm font-medium group-hover:underline">
                    {prevPost.data.title}
                  </span>
                </Link>
              ) : (
                <div />
              )}
              {nextPost ? (
                <Link
                  href={nextPost.url}
                  className="group flex flex-col items-end gap-1 text-right"
                >
                  <span className="text-2xs text-warm-gray-light group-hover:text-brand-orange transition-smooth font-mono tracking-[0.08em] uppercase">
                    Newer →
                  </span>
                  <span className="text-charcoal text-sm font-medium group-hover:underline">
                    {nextPost.data.title}
                  </span>
                </Link>
              ) : (
                <div />
              )}
            </nav>
          )}
        </article>

        {page.data.toc.length > 2 && <BlogTOCSidebar toc={page.data.toc} />}
      </div>
    </div>
  );
}

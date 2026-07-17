import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { blog } from '@/lib/source';
import { releaseVersion, sortBlogPagesNewestFirst } from '@/lib/blog-order';
import { getMDXComponents } from '@/components/mdx-components';
import { siteConfig } from '@/config/site';
import {
  gitLastModified,
  readingTimeLabel,
  rssFeedAlternateTypes,
  twitterFromOpenGraph,
} from '@/lib/metadata';
import { NewsletterSignupForm } from '@/layers/shared/ui/newsletter-signup';
import { BlogTOCSidebar } from './_components/BlogTOCSidebar';
import { ReleaseInstallFooter } from './_components/ReleaseInstallFooter';

export function generateStaticParams() {
  return blog.getPages().map((page) => ({
    slug: page.slugs[0],
  }));
}

/**
 * Read a blog post's reading-time label from its source markdown, or null if the
 * file can't be read (e.g. a slug with no on-disk source). Blog sources live at
 * the repo-root `blog/` dir; `process.cwd()` is `apps/site` at build time.
 *
 * @param path - The page's source path, relative to the blog content dir.
 */
function readingTimeFor(path: string): string | null {
  try {
    const raw = readFileSync(join(process.cwd(), '../../blog', path), 'utf-8');
    return readingTimeLabel(raw);
  } catch {
    return null;
  }
}

/**
 * The post's real `modifiedTime`, or `undefined` when there isn't one worth
 * reporting.
 *
 * A same-day git commit is almost certainly the publish commit itself, not a
 * later edit, so it would just echo `publishedTime` under a different label.
 * Only a git date that lands on a later calendar day (UTC) counts as a
 * genuine revision worth surfacing as freshness.
 *
 * Wrapped in React's `cache()` so `generateMetadata` and the page component
 * — both invoked per-request for the same route — resolve to the exact same
 * value instead of computing it twice from two call sites.
 *
 * @param path - The page's source path, relative to the blog content dir.
 * @param publishedTime - The post's frontmatter date, as an ISO string.
 */
const resolveModifiedTime = cache((path: string, publishedTime: string): string | undefined => {
  const gitTime = gitLastModified(`blog/${path}`);
  if (!gitTime) return undefined;
  const publishedDay = publishedTime.slice(0, 10);
  const gitDay = new Date(gitTime).toISOString().slice(0, 10);
  return gitDay > publishedDay ? gitTime : undefined;
});

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  const page = blog.getPage([params.slug]);
  if (!page) notFound();

  const title = page.data.title;
  const description = page.data.description ?? `${siteConfig.name} blog`;
  const readingTime = readingTimeFor(page.path);
  const version = releaseVersion(page.data.title, params.slug);
  const publishedTime = new Date(page.data.date).toISOString();
  const modifiedTime = resolveModifiedTime(page.path, publishedTime);

  // twitter:label1/data1 (and label2/data2) render as chips in X and Slack
  // unfurls. Reading time is the headline chip; release posts add the version.
  const labelChips: Record<string, string> = {};
  if (readingTime) {
    labelChips['twitter:label1'] = 'Reading time';
    labelChips['twitter:data1'] = readingTime;
  }
  if (version) {
    labelChips['twitter:label2'] = 'Version';
    labelChips['twitter:data2'] = version;
  }

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: 'article',
      publishedTime,
      ...(modifiedTime ? { modifiedTime } : {}),
      url: `/blog/${params.slug}`,
      siteName: siteConfig.name,
      tags: page.data.tags,
    },
    twitter: twitterFromOpenGraph({ title, description }),
    ...(Object.keys(labelChips).length > 0 ? { other: labelChips } : {}),
    alternates: {
      canonical: `/blog/${params.slug}`,
      // Article pages are where most readers autodiscover the feed; the page's
      // own `alternates` overwrites the layout's, so re-declare it here.
      types: rssFeedAlternateTypes,
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
  const allPosts = sortBlogPagesNewestFirst(blog.getPages());

  const currentIndex = allPosts.findIndex((p) => p.slugs[0] === params.slug);
  const prevPost = currentIndex < allPosts.length - 1 ? allPosts[currentIndex + 1] : null;
  const nextPost = currentIndex > 0 ? allPosts[currentIndex - 1] : null;

  // BlogPosting JSON-LD structured data. `dateModified` reuses the same
  // honest-freshness check as the openGraph `modifiedTime` in
  // generateMetadata (see resolveModifiedTime) — omitted entirely rather
  // than fabricated when there's no real later edit.
  const publishedTime = new Date(page.data.date).toISOString();
  const modifiedTime = resolveModifiedTime(page.path, publishedTime);
  const blogPostingJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: page.data.title,
    description: page.data.description,
    datePublished: publishedTime,
    ...(modifiedTime ? { dateModified: modifiedTime } : {}),
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
                  // Frontmatter dates parse as UTC midnight; render in UTC so
                  // the day doesn't shift in negative-offset timezones.
                  timeZone: 'UTC',
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

          {/* Install / Update — rendered by the template for every release post
              so install guidance stays current instead of drifting per-post. */}
          {page.data.category === 'release' && (
            <ReleaseInstallFooter title={page.data.title} slug={params.slug} />
          )}

          {/* Newsletter CTA — release notes + fleet reports, ~2/month */}
          <aside className="border-warm-gray-light/30 mt-16 rounded-xl border p-6">
            <p className="text-charcoal mb-1 font-mono text-sm font-bold tracking-tight">
              Get posts like this by email
            </p>
            <NewsletterSignupForm source="blog" variant="card" />
          </aside>

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

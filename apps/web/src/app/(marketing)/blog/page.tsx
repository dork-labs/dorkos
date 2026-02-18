import type { Metadata } from 'next'
import Link from 'next/link'
import { blog } from '@/lib/source'
import { siteConfig } from '@/config/site'

export const metadata: Metadata = {
  title: 'Blog',
  description: `Latest news and updates from ${siteConfig.name}.`,
  openGraph: {
    title: `Blog | ${siteConfig.name}`,
    description: `Latest news and updates from ${siteConfig.name}.`,
    url: '/blog',
    type: 'website',
  },
  alternates: {
    canonical: '/blog',
    types: {
      'application/rss+xml': '/blog/feed.xml',
    },
  },
}

const categoryColors: Record<string, string> = {
  release: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
  tutorial: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  announcement: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  news: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
}

export default function BlogIndex() {
  const posts = blog
    .getPages()
    .sort((a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime())

  return (
    <div className="mx-auto max-w-3xl px-6 py-24">
      <h1 className="mb-2 font-mono text-3xl font-bold tracking-tight">Blog</h1>
      <p className="mb-12 text-neutral-600 dark:text-neutral-400">
        Release notes, tutorials, and updates from the {siteConfig.name} team.
      </p>

      <div className="space-y-8">
        {posts.map((post) => (
          <article key={post.url} className="group">
            <Link href={post.url} className="block">
              <div className="flex items-center gap-3 text-sm text-neutral-500 dark:text-neutral-400">
                <time dateTime={new Date(post.data.date).toISOString()}>
                  {new Date(post.data.date).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </time>
                {post.data.category && (
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${categoryColors[post.data.category] ?? 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'}`}
                  >
                    {post.data.category}
                  </span>
                )}
              </div>
              <h2 className="mt-1 text-xl font-semibold group-hover:underline">
                {post.data.title}
              </h2>
              {post.data.description && (
                <p className="mt-1 text-neutral-600 dark:text-neutral-400">
                  {post.data.description}
                </p>
              )}
            </Link>
          </article>
        ))}

        {posts.length === 0 && (
          <p className="text-neutral-500 dark:text-neutral-400">No posts yet.</p>
        )}
      </div>
    </div>
  )
}

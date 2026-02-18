import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { InlineTOC } from 'fumadocs-ui/components/inline-toc'
import { blog } from '@/lib/source'
import { getMDXComponents } from '@/components/mdx-components'
import { siteConfig } from '@/config/site'

export function generateStaticParams() {
  return blog.getPages().map((page) => ({
    slug: page.slugs[0],
  }))
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const params = await props.params
  const page = blog.getPage([params.slug])
  if (!page) notFound()

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
    },
    alternates: {
      canonical: `/blog/${params.slug}`,
    },
  }
}

export default async function BlogPost(props: {
  params: Promise<{ slug: string }>
}) {
  const params = await props.params
  const page = blog.getPage([params.slug])
  if (!page) notFound()

  const Mdx = page.data.body

  return (
    <article className="mx-auto max-w-3xl px-6 py-24">
      <header className="mb-8">
        <div className="flex items-center gap-3 text-sm text-neutral-500 dark:text-neutral-400">
          <time dateTime={new Date(page.data.date).toISOString()}>
            {new Date(page.data.date).toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            })}
          </time>
          {page.data.author && <span>{page.data.author}</span>}
        </div>
        <h1 className="mt-2 font-mono text-3xl font-bold tracking-tight">
          {page.data.title}
        </h1>
        {page.data.description && (
          <p className="mt-2 text-lg text-neutral-600 dark:text-neutral-400">
            {page.data.description}
          </p>
        )}
      </header>

      {page.data.toc.length > 2 && (
        <InlineTOC items={page.data.toc} />
      )}

      <div className="prose prose-neutral dark:prose-invert max-w-none">
        <Mdx components={getMDXComponents()} />
      </div>
    </article>
  )
}

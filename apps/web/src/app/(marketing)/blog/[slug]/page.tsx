import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { blog } from '@/lib/source'
import { getMDXComponents } from '@/components/mdx-components'
import { siteConfig } from '@/config/site'
import { BlogTOCSidebar } from './_components/BlogTOCSidebar'

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
    <div className="mx-auto max-w-6xl px-6 py-24">
      <div className="flex gap-12">
        <article className="min-w-0 max-w-3xl flex-1">
          <header className="mb-8">
            <div className="flex items-center gap-3 text-sm text-warm-gray-light">
              <time dateTime={new Date(page.data.date).toISOString()}>
                {new Date(page.data.date).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </time>
              {page.data.author && <span>{page.data.author}</span>}
            </div>
            <h1 className="mt-2 font-mono text-3xl font-bold tracking-tight text-charcoal">
              {page.data.title}
            </h1>
            {page.data.description && (
              <p className="mt-2 text-lg text-warm-gray">
                {page.data.description}
              </p>
            )}
          </header>

          <div className="prose max-w-none prose-headings:text-charcoal prose-p:text-warm-gray prose-li:text-warm-gray prose-strong:text-charcoal prose-code:text-charcoal prose-a:text-charcoal prose-a:underline">
            <Mdx components={getMDXComponents()} />
          </div>
        </article>

        {page.data.toc.length > 2 && (
          <BlogTOCSidebar toc={page.data.toc} />
        )}
      </div>
    </div>
  )
}

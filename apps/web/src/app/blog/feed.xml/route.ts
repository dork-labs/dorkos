import { blog } from '@/lib/source'
import { siteConfig } from '@/config/site'

export const dynamic = 'force-static'

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * RSS 2.0 feed for blog posts.
 */
export function GET() {
  const posts = blog
    .getPages()
    .sort((a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime())

  const items = posts
    .map(
      (post) => `    <item>
      <title>${escapeXml(post.data.title)}</title>
      <link>${siteConfig.url}${post.url}</link>
      <guid isPermaLink="true">${siteConfig.url}${post.url}</guid>
      <pubDate>${new Date(post.data.date).toUTCString()}</pubDate>${
        post.data.description
          ? `\n      <description>${escapeXml(post.data.description)}</description>`
          : ''
      }
    </item>`
    )
    .join('\n')

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${siteConfig.name} Blog</title>
    <link>${siteConfig.url}/blog</link>
    <description>Latest news and updates from ${siteConfig.name}.</description>
    <language>en-us</language>
    <atom:link href="${siteConfig.url}/blog/feed.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
    },
  })
}

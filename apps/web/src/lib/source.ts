import { docs, blogPosts } from '@/.source'
import { loader } from 'fumadocs-core/source'
import { openapiPlugin } from 'fumadocs-openapi/server'
import { toFumadocsSource } from 'fumadocs-mdx/runtime/server'

/**
 * Fumadocs source loader for documentation pages.
 *
 * Reads MDX content from the root-level docs/ directory (configured in source.config.ts)
 * and makes it available at the /docs base URL. The openapiPlugin processes
 * generated OpenAPI MDX pages so they can be rendered with the APIPage component.
 */
export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  plugins: [openapiPlugin()],
})

/**
 * Fumadocs source loader for blog posts.
 *
 * Reads MDX content from the root-level blog/ directory (configured in source.config.ts)
 * and makes it available at the /blog base URL.
 */
export const blog = loader({
  baseUrl: '/blog',
  source: toFumadocsSource(blogPosts, []),
})

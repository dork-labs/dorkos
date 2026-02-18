import { defineConfig, defineDocs, defineCollections } from 'fumadocs-mdx/config'
import { z } from 'zod'

export const docs = defineDocs({
  // Points to the root-level docs/ directory in the monorepo
  dir: '../../docs',
})

export const blogPosts = defineCollections({
  type: 'doc',
  dir: '../../blog',
  schema: (ctx) =>
    z.object({
      title: z.string(),
      description: z.string().optional(),
      date: z.coerce.date(),
      author: z.string().optional(),
      category: z.enum(['release', 'tutorial', 'announcement', 'news']).optional(),
      tags: z.array(z.string()).optional(),
      image: z.string().optional(),
    }),
})

export default defineConfig()

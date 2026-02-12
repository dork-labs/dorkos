# Metadata & SEO Guide

## Overview

This guide covers implementing metadata, favicons, Open Graph tags, structured data (JSON-LD), SEO fundamentals, and Answer Engine Optimization (AEO) in Next.js 16. The goal is to make your site discoverable by search engines, presentable in social shares, and readable by AI assistants.

## Key Files

| Concept | Location |
|---------|----------|
| Root metadata | `src/app/layout.tsx` |
| Page-specific metadata | `src/app/[route]/page.tsx` |
| Favicon (legacy) | `src/app/favicon.ico` |
| Dynamic icons | `src/app/icon.tsx`, `src/app/apple-icon.tsx` |
| OG image generation | `src/app/opengraph-image.tsx` |
| Web app manifest | `public/manifest.webmanifest` |
| Robots rules | `src/app/robots.ts` |
| Sitemap generation | `src/app/sitemap.ts` |

## When to Use What

| Scenario | Approach | Why |
|----------|----------|-----|
| Site-wide metadata | Static `metadata` in root `layout.tsx` | Single source of truth, inherited by all pages |
| Page-specific metadata | Static `metadata` export in `page.tsx` | Overrides or extends parent metadata |
| Dynamic metadata (blog posts) | `generateMetadata()` function | Fetches data to build title, description, OG tags |
| Favicon for all browsers | Minimal setup (ico + svg + apple-touch + manifest) | Covers 99%+ of use cases with 4-5 files |
| Social share images | Static file or `opengraph-image.tsx` | 1200x630 images for Facebook, LinkedIn, Twitter |
| Rich search results | JSON-LD structured data | Enables rich snippets, Knowledge Graph |
| AI assistant visibility | AEO patterns | Makes content extractable by ChatGPT, Perplexity |

## Core Patterns

### Next.js Metadata API

Next.js provides a type-safe Metadata API for defining SEO tags. Metadata is inherited from parent layouts and can be overridden or extended by child routes.

#### Static Metadata

For pages with fixed metadata, export a `metadata` object:

```typescript
// src/app/layout.tsx
import type { Metadata, Viewport } from 'next'

export const metadata: Metadata = {
  metadataBase: new URL('https://yoursite.com'),
  title: {
    default: 'Your Site Name',
    template: '%s | Your Site Name', // For child pages
  },
  description: 'A concise description of your site (150-160 chars ideal)',
  keywords: ['keyword1', 'keyword2', 'keyword3'],
  authors: [{ name: 'Your Name', url: 'https://yoursite.com' }],
  creator: 'Your Name',
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://yoursite.com',
    siteName: 'Your Site Name',
    title: 'Your Site Name',
    description: 'A concise description of your site',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Your Site Name',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Your Site Name',
    description: 'A concise description of your site',
    images: ['/og-image.png'],
    creator: '@yourhandle',
  },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafafa' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
  width: 'device-width',
  initialScale: 1,
}
```

#### Dynamic Metadata with generateMetadata

For pages that need to fetch data (blog posts, products), use `generateMetadata`:

```typescript
// src/app/blog/[slug]/page.tsx
import type { Metadata, ResolvingMetadata } from 'next'
import { getPostBySlug } from '@/layers/entities/post'
import { notFound } from 'next/navigation'

type Props = {
  params: Promise<{ slug: string }>
}

export async function generateMetadata(
  { params }: Props,
  parent: ResolvingMetadata
): Promise<Metadata> {
  const { slug } = await params
  const post = await getPostBySlug(slug)

  if (!post) return {}

  // Extend parent OG images instead of replacing
  const previousImages = (await parent).openGraph?.images || []

  return {
    title: post.title,
    description: post.excerpt,
    openGraph: {
      title: post.title,
      description: post.excerpt,
      type: 'article',
      publishedTime: post.createdAt.toISOString(),
      authors: [post.author.name],
      images: [
        {
          url: post.coverImage || '/og-image.png',
          width: 1200,
          height: 630,
        },
        ...previousImages,
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: post.title,
      description: post.excerpt,
      images: [post.coverImage || '/og-image.png'],
    },
  }
}

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params
  const post = await getPostBySlug(slug)

  if (!post) notFound()

  return <article>{/* ... */}</article>
}
```

#### Title Patterns

Next.js supports three title configuration patterns:

```typescript
// Root layout - defines template and default
export const metadata: Metadata = {
  title: {
    template: '%s | Your Site',  // %s is replaced by child page title
    default: 'Your Site',        // Fallback when child has no title
  },
}

// Child page - uses template
export const metadata: Metadata = {
  title: 'About',  // Renders: "About | Your Site"
}

// Child page - ignores template
export const metadata: Metadata = {
  title: {
    absolute: 'Custom Title',  // Renders: "Custom Title" (no template)
  },
}
```

| Pattern | Use Case |
|---------|----------|
| `title.template` | Consistent branding suffix/prefix |
| `title.default` | Fallback for pages without explicit title |
| `title.absolute` | Override template for specific pages (e.g., home page) |

#### Metadata Inheritance

Next.js automatically merges metadata from parent layouts:

```typescript
// app/layout.tsx (parent)
export const metadata = {
  title: 'My App',
  openGraph: {
    title: 'My App',
    description: 'App description',
    siteName: 'My App',
  },
}

// app/about/page.tsx (child)
export const metadata = {
  title: 'About',
  // openGraph.title and openGraph.description inherited from parent
  // Only need to override what changes
}

// Result: title="About", og:title="My App", og:description="App description"
```

**Key behavior:**
- Child metadata **replaces** parent for same keys (not deep merge)
- Unspecified fields **inherit** from parent
- To extend arrays (like OG images), use `generateMetadata` with `parent` parameter

#### Request Memoization

Fetch requests in `generateMetadata` are automatically memoized across the render tree:

```typescript
// This fetch is automatically deduplicated across generateMetadata,
// generateStaticParams, layouts, pages, and Server Components
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const post = await fetch(`https://api.example.com/posts/${slug}`).then(r => r.json())

  return { title: post.title }
}

export default async function Page({ params }: Props) {
  const { slug } = await params
  // Same fetch - reuses memoized result, no duplicate request
  const post = await fetch(`https://api.example.com/posts/${slug}`).then(r => r.json())

  return <article>{post.content}</article>
}
```

**Memoization rules:**
- Only applies to `GET` method in fetch requests
- Only lasts for the current request (not across requests)
- Does not apply to Route Handlers

#### Using React.cache() for Non-Fetch Data

For database queries or other non-fetch data, use `React.cache()` to deduplicate:

```typescript
// src/layers/entities/post/api/queries.ts
import { cache } from 'react'
import { prisma } from '@/lib/prisma'

// Memoize the database query
export const getPostBySlug = cache(async (slug: string) => {
  return prisma.post.findUnique({
    where: { slug },
    include: { author: true },
  })
})
```

```typescript
// src/app/blog/[slug]/page.tsx
import { getPostBySlug } from '@/layers/entities/post'

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const post = await getPostBySlug(slug) // First call - executes query
  return { title: post?.title }
}

export default async function Page({ params }: Props) {
  const { slug } = await params
  const post = await getPostBySlug(slug) // Second call - returns cached result
  return <article>{post?.content}</article>
}
```

#### Streaming Metadata (Next.js 15.2+)

Next.js streams metadata separately from page content, improving perceived performance:

- **Page content renders immediately** while metadata resolves
- **Metadata injected into `<head>`** once `generateMetadata` completes
- **Disabled for bots** (Twitterbot, Slackbot, etc.) that expect metadata in initial HTML

This is automatic—no configuration needed. Just be aware that slow `generateMetadata` functions won't block page rendering.

#### Static vs Dynamic: When to Use What

| Content Type | Approach | Why |
|--------------|----------|-----|
| Fixed content (About, Contact) | Static `metadata` export | No overhead, resolved at build time |
| Blog posts, products | `generateMetadata()` function | Needs data to build title/description |
| Client Component pages | Wrap in `layout.tsx` with static metadata | Client Components can't export metadata |

**Anti-pattern:** Don't use `generateMetadata` for static pages—it adds unnecessary overhead:

```typescript
// Bad: Using generateMetadata for static content
export async function generateMetadata(): Promise<Metadata> {
  return { title: 'About Us' }  // This never changes, why async?
}

// Good: Static export
export const metadata: Metadata = {
  title: 'About Us',
}
```

#### Per-Page Robots Control

Control crawling at the page level via metadata:

```typescript
// Public page - allow indexing
export const metadata: Metadata = {
  robots: {
    index: true,
    follow: true,
  },
}

// Private/draft page - block indexing
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
}

// Advanced: Google-specific directives
export const metadata: Metadata = {
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
}
```

### Favicons & App Icons

Modern favicon setup requires only 4-5 files to cover all browsers and devices. Avoid generating dozens of sizes—most are unnecessary.

#### Minimal Setup (Recommended)

```
public/
├── favicon.ico          # 32x32 ICO for legacy browsers
├── icon.svg             # SVG for modern browsers (scales perfectly)
├── apple-touch-icon.png # 180x180 PNG for iOS home screen
└── manifest.webmanifest # PWA manifest with icon references
```

Add to your root layout's `<head>` via metadata:

```typescript
// src/app/layout.tsx
export const metadata: Metadata = {
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '32x32' },
      { url: '/icon.svg', type: 'image/svg+xml' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
  manifest: '/manifest.webmanifest',
}
```

#### Web App Manifest

```json
// public/manifest.webmanifest
{
  "name": "Your App Name",
  "short_name": "App",
  "description": "Your app description",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#000000",
  "icons": [
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    },
    {
      "src": "/icon-512-maskable.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}
```

#### Icon Sizes Reference

| Size | Purpose | Required? |
|------|---------|-----------|
| 16x16 | Browser tabs, bookmark lists | Via ICO |
| 32x32 | Browser tabs (Retina), Windows taskbar | Yes (ICO) |
| 180x180 | iOS home screen (Apple Touch Icon) | Yes |
| 192x192 | Android home screen (PWA) | Yes |
| 512x512 | PWA splash screen, app stores | Yes |
| 512x512 maskable | Android adaptive icons | Recommended |

#### Dynamic Icon Generation

Next.js can generate icons programmatically using the `ImageResponse` API:

```typescript
// src/app/icon.tsx
import { ImageResponse } from 'next/og'

export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          fontSize: 24,
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          borderRadius: 6,
        }}
      >
        A
      </div>
    ),
    { ...size }
  )
}
```

#### Dark Mode Favicon

Support dark mode with media query variants:

```typescript
export const metadata: Metadata = {
  icons: {
    icon: [
      { url: '/icon-light.svg', type: 'image/svg+xml' },
      {
        url: '/icon-dark.svg',
        type: 'image/svg+xml',
        media: '(prefers-color-scheme: dark)',
      },
    ],
  },
}
```

### Open Graph & Social Cards

Open Graph (OG) tags control how your pages appear when shared on Facebook, LinkedIn, Twitter, Slack, and other platforms.

#### Recommended Image Dimensions

| Platform | Size | Aspect Ratio | Notes |
|----------|------|--------------|-------|
| Universal | 1200x630 | 1.91:1 | Works everywhere, recommended default |
| Facebook | 1200x630 | 1.91:1 | Minimum 600x315 |
| LinkedIn | 1200x627 | 1.91:1 | Nearly identical to Facebook |
| Twitter | 1200x675 | 16:9 | Summary Large Image card |
| Minimum | 600x315 | 1.91:1 | Below this, quality suffers |

#### Static OG Image

Place a static image at `public/og-image.png` (1200x630):

```typescript
export const metadata: Metadata = {
  openGraph: {
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Your Site Name',
      },
    ],
  },
}
```

#### Dynamic OG Image Generation

Generate OG images at build/request time with Next.js:

```typescript
// src/app/opengraph-image.tsx
import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'Your Site Name'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'white',
          fontFamily: 'sans-serif',
        }}
      >
        <h1 style={{ fontSize: 72, fontWeight: 'bold', margin: 0 }}>
          Your Site Name
        </h1>
        <p style={{ fontSize: 32, opacity: 0.9, marginTop: 16 }}>
          Your tagline here
        </p>
      </div>
    ),
    { ...size }
  )
}
```

For dynamic pages (blog posts), create route-specific OG images:

```typescript
// src/app/blog/[slug]/opengraph-image.tsx
import { ImageResponse } from 'next/og'
import { getPostBySlug } from '@/layers/entities/post'

export const runtime = 'edge'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function Image({ params }: { params: { slug: string } }) {
  const post = await getPostBySlug(params.slug)

  return new ImageResponse(
    (
      <div
        style={{
          background: '#1a1a1a',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          padding: 60,
          color: 'white',
        }}
      >
        <h1 style={{ fontSize: 56, fontWeight: 'bold', lineHeight: 1.2 }}>
          {post?.title || 'Blog Post'}
        </h1>
        <p style={{ fontSize: 28, opacity: 0.8, marginTop: 24 }}>
          {post?.excerpt || ''}
        </p>
        <div style={{ marginTop: 'auto', fontSize: 24, opacity: 0.6 }}>
          yoursite.com
        </div>
      </div>
    ),
    { ...size }
  )
}
```

#### Twitter-Specific Tags

Twitter (X) has its own card types:

```typescript
export const metadata: Metadata = {
  twitter: {
    card: 'summary_large_image', // or 'summary', 'player', 'app'
    site: '@yoursite',          // Site's Twitter handle
    creator: '@authorhandle',   // Content creator's handle
    title: 'Page Title',
    description: 'Page description',
    images: {
      url: '/twitter-image.png',
      alt: 'Description of image',
    },
  },
}
```

#### Testing Social Previews

| Platform | Tool |
|----------|------|
| Facebook | [Sharing Debugger](https://developers.facebook.com/tools/debug/) |
| Twitter | [Card Validator](https://cards-dev.twitter.com/validator) |
| LinkedIn | [Post Inspector](https://www.linkedin.com/post-inspector/) |
| General | [opengraph.xyz](https://www.opengraph.xyz/) |

### Structured Data (JSON-LD)

JSON-LD (JavaScript Object Notation for Linked Data) helps search engines understand your content and display rich results (snippets, Knowledge Graph entries).

#### Implementation Pattern

Add JSON-LD as a script tag in your page component:

```typescript
// src/app/page.tsx
export default function HomePage() {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Your Site Name',
    url: 'https://yoursite.com',
    description: 'Your site description',
    potentialAction: {
      '@type': 'SearchAction',
      target: 'https://yoursite.com/search?q={search_term_string}',
      'query-input': 'required name=search_term_string',
    },
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <main>{/* Page content */}</main>
    </>
  )
}
```

**Security note:** The `.replace(/</g, '\\u003c')` prevents XSS attacks by escaping `<` characters in the JSON.

#### Type Safety with schema-dts

Install the `schema-dts` package for TypeScript types:

```bash
pnpm add schema-dts
```

```typescript
import type { WebSite, WithContext } from 'schema-dts'

const jsonLd: WithContext<WebSite> = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: 'Your Site Name',
  url: 'https://yoursite.com',
}
```

#### Common Schema Types

| Content Type | Schema Type | Rich Result |
|--------------|-------------|-------------|
| Home/About | `Organization`, `WebSite` | Knowledge Panel, Sitelinks Search |
| Blog posts | `Article`, `BlogPosting` | Article rich results |
| Products | `Product` | Product rich results, reviews |
| Events | `Event` | Event rich results |
| FAQ pages | `FAQPage` | FAQ dropdowns in SERPs |
| How-to guides | `HowTo` | Step-by-step rich results |
| Recipes | `Recipe` | Recipe cards |
| Local business | `LocalBusiness` | Maps, hours, contact info |
| People | `Person` | Knowledge Panel |
| Breadcrumbs | `BreadcrumbList` | Breadcrumb trails in SERPs |

#### Organization Schema Example

```typescript
const organizationJsonLd: WithContext<Organization> = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Your Company',
  url: 'https://yoursite.com',
  logo: 'https://yoursite.com/logo.png',
  sameAs: [
    'https://twitter.com/yourcompany',
    'https://linkedin.com/company/yourcompany',
    'https://github.com/yourcompany',
  ],
  contactPoint: {
    '@type': 'ContactPoint',
    email: 'hello@yoursite.com',
    contactType: 'customer service',
  },
}
```

#### Article Schema Example

```typescript
// src/app/blog/[slug]/page.tsx
import type { Article, WithContext } from 'schema-dts'

export default async function BlogPostPage({ params }: Props) {
  const { slug } = await params
  const post = await getPostBySlug(slug)

  const articleJsonLd: WithContext<Article> = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.excerpt,
    image: post.coverImage,
    datePublished: post.createdAt.toISOString(),
    dateModified: post.updatedAt.toISOString(),
    author: {
      '@type': 'Person',
      name: post.author.name,
      url: `https://yoursite.com/authors/${post.author.slug}`,
    },
    publisher: {
      '@type': 'Organization',
      name: 'Your Site Name',
      logo: {
        '@type': 'ImageObject',
        url: 'https://yoursite.com/logo.png',
      },
    },
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(articleJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <article>{/* Post content */}</article>
    </>
  )
}
```

#### Breadcrumbs Schema

```typescript
const breadcrumbJsonLd: WithContext<BreadcrumbList> = {
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    {
      '@type': 'ListItem',
      position: 1,
      name: 'Home',
      item: 'https://yoursite.com',
    },
    {
      '@type': 'ListItem',
      position: 2,
      name: 'Blog',
      item: 'https://yoursite.com/blog',
    },
    {
      '@type': 'ListItem',
      position: 3,
      name: post.title,
      item: `https://yoursite.com/blog/${post.slug}`,
    },
  ],
}
```

#### Validation Tools

| Tool | URL |
|------|-----|
| Google Rich Results Test | [search.google.com/test/rich-results](https://search.google.com/test/rich-results) |
| Schema Markup Validator | [validator.schema.org](https://validator.schema.org/) |

### SEO Fundamentals

#### Robots.txt

Control which pages search engines can crawl:

```typescript
// src/app/robots.ts
import type { MetadataRoute } from 'next'

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://yoursite.com'

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/admin/',
          '/_next/',
          '/private/',
        ],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
  }
}
```

#### Sitemap

Generate a sitemap for search engine discovery:

```typescript
// src/app/sitemap.ts
import type { MetadataRoute } from 'next'
import { getAllPosts } from '@/layers/entities/post'

export default async function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://yoursite.com'

  // Static pages
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: baseUrl,
      lastModified: new Date(),
      changeFrequency: 'daily',
      priority: 1,
    },
    {
      url: `${baseUrl}/about`,
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: `${baseUrl}/blog`,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 0.9,
    },
  ]

  // Dynamic pages (blog posts)
  const posts = await getAllPosts()
  const postPages: MetadataRoute.Sitemap = posts.map((post) => ({
    url: `${baseUrl}/blog/${post.slug}`,
    lastModified: post.updatedAt,
    changeFrequency: 'weekly' as const,
    priority: 0.7,
  }))

  return [...staticPages, ...postPages]
}
```

#### Multiple Sitemaps for Large Sites

For sites with 50,000+ URLs, split into multiple sitemaps using `generateSitemaps`:

```typescript
// src/app/sitemap.ts
import type { MetadataRoute } from 'next'

// Generate sitemap index with multiple sitemaps
export async function generateSitemaps() {
  const totalProducts = await getProductCount()
  const sitemapCount = Math.ceil(totalProducts / 50000)

  return Array.from({ length: sitemapCount }, (_, i) => ({ id: i }))
}

// Generate individual sitemap by ID
export default async function sitemap(props: {
  id: Promise<string>
}): Promise<MetadataRoute.Sitemap> {
  const id = Number(await props.id)
  const start = id * 50000
  const end = start + 50000

  const products = await getProducts({ skip: start, take: 50000 })

  return products.map((product) => ({
    url: `https://yoursite.com/products/${product.slug}`,
    lastModified: product.updatedAt,
  }))
}
```

This generates `/sitemap/0.xml`, `/sitemap/1.xml`, etc., and a sitemap index at `/sitemap.xml`.

#### Image Sitemaps

Include images in your sitemap for better image search visibility:

```typescript
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://yoursite.com/blog/my-post',
      lastModified: new Date(),
      images: [
        'https://yoursite.com/images/post-cover.jpg',
        'https://yoursite.com/images/post-diagram.png',
      ],
    },
  ]
}
```

#### Localized Sitemaps

For internationalized sites, include alternate language URLs:

```typescript
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://yoursite.com/about',
      lastModified: new Date(),
      alternates: {
        languages: {
          en: 'https://yoursite.com/about',
          es: 'https://yoursite.com/es/about',
          de: 'https://yoursite.com/de/about',
        },
      },
    },
  ]
}
```

#### Canonical URLs

Prevent duplicate content issues:

```typescript
export const metadata: Metadata = {
  metadataBase: new URL('https://yoursite.com'),
  alternates: {
    canonical: '/', // Resolves to https://yoursite.com/
    languages: {
      'en-US': '/en-US',
      'es': '/es',
    },
  },
}
```

#### Core Web Vitals

Google's performance metrics that affect rankings:

| Metric | Target | What It Measures |
|--------|--------|------------------|
| LCP (Largest Contentful Paint) | < 2.5s | Loading performance |
| INP (Interaction to Next Paint) | < 200ms | Interactivity responsiveness |
| CLS (Cumulative Layout Shift) | < 0.1 | Visual stability |

**Optimization tips:**

1. **Improve LCP:**
   - Use `next/image` for automatic image optimization
   - Preload critical fonts with `next/font`
   - Minimize render-blocking JavaScript

2. **Improve INP:**
   - Break up long JavaScript tasks
   - Use `React.memo()` and `useMemo()` to prevent unnecessary re-renders
   - Defer non-critical JavaScript

3. **Improve CLS:**
   - Always include `width` and `height` on images
   - Reserve space for dynamic content
   - Avoid inserting content above existing content

#### Image Optimization with next/image

The `next/image` component is critical for SEO and Core Web Vitals:

```tsx
import Image from 'next/image'
import heroImage from './hero.png'

// Static import - automatic width/height/blur placeholder
<Image
  src={heroImage}
  alt="Hero image description"  // Required for accessibility + SEO
  placeholder="blur"            // Shows blur while loading
  preload                       // Preload for LCP images (above the fold)
/>

// Remote image - must specify dimensions
<Image
  src="https://example.com/image.jpg"
  alt="Remote image description"
  width={1200}
  height={630}
  loading="lazy"  // Default - defer loading until near viewport
/>
```

**SEO-critical Image attributes:**

| Attribute | Impact | Best Practice |
|-----------|--------|---------------|
| `alt` | Accessibility, image search | Descriptive, includes keywords naturally |
| `width`/`height` | CLS prevention | Always specify to reserve layout space |
| `preload` | LCP improvement | Only for above-the-fold hero/banner images |
| `loading="lazy"` | Performance | Default for below-fold images |
| `placeholder="blur"` | Perceived performance | Use for static imports |

**Remote image configuration:**

```typescript
// next.config.ts
const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.unsplash.com',
      },
      {
        protocol: 'https',
        hostname: 'cdn.yoursite.com',
        pathname: '/uploads/**',
      },
    ],
  },
}
```

#### Semantic HTML

Use proper heading hierarchy and semantic elements:

```tsx
<article>
  <header>
    <h1>Main Article Title</h1>
    <p>Article description or subtitle</p>
  </header>

  <section>
    <h2>First Section</h2>
    <p>Content...</p>

    <h3>Subsection</h3>
    <p>More content...</p>
  </section>

  <section>
    <h2>Second Section</h2>
    <p>Content...</p>
  </section>

  <footer>
    <p>Author info, published date</p>
  </footer>
</article>
```

**Rules:**
- One `<h1>` per page (usually the page title)
- Don't skip heading levels (h1 → h3)
- Use `<article>`, `<section>`, `<nav>`, `<aside>`, `<header>`, `<footer>` appropriately
- Use `<main>` for primary content (one per page)

### Answer Engine Optimization (AEO)

AEO optimizes content for AI-powered search engines like ChatGPT, Perplexity, Google AI Overviews, and Microsoft Copilot. As AI assistants handle more searches, AEO is becoming as important as traditional SEO.

#### Why AEO Matters

- **Gartner predicts** 25% of organic search traffic will shift to AI assistants by 2026
- **Over 50% of searches** in 2025 don't result in clicks—users get answers directly from AI
- **Semrush predicts** LLM traffic will overtake traditional Google search by end of 2027

#### AEO Content Patterns

**1. Structure for Extraction**

AI systems extract information better from well-structured content:

```markdown
## What is [Topic]?

[Clear, concise 1-2 sentence definition]

## Key Features

- **Feature 1**: Brief explanation
- **Feature 2**: Brief explanation
- **Feature 3**: Brief explanation

## How to [Action]

1. First step with clear instruction
2. Second step with clear instruction
3. Third step with clear instruction

## [Topic] vs [Alternative]

| Aspect | [Topic] | [Alternative] |
|--------|---------|---------------|
| Speed | Fast | Medium |
| Cost | $10/mo | $20/mo |
| Ease | Easy | Complex |
```

**2. Answer Questions Directly**

Front-load answers—don't bury them:

```markdown
<!-- Good: Answer first -->
## How long does X take?

X typically takes 2-3 hours. The exact duration depends on...

<!-- Bad: Answer buried -->
## How long does X take?

When considering the various factors involved in X, including preparation
time, execution, and cleanup, as well as potential complications that may
arise during the process, one must consider... [300 words later] ...about
2-3 hours.
```

**3. Build Entity Authority**

Help AI systems understand your expertise:

- Use consistent terminology across your site
- Link internally between related content
- Create dedicated pages for key concepts
- Include author bios with credentials
- Reference authoritative external sources

**4. Structured Data for AI**

JSON-LD isn't just for Google—AI systems also parse it:

```typescript
// FAQ schema helps AI extract Q&A pairs
const faqJsonLd: WithContext<FAQPage> = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'What is the best approach for X?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'The best approach is to...',
      },
    },
  ],
}
```

**5. Content Completeness**

AI prefers comprehensive, self-contained content:

- Answer the full question, not just part of it
- Include relevant context without requiring other pages
- Cover common follow-up questions
- Provide specific examples and data points

#### AEO Checklist

- [ ] Clear heading hierarchy (H1 → H2 → H3)
- [ ] Concise paragraphs (one main idea each)
- [ ] Bullet points and numbered lists for key information
- [ ] Comparison tables where relevant
- [ ] FAQ sections with common questions
- [ ] Definitions at the start of technical terms
- [ ] Specific data points and statistics
- [ ] Author credentials and expertise signals
- [ ] Structured data (JSON-LD) for content type
- [ ] Internal links to related content

## SEO Checklist

### Technical Foundation

- [ ] `robots.txt` allows crawling of important pages
- [ ] XML sitemap generated and submitted to Search Console
- [ ] HTTPS enforced site-wide
- [ ] Canonical URLs set to prevent duplicates
- [ ] Mobile-responsive design
- [ ] Core Web Vitals passing (LCP < 2.5s, INP < 200ms, CLS < 0.1)

### On-Page SEO

- [ ] Unique `<title>` on every page (50-60 characters)
- [ ] Unique `<meta description>` on every page (150-160 characters)
- [ ] One `<h1>` per page matching the topic
- [ ] Semantic heading hierarchy (no skipped levels)
- [ ] Descriptive alt text on images
- [ ] Internal linking between related content
- [ ] Clean, readable URLs with keywords

### Social & Sharing

- [ ] Open Graph tags on all public pages
- [ ] og:image at 1200x630 for each page type
- [ ] Twitter Card tags configured
- [ ] Social preview tested on all platforms

### Structured Data

- [ ] Organization schema on home page
- [ ] Article schema on blog posts
- [ ] Breadcrumb schema for navigation
- [ ] FAQ schema on FAQ pages
- [ ] Validated with Rich Results Test

### Icons & PWA

- [ ] favicon.ico (32x32) present
- [ ] SVG icon for modern browsers
- [ ] Apple Touch Icon (180x180)
- [ ] Web app manifest with 192x192 and 512x512 icons

## Resources

### Official Documentation

- [Next.js Metadata API](https://nextjs.org/docs/app/api-reference/functions/generate-metadata)
- [Next.js JSON-LD Guide](https://nextjs.org/docs/app/guides/json-ld)
- [Schema.org Documentation](https://schema.org/docs/documents.html)
- [Google Search Central](https://developers.google.com/search/docs)

### Testing Tools

- [Google Rich Results Test](https://search.google.com/test/rich-results)
- [Schema Markup Validator](https://validator.schema.org/)
- [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/)
- [Twitter Card Validator](https://cards-dev.twitter.com/validator)
- [PageSpeed Insights](https://pagespeed.web.dev/)

### Favicon Generators

- [RealFaviconGenerator](https://realfavicongenerator.net/)
- [Favicon.io](https://favicon.io/)

### Further Reading

- [How to Favicon in 2025 (Evil Martians)](https://evilmartians.com/chronicles/how-to-favicon-in-2021-six-files-that-fit-most-needs)
- [Answer Engine Optimization Guide (CXL)](https://cxl.com/blog/answer-engine-optimization-aeo-the-comprehensive-guide-for-2025/)
- [Open Graph Protocol Specification](https://ogp.me/)

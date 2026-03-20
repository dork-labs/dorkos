# Feature Catalog System for Marketing Site

**Status:** Draft
**Authors:** Claude Code — 2026-03-20
**Spec:** `specs/site-feature-catalog/02-specification.md`
**Ideation:** `specs/site-feature-catalog/01-ideation.md`

---

## Overview

Build a data-driven feature catalog for the DorkOS marketing site (`apps/site`) that surfaces individual product features with SEO-optimized pages, a browsable `/features` catalog with server-rendered category filtering, and a teaser section on the homepage. This is an additive feature — no existing pages are migrated or removed.

---

## Background / Problem Statement

The marketing site currently describes DorkOS capabilities at the subsystem level (`SubsystemsSection`, `subsystems.ts`) but doesn't surface individual features with dedicated URLs. This means:

- Individual product capabilities have no SEO surface area — they can't be found via long-tail developer searches
- There's no machine-readable feature inventory in `llms.txt` for AI crawlers
- Potential users exploring "what can this actually do?" have no comprehensive answer
- The sitemap has no feature entries

This spec adds a `/features` catalog with individual `/features/[slug]` pages, integrating with the existing SEO infrastructure.

---

## Goals

- Create a typed `Feature` schema as the authoritative data source for all feature metadata
- Expose a `/features` catalog index with server-rendered category tab filtering
- Generate statically-rendered individual pages at `/features/[slug]` with JSON-LD structured data
- Add feature pages to `/sitemap.xml` and `/llms.txt`
- Surface 4-6 featured features on the homepage via a new teaser section
- Add a "features" link to the marketing nav
- Populate an initial catalog of ≥10 real DorkOS features across all 5 categories

## Non-Goals

- Migrating or deprecating `subsystems.ts` / `modules.ts` (deferred to a future cleanup spec)
- Admin CMS or visual editor for the feature catalog
- Client-side JavaScript filtering (harmful for SEO)
- User-submitted content
- The optional MDX per-feature body layer (noted as deferred below)
- Feature flags or product gating logic

---

## Technical Dependencies

- Next.js 16 App Router (`generateStaticParams`, `generateMetadata`, server components, `searchParams`)
- Tailwind CSS v4 + shadcn/ui (new-york, neutral gray)
- `@/config/site` (`siteConfig`) — URL, name, description used in metadata
- `@/layers/features/marketing` — barrel for all marketing feature exports
- No new dependencies required

---

## Detailed Design

### 1. Data Model — `features.ts`

**File:** `apps/site/src/layers/features/marketing/lib/features.ts`

Follows the exact pattern of `subsystems.ts` (interface + exported const array):

```typescript
export type FeatureStatus = 'ga' | 'beta' | 'coming-soon';

/**
 * Subsystem category — maps 1:1 to DorkOS architecture subsystems.
 * Used for grouping and URL param filtering on /features.
 */
export type FeatureCategory = 'console' | 'pulse' | 'relay' | 'mesh' | 'core';

/** Display labels for each category tab on /features */
export const CATEGORY_LABELS: Record<FeatureCategory, string> = {
  console: 'Console',
  pulse: 'Pulse',
  relay: 'Relay',
  mesh: 'Mesh',
  core: 'Core',
};

/**
 * A single DorkOS product feature in the feature catalog.
 *
 * This interface is the authoritative source of truth for feature metadata.
 * TypeScript data is authoritative — MDX files (if added) only contribute body content.
 */
export interface Feature {
  /** URL key — immutable, lowercase-kebab. Used in /features/[slug] route. */
  slug: string;
  /** Display name, e.g. "Pulse Scheduler" */
  name: string;
  /** Subsystem grouping — used for tab filtering on catalog index */
  category: FeatureCategory;
  /**
   * Benefit one-liner ≤80 chars.
   * Used in card hooks, OG title suffix. Must be benefit-led, not feature-led.
   * Good: "Let your agents work while you sleep"
   * Bad: "Provides cron-based task scheduling"
   */
  tagline: string;
  /**
   * Meta-description ready copy: 120-160 chars, problem-first.
   * This is the text used in <meta description> and OG description.
   */
  description: string;
  /** Lifecycle stage — drives badge rendering and catalog filtering */
  status: FeatureStatus;
  /**
   * If true, this feature appears in the homepage FeatureCatalogSection.
   * Maximum 6 featured features at any time.
   */
  featured?: boolean;
  /**
   * 3-5 concrete capability statements, ≤12 words each.
   * Used in benefits bullets on feature pages and in JSON-LD featureList.
   */
  benefits: string[];
  /** Optional media assets */
  media?: {
    /** Path relative to /public, e.g. '/features/pulse-scheduler.png' */
    screenshot?: string;
    /** YouTube embed ID or full URL */
    demoUrl?: string;
    /** Required when screenshot or demoUrl is present (a11y + SEO) */
    alt?: string;
  };
  /**
   * Optional slug linking to a Fumadocs MDX collection entry.
   * When present, the MDX body renders below the structured section on the feature page.
   * This layer is deferred — do not implement in this spec.
   */
  mdxSlug?: string;
  /**
   * Explicit link to documentation, e.g. '/docs/pulse'.
   * Not derived — must be set manually to ensure it stays valid.
   */
  docsUrl?: string;
  /** Other feature slugs for cross-linking on the feature page */
  relatedFeatures?: string[];
  /** Display order within category (lower = first). Defaults to insertion order. */
  sortOrder?: number;
}

export const features: Feature[] = [
  // === CONSOLE ===
  {
    slug: 'chat-interface',
    name: 'Chat Interface',
    category: 'console',
    tagline: 'A web UI for every agent session, with streaming output in real time',
    description:
      'Stop SSH-ing into terminal windows to watch agents run. The Console gives every agent session a persistent, streaming chat UI accessible from any browser.',
    status: 'ga',
    featured: true,
    benefits: [
      'Live streaming output with per-word text animation',
      'Persistent session history across restarts',
      'Tool call cards with expand/collapse and approval UI',
      'File attachment support for context sharing',
      'Works from any browser — laptop, phone, or tablet',
    ],
    docsUrl: '/docs/console',
    relatedFeatures: ['tool-approval', 'question-prompts', 'file-uploads'],
    sortOrder: 1,
  },
  {
    slug: 'tool-approval',
    name: 'Tool Approval',
    category: 'console',
    tagline: 'Approve or reject agent tool calls before they execute',
    description:
      "Agents sometimes ask before they act. Tool Approval surfaces those requests in real time so you stay in the loop without blocking your agents' flow.",
    status: 'ga',
    benefits: [
      'Real-time approval prompts with full tool call context',
      'Approve, reject, or approve-all for a session',
      'Timeout handling — agents continue if you step away',
      'Slack and Telegram delivery via Relay adapters',
    ],
    docsUrl: '/docs/console/tool-approval',
    relatedFeatures: ['chat-interface', 'slack-adapter', 'telegram-adapter'],
    sortOrder: 2,
  },
  {
    slug: 'question-prompts',
    name: 'Question Prompts',
    category: 'console',
    tagline: 'Agents ask questions; you answer from anywhere',
    description:
      "When an agent needs input to continue, it surfaces a structured question prompt in the Console. Answer inline or via your connected chat adapter — agents don't stall.",
    status: 'ga',
    benefits: [
      'Structured question prompts with multiple-choice options',
      'Answer via Console, Slack, or Telegram',
      'Question history persisted in session transcript',
      'Agents resume immediately after your answer',
    ],
    docsUrl: '/docs/console/question-prompts',
    relatedFeatures: ['chat-interface', 'tool-approval'],
    sortOrder: 3,
  },
  {
    slug: 'file-uploads',
    name: 'File Uploads',
    category: 'console',
    tagline: 'Drop files into the chat — agents read them as context',
    description:
      'Paste a spec, attach a screenshot, or upload a log file. File uploads give your agents rich context without terminal copy-paste gymnastics.',
    status: 'ga',
    benefits: [
      'Drag-and-drop or click-to-upload in chat input',
      'Files appear inline in the conversation history',
      'Supports images, PDFs, text, and code files',
    ],
    docsUrl: '/docs/console/file-uploads',
    relatedFeatures: ['chat-interface'],
    sortOrder: 4,
  },

  // === PULSE ===
  {
    slug: 'pulse-scheduler',
    name: 'Pulse Scheduler',
    category: 'pulse',
    tagline: "Schedule agents to run on any cron — they work while you don't",
    description:
      'Stop manually triggering agent runs. Pulse lets you schedule any agent on any cron expression, with a visual builder, preset gallery, and full run history.',
    status: 'ga',
    featured: true,
    benefits: [
      'Visual cron builder with natural-language preview',
      'Preset gallery for common patterns (daily standup, weekly report)',
      'Run history with status, duration, and output',
      'Timezone-aware scheduling',
      'Per-schedule working directory configuration',
    ],
    docsUrl: '/docs/pulse',
    relatedFeatures: ['relay-message-bus', 'mesh-agent-discovery'],
    sortOrder: 1,
  },

  // === RELAY ===
  {
    slug: 'relay-message-bus',
    name: 'Relay Message Bus',
    category: 'relay',
    tagline: 'Agents send and receive messages across any channel',
    description:
      "Relay is the DorkOS inter-agent message bus. It routes messages between agents, human operators, and external services — so your agents aren't isolated processes.",
    status: 'ga',
    featured: true,
    benefits: [
      'Pub/sub message routing between agents',
      'Dead-letter queue for undeliverable messages',
      'Message tracing and activity feed',
      'Pluggable adapter system for any channel',
      'Bindings link adapters to specific agents',
    ],
    docsUrl: '/docs/relay',
    relatedFeatures: ['slack-adapter', 'telegram-adapter', 'mesh-agent-discovery'],
    sortOrder: 1,
  },
  {
    slug: 'slack-adapter',
    name: 'Slack Adapter',
    category: 'relay',
    tagline: 'Chat with your agents in Slack — no context switching required',
    description:
      'The Slack adapter connects DorkOS Relay to your Slack workspace. Send messages, receive agent updates, and approve tool calls without leaving Slack.',
    status: 'beta',
    benefits: [
      'Send messages to agents from any Slack channel',
      'Receive streaming agent responses in Slack',
      'Tool approval and question prompts via Slack buttons',
      'Per-agent Slack binding — route specific agents to specific channels',
    ],
    docsUrl: '/docs/relay/adapters/slack',
    relatedFeatures: ['relay-message-bus', 'tool-approval'],
    sortOrder: 2,
  },
  {
    slug: 'telegram-adapter',
    name: 'Telegram Adapter',
    category: 'relay',
    tagline: 'Monitor and control your agents via Telegram bot',
    description:
      'The Telegram adapter gives every DorkOS agent a Telegram bot interface. Monitor runs, receive notifications, and send commands from your phone.',
    status: 'ga',
    benefits: [
      'Full streaming agent responses in Telegram',
      'Tool approval prompts with inline buttons',
      'Agent-to-adapter binding for targeted routing',
      'Works on mobile — monitor agents anywhere',
    ],
    docsUrl: '/docs/relay/adapters/telegram',
    relatedFeatures: ['relay-message-bus', 'tool-approval'],
    sortOrder: 3,
  },

  // === MESH ===
  {
    slug: 'mesh-agent-discovery',
    name: 'Agent Discovery',
    category: 'mesh',
    tagline: 'DorkOS finds your agents — you just point it at a directory',
    description:
      'Mesh scans your filesystem for running Claude Code agents and registers them automatically. No config files, no IDs to manage — your agents are discoverable the moment they start.',
    status: 'ga',
    featured: true,
    benefits: [
      'Automatic discovery via filesystem scan',
      'Registers agents from Claude Code, Cursor, and custom runtimes',
      'Health monitoring with online/offline status',
      'Cross-namespace agent visibility',
      'Agent registry with capabilities and metadata',
    ],
    docsUrl: '/docs/mesh',
    relatedFeatures: ['mesh-topology', 'relay-message-bus'],
    sortOrder: 1,
  },
  {
    slug: 'mesh-topology',
    name: 'Mesh Topology Graph',
    category: 'mesh',
    tagline: 'See every agent and connection in your mesh at a glance',
    description:
      'The Mesh Topology panel renders your entire agent network as an interactive graph — nodes, bindings, and cross-namespace edges. Understand your system without reading logs.',
    status: 'ga',
    featured: true,
    benefits: [
      'Interactive force-directed graph of all agents',
      'Visual adapter–agent binding edges',
      'Namespace grouping for multi-project meshes',
      'Click-through to agent detail and settings',
      'Respects reduced-motion preferences',
    ],
    docsUrl: '/docs/mesh/topology',
    relatedFeatures: ['mesh-agent-discovery', 'relay-message-bus'],
    sortOrder: 2,
  },

  // === CORE ===
  {
    slug: 'mcp-server',
    name: 'MCP Server',
    category: 'core',
    tagline: 'All DorkOS tools available to any MCP-compatible agent',
    description:
      "DorkOS exposes its full tool suite via a Streamable HTTP MCP server. Any agent that speaks MCP — Claude Code, Cursor, Windsurf — can call Pulse, Relay, and Mesh tools directly.",
    status: 'ga',
    featured: true,
    benefits: [
      'Stateless Streamable HTTP transport — no persistent connections',
      'Optional API key authentication',
      'Full Pulse, Relay, and Mesh tool surface',
      'Works with Claude Code, Cursor, Windsurf, and any MCP client',
      'Auto-documented via OpenAPI at /api/docs',
    ],
    docsUrl: '/docs/mcp',
    relatedFeatures: ['pulse-scheduler', 'relay-message-bus', 'mesh-agent-discovery'],
    sortOrder: 1,
  },
  {
    slug: 'cli',
    name: 'CLI',
    category: 'core',
    tagline: 'One command to install and run DorkOS anywhere',
    description:
      'The `dorkos` CLI installs via npm and starts the full DorkOS stack — server and Console — with a single command. Zero config required to get started.',
    status: 'ga',
    benefits: [
      'Single `npx dorkos` command to start everything',
      'Config precedence: flags > env vars > config file > defaults',
      'Global install or npx — no lockfile required',
      'Docker image available for containerized deployments',
    ],
    docsUrl: '/docs/getting-started',
    relatedFeatures: ['tunnel'],
    sortOrder: 2,
  },
  {
    slug: 'tunnel',
    name: 'Remote Tunnel',
    category: 'core',
    tagline: 'Access your local DorkOS instance from anywhere via secure tunnel',
    description:
      'The built-in ngrok tunnel exposes your local DorkOS server to the internet with a single toggle. Control agents from your phone, share access with a collaborator, or connect from a remote machine.',
    status: 'ga',
    benefits: [
      'One-click tunnel from the Settings panel',
      'Secure HTTPS URL with optional API key protection',
      'QR code for instant mobile access',
      'Works with Relay adapters for remote tool approval',
    ],
    docsUrl: '/docs/tunnel',
    relatedFeatures: ['cli', 'relay-message-bus'],
    sortOrder: 3,
  },
];
```

**Design notes:**
- The `features` array is sorted by `category` then `sortOrder` for predictability
- `featured: true` is set on exactly 6 features (chat-interface, pulse-scheduler, relay-message-bus, mesh-agent-discovery, mesh-topology, mcp-server) — the most representative cross-subsystem selection
- All `tagline` fields are ≤80 chars and benefit-led
- All `description` fields are 120-160 chars and problem-first
- `benefits` arrays have 3-5 items, each ≤12 words

---

### 2. Route: Catalog Index — `/features`

**File:** `apps/site/src/app/(marketing)/features/page.tsx`

Server component. Reads `?category=` from `searchParams` to filter. No client JS.

```typescript
import type { Metadata, SearchParams } from 'next/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { siteConfig } from '@/config/site';
import { features, CATEGORY_LABELS, type FeatureCategory } from '@/layers/features/marketing';
import { FeatureCard } from '@/layers/features/marketing';

export const metadata: Metadata = {
  title: 'Features — DorkOS',
  description:
    'The complete DorkOS feature catalog — scheduling, messaging, agent discovery, and more. Built for developers who ship.',
  alternates: { canonical: '/features' },
  openGraph: {
    title: 'Features — DorkOS',
    description: 'The complete DorkOS feature catalog.',
    url: '/features',
    siteName: siteConfig.name,
  },
};

const VALID_CATEGORIES = Object.keys(CATEGORY_LABELS) as FeatureCategory[];

export default async function FeaturesPage(props: { searchParams: Promise<SearchParams> }) {
  const searchParams = await props.searchParams;
  const rawCategory = searchParams['category'];
  const activeCategory =
    typeof rawCategory === 'string' && VALID_CATEGORIES.includes(rawCategory as FeatureCategory)
      ? (rawCategory as FeatureCategory)
      : null;

  const filteredFeatures = activeCategory
    ? features.filter((f) => f.category === activeCategory)
    : features;

  // Sort within each category by sortOrder, then insertion order
  const sortedFeatures = [...filteredFeatures].sort((a, b) => {
    if (a.category !== b.category) return 0;
    return (a.sortOrder ?? 999) - (b.sortOrder ?? 999);
  });

  return (
    <div className="mx-auto max-w-6xl px-6 pt-32 pb-24">
      <header className="mb-12">
        <h1 className="text-charcoal font-mono text-4xl font-bold tracking-tight">Features</h1>
        <p className="text-warm-gray mt-3 max-w-2xl text-lg">
          Everything DorkOS does — scheduling, messaging, discovery, and control.
        </p>
      </header>

      {/* Category tab strip — pure links, no JS */}
      <nav className="mb-10 flex flex-wrap gap-2" aria-label="Filter by category">
        <CategoryTab href="/features" active={activeCategory === null} label="All" />
        {VALID_CATEGORIES.map((cat) => (
          <CategoryTab
            key={cat}
            href={`/features?category=${cat}`}
            active={activeCategory === cat}
            label={CATEGORY_LABELS[cat]}
          />
        ))}
      </nav>

      {sortedFeatures.length === 0 ? (
        <p className="text-warm-gray-light text-sm">No features in this category yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sortedFeatures.map((feature) => (
            <FeatureCard key={feature.slug} feature={feature} />
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryTab({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-4 py-1.5 font-mono text-xs tracking-[0.04em] transition-colors ${
        active
          ? 'bg-charcoal text-cream-primary'
          : 'border-warm-gray-light/30 text-warm-gray hover:text-charcoal border'
      }`}
    >
      {label}
    </Link>
  );
}
```

**Key constraints:**
- `searchParams` is `Promise<SearchParams>` in Next.js 15+/16 (async params)
- The `CategoryTab` uses `<Link>` not `<button>` — each tab is a navigable URL
- Invalid `?category=` values silently fall back to "All"

---

### 3. Route: Individual Feature Page — `/features/[slug]`

**File:** `apps/site/src/app/(marketing)/features/[slug]/page.tsx`

```typescript
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, ExternalLink, CheckCircle } from 'lucide-react';
import { features, CATEGORY_LABELS } from '@/layers/features/marketing';
import { siteConfig } from '@/config/site';

export function generateStaticParams() {
  return features.map((f) => ({ slug: f.slug }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  const feature = features.find((f) => f.slug === params.slug);
  if (!feature) notFound();

  return {
    title: `${feature.name} — DorkOS`,
    description: feature.description,
    openGraph: {
      title: `${feature.name} — DorkOS`,
      description: feature.description,
      url: `/features/${feature.slug}`,
      siteName: siteConfig.name,
      type: 'website',
    },
    alternates: {
      canonical: `/features/${feature.slug}`,
    },
  };
}

export default async function FeaturePage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const feature = features.find((f) => f.slug === params.slug);
  if (!feature) notFound();

  const relatedFeatureData = (feature.relatedFeatures ?? [])
    .map((slug) => features.find((f) => f.slug === slug))
    .filter(Boolean);

  // BreadcrumbList JSON-LD
  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: siteConfig.url },
      { '@type': 'ListItem', position: 2, name: 'Features', item: `${siteConfig.url}/features` },
      {
        '@type': 'ListItem',
        position: 3,
        name: feature.name,
        item: `${siteConfig.url}/features/${feature.slug}`,
      },
    ],
  };

  // SoftwareApplication JSON-LD scoped to this feature
  const featureJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: `${siteConfig.name} — ${feature.name}`,
    description: feature.description,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    url: `${siteConfig.url}/features/${feature.slug}`,
    featureList: feature.benefits,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };

  return (
    <div className="mx-auto max-w-6xl px-6 pt-32 pb-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(featureJsonLd).replace(/</g, '\\u003c'),
        }}
      />

      {/* Back link */}
      <Link
        href="/features"
        className="text-2xs text-warm-gray-light hover:text-brand-orange transition-smooth mb-8 inline-flex items-center gap-1 font-mono tracking-[0.04em]"
      >
        <ArrowLeft size={12} /> Features
      </Link>

      <div className="max-w-3xl">
        {/* Category + status badges */}
        <div className="mb-4 flex items-center gap-2">
          <span className="text-warm-gray-light border-warm-gray-light/30 rounded-full border px-2.5 py-0.5 font-mono text-xs">
            {CATEGORY_LABELS[feature.category]}
          </span>
          <StatusBadge status={feature.status} />
        </div>

        <h1 className="text-charcoal font-mono text-4xl font-bold tracking-tight">
          {feature.name}
        </h1>
        <p className="text-warm-gray mt-3 text-xl leading-relaxed">{feature.tagline}</p>
        <p className="text-warm-gray-light mt-4 text-base">{feature.description}</p>

        {/* Benefits */}
        {feature.benefits.length > 0 && (
          <ul className="mt-8 space-y-3">
            {feature.benefits.map((benefit) => (
              <li key={benefit} className="flex items-start gap-3">
                <CheckCircle
                  size={16}
                  className="text-brand-orange mt-0.5 shrink-0"
                  strokeWidth={2}
                />
                <span className="text-warm-gray text-base">{benefit}</span>
              </li>
            ))}
          </ul>
        )}

        {/* Screenshot */}
        {feature.media?.screenshot && (
          <figure className="mt-10">
            <img
              src={feature.media.screenshot}
              alt={feature.media.alt ?? `${feature.name} screenshot`}
              className="border-warm-gray-light/20 w-full rounded-lg border shadow-sm"
            />
          </figure>
        )}

        {/* Docs link */}
        {feature.docsUrl && (
          <div className="mt-10">
            <Link
              href={feature.docsUrl}
              className="text-charcoal hover:text-brand-orange transition-smooth inline-flex items-center gap-1.5 font-mono text-sm font-medium"
            >
              Read the docs <ExternalLink size={12} />
            </Link>
          </div>
        )}

        {/* Related features */}
        {relatedFeatureData.length > 0 && (
          <section className="mt-12">
            <h2 className="text-charcoal mb-4 font-mono text-sm font-semibold uppercase tracking-[0.08em]">
              Related Features
            </h2>
            <div className="flex flex-wrap gap-2">
              {relatedFeatureData.map((related) => (
                <Link
                  key={related!.slug}
                  href={`/features/${related!.slug}`}
                  className="border-warm-gray-light/30 text-warm-gray hover:text-charcoal hover:border-warm-gray transition-smooth inline-flex items-center gap-1 rounded-full border px-3 py-1 font-mono text-xs"
                >
                  {related!.name} <ArrowRight size={10} />
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ga: 'bg-emerald-100/60 text-emerald-900',
    beta: 'bg-amber-100/60 text-amber-900',
    'coming-soon': 'bg-warm-gray/10 text-warm-gray-light',
  };
  const labels: Record<string, string> = {
    ga: 'Available',
    beta: 'Beta',
    'coming-soon': 'Coming Soon',
  };
  return (
    <span className={`rounded-full px-2.5 py-0.5 font-mono text-xs ${styles[status] ?? ''}`}>
      {labels[status] ?? status}
    </span>
  );
}
```

---

### 4. Route: OG Image — `/features/[slug]/opengraph-image.tsx`

**File:** `apps/site/src/app/(marketing)/features/[slug]/opengraph-image.tsx`

```typescript
import { ImageResponse } from 'next/og';
import { features } from '@/layers/features/marketing';
import { siteConfig } from '@/config/site';

export const alt = 'DorkOS Feature';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function Image(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const feature = features.find((f) => f.slug === params.slug);

  return new ImageResponse(
    (
      <div
        style={{
          background: '#F5F0E8',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '80px',
        }}
      >
        <div style={{ fontSize: 16, color: '#9B8E7E', fontFamily: 'monospace', marginBottom: 24 }}>
          {siteConfig.name}
        </div>
        <div
          style={{ fontSize: 56, fontWeight: 700, color: '#1A1714', fontFamily: 'monospace', lineHeight: 1.1 }}
        >
          {feature?.name ?? 'Feature'}
        </div>
        <div style={{ fontSize: 24, color: '#6B5E4E', marginTop: 20, maxWidth: 800 }}>
          {feature?.tagline}
        </div>
      </div>
    ),
    size
  );
}
```

---

### 5. Component: `FeatureCard`

**File:** `apps/site/src/layers/features/marketing/ui/FeatureCard.tsx`

```typescript
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { Feature } from '../lib/features';
import { CATEGORY_LABELS } from '../lib/features';

interface FeatureCardProps {
  feature: Feature;
}

/**
 * Compact feature card for use in catalog grids.
 * Links to /features/[slug].
 */
export function FeatureCard({ feature }: FeatureCardProps) {
  const statusStyles: Record<string, string> = {
    ga: 'bg-emerald-100/60 text-emerald-900',
    beta: 'bg-amber-100/60 text-amber-900',
    'coming-soon': 'bg-warm-gray/10 text-warm-gray-light',
  };
  const statusLabels: Record<string, string> = {
    ga: 'Available',
    beta: 'Beta',
    'coming-soon': 'Coming Soon',
  };

  return (
    <Link
      href={`/features/${feature.slug}`}
      className="border-warm-gray-light/20 hover:border-warm-gray-light/50 hover:shadow-sm transition-smooth group flex flex-col rounded-xl border bg-white/40 p-5"
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="text-warm-gray-light border-warm-gray-light/30 rounded-full border px-2 py-0.5 font-mono text-xs">
          {CATEGORY_LABELS[feature.category]}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 font-mono text-xs ${statusStyles[feature.status] ?? ''}`}
        >
          {statusLabels[feature.status] ?? feature.status}
        </span>
      </div>

      <h3 className="text-charcoal group-hover:text-brand-orange transition-smooth mb-1 font-mono text-base font-semibold">
        {feature.name}
      </h3>
      <p className="text-warm-gray mb-4 flex-1 text-sm leading-relaxed">{feature.tagline}</p>

      <div className="text-warm-gray-light group-hover:text-brand-orange transition-smooth flex items-center gap-1 font-mono text-xs">
        Learn more <ArrowRight size={10} />
      </div>
    </Link>
  );
}
```

---

### 6. Component: `FeatureCatalogSection` (Homepage Teaser)

**File:** `apps/site/src/layers/features/marketing/ui/FeatureCatalogSection.tsx`

```typescript
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { features } from '../lib/features';
import { FeatureCard } from './FeatureCard';

/**
 * Homepage teaser section — shows featured features in a grid with
 * a link to the full /features catalog.
 */
export function FeatureCatalogSection() {
  const featuredFeatures = features.filter((f) => f.featured);

  return (
    <section className="mx-auto max-w-6xl px-6 py-20">
      <div className="mb-10 flex items-end justify-between">
        <div>
          <h2 className="text-charcoal font-mono text-3xl font-bold tracking-tight">
            Built for how you actually work
          </h2>
          <p className="text-warm-gray mt-2 text-lg">
            Every subsystem designed to get out of the way.
          </p>
        </div>
        <Link
          href="/features"
          className="text-warm-gray-light hover:text-brand-orange transition-smooth hidden items-center gap-1.5 font-mono text-sm sm:flex"
        >
          All features <ArrowRight size={14} />
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {featuredFeatures.map((feature) => (
          <FeatureCard key={feature.slug} feature={feature} />
        ))}
      </div>

      <div className="mt-8 sm:hidden">
        <Link
          href="/features"
          className="text-warm-gray-light hover:text-brand-orange transition-smooth inline-flex items-center gap-1.5 font-mono text-sm"
        >
          View all features <ArrowRight size={14} />
        </Link>
      </div>
    </section>
  );
}
```

---

### 7. Modified Files

#### 7.1 `apps/site/src/layers/features/marketing/index.ts`

Add after existing data exports:
```typescript
// Feature catalog
export { features, CATEGORY_LABELS } from './lib/features';
export type { Feature, FeatureStatus, FeatureCategory } from './lib/features';

// Feature catalog components
export { FeatureCard } from './ui/FeatureCard';
export { FeatureCatalogSection } from './ui/FeatureCatalogSection';
```

#### 7.2 `apps/site/src/app/sitemap.ts`

Add feature pages to the sitemap array:
```typescript
import { features } from '@/layers/features/marketing';

// Add to the function body:
const featureCatalogPage: MetadataRoute.Sitemap = [
  {
    url: `${BASE_URL}/features`,
    lastModified: new Date(),
    changeFrequency: 'monthly',
    priority: 0.7,
  },
];

const featurePages: MetadataRoute.Sitemap = features.map((feature) => ({
  url: `${BASE_URL}/features/${feature.slug}`,
  lastModified: new Date(),
  changeFrequency: 'monthly' as const,
  priority: 0.8,
}));

return [...staticPages, ...featureCatalogPage, ...featurePages, ...docPages, ...blogPages];
```

#### 7.3 `apps/site/src/app/llms.txt/route.ts`

Add `buildFeaturesSection()` helper and include it in the template:

```typescript
import { features } from '@/layers/features/marketing/lib/features';

// Add new section builder:
function buildFeaturesSection(): string {
  return features
    .map((f) => `- **${f.name}** (${f.category}): ${f.tagline}`)
    .join('\n');
}

// In the GET() template, add after ## Core Capabilities:
`## Features

${buildFeaturesSection()}
`
```

The full template becomes:
```
## Core Capabilities
...

## Features
...

## Documentation
...
```

#### 7.4 `apps/site/src/app/(marketing)/page.tsx`

**Add `FeatureCatalogSection` to homepage.** Insert after `SubsystemsSection` — the subsystems section gives the high-level "here's what DorkOS does" pitch, and `FeatureCatalogSection` provides the "here's what that looks like in practice" follow-through:

```typescript
import {
  // ... existing imports ...
  SubsystemsSection,
  FeatureCatalogSection,  // <-- add this
  HonestySection,
} from '@/layers/features/marketing';

// In the JSX:
<SubsystemsSection />
<FeatureCatalogSection />  {/* <-- insert here */}
<HonestySection />
```

**Add "features" to nav links:**
```typescript
const navLinks = [
  { label: 'features', href: '/features' },  // <-- add first
  { label: 'about', href: '#about' },
  { label: 'blog', href: '/blog' },
  { label: 'docs', href: '/docs' },
];
```

---

### 8. Data Flow

```
features.ts (const array — authoritative)
  │
  ├── /features/page.tsx
  │     reads ?category= searchParam
  │     renders FeatureCard grid
  │     → links to /features/[slug]
  │
  ├── /features/[slug]/page.tsx
  │     generateStaticParams() → pre-renders all slugs
  │     generateMetadata() → title, description, OG
  │     JSON-LD: BreadcrumbList + SoftwareApplication
  │     renders: name, tagline, status, benefits, media, related
  │
  ├── /features/[slug]/opengraph-image.tsx
  │     ImageResponse with feature name + tagline
  │
  ├── /sitemap.ts
  │     featurePages: priority 0.8
  │     featureCatalogPage: priority 0.7
  │
  ├── /llms.txt/route.ts
  │     ## Features section
  │
  └── (marketing)/page.tsx
        FeatureCatalogSection (featured: true features only)
        navLinks includes /features
```

---

## User Experience

### Discovering Features

1. User arrives at homepage → sees `FeatureCatalogSection` with 6 featured feature cards
2. Clicks "All features →" → lands on `/features`
3. Browses the full catalog — by default sees all 13+ features in a 3-column grid
4. Clicks a category tab (e.g. "Relay") → URL updates to `/features?category=relay`, server re-renders with filtered grid
5. Clicks a feature card → lands on `/features/pulse-scheduler`

### Individual Feature Page

- Above the fold: category badge, status badge, feature name, tagline, description
- Below: benefits checklist, optional screenshot, docs link, related features
- Breadcrumb: Home > Features > Feature Name (also in JSON-LD)
- Navigation: back arrow links to `/features`

### SEO Discovery Path

1. User searches "DorkOS Pulse scheduler" or "agent cron scheduling tool"
2. Google finds `/features/pulse-scheduler` with proper title/description/JSON-LD
3. User lands directly on feature page without needing to find the homepage first

---

## Testing Strategy

### Unit Tests — Not Required

The data layer (`features.ts`) is a static TypeScript const — no runtime behavior to test. Type correctness is validated by the compiler.

### Component Tests — `FeatureCard`

**File:** `apps/site/src/layers/features/marketing/ui/__tests__/FeatureCard.test.tsx`

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { FeatureCard } from '../FeatureCard';
import type { Feature } from '../../lib/features';

const mockFeature: Feature = {
  slug: 'test-feature',
  name: 'Test Feature',
  category: 'core',
  tagline: 'A tagline that explains the benefit',
  description: 'A description of the feature that is 120-160 chars for testing purposes here.',
  status: 'ga',
  benefits: ['First benefit here', 'Second benefit here'],
};

describe('FeatureCard', () => {
  it('renders feature name and tagline', () => {
    render(<FeatureCard feature={mockFeature} />);
    expect(screen.getByText('Test Feature')).toBeInTheDocument();
    expect(screen.getByText('A tagline that explains the benefit')).toBeInTheDocument();
  });

  it('links to the correct feature slug', () => {
    render(<FeatureCard feature={mockFeature} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/features/test-feature');
  });

  it('renders category and status badges', () => {
    render(<FeatureCard feature={mockFeature} />);
    expect(screen.getByText('Core')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
  });

  it('renders beta badge for beta status', () => {
    render(<FeatureCard feature={{ ...mockFeature, status: 'beta' }} />);
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('renders Coming Soon badge for coming-soon status', () => {
    render(<FeatureCard feature={{ ...mockFeature, status: 'coming-soon' }} />);
    expect(screen.getByText('Coming Soon')).toBeInTheDocument();
  });
});
```

### Component Tests — `FeatureCatalogSection`

**File:** `apps/site/src/layers/features/marketing/ui/__tests__/FeatureCatalogSection.test.tsx`

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { FeatureCatalogSection } from '../FeatureCatalogSection';

// Mock the features module to control which features appear
vi.mock('../../lib/features', () => ({
  features: [
    { slug: 'f1', name: 'Feature One', category: 'core', tagline: 'Tagline 1',
      description: 'Desc 1', status: 'ga', featured: true, benefits: [] },
    { slug: 'f2', name: 'Feature Two', category: 'pulse', tagline: 'Tagline 2',
      description: 'Desc 2', status: 'ga', featured: true, benefits: [] },
    { slug: 'f3', name: 'Feature Three', category: 'relay', tagline: 'Tagline 3',
      description: 'Desc 3', status: 'ga', featured: false, benefits: [] }, // not featured
  ],
  CATEGORY_LABELS: { core: 'Core', pulse: 'Pulse', relay: 'Relay' },
}));

describe('FeatureCatalogSection', () => {
  it('renders only featured features', () => {
    render(<FeatureCatalogSection />);
    expect(screen.getByText('Feature One')).toBeInTheDocument();
    expect(screen.getByText('Feature Two')).toBeInTheDocument();
    expect(screen.queryByText('Feature Three')).not.toBeInTheDocument();
  });

  it('renders View all features link to /features', () => {
    render(<FeatureCatalogSection />);
    const links = screen.getAllByRole('link', { name: /all features/i });
    expect(links.length).toBeGreaterThan(0);
    expect(links[0]).toHaveAttribute('href', '/features');
  });
});
```

### Data Integrity Tests

**File:** `apps/site/src/layers/features/marketing/lib/__tests__/features.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import { features, CATEGORY_LABELS, type FeatureCategory } from '../features';

describe('features catalog data integrity', () => {
  it('all slugs are unique', () => {
    const slugs = features.map((f) => f.slug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(slugs.length);
  });

  it('all relatedFeatures references resolve to valid slugs', () => {
    const allSlugs = new Set(features.map((f) => f.slug));
    for (const feature of features) {
      for (const ref of feature.relatedFeatures ?? []) {
        expect(allSlugs.has(ref)).toBe(true);
      }
    }
  });

  it('all taglines are ≤80 chars', () => {
    for (const feature of features) {
      expect(feature.tagline.length).toBeLessThanOrEqual(80);
    }
  });

  it('all descriptions are 120-160 chars', () => {
    for (const feature of features) {
      expect(feature.description.length).toBeGreaterThanOrEqual(120);
      expect(feature.description.length).toBeLessThanOrEqual(160);
    }
  });

  it('each feature has 3-5 benefits', () => {
    for (const feature of features) {
      expect(feature.benefits.length).toBeGreaterThanOrEqual(3);
      expect(feature.benefits.length).toBeLessThanOrEqual(5);
    }
  });

  it('featured features count is ≤6', () => {
    const featuredCount = features.filter((f) => f.featured).length;
    expect(featuredCount).toBeLessThanOrEqual(6);
  });

  it('covers all 5 categories', () => {
    const categories = new Set(features.map((f) => f.category));
    const allCategories = Object.keys(CATEGORY_LABELS) as FeatureCategory[];
    for (const cat of allCategories) {
      expect(categories.has(cat)).toBe(true);
    }
  });

  it('media items with screenshot have alt text', () => {
    for (const feature of features) {
      if (feature.media?.screenshot) {
        expect(feature.media.alt).toBeTruthy();
      }
    }
  });
});
```

---

## Performance Considerations

- **All routes are statically generated** — `generateStaticParams` pre-renders every feature page at build time. No runtime database queries.
- **Catalog index is server-rendered** — `?category=` filtering happens on the server via `searchParams`; no client JS bundle for filtering.
- **OG images are generated on-demand and cached** — Next.js caches `ImageResponse` outputs automatically.
- **`features.ts` is imported at build time only** — no runtime cost; TypeScript module evaluated once.
- **No new dependencies added** — no bundle size impact.

---

## Security Considerations

- **No user input surfaces** — the `?category=` param is validated against `VALID_CATEGORIES` before use; invalid values silently fall back to "All"
- **JSON-LD XSS prevention** — all JSON-LD blocks use `.replace(/</g, '\\u003c')` (identical to the blog pattern)
- **Static images only** — no image upload surface; screenshots are `/public` assets with static paths
- **No API routes added** — this spec adds only Next.js page routes and static data

---

## Documentation

- Update `apps/site/src/app/llms.txt/route.ts` with `## Features` section (spec includes this)
- The feature catalog is self-documenting via feature page content
- No `contributing/` guide update required — the pattern follows `subsystems.ts` exactly

---

## Implementation Phases

### Phase 1 — Data Layer & Routes (Core)
1. Create `features.ts` with initial catalog (≥10 features, 5 categories)
2. Export from `index.ts`
3. Create `FeatureCard` component
4. Create `/features/page.tsx` (catalog index with category tabs)
5. Create `/features/[slug]/page.tsx` (individual feature pages)
6. Create `/features/[slug]/opengraph-image.tsx`

### Phase 2 — SEO Integration
7. Update `sitemap.ts` to include feature pages
8. Update `llms.txt/route.ts` to add `## Features` section

### Phase 3 — Homepage & Nav
9. Create `FeatureCatalogSection` component
10. Add `FeatureCatalogSection` to `(marketing)/page.tsx` after `SubsystemsSection`
11. Add "features" to `navLinks` in `(marketing)/page.tsx`

### Phase 4 — Tests
12. Write data integrity tests (`features.test.ts`)
13. Write component tests (`FeatureCard.test.tsx`, `FeatureCatalogSection.test.tsx`)
14. Verify TypeScript compiles cleanly across all new files

---

## Open Questions

_All questions from ideation resolved. No open questions remain._

---

## Deferred Work

- **Optional MDX per-feature body layer**: `features.ts` includes `mdxSlug?: string` as an opt-in field. Activation requires adding `defineCollections` for a `features/` directory in `source.config.ts` and a Fumadocs loader in `lib/source.ts`. This is intentionally not implemented here — the field reserves the contract without adding complexity.
- **`subsystems.ts` / `modules.ts` migration**: The feature catalog overlaps semantically with `subsystems.ts`. A future spec should migrate the homepage sections to use `features.ts` as the data source and remove the overlap.
- **Feature page analytics**: Add event tracking for feature page views and docs link clicks.
- **Search integration**: Fumadocs search currently covers docs and blog. Feature pages are not indexed in site search — deferred.

---

## Related ADRs

- None directly applicable. Relevant patterns from existing ADRs:
  - `decisions/` — check for any ADRs on site architecture or SEO conventions

---

## References

- `apps/site/src/app/(marketing)/blog/[slug]/page.tsx` — dynamic route + JSON-LD reference implementation
- `apps/site/src/layers/features/marketing/lib/subsystems.ts` — data pattern reference
- `apps/site/src/app/sitemap.ts` — sitemap extension pattern
- `apps/site/src/app/llms.txt/route.ts` — llms.txt section addition pattern
- [Next.js `generateStaticParams`](https://nextjs.org/docs/app/api-reference/functions/generate-static-params)
- [Schema.org SoftwareApplication](https://schema.org/SoftwareApplication)
- [Next.js `searchParams` in Server Components](https://nextjs.org/docs/app/api-reference/file-conventions/page#searchparams-optional)

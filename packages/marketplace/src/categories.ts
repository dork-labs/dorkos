/**
 * @dorkos/marketplace — Controlled marketplace category vocabulary.
 *
 * The single source of truth for the closed, CI-checked list of category
 * slugs that DorkOS-authored packages may belong to. The vocabulary binds the
 * plural `categories[]` membership field (ADR-0236 sidecar + `.dork/manifest.json`)
 * and the DorkOS registry vocabulary check — it never constrains the singular,
 * CC-interop `category` field or the inbound `marketplace.json` parser, both of
 * which stay lenient so foreign Claude Code marketplaces and legacy packages
 * keep parsing.
 *
 * This module is browser-safe — it imports `zod` only and has no Node.js
 * dependencies, so it can be consumed by `apps/client` and `apps/site`
 * (mirrors `package-types.ts`).
 *
 * @module @dorkos/marketplace/categories
 */

import { z } from 'zod';

/**
 * Closed, ordered marketplace category vocabulary (v1). The order is
 * meaningful — it is the canonical display order for facet chips, SEO
 * `generateStaticParams`, and dropdowns. Adding, removing, or renaming a
 * slug is a breaking taxonomy change: bump nothing here, but ship a backfill
 * migration for the registry (see the spec's Registry Backfill section).
 */
export const MARKETPLACE_CATEGORIES = [
  // Act 1 — dev-facing
  'code-review',
  'security',
  'release-ops',
  'observability',
  'documentation',
  'agent-ops',
  'project-management',
  'dev-tools',
  // Cross-cutting
  'integrations',
  'productivity',
  // Act 2 — business seeds
  'marketing',
  'sales-crm',
  'content',
  'support',
  'accounting',
  'research',
] as const;

/** A single controlled category slug. */
export const MarketplaceCategorySchema = z.enum(MARKETPLACE_CATEGORIES);

/** A controlled category slug (`'code-review' | 'security' | …`). */
export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

/** Human display label for each category. Exhaustive over the enum. */
export const CATEGORY_LABELS: Record<MarketplaceCategory, string> = {
  'code-review': 'Code Review',
  security: 'Security',
  'release-ops': 'Release Ops',
  observability: 'Observability',
  documentation: 'Documentation',
  'agent-ops': 'Agent Ops',
  'project-management': 'Project Management',
  'dev-tools': 'Developer Tools',
  integrations: 'Integrations',
  productivity: 'Productivity',
  marketing: 'Marketing',
  'sales-crm': 'Sales & CRM',
  content: 'Content',
  support: 'Support',
  accounting: 'Accounting',
  research: 'Research',
};

/**
 * One-line, honest description per category — used as the SEO route's meta
 * description seed and the facet-chip tooltip. Plain language, no hype, no
 * unverified capability claims (demo-claim gate). Exhaustive over the enum.
 */
export const CATEGORY_DESCRIPTIONS: Record<MarketplaceCategory, string> = {
  'code-review': 'Agents and packages that review code and pull requests.',
  security: 'Security auditing, dependency and configuration checks.',
  'release-ops': 'Release, versioning, and deploy workflows.',
  observability: 'Monitoring, analytics, and run tracking.',
  documentation: 'Keeping docs in sync with your code.',
  'agent-ops': 'Orchestrating, scheduling, and coordinating agents.',
  'project-management': 'Issue tracking, boards, and planning.',
  'dev-tools': 'Tooling for building on and extending DorkOS.',
  integrations: 'Connectors and adapters for outside services.',
  productivity: 'Personal planning and knowledge work.',
  marketing: 'Content marketing, campaigns, and outreach.',
  'sales-crm': 'Contacts, pipeline, and follow-ups.',
  content: 'Drafting, editing, and publishing content.',
  support: 'Customer support and help workflows.',
  accounting: 'Bookkeeping, invoicing, and finance.',
  research: 'Gathering, summarizing, and analyzing information.',
};

/**
 * Derive a package's primary category from its multi-membership list and its
 * legacy singular field. `categories[0]` wins; the singular `category` is the
 * back-compat fallback for packages that predate `categories[]`.
 *
 * @param categories - The multi-membership list, if present.
 * @param category - The legacy singular category, if present.
 * @returns The primary category slug, or `undefined` when uncategorized.
 */
export function primaryCategory(
  categories: readonly string[] | undefined,
  category: string | undefined
): string | undefined {
  return categories?.[0] ?? category;
}

/** Narrow an arbitrary string to a controlled category (or `undefined`). */
export function asMarketplaceCategory(value: string): MarketplaceCategory | undefined {
  return (MARKETPLACE_CATEGORIES as readonly string[]).includes(value)
    ? (value as MarketplaceCategory)
    : undefined;
}

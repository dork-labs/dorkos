/**
 * The role → recommendations mapping (spec `user-profile-onboarding`).
 *
 * Pure data plus one pure function; no I/O, no ML. A lookup table anyone can
 * read and correct: given the roles a person saved in `config.profile.roles`,
 * it suggests which connector services and marketplace searches fit their work.
 * Consumers: the onboarding suggestion line (`dorkbotProfileSuggestionLine` in
 * `@dorkos/shared/dorkbot-templates`) and the Connections page + marketplace
 * surface (spec `connector-completion`, which ranks its list with this data).
 *
 * The mapping deliberately says nothing about whether a connector is currently
 * installable — the consuming surface filters against what it can actually
 * offer, which keeps this module honest data. Marketplace entries are search
 * TERMS, never package ids, so catalog churn never needs a data migration
 * (spec decision D5).
 *
 * @module profile-recommendations
 */

/** One suggested role: its stable id and the label onboarding shows on a chip. */
export interface CanonRole {
  /** Stable id, saved into `config.profile.roles` when the chip is picked. */
  id: string;
  /** Plain-language chip label (e.g. "Building software"). */
  label: string;
}

/**
 * The suggested roles with UI labels. Onboarding shows the first six as chips
 * (plus free text); the full canon backs alias matching in
 * {@link recommendForRoles}.
 */
export const ROLE_CANON = [
  { id: 'software-development', label: 'Building software' },
  { id: 'hiring', label: 'Hiring people' },
  { id: 'marketing', label: 'Marketing' },
  { id: 'writing', label: 'Writing' },
  { id: 'research', label: 'Research' },
  { id: 'business-ops', label: 'Running a business' },
  { id: 'design', label: 'Design' },
  { id: 'sales', label: 'Sales' },
] as const satisfies readonly CanonRole[];

/** One of the canonical role ids in {@link ROLE_CANON}. */
export type CanonRoleId = (typeof ROLE_CANON)[number]['id'];

/** How many of the canon roles onboarding offers as quick-pick chips. */
export const ONBOARDING_ROLE_CHIP_COUNT = 6;

/**
 * Normalization table for free-form role input. Keys are lowercase; input is
 * lowercase-trimmed before lookup. Grown from the obvious spellings first;
 * widen it from real free-form answers later (locally observed — nothing is
 * phoned home, so growth comes from dogfood and user reports, not analytics).
 */
export const ROLE_ALIASES: Readonly<Record<string, CanonRoleId>> = {
  developer: 'software-development',
  engineer: 'software-development',
  programmer: 'software-development',
  coder: 'software-development',
  'software engineer': 'software-development',
  recruiter: 'hiring',
  recruiting: 'hiring',
  talent: 'hiring',
  marketer: 'marketing',
  growth: 'marketing',
  writer: 'writing',
  author: 'writing',
  researcher: 'research',
  scientist: 'research',
  founder: 'business-ops',
  entrepreneur: 'business-ops',
  operations: 'business-ops',
  ops: 'business-ops',
  designer: 'design',
  seller: 'sales',
  salesperson: 'sales',
};

/** What one canon role suggests: connector toolkit slugs + marketplace search terms. */
export interface RoleRecommendationEntry {
  /** Connector toolkit slugs from the connector-gateway vocabulary (e.g. `gmail`). */
  connectors: readonly string[];
  /** Marketplace search terms — terms, never package ids (spec D5). */
  marketplaceSearch: readonly string[];
}

/**
 * The role → suggestions table. Connector entries are toolkit slugs from the
 * connector-gateway vocabulary; the consuming surface resolves them against
 * what it can actually offer.
 */
export const ROLE_RECOMMENDATIONS: Readonly<Record<CanonRoleId, RoleRecommendationEntry>> = {
  'software-development': {
    connectors: ['github', 'linear'],
    marketplaceSearch: ['code review', 'issue tracking'],
  },
  hiring: {
    connectors: ['gmail', 'greenhouse'],
    marketplaceSearch: ['recruiting', 'email'],
  },
  marketing: {
    connectors: ['hubspot', 'slack'],
    marketplaceSearch: ['marketing', 'content'],
  },
  writing: {
    connectors: ['notion', 'gmail'],
    marketplaceSearch: ['writing', 'notes'],
  },
  research: {
    connectors: ['notion', 'github'],
    marketplaceSearch: ['research', 'notes'],
  },
  'business-ops': {
    connectors: ['gmail', 'slack'],
    marketplaceSearch: ['operations', 'email'],
  },
  design: {
    connectors: ['figma', 'slack'],
    marketplaceSearch: ['design', 'feedback'],
  },
  sales: {
    connectors: ['hubspot', 'gmail'],
    marketplaceSearch: ['sales', 'crm'],
  },
};

/**
 * Plain display names for the connector slugs the mapping can suggest, so a
 * spoken suggestion line says "Gmail and Greenhouse", never raw slugs.
 */
export const CONNECTOR_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  github: 'GitHub',
  linear: 'Linear',
  gmail: 'Gmail',
  greenhouse: 'Greenhouse',
  hubspot: 'HubSpot',
  slack: 'Slack',
  notion: 'Notion',
  figma: 'Figma',
};

/** The most suggestions {@link recommendForRoles} ever returns. */
export const MAX_RECOMMENDATIONS = 3;

/** One connector suggestion produced by {@link recommendForRoles}. */
export interface ProfileRecommendation {
  /** The connector-gateway toolkit slug, e.g. `gmail`. */
  slug: string;
  /** Plain display name for the service, e.g. `Gmail`. */
  name: string;
  /** The canon role that contributed this suggestion (first contributor wins). */
  role: CanonRoleId;
}

/**
 * Normalize one free-form role string to a canon id, or `undefined` when it
 * matches nothing. Lowercase-trims, then tries the canon ids, the alias table,
 * and the canon chip labels, in that order.
 *
 * @param role - A stored role string, canon or free-form.
 */
export function normalizeRole(role: string): CanonRoleId | undefined {
  const needle = role.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  const canon = ROLE_CANON.find((r) => r.id === needle);
  if (canon) return canon.id;
  const alias = ROLE_ALIASES[needle];
  if (alias) return alias;
  return ROLE_CANON.find((r) => r.label.toLowerCase() === needle)?.id;
}

/**
 * Suggest connector services for the roles a person saved.
 *
 * Normalizes each role (canon id, alias, or chip label; unmatched roles
 * contribute nothing), merges in first-role-first order, dedupes by slug, and
 * caps at {@link MAX_RECOMMENDATIONS} total. Deterministic; returns `[]` for an
 * empty or entirely-unmatched input.
 *
 * @param roles - The stored `config.profile.roles` array.
 */
export function recommendForRoles(roles: readonly string[]): ProfileRecommendation[] {
  const out: ProfileRecommendation[] = [];
  const seen = new Set<string>();
  for (const raw of roles) {
    const role = normalizeRole(raw);
    if (!role) continue;
    for (const slug of ROLE_RECOMMENDATIONS[role].connectors) {
      if (out.length >= MAX_RECOMMENDATIONS) return out;
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ slug, name: CONNECTOR_DISPLAY_NAMES[slug] ?? slug, role });
    }
  }
  return out;
}

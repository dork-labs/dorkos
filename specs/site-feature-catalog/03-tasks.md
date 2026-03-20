# Task Breakdown: Feature Catalog System for Marketing Site
Generated: 2026-03-20
Source: specs/site-feature-catalog/02-specification.md
Last Decompose: 2026-03-20

## Overview

Build a data-driven feature catalog for the DorkOS marketing site that surfaces individual product features with SEO-optimized pages at `/features/[slug]`, a browsable `/features` catalog with server-rendered category filtering, a homepage teaser section, and integration with sitemap and llms.txt. This is an additive feature with 13 initial features across 5 categories.

## Phase 1: Data Layer & Foundation

### Task 1.1: Create features data model and initial catalog
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Technical Requirements**:
- Create `apps/site/src/layers/features/marketing/lib/features.ts`
- Define `FeatureStatus`, `FeatureCategory`, `CATEGORY_LABELS`, and `Feature` interface
- Populate `features` const array with all 13 features across 5 categories (console, pulse, relay, mesh, core)
- Exactly 6 features marked `featured: true`
- All taglines ≤80 chars, descriptions 120-160 chars, 3-5 benefits per feature

**Acceptance Criteria**:
- [ ] File compiles with zero TypeScript errors
- [ ] All 13 features present with correct data
- [ ] All 5 categories represented
- [ ] Exactly 6 features marked `featured: true`
- [ ] All slugs are unique
- [ ] All `relatedFeatures` references resolve to valid slugs
- [ ] TSDoc on all exported types and constants

---

### Task 1.2: Create FeatureCard component
**Size**: Small
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: None

**Technical Requirements**:
- Create `apps/site/src/layers/features/marketing/ui/FeatureCard.tsx`
- Render feature name, tagline, category badge, status badge
- Entire card is a `<Link>` to `/features/{slug}`
- Status badge colors: ga=emerald, beta=amber, coming-soon=gray
- Uses `group`/`group-hover` pattern, `transition-smooth`, `font-mono`

**Acceptance Criteria**:
- [ ] Component renders feature name, tagline, category badge, and status badge
- [ ] Links to `/features/{slug}`
- [ ] All 3 status variants render correct label and color
- [ ] TSDoc on exported component

---

### Task 1.3: Export features data and components from marketing barrel
**Size**: Small
**Priority**: High
**Dependencies**: 1.1, 1.2
**Can run parallel with**: None

**Technical Requirements**:
- Update `apps/site/src/layers/features/marketing/index.ts`
- Export `features`, `CATEGORY_LABELS`, `Feature`, `FeatureStatus`, `FeatureCategory`, `FeatureCard`

**Acceptance Criteria**:
- [ ] All exports importable from `@/layers/features/marketing`
- [ ] No circular dependencies
- [ ] Barrel compiles cleanly

---

### Task 1.4: Create catalog index route at /features
**Size**: Medium
**Priority**: High
**Dependencies**: 1.3
**Can run parallel with**: 1.5 (partially)

**Technical Requirements**:
- Create `apps/site/src/app/(marketing)/features/page.tsx`
- Server component with `?category=` filtering via `searchParams` (async in Next.js 16)
- Category tab strip using `<Link>` elements (no client JS)
- Invalid categories silently fall back to "All"
- 3-column responsive grid of FeatureCards
- Static metadata with title, description, canonical, OG tags

**Acceptance Criteria**:
- [ ] `/features` renders all 13 features
- [ ] `/features?category=relay` shows only Relay features
- [ ] `/features?category=invalid` shows all features
- [ ] Category tabs are navigable links
- [ ] Active tab has distinct visual style
- [ ] Page is a server component (no `'use client'`)

---

### Task 1.5: Create individual feature page route at /features/[slug]
**Size**: Large
**Priority**: High
**Dependencies**: 1.3
**Can run parallel with**: 1.4

**Technical Requirements**:
- Create `apps/site/src/app/(marketing)/features/[slug]/page.tsx`
- `generateStaticParams()` pre-renders all 13 slugs
- `generateMetadata()` with per-feature title, description, OG, canonical
- BreadcrumbList JSON-LD (3-level: Home > Features > Feature)
- SoftwareApplication JSON-LD with `featureList` from benefits
- Full page layout: back link, category badge, status badge, h1, tagline, description, benefits checklist, optional screenshot, docs link, related features
- JSON-LD XSS prevention via `.replace(/</g, '\\u003c')`

**Acceptance Criteria**:
- [ ] Feature pages render with all sections
- [ ] Unknown slugs return 404
- [ ] JSON-LD structured data present
- [ ] Related features link correctly
- [ ] Status badges show correct variants

---

### Task 1.6: Create OG image route for feature pages
**Size**: Small
**Priority**: Medium
**Dependencies**: 1.3
**Can run parallel with**: 1.4, 1.5

**Technical Requirements**:
- Create `apps/site/src/app/(marketing)/features/[slug]/opengraph-image.tsx`
- `ImageResponse` with DorkOS brand colors (cream background, charcoal text)
- Shows feature name and tagline
- 1200x630 standard OG dimensions

**Acceptance Criteria**:
- [ ] OG image generates for each feature slug
- [ ] Uses DorkOS brand colors
- [ ] Exports `alt`, `size`, `contentType` constants

---

## Phase 2: SEO & Integration

### Task 2.1: Add feature pages to sitemap.ts
**Size**: Small
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: 2.2, 2.3

**Technical Requirements**:
- Modify `apps/site/src/app/sitemap.ts`
- Add `/features` catalog entry (priority 0.7)
- Add all `/features/[slug]` entries (priority 0.8)
- Preserve existing entries

**Acceptance Criteria**:
- [ ] Sitemap includes `/features` and all 13 feature slugs
- [ ] Correct priorities assigned
- [ ] Existing entries unaffected

---

### Task 2.2: Add features section to llms.txt route
**Size**: Small
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: 2.1, 2.3

**Technical Requirements**:
- Modify `apps/site/src/app/llms.txt/route.ts`
- Add `buildFeaturesSection()` helper
- Insert `## Features` section between Core Capabilities and Documentation

**Acceptance Criteria**:
- [ ] `/llms.txt` contains `## Features` section with all 13 features
- [ ] Section positioned correctly in template
- [ ] Existing sections unchanged

---

### Task 2.3: Create FeatureCatalogSection homepage teaser and integrate into homepage
**Size**: Medium
**Priority**: High
**Dependencies**: 1.2, 1.3
**Can run parallel with**: 2.1, 2.2

**Technical Requirements**:
- Create `apps/site/src/layers/features/marketing/ui/FeatureCatalogSection.tsx`
- Shows only `featured: true` features (6 max) in 3-column grid
- Responsive "All features" / "View all features" link (desktop/mobile variants)
- Export from marketing barrel `index.ts`
- Insert in homepage between `SubsystemsSection` and `HonestySection`
- Add `{ label: 'features', href: '/features' }` as first nav link

**Acceptance Criteria**:
- [ ] Homepage shows 6 featured features
- [ ] Section positioned correctly
- [ ] Responsive link variants work
- [ ] "features" appears as first nav link

---

## Phase 3: Tests

### Task 3.1: Write data integrity tests for features catalog
**Size**: Small
**Priority**: High
**Dependencies**: 1.1
**Can run parallel with**: 3.2, 3.3

**Technical Requirements**:
- Create `apps/site/src/layers/features/marketing/lib/__tests__/features.test.ts`
- 8 tests: unique slugs, valid relatedFeatures, tagline length, description length, benefits count, featured count, category coverage, media alt text

**Acceptance Criteria**:
- [ ] All 8 tests pass
- [ ] Tests catch data constraint violations

---

### Task 3.2: Write FeatureCard component tests
**Size**: Small
**Priority**: High
**Dependencies**: 1.2
**Can run parallel with**: 3.1, 3.3

**Technical Requirements**:
- Create `apps/site/src/layers/features/marketing/ui/__tests__/FeatureCard.test.tsx`
- 5 tests: renders name/tagline, correct link href, category/status badges, beta variant, coming-soon variant
- Uses `@vitest-environment jsdom`

**Acceptance Criteria**:
- [ ] All 5 tests pass
- [ ] Mock data satisfies Feature type contract

---

### Task 3.3: Write FeatureCatalogSection component tests
**Size**: Small
**Priority**: High
**Dependencies**: 2.3
**Can run parallel with**: 3.1, 3.2

**Technical Requirements**:
- Create `apps/site/src/layers/features/marketing/ui/__tests__/FeatureCatalogSection.test.tsx`
- 2 tests: renders only featured features, "All features" link points to /features
- Mocks `../../lib/features` with controlled test data
- Uses `@vitest-environment jsdom`

**Acceptance Criteria**:
- [ ] Both tests pass
- [ ] Non-featured features confirmed absent

---

### Task 3.4: Verify full TypeScript compilation and build
**Size**: Medium
**Priority**: High
**Dependencies**: All previous tasks
**Can run parallel with**: None

**Technical Requirements**:
- `pnpm typecheck` passes
- `turbo build --filter=@dorkos/site` succeeds
- All 13 feature pages statically generated
- ESLint passes
- All tests pass, no regressions

**Acceptance Criteria**:
- [ ] Zero TypeScript errors
- [ ] Build succeeds with all feature pages generated
- [ ] ESLint clean
- [ ] All tests green

# Marketing FAQ Section

**Status:** Draft
**Authors:** Claude Code, 2026-03-02
**Spec:** #83
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## Overview

Add an FAQ section to the DorkOS marketing homepage — 7 questions in an accordion, positioned between IdentityClose and InstallMoment. The section handles residual objections right before the install CTA, following the standard conversion funnel pattern.

Two new files (data + component), two modified files (barrel + page). Minimal blast radius.

## Background / Problem Statement

The marketing homepage progresses through a narrative arc (villain, pivot, subsystems, honesty, identity) but never addresses practical objections before asking visitors to install. Common questions — "What's an agent?", "Is my data safe?", "What does it cost?" — go unanswered. An FAQ section at the bottom of the funnel neutralizes these objections and reduces bounce before the install CTA.

## Goals

- Answer the 7 most common visitor questions in a scannable accordion format
- Define "agent" (the site's core concept) for visitors encountering the term for the first time
- Maintain the site's declarative, honest copy register
- Follow existing data/UI separation and motion patterns exactly

## Non-Goals

- Separate /faq page
- Search or filter functionality
- FAQ JSON-LD schema markup (can be added later for SEO)
- Animated micro-interactions beyond standard REVEAL/STAGGER
- Doc links in answers (answers are self-contained)

## Technical Dependencies

| Dependency                 | Version   | Purpose                                   |
| -------------------------- | --------- | ----------------------------------------- |
| `motion/react`             | workspace | Section reveal + stagger animations       |
| `@base-ui/react/accordion` | workspace | Accordion primitives (via shadcn wrapper) |
| Tailwind CSS v4            | workspace | Styling                                   |

No new dependencies required.

## Detailed Design

### File Organization

```
apps/site/src/layers/features/marketing/
├── lib/
│   ├── faq-items.ts          ← NEW: data file
│   └── motion-variants.ts    ← existing (imported, not modified)
├── ui/
│   └── FAQSection.tsx        ← NEW: component
└── index.ts                  ← MODIFIED: add exports
apps/site/src/app/(marketing)/
└── page.tsx                  ← MODIFIED: add FAQSection to page
```

### Data File: `faq-items.ts`

Follows the `subsystems.ts` pattern — interface + exported const array:

```typescript
export interface FaqItem {
  id: string;
  question: string;
  answer: string;
}

export const faqItems: FaqItem[] = [
  {
    id: 'what-is-agent',
    question: 'What do you mean by "agent"?',
    answer:
      "An agent is an AI coding tool — like Claude Code, Cursor, or Codex — that can read, write, and run code on your machine. DorkOS doesn't replace your agents. It gives them the infrastructure to work when you're not watching: scheduling, communication, memory, and coordination.",
  },
  // ... 6 more items (copy finalized in ideation Section 7)
];
```

All 7 questions from ideation Section 7 are included verbatim. The `id` field serves as the React key and the accordion `value` prop.

### Component: `FAQSection.tsx`

Follows the `SubsystemsSection.tsx` pattern:

```tsx
'use client';

import { motion } from 'motion/react';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { faqItems } from '../lib/faq-items';
import { REVEAL, STAGGER, VIEWPORT } from '../lib/motion-variants';

export function FAQSection() {
  return (
    <section className="bg-cream-secondary px-8 py-14 md:py-24">
      <motion.div
        className="mx-auto max-w-2xl"
        initial="hidden"
        whileInView="visible"
        viewport={VIEWPORT}
        variants={STAGGER}
      >
        {/* Eyebrow */}
        <motion.span
          variants={REVEAL}
          className="text-2xs text-brand-orange mb-6 block text-center font-mono tracking-[0.2em] uppercase"
        >
          Questions
        </motion.span>

        {/* Accordion */}
        <motion.div variants={REVEAL}>
          <Accordion>
            {faqItems.map((item) => (
              <AccordionItem key={item.id} value={item.id}>
                <AccordionTrigger>{item.question}</AccordionTrigger>
                <AccordionContent>
                  <p className="text-warm-gray leading-relaxed">{item.answer}</p>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </motion.div>
      </motion.div>
    </section>
  );
}
```

Key design decisions in the component:

- **`bg-cream-secondary`** — alternates from cream-white IdentityClose and cream-primary InstallMoment
- **`max-w-2xl`** — matches narrow content width of other text-focused sections
- **Single `REVEAL` on the accordion container** — the accordion items don't individually stagger (they're a cohesive block, not a list of cards)
- **`text-warm-gray leading-relaxed`** on answers — readable body text that matches the site's muted copy style
- **No custom accordion border overrides needed** — the default shadcn `border-b` dividers work with the warm palette since the border token is already warm-tinted in the site's Tailwind config

### Barrel Export: `index.ts`

Add three exports to the existing barrel file:

```typescript
// UI components
export { FAQSection } from './ui/FAQSection';

// Data
export { faqItems } from './lib/faq-items';

// Types
export type { FaqItem } from './lib/faq-items';
```

### Page Composition: `page.tsx`

Add `FAQSection` to the import and place it between `IdentityClose` and `InstallMoment`:

```tsx
import {
  // ... existing imports
  FAQSection,
} from '@/layers/features/marketing'

// In the JSX:
<IdentityClose email={siteConfig.contact.email} />
<FAQSection />
<InstallMoment />
```

`FAQSection` takes no props — it's fully self-contained like `SubsystemsSection` and `HonestySection`.

## User Experience

Visitors scrolling past the identity/values sections encounter a clean FAQ accordion before the install CTA. Questions are visible as a scannable list; answers expand on tap/click. The section appears with a subtle fade-in + slide-up animation (REVEAL) when it enters the viewport.

The accordion defaults to all-collapsed, letting visitors scan question text and expand only what interests them. This respects their time and avoids wall-of-text fatigue.

## Testing Strategy

### Build Verification

The primary test is a successful site build:

```bash
pnpm build --filter=@dorkos/site
```

This validates:

- TypeScript compilation (no type errors in new files)
- All imports resolve (barrel exports, component imports, data imports)
- No build-time rendering errors

### Visual Verification

Manual check in dev mode (`pnpm dev --filter=@dorkos/site`):

- Section appears between IdentityClose and InstallMoment
- Background color alternation is correct (cream-secondary)
- All 7 questions render with correct copy
- Accordion expand/collapse works
- Chevron rotates on open
- REVEAL animation triggers on scroll
- Responsive layout works on mobile

### Unit Tests

No unit tests required. The component is a thin render of static data through existing primitives (Accordion, motion). There is no business logic, conditional rendering, or interactive state beyond what the Accordion component already provides. Testing the accordion's expand/collapse behavior would be testing the library, not our code.

## Performance Considerations

- **Zero new dependencies** — uses existing motion and accordion libraries
- **Static data** — no API calls, no dynamic imports
- **Accordion keeps panels mounted** (`keepMounted` is the default) — negligible DOM cost for 7 items
- **Single viewport intersection observer** via the STAGGER container — no per-item observers

## Security Considerations

No security implications. The section renders static, hardcoded copy with no user input, no external data fetching, and no dynamic content.

## Documentation

No documentation updates required. The FAQ section is a self-explanatory marketing component with no configuration, no API surface, and no developer-facing features.

## Implementation Phases

### Phase 1 (Single Phase — Complete Implementation)

1. Create `apps/site/src/layers/features/marketing/lib/faq-items.ts` with `FaqItem` interface and `faqItems` array (7 items from ideation)
2. Create `apps/site/src/layers/features/marketing/ui/FAQSection.tsx` with the accordion section component
3. Update `apps/site/src/layers/features/marketing/index.ts` to export `FAQSection`, `faqItems`, and `FaqItem` type
4. Update `apps/site/src/app/(marketing)/page.tsx` to import and render `FAQSection` between `IdentityClose` and `InstallMoment`
5. Verify build: `pnpm build --filter=@dorkos/site`

No phasing needed — this is a small, self-contained feature with no dependencies on other work.

## Open Questions

None. All decisions have been made during ideation and the decision-gathering step.

## Related ADRs

No existing ADRs directly constrain this feature. The FAQ section follows established patterns (FSD layers, data/UI separation, motion variants) that are documented in `contributing/` guides rather than formal ADRs.

## References

- Ideation: `specs/marketing-faq-section/01-ideation.md`
- Research: `research/20260302_faq_section_best_practices_developer_tools.md`
- Design system: `contributing/design-system.md`
- FSD architecture: `contributing/architecture.md`
- Accordion component: `apps/site/src/components/ui/accordion.tsx` (Base UI, not Radix)
- Pattern reference: `apps/site/src/layers/features/marketing/ui/SubsystemsSection.tsx` + `lib/subsystems.ts`

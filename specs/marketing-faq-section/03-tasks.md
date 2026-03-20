# Marketing FAQ Section — Task Breakdown

**Spec:** `specs/marketing-faq-section/02-specification.md`
**Generated:** 2026-03-02
**Mode:** Full
**Tasks:** 4 (1 phase)

---

## Phase 1: Implementation

### 1.1 Create FAQ data file with 7 Q&A items

- **Size:** Small | **Priority:** High
- **Dependencies:** None | **Parallel with:** 1.2
- **File:** `apps/site/src/layers/features/marketing/lib/faq-items.ts`

Create the data file following the `subsystems.ts` pattern — export a `FaqItem` interface and a `faqItems` const array with all 7 questions and answers from the ideation document. Each item has an `id` (used as React key and accordion value), `question`, and `answer` field.

---

### 1.2 Create FAQSection accordion component

- **Size:** Small | **Priority:** High
- **Dependencies:** None | **Parallel with:** 1.1
- **File:** `apps/site/src/layers/features/marketing/ui/FAQSection.tsx`

Create the section component following the `SubsystemsSection.tsx` pattern. Uses `'use client'` directive, motion STAGGER/REVEAL viewport animations, and the shadcn Accordion (Base UI). Background is `bg-cream-secondary` to alternate from surrounding sections. Orange monospace "Questions" eyebrow. Single REVEAL on the accordion container (items don't individually stagger). No props — fully self-contained.

---

### 1.3 Update barrel exports and page composition

- **Size:** Small | **Priority:** High
- **Dependencies:** 1.1, 1.2 | **Parallel with:** None
- **Files:** `apps/site/src/layers/features/marketing/index.ts`, `apps/site/src/app/(marketing)/page.tsx`

Add `FAQSection` component export, `faqItems` data export, and `FaqItem` type export to the marketing barrel. Import `FAQSection` in the homepage and render it between `IdentityClose` and `InstallMoment`.

---

### 1.4 Verify site build succeeds

- **Size:** Small | **Priority:** High
- **Dependencies:** 1.3 | **Parallel with:** None

Run `pnpm build --filter=@dorkos/site` to validate TypeScript compilation, import resolution, and Next.js build-time rendering for all new and modified files.

---

## Dependency Graph

```
1.1 (data file) ──┐
                   ├──→ 1.3 (exports + page) ──→ 1.4 (build verify)
1.2 (component) ──┘
```

Tasks 1.1 and 1.2 can run in parallel. Task 1.3 depends on both. Task 1.4 depends on 1.3.

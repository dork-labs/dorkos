---
slug: world-class-documentation
number: 37
created: 2026-02-17
status: ideation
---

# World-Class Documentation

**Slug:** world-class-documentation
**Author:** Claude Code
**Date:** 2026-02-17
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Audit all existing docs for completeness, fix broken API documentation, and fill content gaps to create world-class documentation for DorkOS — serving end users, integrators, and contributors.
- **Assumptions:**
  - Docs target three audiences: end users (CLI/Obsidian), developers building integrations, and contributors
  - The Fumadocs infrastructure is already in place and working (except API docs)
  - Internal `contributing/` guides are a rich source to draw from for external docs
  - The existing doc structure (sections, filenames) is mostly right — the content just needs to be written
- **Out of scope:** Video tutorials, blog posts, marketing copy, internationalization

---

## 2) Pre-reading Log

- `docs/index.mdx`: Functional link list, but not a proper landing page — no hero, cards, or value prop
- `docs/getting-started/installation.mdx`: Decent but minimal (43 lines). Missing: package manager tabs, Obsidian path, verification output
- `docs/getting-started/quickstart.mdx`: Thin — 5 bullet points with no Steps component, no code blocks, no screenshots
- `docs/getting-started/configuration.mdx`: Substantive, well-written with config table — **good as-is**
- `docs/guides/obsidian-plugin.mdx`: Comprehensive (306 lines) — **good as-is**
- `docs/guides/tool-approval.mdx`: Substantive — **good as-is**
- `docs/guides/keyboard-shortcuts.mdx`: Substantive — **good as-is**
- `docs/guides/cli-usage.mdx`: **STUB** — just a TODO comment and 5 bullet points
- `docs/guides/slash-commands.mdx`: **STUB** — just a TODO and bullet list
- `docs/guides/tunnel-setup.mdx`: **STUB** — just a TODO and bullet list
- `docs/integrations/building-integrations.mdx`: **STUB** — just a TODO and bullet list
- `docs/integrations/sse-protocol.mdx`: **STUB** — just a TODO and bullet list
- `docs/contributing/development-setup.mdx`: **STUB** — just a TODO and bullet list
- `docs/contributing/architecture.mdx`: **STUB** — just a TODO and bullet list
- `docs/contributing/testing.mdx`: **STUB** — just a TODO and bullet list
- `docs/self-hosting/deployment.mdx`: **STUB** — just a TODO and bullet list
- `docs/self-hosting/reverse-proxy.mdx`: **STUB** — just a TODO and bullet list
- `docs/changelog.mdx`: Exists but content status unknown
- `docs/api/api/**/*.mdx`: Generated OpenAPI MDX files exist but **rendering is broken**
- `contributing/api-reference.md`: Rich internal doc with full SSE protocol, endpoint details — excellent source
- `contributing/interactive-tools.md`: Detailed architecture walkthrough — source for tool-approval docs
- `contributing/configuration.md`: Full config reference — source for config guide
- `apps/web/src/components/api-page.tsx`: Has `'use client'` directive causing Server Component breakage
- `apps/web/src/lib/openapi.ts`: Correctly uses `createOpenAPI` + `createAPIPage` from fumadocs-openapi

---

## 3) Codebase Map

**Primary files to modify (docs content):**

- `docs/index.mdx` — landing page rewrite
- `docs/getting-started/installation.mdx` — enhance with tabs, targets
- `docs/getting-started/quickstart.mdx` — full rewrite
- `docs/guides/cli-usage.mdx` — write from scratch
- `docs/guides/slash-commands.mdx` — write from scratch
- `docs/guides/tunnel-setup.mdx` — write from scratch
- `docs/integrations/building-integrations.mdx` — write from scratch
- `docs/integrations/sse-protocol.mdx` — write from scratch
- `docs/contributing/development-setup.mdx` — write from scratch
- `docs/contributing/architecture.mdx` — write from scratch
- `docs/contributing/testing.mdx` — write from scratch
- `docs/self-hosting/deployment.mdx` — write from scratch
- `docs/self-hosting/reverse-proxy.mdx` — write from scratch
- `docs/meta.json` — add missing sections (integrations, self-hosting)

**API docs fix:**

- `apps/web/src/components/api-page.tsx` — remove `'use client'` directive
- `apps/web/src/lib/openapi.ts` — verify Server Component compatibility

**Source material (internal docs to draw from):**

- `contributing/api-reference.md` → `docs/integrations/sse-protocol.mdx`
- `contributing/interactive-tools.md` → `docs/guides/tool-approval.mdx`
- `contributing/configuration.md` → `docs/getting-started/configuration.mdx`
- `contributing/architecture.md` → `docs/contributing/architecture.mdx`
- `contributing/data-fetching.md` → contributor docs
- `contributing/state-management.md` → contributor docs
- `contributing/animations.md` → contributor docs
- `contributing/styling-theming.md` → contributor docs

**Navigation gaps:**

- `docs/meta.json` lists: getting-started, guides, api, contributing, changelog
- **Missing from root meta.json:** `integrations`, `self-hosting`
- `docs/guides/meta.json` lists only 3 of 6 existing files (missing: cli-usage, slash-commands, tunnel-setup)

**Blast radius:** Docs-only changes + one small component fix. No impact on app functionality.

---

## 4) Root Cause Analysis (API Docs Bug)

**Observed:** Visiting `/docs/api/api/sessions/get` shows an error page with React console errors: "A component was suspended by an uncached promise. Creating promises inside a Client Component or hook is not yet supported."

**Root cause:** `apps/web/src/components/api-page.tsx` has a `'use client'` directive at line 1. It re-exports `APIPage` from `@/lib/openapi`, which is created by `createAPIPage(openapi)` from `fumadocs-openapi/ui`. The `APIPage` component is an async Server Component that performs file I/O to load the OpenAPI JSON spec. Wrapping it with `'use client'` forces it into client-side rendering where async I/O and Suspense promises aren't supported.

**Fix:** Remove the `'use client'` directive from `apps/web/src/components/api-page.tsx`. The component should remain a Server Component since it performs async data loading. The catch-all docs page (`[[...slug]]/page.tsx`) is already a Server Component, so the import chain works correctly without the client directive.

**Evidence:**

- Console error: "A component was suspended by an uncached promise" (confirmed by browser agent)
- `fumadocs-openapi@10.3.5` — `createAPIPage` returns a Server Component
- The `'use client'` directive was likely added by mistake or to satisfy a linting rule

---

## 5) Research

Full research saved to `research/20260217_world_class_developer_docs.md`. Key findings:

### Diátaxis Framework (Gold Standard for Docs IA)

- **Tutorials**: Learning-oriented (quickstart)
- **How-to guides**: Task-oriented (guides/)
- **Reference**: Information-oriented (API docs, config reference)
- **Explanation**: Understanding-oriented (concepts — currently missing)
- Critical: keep these types strictly separate

### Fumadocs Components We Should Adopt

| Component                | Where to Use                                      | Current State                         |
| ------------------------ | ------------------------------------------------- | ------------------------------------- |
| `<Steps>` / `<Step>`     | All procedural content (quickstart, guides)       | Not used — using plain numbered lists |
| `<Cards>` / `<Card>`     | Index page, section landing pages                 | Not used — using link lists           |
| `<Tabs groupId persist>` | Install commands, multi-target config             | Not used                              |
| `<Callout type>`         | Warnings, notes, tips throughout                  | Not used — using bold text            |
| `<TypeTable>`            | Config reference, CLI flags                       | Not used — using markdown tables      |
| `<Files>` / `<Folder>`   | Project structure diagrams                        | Not used                              |
| `<DocsCategory>`         | Section landing pages (auto-generate child links) | Not used                              |
| `<Include>`              | Shared content (prerequisites, API key setup)     | Not used                              |
| NPM code tabs            | All install commands (auto npm/pnpm/yarn/bun)     | Not used                              |
| `// [!code highlight]`   | Code examples with key lines highlighted          | Not used                              |

### Key Principles from Stripe/Supabase/Tailwind

1. **30-second test**: Within 30 seconds, answer: what is this? is it for me? how do I start?
2. **Progressive disclosure**: Reveal complexity gradually, not all at once
3. **Copy-paste-runnable code**: Every code block works when pasted without modification
4. **No dead ends**: Every page ends with "next steps" or "what to do now"
5. **Outcome-based naming**: Name sections by what users achieve, not what the API does

### Potential Approaches

**1. Content-first (fill all stubs, then polish)**

- Pros: Fastest path to completeness, highest immediate value
- Cons: May need restructuring later
- Complexity: Medium
- Recommendation: **Do this**

**2. Structure-first (reorganize IA, add concepts section, then fill)**

- Pros: Better long-term organization
- Cons: Slower to deliver user value, may over-engineer
- Complexity: High

**3. Hybrid (fix API bug + fill critical stubs first, then restructure)**

- Pros: Quick wins first, then systematic improvement
- Cons: Two passes over same files
- Recommendation: Best overall approach

---

## 6) Clarifications

1. **Should we add a `concepts/` section?** The research strongly recommends it (Diátaxis "explanation" layer). This would house: architecture overview, session model, transport interface explanation, tool approval model. Currently these live only in `contributing/` which is developer-focused. **Recommended: Yes, add it.**

2. **Should we create separate quickstarts per installation target?** The research recommends it (Supabase pattern). DorkOS has 3 targets: npm CLI, Obsidian plugin, self-hosted. Currently there's one generic quickstart. **Recommended: Keep one quickstart (npm CLI path) but add target-selection Cards on the installation page.**

3. **How much Fumadocs component adoption should we do in this pass?** Options:
   - Minimal: Just fill content, use plain markdown
   - Moderate: Use Steps, Callouts, Tabs where obvious
   - Full: Adopt all recommended components (Steps, Cards, Tabs, TypeTable, Files, DocsCategory, Include)
     **Recommended: Full adoption — these components are what make the difference between "adequate" and "world class"**

4. **Should the changelog be populated?** It exists but may be thin. The `/system:release` skill already generates changelog entries. **Recommended: Yes, populate from git history.**

5. **API docs: regenerate MDX or just fix the rendering bug?** The generated MDX files in `docs/api/api/` are checked into git. Fixing the `'use client'` bug should make them render. But we should also verify the OpenAPI spec is up-to-date. **Recommended: Fix the bug first, then regenerate if needed.**

6. **Priority order?** Suggested:
   1. Fix API docs bug (quick win, 1 line change)
   2. Fix navigation gaps (meta.json files)
   3. Rewrite quickstart (highest-traffic page after index)
   4. Write CLI usage guide (most-searched stub)
   5. Enhance index page (first impression)
   6. Fill remaining stubs (guides, integrations, contributing, self-hosting)
   7. Add Fumadocs components throughout
   8. Add concepts section (if approved)

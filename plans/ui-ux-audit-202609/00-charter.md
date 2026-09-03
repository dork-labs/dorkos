# UI/UX Audit Charter — September 2026

**Scope:** `apps/client/src` — the DorkOS web/desktop client. 940 component files: ~90 shared/ui primitives, 26 entities, 60 features, 17 widgets, the dev playground (24 pages, 92 showcase files), and the app shell.

**Prime directive (operator, 2026-09-03): simplify, simplify, simplify.** When two valid recommendations exist, the one that removes, merges, or shortens wins. Prefer deleting over restyling, one component over two, a 3-word label over a sentence.

**Goal:** find everything standing between this UI and world-class, then fix it. The audit produces a findings report; the findings become Linear issues; the issues become PRs.

## Ground truth the auditors must read first

- `contributing/design-system.md` — Calm Tech: "less, but better", no pure black/white, no dramatic animation, chrome appears on hover/focus, whitespace before rules.
- `contributing/animations.md` — motion rules.
- `.claude/rules/fsd-layers.md` — layer hierarchy `shared ← entities ← features ← widgets`, barrel imports only.
- `.claude/skills/maintaining-dev-playground/SKILL.md` — playground candidacy rules.
- `AGENTS.md` §Vision + §Quality Standard — personas (Kai, Priya, Ikechi), banned vocabulary ("mission control", "cockpit"), writing-for-humans standard for all copy.

## The twelve lenses

Each lens is one auditor. A finding belongs to exactly one lens (the synthesizer dedups cross-lens overlap).

1. **Tokens & consistency** — fonts, colors, spacing, radii, shadows. Raw hex/arbitrary values where semantic Tailwind tokens exist; inconsistent spacing scales between sibling components; type ramp violations; light/dark drift.
2. **Composition & CVA** — are variants expressed via `class-variance-authority` where a component has ≥2 visual variants? Prop-driven className spaghetti; boolean-prop explosions that should be variants; missing `asChild`/slot patterns; primitives that fight Radix instead of wrapping it.
3. **DRY** — duplicate or near-duplicate components/hooks/utilities; parallel implementations of the same UI idea (e.g. two empty-state renderers, three chip variants); copy-pasted JSX blocks appearing ≥3 times.
4. **Organization & naming** — components in the wrong FSD layer/slice; misleading or inconsistent names (PascalCase files vs kebab-case in shared/ui — document the actual convention and flag breakers); slices that should merge or split; dead exports.
5. **DX** — is each shared primitive easy to use correctly and hard to misuse? Missing/wrong TSDoc; unclear prop names; required props that could default; missing forwardRef/className passthrough; error messages.
6. **Playground organization & coverage** — are the 24 pages coherent? Pages with too many showcases (propose a max per page and a split rule); shared primitives and reusable feature components missing showcases; stale showcases that no longer match the real component; mock-data drift.
7. **Copy (ELI5)** — every user-facing string: shorten sentences, simple friendly words, consistent terminology (one name per concept across surfaces), no jargon a newcomer to agents/AI wouldn't know, no banned vocabulary. Cite the exact current string and propose the replacement.
8. **Responsiveness** — mobile/tablet/desktop behavior; touch targets <44px; fonts/buttons/icons that need to be **bigger** on mobile; layouts that overflow or cram; missing breakpoint handling; hover-only affordances with no touch equivalent.
   **Adaptive layouts (operator, 2026-09-03):** responsiveness is not just shrinking — sometimes mobile deserves a _different_ layout. For each cramped surface, recommend the right adaptation strategy, choosing deliberately among: (a) collapse buttons to icon-only (text+icon → icon, with tooltip/label elsewhere); (b) fold overflow actions behind an ellipsis / context menu / collapsed section; (c) hide an element entirely on mobile when it doesn't earn its space; (d) swap in a mobile-specific variant (shorter text, different image, alternate component or layout). The same question applies on desktop when content grows: define how each component degrades as items are added (overflow rules), not just at breakpoints. Name which strategy fits and why.
   **Overflow containment (operator, 2026-09-03, confirmed live bug):** no content may ever escape its container or cause page-level horizontal scroll. Long unbroken strings — file paths, URLs, session IDs, branch names — are the usual culprits and this codebase is full of them. Every surface rendering one must contain it deliberately: middle/end truncation with full value on hover or tap (prefer shared/ui `path-breadcrumb` / `truncated-output` where they fit), `break-all` only where reading the whole string matters, `min-w-0` on the flex ancestors that silently block truncation. Auditors should hunt these; a string overflowing its container is automatically P1. Confirmed example: the Workspaces empty state on mobile renders `~/Keep/dork-os/dorkos/apps/desktop/.temp/.dork/wo…` straight out of the card and off the page.
9. **UI states** — hover, active, focus-visible, disabled, loading, empty, error, skeleton. Interactive elements missing hover/active feedback; missing empty/error states; states that exist but are inconsistent with siblings.
10. **Motion & micro-interactions** — what a world-class motion designer would add or fix within Calm Tech limits: enter/exit transitions, subtle press feedback, layout animation, staggering — and dramatic/bouncy motion to remove. Delight-and-surprise opportunities that stay quiet.
11. **Clutter, simplification & progressive disclosure** — surfaces doing too much at once; settings/panels that should hide advanced options behind disclosure; product-designer lens: for each major surface, what would a world-class designer cut, merge, or reorder?
12. **Componentization** — repeated inline JSX patterns that should become shared components; ad-hoc one-off implementations of things shared/ui already solves; shadcn primitives worth customizing further (better responsiveness, styling, micro-interactions).

## The no-wall-of-text rule (operator directive, 2026-09-03)

No surface may show a super-large block of text. Replace prose blocks with a headline, a short blurb, or bullets — the gist in as few words as possible (generally under 5 for the headline/gist) — plus an optional path to more detail when it genuinely matters. "Learn more" names the pattern, never the literal text — pick the affordance that fits the context (info icon, tooltip, expandable section, a contextual link like "How agents work", hover card). If the gist is sufficient, skip the affordance entirely. Any component rendering a paragraph of static copy is a finding under lens 7 or 11. This is progressive disclosure applied to copy: don't throw up on the page.

## Severity & effort rubric

- **P1** — visibly broken/embarrassing to a new user, an accessibility failure, or a Hard Rule violation. Fix in the first batch.
- **P2** — real quality gap a designer or Priya-grade engineer would flag. The bulk of the work.
- **P3** — polish and delight. Do after P1/P2.
- **Effort:** S (≤1h, one file), M (one PR, one slice), L (multi-file refactor, own spec).

## Rules for a valid finding

1. **Cite it.** Every finding names ≥1 real `file:line` the auditor actually read. No inferences from file names.
2. **One finding, one fix.** State the current state, why it falls short of the charter, and the concrete recommendation.
3. **Respect the design language.** "Add a gradient" is not a finding. Calm Tech bounds every recommendation.
4. **Don't relitigate decisions.** ADRs and specs are settled; if a pattern looks odd, check `decisions/` and `research/` before flagging it.
5. **Sample honestly.** Auditors that sample (copy, states, responsive) must say what they covered and what they skipped, so coverage gaps are visible.
6. **No fix-by-drive-by.** The audit writes zero code. Findings only.

## Output shape (per auditor)

Structured findings: `{lens, severity, effort, title, files[], evidence, recommendation}` plus a `coverage` note listing what was examined vs skipped.

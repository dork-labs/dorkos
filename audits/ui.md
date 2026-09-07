# UI/UX audit charter

The standing contract for auditing the DorkOS client's interface. Read
[`README.md`](README.md) first: its standing directives bind every lens here.

**Scope:** `apps/client/src` — the web, desktop, and phone client, which are one codebase.
Shared UI primitives, entities, features, widgets, the app shell, and the dev playground are all
in scope. Server code, the marketing site, and the Obsidian plugin are not.

**Goal:** find everything standing between this interface and world-class, then fix it. An audit
run produces a findings report; the findings become tracked work items; the items become PRs.

## Standing directives (UI)

Sharpened from the shared directives in `README.md`, plus operator directives recorded here with
their dates so a later reader knows what is durable and what was situational.

- **Simplify, simplify, simplify** (operator, 2026-09-03). The prime directive. Prefer deleting
  over restyling, one component over two, a three-word label over a sentence.
- **No wall of text** (operator, 2026-09-03). No surface may show a large block of prose.
  Replace it with a headline, a short blurb, or bullets, plus an optional path to more detail.
  Any component rendering a paragraph of static copy is a finding under lens 7 or 11.
- **Adaptive layouts, not just shrinking** (operator, 2026-09-03). See lens 8.
- **Overflow containment** (operator, 2026-09-03). See lens 8. A string escaping its container
  is automatically P1.

## Ground truth the auditors read first

> **Repo-specific.** Everything above and below this section is portable; this list is not.
> A different repo adopting this charter replaces these pointers with its own.

- `contributing/design-system.md` — Calm Tech: "less, but better", no pure black or white, no
  dramatic animation, chrome appears on hover and focus, whitespace before rules.
- `contributing/animations.md` — the motion rules and the timing system.
- `.claude/rules/fsd-layers.md` — the layer hierarchy `shared ← entities ← features ← widgets`,
  barrel imports only.
- `.claude/skills/maintaining-dev-playground/SKILL.md` — playground candidacy rules.
- `AGENTS.md`, sections Vision and Quality Standard — the personas an auditor judges against
  (**Kai**, **Priya**, **Ikechi**; Lil is horizon-staged and explicitly not a launch target, so
  do not weight her), the retired vocabulary enforced by `scripts/check-banned-words.sh`, and the
  `writing-for-humans` standard that binds all user-facing copy.
- `meta/personas/` — the full persona set, when a lens needs more than the AGENTS.md summary.
- `decisions/` and `research/` — check before flagging a pattern that looks odd. It may be settled.

Primitives the lenses reach for by name, in `apps/client/src/layers/shared/ui/`:
`path-breadcrumb.tsx` and `truncated-output.tsx` (lens 8's overflow containment, the P1 one) and
`touch-target.ts` (lens 8's tap sizes). Prefer them over a new one-off.

## The twelve lenses

Each lens is one auditor. A finding belongs to exactly one lens; the synthesizer dedups
cross-lens overlap.

The `key` after each title is the lens's **canonical identifier**, and this list is its only
authority. Commands take it (`/ui-audit:run lens:tokens`), stamps and raw findings files are
named by it (`raw/tokens.md`), and the rotation cycles through it. Renaming a lens here renames
it everywhere; do not invent a second spelling elsewhere.

1. **Tokens & consistency** `tokens` — fonts, colors, spacing, radii, shadows. Raw hex or arbitrary
   values where semantic tokens exist; inconsistent spacing scales between sibling components;
   type-ramp violations; light and dark drift. Also: rules written outside the cascade layers,
   which silently defeat the tokens they appear to set.
2. **Composition & CVA** `cva` — are variants expressed through `class-variance-authority` wherever a
   component has two or more visual variants? Prop-driven className spaghetti; boolean-prop
   explosions that should be variants; missing `asChild` or slot patterns; primitives that fight
   Radix instead of wrapping it.
3. **DRY** `dry` — duplicate or near-duplicate components, hooks, and utilities; parallel
   implementations of the same idea (two empty-state renderers, three chip variants); copy-pasted
   JSX blocks appearing three or more times. Confirm by reading candidates side by side;
   superficial similarity is not duplication.
4. **Organization & naming** `organization` — components in the wrong layer or slice; misleading or
   inconsistent names (document the directory's real convention, then flag the breakers); slices
   that should merge or split; dead exports.
5. **DX** `dx` — is each shared primitive easy to use correctly and hard to misuse? Missing or wrong
   TSDoc; unclear prop names; required props that could default; missing ref forwarding or
   `className` passthrough; size and variant vocabularies that disagree between siblings.
6. **Playground organization & coverage** `playground` — are the playground's pages coherent? Pages with too
   many showcases (propose a maximum and a split rule); shared primitives and reusable feature
   components with no showcase; stale showcases that no longer match the real component;
   mock-data drift.
7. **Copy (ELI5)** `copy` — every user-facing string. Shorten sentences, use simple friendly words,
   keep one name per concept across every surface, drop jargon a newcomer to AI agents would not
   know, and use no retired vocabulary. Cite the exact current string and propose the
   replacement. Error voice counts: a raw server message pasted in front of an authored sentence
   is a finding.
8. **Responsiveness** `responsive` — phone, tablet, and desktop behavior; touch targets under 44px; text,
   buttons, and icons that need to be **bigger** on small screens; layouts that overflow or
   cram; missing breakpoint handling; hover-only affordances with no touch equivalent.
   - **Adaptive layouts.** Responsiveness is not only shrinking; sometimes a small screen
     deserves a _different_ layout. For each cramped surface, name the adaptation strategy and
     why: (a) collapse to icon-only, with the label available elsewhere; (b) fold overflow
     actions behind an ellipsis, context menu, or collapsed section; (c) hide the element
     entirely where it does not earn its space; (d) swap in a small-screen variant (shorter
     text, different image, alternate component). The same question applies on desktop as
     content grows: define how each component degrades as items are added, not only at
     breakpoints.
   - **Overflow containment.** No content may ever escape its container or cause page-level
     horizontal scroll. Long unbroken strings (file paths, URLs, session ids, branch names) are
     the usual culprits. Every surface rendering one contains it deliberately: middle or end
     truncation with the full value on hover or tap, `break-all` only where reading the whole
     string matters, `min-w-0` on the flex ancestors that silently block truncation. Prefer the
     shared primitives that already solve this where they fit. A string overflowing its
     container is automatically P1.
9. **UI states** `states` — hover, active, focus-visible, disabled, loading, empty, error, skeleton.
   Interactive elements with no hover or press feedback; missing empty and error states;
   skeletons that do not match the final layout; states that exist but disagree with siblings.
10. **Motion & micro-interactions** `motion` — what a world-class motion designer would add or fix inside
    Calm Tech limits: enter and exit transitions, subtle press feedback, layout animation,
    staggering, and dramatic or bouncy motion to remove. Delight that stays quiet.
11. **Clutter, simplification & progressive disclosure** `clutter` — surfaces doing too much at once;
    panels that should hide advanced options behind disclosure; for each major surface, what
    would a world-class product designer cut, merge, or reorder? Judge against the personas: Kai
    wants density with calm, Ikechi must not be scared off.
12. **Componentization** `componentize` — repeated inline JSX that should become a shared component; ad-hoc
    reimplementations of things the shared layer already solves; near-stock primitives worth
    customizing further for responsiveness, styling, or micro-interaction.

### Lens classes (why this matters for scoping)

- **Surface-local** — `copy`, `responsive`, `states`, `motion`, plus `tokens` and `clutter`,
  whose questions can be asked of one route at a time. These can be answered about a single
  surface or a single diff.
- **Whole-tree** — `cva`, `dry`, `organization`, `dx`, `playground`, `componentize`. These are
  structurally incapable of it: duplication, placement, and API consistency are properties of
  the whole tree, and a diff-scoped run of them produces confident nonsense.

A scoped or incremental audit runs the surface-local lenses over the change and reaches the
whole-tree lenses only through rotation, one per run, in the order listed above. See the
`auditing-ui` skill.

## Severity & effort rubric

- **P1** — visibly broken or embarrassing to a new user, an accessibility failure, or a Hard
  Rule violation. Fix first.
- **P2** — a real quality gap a designer or a Priya-grade engineer would flag. The bulk of the work.
- **P3** — polish and delight. After P1 and P2.
- **Effort:** **S** (about an hour, one file) · **M** (one PR, one slice) · **L** (multi-file
  refactor, wants its own spec).

## Rules for a valid finding

1. **Cite it.** Every finding names at least one real `file:line` the auditor actually read. No
   inferences from file names.
2. **One finding, one fix.** State the current state, why it falls short of this charter, and
   the concrete recommendation. Pattern findings covering many files are welcome; list the files.
3. **Respect the design language.** "Add a gradient" is not a finding. Calm Tech bounds every
   recommendation.
4. **Don't relitigate decisions.** ADRs and specs are settled. Check `decisions/` and `research/`
   before flagging a pattern that looks odd.
5. **Sample honestly.** Auditors that sample say what they covered and what they skipped, so
   coverage gaps are visible in the report rather than invisible in the reader's head.
6. **No fix by drive-by.** The audit writes zero code.

## Output shape (per auditor)

One markdown file per lens at `audits/runs/ui/<date>/raw/<key>.md`, plus a structured summary.
Each finding: `{lens, severity, effort, title, files[], evidence, recommendation}`, preceded by a
`coverage` section stating what was examined and what was skipped.

## Provenance

Generalized from `plans/ui-ux-audit-202609/00-charter.md`, the September 2026 run's charter. The
lens set, rubric, and validity rules are that charter's, unchanged in substance. Added here from
what the run itself taught, and not in the source: the lens **keys** and the **Lens classes**
section (both load-bearing for scoping), the cascade-layer clause in lens 1, "confirm by reading
candidates side by side" in lens 3, the size and variant vocabulary clause in lens 5, the error
voice clause in lens 7, and the persona judgment line in lens 11. The scope line is generalized
from that run's file counts, which would rot.

To record a new operator directive, add it to **Standing directives** with its date, and sharpen
the affected lens in the same edit. Never rewrite this file wholesale: it accretes, and
`/ui-audit:init` will not overwrite it.

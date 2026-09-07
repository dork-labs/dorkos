// NON-NORMATIVE REFERENCE IMPLEMENTATION. Do not treat this file as the contract.
//
// This is the actual audit fan-out orchestration script from the September 2026 UI/UX
// audit programme, kept verbatim as a known-good example. It is written for ONE
// specific session orchestrator (the Workflow runner, with its `agent()`,
// `parallel()`, `pipeline()`, `phase()` and `log()` primitives) and hard-codes
// that session's absolute paths, ports, and Linear issue shape. Nothing here runs
// unchanged anywhere else, and nothing here overrides the skill.
//
// The normative procedure is the prose in ../../SKILL.md plus the charter at
// audits/ui.md. If this script and that prose disagree, the prose wins.
//
// Shape: twelve parallel lens auditors writing raw markdown, then one synthesizer that dedups, spot-verifies, and batches. Maps to SKILL.md sections 2 and 4.
//
// One line was adjusted from the original: the reminder about retired vocabulary
// now points at scripts/check-banned-words.sh rather than naming the words.

export const meta = {
  name: 'ui-ux-audit',
  description:
    'Twelve-lens UI/UX audit of apps/client, then synthesis into a master findings report',
  phases: [
    { title: 'Audit', detail: 'twelve parallel lens auditors' },
    { title: 'Synthesize', detail: 'dedup and rank into master report' },
  ],
};

const CHARTER = '/Users/doriancollier/Keep/dork-os/dorkos/plans/ui-ux-audit-202609/00-charter.md';
const RAW_DIR = '/Users/doriancollier/Keep/dork-os/dorkos/plans/ui-ux-audit-202609/raw';

const FINDINGS_SCHEMA = {
  type: 'object',
  required: ['coverage', 'counts', 'topFindings'],
  properties: {
    coverage: { type: 'string', description: 'what was examined vs skipped' },
    counts: {
      type: 'object',
      required: ['P1', 'P2', 'P3'],
      properties: { P1: { type: 'number' }, P2: { type: 'number' }, P3: { type: 'number' } },
    },
    topFindings: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        required: ['severity', 'effort', 'title', 'files'],
        properties: {
          severity: { enum: ['P1', 'P2', 'P3'] },
          effort: { enum: ['S', 'M', 'L'] },
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const LENSES = [
  {
    key: 'tokens',
    model: 'sonnet',
    title: 'Tokens & consistency',
    brief:
      'Fonts, colors, spacing, radii, shadows across apps/client/src. Hunt raw hex values, arbitrary Tailwind values (e.g. w-[13px], text-[#...]), px paddings inconsistent with sibling components, type-ramp violations, light/dark theme drift. Grep systematically (patterns like "\\[#", "text-\\[", "p-\\[", "hsl(") then read the hits. Compare shared/ui primitives against contributing/design-system.md token tables.',
  },
  {
    key: 'cva',
    model: 'opus',
    title: 'Composition & CVA',
    brief:
      'Read every file in apps/client/src/layers/shared/ui (~90 files). Which multi-variant components use class-variance-authority and which fake variants with ternary className soup or boolean-prop explosions? Missing asChild/slot patterns, missing className passthrough, primitives fighting Radix instead of wrapping it, components that should compose smaller primitives. Also sample 15+ feature components for the same smells.',
  },
  {
    key: 'dry',
    model: 'sonnet',
    title: 'DRY',
    brief:
      'Find duplicate or near-duplicate components, hooks, and utilities across apps/client/src. Parallel implementations of the same UI idea (multiple empty-state renderers, chip/badge/pill variants, copy buttons, loading spinners, avatar renderers, relative-time formatters). Copy-pasted JSX blocks appearing 3+ times that should be one component. Use grep for signature phrases, then read candidates side by side to confirm real duplication, not superficial similarity.',
  },
  {
    key: 'organization',
    model: 'sonnet',
    title: 'Organization & naming',
    brief:
      'FSD placement and naming across apps/client/src/layers. Components in the wrong layer/slice (feature code that is really shared, shared code used by one feature only, widgets that are really features). Naming convention drift: shared/ui mixes PascalCase (ConnectionStatusBanner.tsx, ScanLine.tsx) with kebab-case — document the real convention and list breakers. Slices that should merge/split. Non-barrel imports. Dead or unused exports (spot-check, do not run knip).',
  },
  {
    key: 'dx',
    model: 'opus',
    title: 'DX',
    brief:
      'Developer experience of shared/ui and entity-layer public APIs. For ~30 of the most-used shared primitives (grep import counts to pick them): is the API easy to use right and hard to misuse? Missing or wrong TSDoc, unclear prop names, required props that could default, missing forwardRef, inconsistent size/variant vocab across primitives (one says sm/md/lg, another small/default), confusing barrel exports.',
  },
  {
    key: 'playground',
    model: 'sonnet',
    title: 'Playground organization & coverage',
    brief:
      'The dev playground: apps/client/src/dev (24 pages, 92 showcase files, registry in playground-pages.ts / playground-registry.ts). Audit page organization: pages with too many showcases (propose a max and a split rule), incoherent groupings, ordering. Coverage: diff the shared/ui primitive list and reusable feature/widget components against existing showcases — list components that SHOULD be in the playground but are not. Stale showcases whose props/variants no longer match the real component. Read .claude/skills/maintaining-dev-playground/SKILL.md first.',
  },
  {
    key: 'copy',
    model: 'opus',
    title: 'Copy (ELI5)',
    brief:
      'User-facing strings across apps/client/src: button labels, empty states, error messages, tooltips, onboarding, settings descriptions, dialogs. Apply the writing-for-humans standard (read .claude/skills/writing-for-humans/SKILL.md or .agents/skills equivalent): short sentences, simple friendly words a newcomer to AI agents understands, consistent terminology (one name per concept — e.g. is it "agent", "session", "chat"? map the vocabulary and flag drift), zero retired vocabulary (see scripts/check-banned-words.sh). For each flagged string cite the exact current text and propose the replacement. Sample broadly: onboarding, settings, empty states, errors, marketplace, connections at minimum.',
  },
  {
    key: 'responsive',
    model: 'sonnet',
    title: 'Responsiveness',
    brief:
      'Mobile/tablet/desktop behavior in code: grep for sm:/md:/lg: usage patterns and their absence in leaf components; touch targets under 44px (h-6, h-7, size-6 buttons/icons without touch-target handling — read shared/ui/touch-target.ts first); fonts/buttons/icons that should get BIGGER on mobile; fixed widths that overflow small screens; hover-only affordances (opacity-0 group-hover:opacity-100) with no touch-device fallback; dialogs/popovers not adapting to drawer/sheet on mobile. Check how existing responsive components (mobile-tabs widget, drawer) do it, then flag components that do not.',
  },
  {
    key: 'states',
    model: 'sonnet',
    title: 'UI states',
    brief:
      'Interaction and data states across shared/ui and major features: hover, active/pressed, focus-visible, disabled, loading, empty, error, skeleton. Grep for interactive elements (onClick on div/span, Button usages, row components) missing hover/active feedback; missing focus-visible rings; features rendering lists with no empty state or no error state; skeletons that do not match final layout. Compare sibling components for state inconsistency (one row highlights on hover, its sibling does not).',
  },
  {
    key: 'motion',
    model: 'opus',
    title: 'Motion & micro-interactions',
    brief:
      'What a world-class motion designer would fix or add, inside Calm Tech limits (read contributing/animations.md and contributing/design-system.md anti-patterns first — no bounces, no spins, no drama). Audit existing motion usage (grep "motion", "animate-", "transition") for: missing enter/exit transitions on overlays/lists, missing press feedback, abrupt layout shifts, inconsistent durations/easings, and REMOVE-worthy dramatic motion. Then propose the top quiet micro-interactions and delight-and-surprise moments worth adding, each tied to a concrete component.',
  },
  {
    key: 'clutter',
    model: 'opus',
    title: 'Clutter, simplification & progressive disclosure',
    brief:
      'Product-designer pass over the major surfaces: home/team room, session/chat view, settings, connections, marketplace, tasks, activity, onboarding, right panel, one-bar. For each: what would a world-class product designer cut, merge, reorder, or hide behind progressive disclosure? Surfaces doing too much at once, settings panels listing advanced options flat, toolbars with too many always-visible controls, duplicate paths to the same action. Judge against the personas: Kai wants density with calm; Ikechi must not be scared off. Read the actual page/widget components to ground every claim.',
  },
  {
    key: 'componentize',
    model: 'sonnet',
    title: 'Componentization',
    brief:
      'Repeated inline JSX patterns across features/widgets that should become shared components (grep for repeated structural patterns: icon+title+description headers, labeled key-value rows, status chips built inline, card headers, inline empty states). Ad-hoc reimplementations of things shared/ui already solves. Plus: which shadcn primitives in shared/ui are still near-stock and worth customizing for DorkOS (better responsive behavior, refined styling, micro-interactions) — list concrete upgrade ideas per primitive.',
  },
];

phase('Audit');
const auditorPrompt = (l) => `You are one auditor in a twelve-lens UI/UX audit of the DorkOS client.

Repo root: /Users/doriancollier/Keep/dork-os/dorkos. Work read-only on the main checkout — you must NOT modify any source file.

First read your charter: ${CHARTER} (the whole file, including the ground-truth doc list — read those docs too). Your lens is "${l.title}".

Lens brief: ${l.brief}

Rules (from the charter, binding):
- Every finding cites at least one real file:line you actually read.
- One finding = current state + why it falls short + concrete recommendation. Pattern findings covering many files are encouraged (list the files).
- Severity P1/P2/P3 and effort S/M/L per the charter rubric.
- Calm Tech bounds every recommendation. Check decisions/ before flagging something that might be a settled ADR.
- Be comprehensive within your lens: aim for full coverage of shared/ui and honest sampling elsewhere; state coverage explicitly.

Write your FULL findings (all of them, ranked by severity) as markdown to: ${RAW_DIR}/${l.key}.md
Format: a coverage section, then one "### [P?/effort] Title" block per finding with files, evidence, recommendation.

Then return the structured summary: coverage note, counts by severity, and your top findings (max 12).`;

const results = await parallel(
  LENSES.map(
    (l) => () =>
      agent(auditorPrompt(l), {
        label: `audit:${l.key}`,
        phase: 'Audit',
        model: l.model,
        schema: FINDINGS_SCHEMA,
      }).then((r) => ({ lens: l.key, title: l.title, ...r }))
  )
);

const done = results.filter(Boolean);
log(`${done.length}/12 auditors reported; synthesizing`);

phase('Synthesize');
const synthesis = await agent(
  `You are the synthesizer for a twelve-lens UI/UX audit of the DorkOS client (repo /Users/doriancollier/Keep/dork-os/dorkos).

Read the charter at ${CHARTER}, then read EVERY raw findings file in ${RAW_DIR}/ (up to 12 markdown files).

Your job:
1. Dedup: the same underlying issue reported by multiple lenses becomes ONE finding (keep the best evidence, note the lenses that saw it).
2. Sanity-check: drop findings that violate charter rules (no file:line citation, relitigates an ADR, anti-Calm-Tech recommendation). Spot-verify at least 15 findings by opening the cited files; drop any whose citation does not hold.
3. Group the surviving findings into coherent WORK BATCHES — each batch is one future PR-sized chunk (or one spec for L items): same slice/theme, 3-15 findings each. Name each batch, give it a priority (from its worst finding), and list its finding titles with files.
4. Write the master report to /Users/doriancollier/Keep/dork-os/dorkos/plans/ui-ux-audit-202609/01-findings.md with: executive summary (10 sentences max, plain language), stats table (findings by lens x severity), then the batches in priority order, each finding with severity/effort/files/evidence/recommendation. This report must stand alone — a reader who never sees the raw files gets everything.

Do NOT modify any source file. Return: total findings before/after dedup, number of batches, and the batch list (name, priority, finding count, effort mix, one-line scope).`,
  {
    label: 'synthesize',
    phase: 'Synthesize',
    model: 'opus',
    effort: 'high',
    schema: {
      type: 'object',
      required: ['totalBefore', 'totalAfter', 'batches'],
      properties: {
        totalBefore: { type: 'number' },
        totalAfter: { type: 'number' },
        batches: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'priority', 'findingCount', 'scope'],
            properties: {
              name: { type: 'string' },
              priority: { enum: ['P1', 'P2', 'P3'] },
              findingCount: { type: 'number' },
              effortMix: { type: 'string' },
              scope: { type: 'string' },
            },
          },
        },
      },
    },
  }
);

return {
  auditors: done.map((d) => ({ lens: d.lens, counts: d.counts, coverage: d.coverage })),
  synthesis,
};

---
title: 'Pulse Template Gallery UX — Patterns, File Location, Schema, and Interaction Design'
date: 2026-03-11
type: external-best-practices
status: active
tags:
  [
    pulse,
    templates,
    template-gallery,
    ux,
    onboarding,
    empty-state,
    create-dialog,
    cron,
    scheduler,
    calm-tech,
  ]
feature_slug: pulse-template-gallery
searches_performed: 14
sources_count: 22
---

# Pulse Template Gallery UX

**Research Date:** 2026-03-11
**Research Mode:** Deep Research
**Topic:** Template gallery UX patterns for Pulse scheduler — gallery presentation, file location, schema design, factory vs user templates, and interaction design for the create dialog

---

## Research Summary

Template galleries in developer tools split into two distinct archetypes: the **onboarding gallery** (wide, discoverable, visual) and the **in-form template picker** (focused, fast, inline). Power-user tools like GitHub Actions, Linear, and VS Code consistently choose the in-form pattern for creation flows — templates exist to pre-fill a form, not to replace it. The right file location for Pulse templates is a dedicated per-feature file (`~/.dork/pulse/templates.json`) rather than a centralized config, for reasons of scope isolation and future-proofing. Factory defaults should be bundled in the binary (never written to disk), with user templates stored separately as a first-class extension of the built-in set. The recommended interaction is: template selection → form pre-fill → user edits → save, with the template picker surfacing inside the existing `CreateScheduleDialog` rather than as a separate modal.

---

## Key Findings

### 1. Template Gallery Archetypes

Production tools use two fundamentally different patterns depending on context:

**The Standalone Gallery** (Vercel, Railway, Raycast templates page):

- Wide card grid (typically 3–4 columns)
- Large preview image or icon, name, brief description
- Category/tag filtering, sometimes search
- Used for browsing and discovery — the user has no specific form open
- The click action is "deploy" or "create project" — the template IS the creation action
- Not appropriate for an inline creation dialog

**The In-Form Picker** (GitHub Actions, Linear, VS Code, Zapier):

- Compact list or small card grid
- Name + one-line description
- No images — metadata only
- Surfaced inside a creation dialog, before or alongside form fields
- The click action is "apply to this form" — the template pre-fills fields, then the user edits
- This is the right pattern for Pulse's `CreateScheduleDialog`

The key insight: **the gallery archetype is determined by whether a form exists at the destination.** Vercel shows a wide gallery because clicking a template IS the deployment. GitHub Actions shows a compact in-form picker because clicking a template pre-fills a YAML editor. Pulse has a form (`CreateScheduleDialog`), so it belongs to the second archetype.

### 2. How Specific Tools Handle Templates

#### GitHub Actions — The Gold Standard for Developer Tool Templates

GitHub Actions' workflow template picker appears when clicking "New Workflow" in the Actions tab. The UX:

- Compact card grid (2-column on most viewports) inside the page — not a modal
- Each card: icon (SVG), name, description (2 lines max), category badges
- Category filters at the top: CI, Deployment, Security, Automation, Pages
- "Skip this and set up a workflow yourself" link for power users who don't want a template
- Clicking a card opens the YAML editor pre-populated with the template content
- The user edits the YAML before committing — they always land in edit mode, never "applied and done"

Template metadata schema (`.properties.json`):

```json
{
  "name": "Node.js CI",
  "description": "Build and test a Node.js project with npm.",
  "iconName": "nodejs",
  "categories": ["CI", "JavaScript", "Node"],
  "filePatterns": ["package.json", "node_modules"]
}
```

Key behavior: `filePatterns` makes templates context-aware — the Node.js template surfaces prominently when the repo has `package.json`. This is a powerful pattern for Pulse: templates could surface differently based on the selected `cwd` (e.g., if the directory is a Node project, Node-relevant templates rank higher).

#### Zapier — Pre-Filled Form as Template Application

Zapier Zap templates are defined as "ready-made Zaps with apps and core fields pre-selected." The critical pattern: **templates are simply pre-filled URLs**. A template is a set of field values encoded into a URL that opens the Zap editor with those fields already populated. The user then completes any empty fields and publishes.

This produces the smoothest template-to-creation flow possible:

1. User clicks a template in a gallery or via a link
2. The creation form opens with relevant fields filled
3. User reviews, edits if needed, saves
4. No intermediate "template preview" step — they're already in the editor

Implication for Pulse: applying a template should be equivalent to clicking "New Schedule" and having the form pre-populated. There should be no extra "confirm you want to use this template" step.

#### Linear — Template Picker in Creation Modal

Linear's issue and project templates surface inside the creation modal, via a "Template" button in the issue creation flow. The picker opens a compact dropdown/popover showing available templates with name and description. Selecting one applies the template's fields to the current form state. The user is then in the normal editing flow.

Key observation: Linear does NOT navigate to a separate "template browser" page. The template picker is a compact, focused overlay that doesn't disrupt the creation flow. This is important — it means templates are a shortcut, not a gateway.

#### VS Code Snippets — Bundled vs User: The Definitive Pattern

VS Code's snippet system is the clearest real-world precedent for the factory-vs-user template question:

- **Built-in snippets** are bundled in language extensions — they're not files on disk, they're compiled into the extension. Users cannot directly edit or delete them.
- **User snippets** live in `~/.config/Code/User/snippets/` (or platform equivalent). Users create them via "Configure Snippets" in the menu.
- **Project snippets** live in `.vscode/` at the project root.

The differentiation in the UI: when you trigger snippet autocomplete, built-in snippets and user snippets appear in the same list, indistinguishable except that user snippets take precedence for identical prefix matches. There's no visual "this is a system snippet" badge.

The behavior when a "built-in" is present: users can create a user snippet with the same prefix/name to override it. There's no mechanism to "delete" a built-in — you override or ignore it.

#### Railway Templates — Discovery-Oriented Gallery

Railway's template marketplace at `railway.com/templates` is a full discovery surface — not used during the creation of a specific resource type. Templates here represent full project stacks (Postgres + Redis + Node, for example). The visual pattern: card grid with icon, name, description, star count, deploy count.

This pattern is not applicable to Pulse's single-resource template picker, but it informs how a future "Pulse Template Marketplace" might look if DorkOS ever allows community-contributed templates.

### 3. Where to Surface Templates in the Pulse UI

Three surface areas are identified in the brief:

**Surface 1: Onboarding wizard**
Pattern: Notion's blank canvas problem. The first time Pulse is enabled and there are no schedules, show the template gallery prominently as the entry point — not a compact in-form picker, but a fuller card view. This is the one place where a wider gallery layout makes sense because the user has no existing context and needs orientation.

Recommended pattern: The onboarding "gallery" state shows 3–5 curated starter templates as cards with name, cron description, and use-case summary. Below them: "Create custom schedule" as a text link. The user clicks a card and lands in the `CreateScheduleDialog` with that template pre-applied.

**Surface 2: Empty state (no schedules exist)**
Pattern: NN/Group's empty state guidelines — provide a "pull revelation" that shows what the module does and offers a direct task pathway. The empty state is NOT the place for a full gallery. It's the place for:

- A single-paragraph explanation of what Pulse does
- 2–3 featured/popular template cards (compact, horizontal, pill-style)
- A primary CTA: "Create schedule" button that opens `CreateScheduleDialog`

The small template cards in the empty state are teasers — clicking one opens `CreateScheduleDialog` with that template pre-applied. This is the same pattern as Notion's "Suggested templates" section in an empty database.

**Surface 3: Create-new dialog**
Pattern: GitHub Actions / Linear in-form picker. Inside `CreateScheduleDialog`, above the form fields, show a compact template picker. This is the "start from template" shortcut before the user fills anything in.

The picker should be:

- Collapsed by default (a "Start from template..." button or `ToggleGroup`)
- When expanded: a compact horizontal scroll of template chips (pill buttons) or a small 2-column grid
- Selecting a template: pre-fills the form fields, collapses the picker, and focuses the `name` field for editing
- The form remains fully editable after template application — the user can change anything
- An "x" or "Clear template" affordance resets the form to blank if they want to start fresh

### 4. Template Cards: Visual Design

For Calm Tech / minimal design language, template cards should be information-dense but not decorative:

```
┌─────────────────────────────────────────┐
│ Daily Digest                            │
│ 0 9 * * *  ·  Every day at 9am         │
│                                         │
│ Summarize the day's important events    │
│ and send a status report.               │
└─────────────────────────────────────────┘
```

No icons, no colors, no illustrations. Name, cron expression (with human-readable translation), 1-2 sentence description. On hover: subtle background shift. On click: apply and collapse.

For power users, show the raw cron expression prominently — they can assess a template's fit at a glance from the cron string, without needing to read the description.

---

## Detailed Analysis

### File Location: `.dork/pulse/templates.json` vs Alternatives

**Evaluated options:**

| Path                                  | Assessment                                                    |
| ------------------------------------- | ------------------------------------------------------------- |
| `~/.dork/pulse/templates.json`        | Recommended — per-feature, scoped, predictable                |
| `~/.dork/templates/pulse.json`        | Reasonable — explicit templates directory, future-proof       |
| `~/.dork/config/pulse-templates.json` | Acceptable — but mixes config with data                       |
| `~/.dork/config.json` (embedded)      | Rejected — conflates runtime config with user-defined content |

**Recommendation: `~/.dork/pulse/templates.json`**

Rationale:

1. **Scope isolation**: Templates are Pulse-specific data, not global DorkOS config. The existing `~/.dork/` hierarchy (`~/.dork/config.json`, `~/.dork/agent.json`) is flat. Adding a `pulse/` subdirectory isolates feature-specific data in a way that scales cleanly: `~/.dork/mesh/`, `~/.dork/relay/` can follow the same pattern.

2. **Precedent from the CLI tool landscape**: Docker uses `~/.docker/` with feature-specific subdirectories (`~/.docker/contexts/`, `~/.docker/config.json`). npm uses `~/.npm/` with feature subdirs. The pattern of `~/.tool/feature/data.json` is established and intuitive.

3. **Not in config.json**: The config-file research (see `research/dorkos-config-file-system.md`) established that `~/.dork/config.json` is for runtime configuration. User-defined templates are user content — they belong closer to the `agent.json` data model than the config model.

4. **Future-proofing**: If Mesh and Relay eventually have templates, they go in `~/.dork/mesh/templates.json` and `~/.dork/relay/templates.json`. The pattern is obvious and consistent.

5. **Not `~/.dork/templates/pulse.json`**: A `templates/` subdirectory implies that templates are a cross-cutting concern managed together. They are not — a Pulse template has nothing structurally in common with a hypothetical Mesh agent template. Organizing by feature is cleaner than organizing by artifact type.

**On lazy creation:** The file should not be written to disk until the user creates their first custom template. Factory templates (bundled in the binary) require no disk file. The file is created on first `POST /api/pulse/templates` or equivalent.

### Factory Defaults vs User Templates

**The correct model:**

Factory templates are **bundled in the server binary** as TypeScript constants, never written to disk. User templates are written to `~/.dork/pulse/templates.json`. At runtime, the server merges the two lists: factory templates first (as the "base"), user templates appended (with possible override capability by matching `id`).

This is exactly how VS Code snippets work: built-in snippets are compiled into the extension, user snippets live on disk. The distinction is an implementation detail — both surfaces appear in the same picker.

**Why factory templates should NOT be written to disk:**

1. If factory templates are written to disk on first run, users can delete or corrupt them. There's no recovery path short of "reinstall DorkOS."
2. If factory templates are written to disk, the server needs to detect "was this file modified by the user or does it still match the binary's built-in set?" — an unnecessary complexity.
3. Updates to factory templates (new versions of DorkOS ship better defaults) can't be delivered if the template is locked to the user's disk file.

**Why factory templates SHOULD be bundled in binary:**

1. Updates to factory templates ship automatically with DorkOS version upgrades
2. No recovery needed — if the user deletes `~/.dork/pulse/templates.json` entirely, factory templates are still present
3. Simpler implementation: factory templates are a `const` in the server, not a file operation

**"Deleting" a factory template:**

The user cannot delete factory templates; they can only "hide" them. This is done by a `hidden: true` flag in the user's own record for a factory template `id`. The merge logic: if the user templates file contains `{ id: "daily-digest", hidden: true }`, that factory template is excluded from the picker. This is consistent with how many CLI tools handle "suppressed defaults" without actually modifying the default.

Alternatively, take the simpler route: factory templates cannot be hidden. If a user doesn't want them, they scroll past them. For a curated list of 8–12 factory templates, this is not a real problem.

**Rendering order in the picker:**

```
[Factory templates — sorted by frequency of use, pinned at top]
[User templates — sorted by creation date, newest first]
```

A visual separator between the two groups: a hairline divider + label "My templates" for the user section. No label needed for factory templates — they're the implicit default.

### Template Schema Design

**Recommended Zod schema:**

```typescript
import { z } from 'zod';

// The "source" of a template: is it bundled or user-created?
const TemplateSourceSchema = z.enum(['builtin', 'user']);

// Friendly cron aliases that expand to standard 5-field expressions
const CronAliasSchema = z.enum([
  '@hourly',
  '@daily',
  '@midnight',
  '@weekly',
  '@monthly',
  '@yearly',
  '@annually',
]);

const TemplateCronSchema = z.union([
  // Standard 5-field cron expression
  z.string().regex(/^(\S+\s){4}\S+$/, 'Must be a valid 5-field cron expression'),
  CronAliasSchema,
]);

export const PulseTemplateSchema = z.object({
  // Unique stable identifier. Slugified. Factory templates use prefixed IDs: "builtin:daily-digest"
  id: z.string().min(1),

  // Display name. Short, noun-phrase form. Max 40 chars.
  name: z.string().min(1).max(40),

  // One or two sentences describing what this template does.
  // Written from the agent's perspective: "Summarizes recent commits..."
  description: z.string().min(1).max(200),

  // The cron expression or alias. Stored as-is; UI shows human-readable translation.
  cron: TemplateCronSchema,

  // Default prompt text. Should be generic enough to be immediately useful.
  // Max 500 chars to keep templates approachable.
  prompt: z.string().min(1).max(500),

  // Permission mode. 'default' is the safe choice; some templates benefit from 'bypassPermissions'.
  permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions']).default('default'),

  // Optional: working directory hint. Null means "use the dialog's current cwd selection."
  // User will always override this in the dialog, so it's a suggestion only.
  cwdHint: z.string().nullable().default(null),

  // Category for grouping in the picker. Keep this list small (3-5 values max).
  category: z
    .enum(['maintenance', 'reporting', 'monitoring', 'productivity', 'custom'])
    .default('custom'),

  // Source distinguishes factory from user templates at runtime.
  // Not stored in the user's JSON file (implied by which list they came from).
  // Present in the merged runtime representation.
  source: TemplateSourceSchema,

  // ISO timestamp. Factory templates use the DorkOS release date.
  createdAt: z.string().datetime(),
});

// The shape of the user-facing templates file on disk.
// Factory templates are NOT in this file.
export const UserTemplatesFileSchema = z.object({
  version: z.literal(1),
  templates: z.array(PulseTemplateSchema.omit({ source: true })),
});

export type PulseTemplate = z.infer<typeof PulseTemplateSchema>;
export type UserTemplatesFile = z.infer<typeof UserTemplatesFileSchema>;
```

**What is intentionally excluded and why:**

- **`tags`**: Tags require a consistent taxonomy. For a set of 8-12 factory templates plus user additions, categories are sufficient. Tags would appear in the picker as noise.
- **`icon`**: Calm Tech design language doesn't use decorative icons in data-dense lists. The cron expression and category are the visual differentiators.
- **`difficulty`**: DorkOS is for Kai (senior dev). There's no "beginner" difficulty. This field would imply a user skill spectrum that doesn't match the persona.
- **`author`**: Only relevant if templates are community-sourced. For a local factory + user model, authorship is implicit.
- **`version` on individual templates**: Schema migrations are handled at the file level (`UserTemplatesFileSchema.version`), not per-template. Individual template versioning adds complexity with no clear use case.
- **`maxRuntime`**: This is a runtime configuration concern, not a template concern. Templates shouldn't encode assumptions about how long a task will take.

**Friendly cron aliases:** Yes, support them. The scheduler's underlying node-cron or equivalent library already supports `@daily`, `@weekly`, etc. Storing them in the template means the UI can display them as-is (the human-readable form is obvious) without needing cronstrue to translate. Factory templates should prefer aliases where they naturally apply (`@daily`, `@weekly`) and 5-field expressions only where aliases don't exist (e.g., "every weekday at 9am" = `0 9 * * 1-5`).

### Recommended Factory Templates

Based on the preset catalog from prior research (`20260221_pulse_scheduler_ux_redesign.md`) plus AI agent-specific use cases:

```typescript
export const BUILTIN_PULSE_TEMPLATES: PulseTemplate[] = [
  {
    id: 'builtin:daily-digest',
    name: 'Daily Digest',
    description:
      'Summarize what happened today across your project — recent commits, open PRs, and any issues that need attention.',
    cron: '0 18 * * 1-5', // 6pm weekdays
    prompt:
      'Review the recent activity in this project. Summarize commits from today, any open pull requests, and issues that were updated. Write a brief status digest.',
    permissionMode: 'default',
    category: 'reporting',
    source: 'builtin',
    createdAt: '2026-03-01T00:00:00Z',
  },
  {
    id: 'builtin:overnight-sweep',
    name: 'Overnight Sweep',
    description:
      'Run a nightly code health check — look for obvious issues, outdated dependencies, and anything that should be addressed.',
    cron: '0 2 * * *', // 2am daily
    prompt:
      'Review the codebase for any obvious code quality issues, outdated dependencies, or TODOs that have been sitting for more than a week. Provide a concise summary with prioritized action items.',
    permissionMode: 'default',
    category: 'maintenance',
    source: 'builtin',
    createdAt: '2026-03-01T00:00:00Z',
  },
  {
    id: 'builtin:weekly-report',
    name: 'Weekly Report',
    description:
      "Generate a weekly summary of progress, blockers, and what's next. Good for async standups and stakeholder updates.",
    cron: '0 9 * * 1', // Monday 9am
    prompt:
      'Generate a weekly progress report for this project. Include: what was completed last week, current blockers, and the plan for this week. Keep it concise and factual.',
    permissionMode: 'default',
    category: 'reporting',
    source: 'builtin',
    createdAt: '2026-03-01T00:00:00Z',
  },
  {
    id: 'builtin:test-run',
    name: 'Scheduled Tests',
    description:
      'Run the test suite on a schedule and report any failures. Useful for catching regressions in long-running branches.',
    cron: '0 6 * * *', // 6am daily
    prompt:
      'Run the test suite for this project. If any tests fail, describe the failures and suggest possible fixes. If all tests pass, confirm with a brief summary.',
    permissionMode: 'acceptEdits',
    category: 'monitoring',
    source: 'builtin',
    createdAt: '2026-03-01T00:00:00Z',
  },
  {
    id: 'builtin:hourly-check',
    name: 'Health Check',
    description:
      'A frequent lightweight check for monitoring purposes. Good for watching a specific file, endpoint, or metric.',
    cron: '0 * * * *', // Hourly
    prompt:
      'Perform a quick health check on this project. Look for any obvious signs of problems: failed processes, error logs, or unexpected file changes. Report findings concisely.',
    permissionMode: 'default',
    category: 'monitoring',
    source: 'builtin',
    createdAt: '2026-03-01T00:00:00Z',
  },
  {
    id: 'builtin:monthly-cleanup',
    name: 'Monthly Cleanup',
    description:
      'Run a monthly maintenance pass — clean up stale branches, archive completed tasks, and tidy the project structure.',
    cron: '0 9 1 * *', // 1st of month at 9am
    prompt:
      'Perform a monthly project cleanup. Look for: stale git branches that can be deleted, completed TODO items that can be removed, outdated documentation that should be updated, and any obvious tech debt to document.',
    permissionMode: 'default',
    category: 'maintenance',
    source: 'builtin',
    createdAt: '2026-03-01T00:00:00Z',
  },
];
```

### Recommended UX Flow: Template in Create Dialog

**The recommended interaction:**

```
State 0: CreateScheduleDialog opens, form blank
  └─ Template picker area: collapsed, shows "Start from a template" chevron link

State 1: User clicks "Start from a template"
  └─ Template picker expands inline (not a modal)
     Shows compact card grid: factory templates first, then user templates
     3-4 cards visible, horizontal scroll for overflow
     Each card: name, cron description, 2-line description summary

State 2: User clicks a template card
  └─ Picker collapses
     Form fields fill in: name, cron, prompt, permissionMode
     A small "Applied: Daily Digest ×" chip appears above the form
     Focus moves to the name field (let them rename immediately)

State 3: User edits any/all fields (cron, prompt, name, timezone, etc.)
  └─ Editing any field does NOT clear the "Applied: X" chip
     The chip is informational only — it's not a lock

State 4: User saves
  └─ Schedule created. Template chip disappears.
     If user clicks "×" on the chip: form resets to blank
```

**Key decisions in this flow:**

1. **Picker is collapsed by default**: This matches Linear's and GitHub Actions' approach. Users who know what they want don't need the template picker interrupting their flow. It's a shortcut, not a mandatory first step.

2. **Picker is inline, not a modal over a modal**: Opening a second modal over `CreateScheduleDialog` would be confusing and violates the "single modal at a time" convention. The picker expands within the dialog itself.

3. **Pre-fill, not replace**: Applying a template fills the form. The user is then in normal editing mode — they can change anything. The template is not applied as a locked blueprint.

4. **No "preview before applying" step**: The card itself (name, cron, description) is the preview. Adding a separate preview step ("here's what the template will fill in — confirm?") introduces friction that no comparable tool uses. Zapier, GitHub Actions, and Linear all apply immediately on click.

5. **The "×" chip allows escape**: If the user wants to start fresh after applying a template, they click the chip's × to clear all fields. This prevents the "now my form is filled with template stuff and I can't undo" frustration.

6. **Search is not needed for the in-form picker**: With 6-12 factory templates plus a small number of user templates, the picker doesn't need search. A scrollable compact grid is sufficient. Search is only needed if the template library grows beyond ~20 entries, which is a future problem.

### Template Picker in the Onboarding Wizard / Empty State

When there are no schedules yet, the empty state should function as a lightweight onboarding surface. The recommended layout:

```
[Illustration or icon: clock/pulse — minimal, monochrome]

No schedules yet.

Pulse runs agent tasks automatically on a schedule.
Set one up to run overnight, on a timer, or every weekday.

Start from a template:
┌─────────────────────────┐ ┌─────────────────────────┐ ┌─────────────────────────┐
│ Daily Digest            │ │ Weekly Report           │ │ Overnight Sweep         │
│ Every weekday at 6pm    │ │ Mondays at 9am          │ │ Nightly at 2am          │
│ Summarize project       │ │ Weekly progress summary │ │ Codebase health check   │
│ activity...             │ │ for your team...        │ │ and tech debt scan...   │
└─────────────────────────┘ └─────────────────────────┘ └─────────────────────────┘

[Create custom schedule]   (text link, not a primary button — the templates are the primary action)
```

Clicking any template card opens `CreateScheduleDialog` with that template pre-applied. Clicking "Create custom schedule" opens `CreateScheduleDialog` blank (no template).

Show exactly 3 cards in the empty state — no more. 3 is enough to convey "this is a range of use cases" without overwhelming. Rotate which 3 are shown based on category variety (one reporting, one maintenance, one monitoring).

---

## Recommendations Summary

### 1. File Location: Use `~/.dork/pulse/templates.json`

- User-defined templates only; factory templates are constants in the server binary
- Lazy-create the file on first user template save
- Schema: `UserTemplatesFileSchema` with `version: 1` for migration support
- Follow the same pattern for future features: `~/.dork/mesh/templates.json`, etc.

### 2. Factory vs User Templates: Bundle in Binary, Never on Disk

- Factory templates are TypeScript constants in `services/pulse/templates.ts`
- They are never written to `~/.dork/pulse/templates.json`
- The server merges factory + user at runtime: factory first, user appended
- User templates can shadow factory templates by matching `id` (advanced override)
- There is no "delete factory template" operation — users can't remove built-ins
- When DorkOS updates, factory template improvements ship automatically

### 3. Schema: Minimal but Complete

Required fields: `id`, `name`, `description`, `cron`, `prompt`
Optional fields: `permissionMode` (default: `'default'`), `cwdHint` (default: `null`), `category`
Excluded: `tags`, `icon`, `difficulty`, `author`, `version` (per template)
Support friendly cron aliases (`@daily`, `@weekly`) in addition to 5-field expressions
File-level versioning via `UserTemplatesFileSchema.version` for future migrations

### 4. UX Flow: Template Picker Inside `CreateScheduleDialog`

- Collapsed by default; expandable via "Start from a template" link
- Inline expansion within the dialog — no modal-over-modal
- Compact card grid showing name + cron + description
- Click to pre-fill form; form remains editable
- "Applied: X ×" chip allows clear/reset
- No separate preview step

### 5. Empty State: 3 Featured Templates + "Create custom" Link

- Show 3 rotating template cards (one per category)
- Clicking a card opens `CreateScheduleDialog` with template pre-applied
- "Create custom schedule" as a secondary text link
- No fake/ghost schedule data — Calm Tech principle: only show what is real

### 6. Template Count Guidance

- Factory templates: 6–8 is the sweet spot. Enough to demonstrate range of use cases; few enough to scan without scrolling in the picker.
- More than 10 factory templates requires categories/filtering, which adds UI complexity
- Start with 6 (daily digest, weekly report, overnight sweep, health check, test runner, monthly cleanup)
- Add more only when specific user needs are identified

---

## Research Gaps and Limitations

- **No direct user research on DorkOS Pulse template usage**: All recommendations are synthesized from analogous tools. User testing would validate whether the collapsed-by-default picker is the right default for Kai's workflow.
- **Community template marketplace not researched**: If DorkOS eventually allows community-contributed Pulse templates (like Zapier's Zap templates or n8n's workflow gallery), a different discovery model would be needed. That's a future problem.
- **Mobile/responsive not considered**: Pulse is a desktop panel; template cards are designed for desktop widths.
- **Template "save from existing schedule" flow**: This research does not cover the flow for creating a user template FROM an existing schedule (i.e., "Save this schedule as a template"). That interaction would need separate design work.

---

## Contradictions and Disputes

- **Template picker: collapsed vs expanded by default**: The research supports collapsed-by-default for power users (don't interrupt the expert flow). However, for first-time users who have just come from the onboarding empty state, they've already seen the template picker — opening `CreateScheduleDialog` with it collapsed would feel like a regression. Potential resolution: use a `localStorage` flag to show the picker expanded on first `CreateScheduleDialog` open, then collapsed on subsequent opens.

- **6 vs 8 vs 12 factory templates**: More templates demonstrate more use cases but create picker cognitive load. The research on in-form pickers (GitHub Actions, Linear) suggests showing all templates is fine up to ~15 without needing search. For Pulse specifically, the constraint is: how many distinct use cases does a senior developer who runs AI agents actually have? The answer is likely 6-8. Building more than that before seeing usage data is premature optimization.

- **Category labels on factory templates**: Categories are useful if the user has many templates. With 6 factory templates, the category label may be overhead. A simpler approach: just sort by use-case breadth (most general first) and skip categories until the template list exceeds 10.

---

## Sources and Evidence

- [GitHub Actions: Using workflow templates](https://docs.github.com/en/actions/writing-workflows/using-workflow-templates) — Template picker pattern, metadata schema
- [GitHub Actions: Creating workflow templates for your organization](https://docs.github.com/en/actions/using-workflows/creating-starter-workflows-for-your-organization) — Template metadata JSON format (`name`, `description`, `iconName`, `categories`, `filePatterns`)
- [Zapier: Zap templates](https://platform.zapier.com/publish/zap-templates) — Pre-filled form as template application; "ready-made with apps and core fields pre-selected"
- [Zapier: Pre-filled Zaps](https://docs.zapier.com/partner-solutions/pre-filled-zaps) — URL-based prefill as template mechanism
- [Linear: Issue templates](https://linear.app/docs/issue-templates) — In-modal template picker pattern for creation flows
- [Linear: Project templates (Changelog 2023-09-21)](https://linear.app/changelog/2023-09-21-project-templates) — Template picker inside project creation modal
- [VS Code: Snippets (User-defined)](https://code.visualstudio.com/docs/editing/userdefinedsnippets) — Bundled vs user-defined snippet distinction; global/language/project scope
- [Railway: Templates documentation](https://docs.railway.com/templates) — Template marketplace pattern for full-stack deployment templates
- [Raycast: Templates page](https://www.raycast.com/templates) — Card grid with featured + all template sections, no categories/search
- [n8n: Workflow gallery](https://n8n.io/workflows/) — Community template discovery; noted discoverability problems with large unfiltered template sets
- [.NET template.json reference](https://github.com/dotnet/templating/wiki/Reference-for-template.json) — `name`, `identity`, `classifications`, `tags` fields; no per-template versioning
- [DorkOS: Pulse Scheduler UX Redesign Research](research/20260221_pulse_scheduler_ux_redesign.md) — Preset catalog, three-tier cron input model, Calm Tech application
- [DorkOS: FTUE Best Practices Deep Dive](research/20260301_ftue_best_practices_deep_dive.md) — Empty state design, progressive disclosure, Notion's blank canvas template solution
- [DorkOS: Config File System Research](research/dorkos-config-file-system.md) — `~/.dork/` directory structure, config vs data distinction
- [crontab.guru: Cron aliases](https://crontab.guru/) — `@daily`, `@weekly`, `@monthly`, `@hourly` alias support and meanings
- [Nielsen Norman Group: Empty states in complex applications](https://www.nngroup.com/articles/empty-state-interface-design/) — Three functions: communicate status, provide learning cues, offer direct task pathway

---

## Search Methodology

- Searches performed: 14
- Most productive search terms: "GitHub Actions workflow templates picker metadata JSON", "Zapier template apply prefill form UX", "VS Code snippets builtin vs user", "Linear project template picker creation modal", "friendly cron @daily @weekly aliases scheduler design"
- Primary source types: Official tool documentation, changelog entries, design system guides, prior DorkOS research reports
- Research depth: Deep — covered all 5 research questions with production tool examples and concrete recommendations

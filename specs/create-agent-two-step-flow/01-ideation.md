---
slug: create-agent-two-step-flow
number: 235
created: 2026-04-11
status: ideation
design-session: .dork/visual-companion/96097-1775935464
---

# Create Agent Two-Step Wizard Flow

**Slug:** create-agent-two-step-flow
**Author:** Claude Code
**Date:** 2026-04-11
**Branch:** preflight/create-agent-two-step-flow

---

## 1) Intent & Assumptions

- **Task brief:** Redesign the Create Agent dialog from a three-tab layout to a two-step wizard with instant-advance cards. Step 1 presents three method cards (Blank, Template, Import) — clicking a card instantly advances to the relevant next step. Template selection uses marketplace PackageCards. Name auto-fills from selected template. Merges the directory-browser-agent-creation ideation (spec #234) into this work.
- **Assumptions:**
  - The recently implemented three-tab dialog (spec #232) is the starting point — all entry point wiring is already correct
  - The existing `motion/react` library and `AnimatePresence` pattern (used in 135+ files including AdapterSetupWizard) will be reused for step transitions
  - The existing `DirectoryPicker` component (shared/ui, 393 lines, 30+ tests) will be reused as-is for the directory browser button
  - The existing marketplace `PackageCard` component will be reused with a new compact/selectable variant for the template picker
  - `useMarketplacePackages({ type: 'agent' })` already filters to agent templates — no backend changes needed
  - The store API (`useAgentCreationStore.open(mode?)`) stays backward-compatible with current callers
- **Out of scope:**
  - Onboarding UI changes (keeps own flow)
  - Server-side creation pipeline changes
  - Native OS file dialog integration (Electron `dialog.showOpenDialog`)
  - Agent settings/editing dialog changes
  - CLI/MCP tool creation paths

## 2) Pre-reading Log

- `apps/client/src/layers/features/agent-creation/ui/CreateAgentDialog.tsx`: Current three-tab dialog (280 lines). Uses Radix Tabs, has DRY violation with duplicated Name/Directory sections across New Agent and From Template tabs
- `apps/client/src/layers/features/agent-creation/ui/TemplatePicker.tsx`: Current template picker (113 lines). Marketplace agent grid via `useMarketplacePackages({ type: 'agent' })` + Advanced collapsible for custom GitHub URL
- `apps/client/src/layers/shared/model/agent-creation-store.ts`: Zustand store (18 lines). `CreationTab = 'new' | 'template' | 'import'`, `open(tab?)` API
- `apps/client/src/layers/features/agent-creation/model/use-create-agent.ts`: TanStack Query mutation hook (21 lines). `transport.createAgent()` + cache invalidation
- `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx`: Existing wizard pattern — `AnimatePresence mode="wait"` + `motion.div key={step}` with opacity fade, `StepIndicator`, `useAdapterWizard` state machine hook
- `apps/client/src/layers/features/relay/ui/wizard/StepIndicator.tsx`: Visual stepper (78 lines) with circles, connectors, completed/active/pending states. Not needed for 2-step flow but pattern is instructive
- `apps/client/src/layers/features/relay/ui/wizard/use-adapter-wizard.ts`: State machine hook (300 lines) with step navigation, validation, forward/back/submit handlers
- `apps/client/src/layers/features/marketplace/ui/PackageCard.tsx`: Marketplace card component (139 lines). Icon, name, type badge, description, author, install button. Needs compact/selectable variant for template picker
- `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`: Full-featured directory browser modal (393 lines) with browse/recent views, folder creation, breadcrumbs, show/hide hidden folders toggle
- `apps/client/src/layers/entities/discovery/ui/ScanRootInput.tsx`: Existing pattern of text input + browse button opening DirectoryPicker
- `apps/client/src/layers/features/mesh/ui/DiscoveryView.tsx`: Component used in Import path — scans filesystem for existing agent projects. Self-contained with its own action buttons
- `apps/client/src/layers/features/dashboard-sidebar/ui/AddAgentMenu.tsx`: Entry point — "Create agent" and "Import project" actions
- `apps/client/src/layers/features/session-list/ui/SidebarTabRow.tsx`: Entry point — Plus button for new agent
- `apps/client/src/layers/features/top-nav/ui/AgentsHeader.tsx`: Entry point — "New Agent" button
- `specs/standardize-agent-creation-flow/02-specification.md`: Previous spec. Deferred items: template name auto-fill, directory browser, .dork conflict detection
- `specs/directory-browser-agent-creation/01-ideation.md`: Directory browser ideation (spec #234). Recommends hybrid text input + browse button using existing DirectoryPicker. ~15 line change. Merged into this spec.
- `research/20260309_chat_microinteractions_polish.md`: Confirms `motion/react` is the established animation library. Spring configs: `{ type: 'spring', stiffness: 320, damping: 28 }` for content arriving, `{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }` for crossfades

## 3) Codebase Map

**Primary Components/Modules:**

- `layers/features/agent-creation/ui/CreateAgentDialog.tsx` — Main dialog, will be fully rewritten from tabs to wizard
- `layers/features/agent-creation/ui/TemplatePicker.tsx` — Template picker, will be adapted to use PackageCard variant
- `layers/shared/model/agent-creation-store.ts` — Store, type rename `CreationTab` → `CreationMode`
- `layers/features/agent-creation/model/use-create-agent.ts` — Mutation hook, unchanged
- `layers/features/marketplace/ui/PackageCard.tsx` — Add compact/selectable variant
- `layers/shared/ui/DirectoryPicker.tsx` — Reused as-is for directory browser
- `layers/features/mesh/ui/DiscoveryView.tsx` — Reused as-is for Import path

**Shared Dependencies:**

- `motion/react` — AnimatePresence + motion.div for step transitions
- `@tanstack/react-query` — Config fetching, marketplace packages, agent creation mutation
- `lucide-react` — Icons (Plus, ArrowLeft, FolderOpen, Check)
- `sonner` — Toast notifications
- `@dorkos/shared/validation` — `validateAgentName()`

**Data Flow:**

```
User action (sidebar +, header button, Cmd+K, etc.)
  │
  ▼
useAgentCreationStore.open(mode?)
  │
  ▼
CreateAgentDialog opens → Step 1: Method Selection
  │
  ├─ Click "Blank" → Step 2: Configure (Name + Directory) → Create
  ├─ Click "Template" → Template Picker → Click template → Configure (pre-filled) → Create
  └─ Click "Import" → DiscoveryView (terminal state)
  │
  ▼
Server creates/registers agent → Cache invalidated → Dialog closes → Agent list refreshes
```

**Feature Flags/Config:** None identified.

**Potential Blast Radius:**

- Direct changes: `CreateAgentDialog.tsx` (major rewrite), `agent-creation-store.ts` (type rename), `PackageCard.tsx` (add variant)
- Indirect: `AddAgentMenu.tsx`, `SidebarTabRow.tsx`, `AgentsHeader.tsx` (only if store API changes — goal is backward compatibility)
- Tests: `CreateAgentDialog.test.tsx` (major rewrite), `TemplatePicker.test.tsx` (moderate), `PackageCard.test.tsx` (add variant tests)
- No changes: `use-create-agent.ts`, `DiscoveryView.tsx`, `DirectoryPicker.tsx`, `AppShell.tsx`

## 4) Root Cause Analysis

N/A — not a bug fix.

## 5) Research

### Potential Solutions

**1. Inline Step Swap — Same Dialog, No Tabs (RECOMMENDED)**

Replace Radix `Tabs` with a plain `step` state machine. Step transitions use `AnimatePresence mode="wait"` + `motion.div key={step}` with opacity fade — identical to the existing `AdapterSetupWizard` pattern.

- Pros:
  - Eliminates duplicated Name/Directory form JSX (170+ lines of duplication gone)
  - Natural linear flow with instant-advance cards
  - Uses existing `motion/react` pattern already in codebase (135+ files)
  - Single Name/Directory form block shared by blank and template paths
  - Store API stays backward-compatible
- Cons:
  - All tab-related tests need rewriting (expected for a redesign)
  - Template path has 3 micro-steps (method → template → configure) while blank has 2
- Complexity: Medium
- Maintenance: Low

**2. Radix Tabs Styled as Step Indicators**

Keep `<Tabs>` but style as linear stepper.

- Pros: Smallest diff to current JSX
- Cons: Tabs are semantically for parallel content, not sequential flow. WCAG guidance favors `role="navigation"` with `aria-current="step"` for wizards. Does NOT eliminate form duplication.
- Complexity: Low
- Maintenance: Medium (semantic mismatch causes accessibility debt)

**3. Stacked Dialogs**

Close first dialog on selection, open second.

- Pros: Clean separation
- Cons: Visual disruption, focus loss, Radix doesn't support nested dialogs cleanly. Not used anywhere in codebase.
- Complexity: Medium
- Maintenance: High

**4. Accordion / Progressive Disclosure**

Single scrolling view, form appears below after choice.

- Pros: Everything visible
- Cons: Import (DiscoveryView) is too tall, creates huge dialog. Doesn't enforce "choose first" ordering.
- Complexity: Low
- Maintenance: Medium

### Recommendation

**Solution 1 (Inline Step Swap)** is the clear choice. It matches the existing AdapterSetupWizard pattern, eliminates the DRY violation, and creates a clean linear flow.

### Key Technical Details

**Step state machine:**

```typescript
type CreationMode = 'new' | 'template' | 'import';
type WizardStep = 'choose' | 'pick-template' | 'configure' | 'import';
```

**Step indicator:** Skip formal `StepIndicator` for this flow (overkill for 2-3 steps). Use `DialogDescription` content change as orientation cue: "How do you want to start?" → "Pick a template" → "Name your agent". The Back button anchors position.

**Template auto-fill:** On advancing from template picker to configure step, set `name` to template's name if `name` is still empty. Pre-populated but immediately editable.

**Animation:** `AnimatePresence mode="wait"` + `motion.div key={step}` with `initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}`.

**PackageCard variant:** Add a `variant?: 'default' | 'compact'` prop using `cva`. Compact variant: smaller padding, no author line, no install button — just icon/name/description with a check indicator on selection.

**Directory browser:** Add `FolderOpen` icon button next to directory input that opens `DirectoryPicker` modal. Same pattern as `ScanRootInput`. Pass `directoryOverride || defaultDirectory` as `initialPath`.

**Accessibility:**

- Focus management: move focus to name input when advancing to configure step
- `aria-live="polite"` region for step change announcements
- Back button first in DOM order on configure step
- Escape/overlay click handled by Radix Dialog as-is

## 6) Decisions

| #   | Decision                          | Choice                                                                                               | Rationale                                                                                                                                  |
| --- | --------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Flow structure                    | Option C: Instant advance — cards click to advance, no Next                                          | Fastest path to creation. Eliminates a button click. Xcode/JetBrains "new project" pattern. User confirmed.                                |
| 2   | Template card component           | Reuse marketplace PackageCard with compact/selectable variant                                        | Consistency across marketplace and creation flow. Avoids creating new components. User explicitly requested marketplace card reuse.        |
| 3   | Template picker placement         | Dedicated step (not inline on Step 1)                                                                | Templates may be numerous and need their own space. User: "there may be many templates to select from, and they may need their own space." |
| 4   | Template indicator on config step | Yes — subtle chip showing selected template with "Change" link                                       | Provides context without taking space. "Change" link navigates back to picker.                                                             |
| 5   | Directory browser                 | Merge spec #234 — add browse button using existing DirectoryPicker                                   | Natural fit for the configure step. DirectoryPicker already exists (393 lines, 30+ tests). ~15 line addition.                              |
| 6   | .dork conflict detection          | Include — debounced inline check on directory path                                                   | Smart UX: detect existing projects and offer to Import instead. Previous spec deferred this as stretch goal; now including.                |
| 7   | Step transitions                  | AnimatePresence opacity fade (motion/react)                                                          | Matches AdapterSetupWizard pattern. Already in codebase (135+ files). Polished feel.                                                       |
| 8   | Step indicator                    | None formal — use DialogDescription text changes                                                     | Overkill for 2-3 steps. Research (NN/g) agrees: for short wizards, back button + descriptive header is sufficient.                         |
| 9   | Store API compatibility           | Backward-compatible — `open(mode?)` keeps same signature                                             | All callers (`AddAgentMenu`, `SidebarTabRow`, `AgentsHeader`, `CommandPalette`) continue working without changes.                          |
| 10  | Back navigation                   | Context-aware: Back from config goes to template picker (if template) or method selection (if blank) | Preserves user's template selection. Avoids losing work.                                                                                   |

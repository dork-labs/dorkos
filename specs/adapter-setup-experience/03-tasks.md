# Task Breakdown: Adapter Setup Experience

Generated: 2026-03-14
Source: specs/adapter-setup-experience/02-specification.md
Last Decompose: 2026-03-14

## Overview

Enhance the adapter setup wizard with a layered documentation system: schema extensions for `setupGuide` and `helpMarkdown`, a shared MarkdownContent component, a slide-out Setup Guide Sheet panel, per-field collapsible help disclosures, Slack manifest URL for one-click app creation, server-side docs loading from `.md` files, and full documentation content for all three user-facing adapters (Slack, Telegram, Webhook).

13 tasks across 5 phases. Key parallelism: Phase 1 tasks 1.1/1.2 are independent; Phase 4 tasks 4.1-4.5 are all independent and can run simultaneously.

---

## Phase 1: Schema & Markdown Rendering Foundation

### Task 1.1: Add setupGuide and helpMarkdown fields to relay adapter schemas

- **Size:** Small | **Priority:** High
- **Dependencies:** None | **Parallel with:** 1.2
- **File:** `packages/shared/src/relay-adapter-schemas.ts`
- Add `helpMarkdown: z.string().optional()` to `ConfigFieldSchema` (after `displayAs`)
- Add `setupGuide: z.string().optional()` to `AdapterManifestSchema` (after `actionButton`)
- Both optional -- existing manifests continue to validate unchanged

### Task 1.2: Create MarkdownContent shared UI component

- **Size:** Small | **Priority:** High
- **Dependencies:** None | **Parallel with:** 1.1
- **File:** `apps/client/src/layers/shared/ui/markdown-content.tsx`
- Wraps `Streamdown` from the `streamdown` package for static (non-streaming) markdown
- Applies `prose prose-sm dark:prose-invert max-w-none` base classes
- Test file at `layers/shared/ui/__tests__/markdown-content.test.tsx`

### Task 1.3: Upgrade setupInstructions rendering from plain text to markdown

- **Size:** Small | **Priority:** High
- **Dependencies:** 1.2 | **Parallel with:** None
- **File:** `apps/client/src/layers/features/relay/ui/wizard/ConfigureStep.tsx`
- Replace `<p>{manifest.setupInstructions}</p>` with `<MarkdownContent>` component
- Preserves the blue info box styling
- Plain text continues to render correctly (plain text is valid markdown)

### Task 1.4: Add schema validation tests for new fields

- **Size:** Small | **Priority:** High
- **Dependencies:** 1.1 | **Parallel with:** None
- **Files:** `packages/shared/src/__tests__/relay-adapter-schemas.test.ts` (new), `packages/relay/src/__tests__/manifests.test.ts` (update)
- Tests for helpMarkdown and setupGuide optionality, type validation, backward compat
- Add SLACK_MANIFEST to existing manifest validation tests

---

## Phase 2: Setup Guide Panel & Per-Field Help

### Task 2.1: Create SetupGuideSheet component

- **Size:** Medium | **Priority:** High
- **Dependencies:** 1.2 | **Parallel with:** 2.3
- **File:** `apps/client/src/layers/features/relay/ui/SetupGuideSheet.tsx`
- Sheet from the right, 480px wide, scrollable
- Renders adapter name in title with BookOpen icon
- Uses MarkdownContent for guide body
- Test file at `layers/features/relay/ui/__tests__/SetupGuideSheet.test.tsx`

### Task 2.2: Integrate SetupGuideSheet into AdapterSetupWizard

- **Size:** Medium | **Priority:** High
- **Dependencies:** 2.1 | **Parallel with:** None
- **Files:** `AdapterSetupWizard.tsx`, `ConfigureStep.tsx`
- `guideOpen` state in wizard, Sheet rendered outside Dialog (sibling)
- "Setup Guide" button in ConfigureStep when `manifest.setupGuide` exists
- Button coexists with actionButton in the same row
- Sheet resets when wizard closes

### Task 2.3: Add per-field help disclosure to ConfigFieldInput

- **Size:** Medium | **Priority:** High
- **Dependencies:** 1.1, 1.2 | **Parallel with:** 2.1
- **File:** `apps/client/src/layers/features/relay/ui/ConfigFieldInput.tsx`
- Collapsible "Where do I find this?" disclosure below field description
- Uses Collapsible from shared/ui with HelpCircle + ChevronDown icons
- Renders helpMarkdown via MarkdownContent in bordered box
- Collapsed by default -- zero visual noise for experts

---

## Phase 3: Build Pipeline & Docs Loading

### Task 3.1: Add build copy step for adapter docs to relay package

- **Size:** Small | **Priority:** High
- **Dependencies:** None | **Parallel with:** 3.2
- **File:** `packages/relay/package.json`
- Shell loop after `tsc` copies `src/adapters/*/docs/*.md` to `dist/`
- Adapters without docs/ are silently skipped
- No turbo.json changes needed (dist/\*\* already cached)

### Task 3.2: Add docs enrichment to adapter-manager server-side loading

- **Size:** Medium | **Priority:** High
- **Dependencies:** 1.1, 3.1 | **Parallel with:** None
- **File:** `apps/server/src/services/relay/adapter-manager.ts`
- `enrichManifestsWithDocs()` reads `setup.md` from each adapter's dist docs dir
- Called in `initialize()` after `populateBuiltinManifests()`
- Missing docs = undefined setupGuide (no error)
- Plugin adapters with inline setupGuide are preserved

---

## Phase 4: Adapter Content & Manifest URL

### Task 4.1: Add Slack manifest URL for one-click app creation

- **Size:** Small | **Priority:** High
- **Dependencies:** None | **Parallel with:** 4.2, 4.3, 4.4, 4.5
- **File:** `packages/relay/src/adapters/slack/slack-adapter.ts`
- YAML manifest constant with Socket Mode, bot events, 11 OAuth scopes
- URL-encoded as `https://api.slack.com/apps?new_app=1&manifest_yaml=`
- No user scopes (critical: "Agents & AI Apps" pitfall)
- Tests verify URL format and content

### Task 4.2: Add helpMarkdown to all adapter config fields

- **Size:** Medium | **Priority:** High
- **Dependencies:** 1.1 | **Parallel with:** 4.1, 4.3, 4.4, 4.5
- **Files:** Slack, Telegram, and Webhook adapter manifests
- Slack: 3 fields (botToken, appToken, signingSecret)
- Telegram: 2 fields (token, webhookUrl)
- Webhook: 3 fields (inbound.secret, outbound.url, outbound.headers)
- All content uses proper markdown with links, bold, code blocks, numbered lists

### Task 4.3: Write Slack adapter setup.md documentation

- **Size:** Medium | **Priority:** Medium
- **Dependencies:** None | **Parallel with:** 4.1, 4.2, 4.4, 4.5
- **File:** `packages/relay/src/adapters/slack/docs/setup.md`
- Sections: Quick Start, Manual Setup, Critical Warning, Troubleshooting

### Task 4.4: Write Telegram adapter setup.md documentation

- **Size:** Medium | **Priority:** Medium
- **Dependencies:** None | **Parallel with:** 4.1, 4.2, 4.3, 4.5
- **File:** `packages/relay/src/adapters/telegram/docs/setup.md`
- Sections: Create a Bot, Get Your Token, Connection Modes, Webhook Setup, Testing

### Task 4.5: Write Webhook adapter setup.md documentation

- **Size:** Medium | **Priority:** Medium
- **Dependencies:** None | **Parallel with:** 4.1, 4.2, 4.3, 4.4
- **File:** `packages/relay/src/adapters/webhook/docs/setup.md`
- Sections: Overview, Inbound Webhooks, Outbound Webhooks, Secret Generation, Testing

---

## Phase 5: Documentation & Polish

### Task 5.1: Update contributing docs with adapter documentation conventions

- **Size:** Small | **Priority:** Medium
- **Dependencies:** 2.2, 2.3, 3.2 | **Parallel with:** 5.2
- **Files:** `contributing/relay-adapters.md`, `contributing/adapter-catalog.md`
- Add "Adapter Documentation" section covering docs/setup.md convention, build step, server loading
- Update ConfigField and AdapterManifest reference tables with new fields

### Task 5.2: Verify end-to-end rendering and backward compatibility

- **Size:** Medium | **Priority:** High
- **Dependencies:** 4.1, 4.2, 4.3, 4.4, 4.5, 3.2 | **Parallel with:** 5.1
- Build verification, typecheck, test suite, lint
- Manual visual verification of all three adapters in the wizard
- Backward compatibility: claude-code (no docs), plugin adapters (no new fields)

---

## Dependency Graph

```
Phase 1 (Foundation):
  1.1 (schemas) ──┬──> 1.4 (schema tests)
                  │
  1.2 (MarkdownContent) ──┬──> 1.3 (setupInstructions upgrade)
                          │
Phase 2 (UI):             │
  1.2 ──> 2.1 (SetupGuideSheet) ──> 2.2 (wizard integration)
  1.1 + 1.2 ──> 2.3 (per-field help) [parallel with 2.1]

Phase 3 (Build):
  3.1 (build copy) ──┐
  1.1 ────────────────┴──> 3.2 (docs enrichment)

Phase 4 (Content):     [all 5 tasks can run in parallel]
  4.1 (Slack manifest URL)
  1.1 ──> 4.2 (helpMarkdown content)
  4.3 (Slack docs)
  4.4 (Telegram docs)
  4.5 (Webhook docs)

Phase 5 (Polish):
  2.2 + 2.3 + 3.2 ──> 5.1 (contributing docs)
  4.* + 3.2 ──> 5.2 (verification)
```

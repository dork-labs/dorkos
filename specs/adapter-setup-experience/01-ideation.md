---
slug: adapter-setup-experience
number: 128
created: 2026-03-14
status: ideation
---

# Adapter Setup Experience

**Slug:** adapter-setup-experience
**Author:** Claude Code
**Date:** 2026-03-14
**Branch:** preflight/adapter-setup-experience

---

## 1) Intent & Assumptions

- **Task brief:** Enhance the adapter setup wizard with four improvements — (1) one-click Slack App creation via manifest URL, (2) per-field help disclosures, (3) adapter docs folder with setup guide panel, (4) implement across all three existing adapters (Slack, Telegram, Webhook). The goal is to solve the problem that the current setup info box is too small for complex adapters like Slack, where users need detailed multi-step guidance.
- **Assumptions:**
  - The existing `AdapterManifest` schema in `packages/shared/src/relay-adapter-schemas.ts` is the extension point
  - Prior research at `research/20260314_plugin_integration_setup_docs_patterns.md` provides the pattern basis
  - The client already uses shadcn Sheet components (available for the guide panel)
  - Built-in adapters are built with tsc; `.md` files need a copy step to reach `dist/`
  - Plugin adapter developers should get the same quality documentation system
  - We pursue DX excellence — adapter authors write real `.md` files, not markdown-inside-TypeScript
- **Out of scope:** Plugin adapter marketplace, config migration system, video tutorials, OAuth redirect flows, multi-file docs navigation (v1 is single `setup.md` per adapter)

## 2) Pre-reading Log

- `packages/shared/src/relay-adapter-schemas.ts`: Defines `AdapterManifestSchema`, `ConfigFieldSchema`, `AdapterSetupStepSchema`. Current fields include `setupInstructions?: string`, `configFields[].description?: string`, `actionButton?: { label, url }`. No `setupGuide` or `helpMarkdown` fields exist yet.
- `apps/client/src/layers/features/relay/ui/wizard/ConfigureStep.tsx`: Renders `setupInstructions` as **plain text** in a blue info box (not markdown). Action button opens external URL in new tab. Setup step title shown as h4.
- `apps/client/src/layers/features/relay/ui/ConfigFieldInput.tsx`: Renders `field.description` as plain `<p>` text in xs gray below inputs. No help disclosure or collapsible sections. Supports show/hide for password fields, radio-cards for select, conditional visibility via `showWhen`.
- `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx`: 4-step dialog (configure → test → confirm → bind). Supports multi-step setup via `setupSteps`. 459 lines.
- `packages/relay/src/adapters/telegram/telegram-adapter.ts`: Telegram manifest with 2 setup steps, action button (`tg://resolve?domain=botfather`), radio-cards for mode selection, conditional webhook fields.
- `packages/relay/src/adapters/webhook/webhook-adapter.ts`: Webhook manifest with no setup steps, fields grouped by `section` (Inbound/Outbound), no action button.
- `packages/relay/src/adapters/slack/slack-adapter.ts`: Slack manifest with 1 setup step, action button to `api.slack.com/apps`, detailed `setupInstructions` and `setupSteps[0].description` (recently improved with numbered steps and "Agents & AI Apps" warning).
- `contributing/relay-adapters.md`: 1250-line adapter authoring guide covering the RelayAdapter interface, subject naming, security, BaseRelayAdapter, compliance tests.
- `contributing/adapter-catalog.md`: 440-line catalog system reference covering AdapterManifest, ConfigField, CatalogEntry, hot-reload, bindings.
- `research/20260314_plugin_integration_setup_docs_patterns.md`: Comprehensive research on setup documentation patterns across Slack, VS Code, Raycast, Home Assistant, n8n, Heroku, Grafana, GitHub Apps. Confirms Slack manifest URL scheme, identifies 6 common patterns (A-F).

## 3) Codebase Map

**Primary Components/Modules:**

- `packages/shared/src/relay-adapter-schemas.ts` — Schema definitions for AdapterManifest, ConfigField, SetupStep (extension point for new fields)
- `apps/client/src/layers/features/relay/ui/wizard/ConfigureStep.tsx` — Renders setup instructions and action button (needs markdown rendering + guide button)
- `apps/client/src/layers/features/relay/ui/ConfigFieldInput.tsx` — Individual field renderer (needs helpMarkdown disclosure)
- `apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx` — Main wizard orchestrator (needs Sheet integration for guide panel)
- `packages/relay/src/adapters/slack/slack-adapter.ts` — Slack manifest (needs manifest URL, setupGuide, helpMarkdown)
- `packages/relay/src/adapters/telegram/telegram-adapter.ts` — Telegram manifest (needs setupGuide, helpMarkdown)
- `packages/relay/src/adapters/webhook/webhook-adapter.ts` — Webhook manifest (needs setupGuide, helpMarkdown)
- `apps/server/src/services/relay/adapter-manager.ts` — Loads manifests, manages catalog (needs docs loading logic)

**Shared Dependencies:**

- `@dorkos/shared/relay-schemas` — Cross-package schema types
- shadcn/ui `Sheet`, `Collapsible` — UI primitives for guide panel and help disclosures
- Markdown renderer (streamdown or similar) — For rendering `.md` content in-app

**Data Flow:**
Adapter `.md` file → build copies to `dist/` → adapter-manager reads at startup → enriches manifest → catalog API serves to client → wizard/field components render markdown

**Feature Flags/Config:**

- `DORKOS_RELAY_ENABLED` — Existing feature gate; no new flags needed

**Potential Blast Radius:**

- Direct: 8 files (schema, 3 adapter manifests, ConfigureStep, ConfigFieldInput, AdapterSetupWizard, adapter-manager)
- New: 3 `docs/setup.md` files, 1 new UI component (SetupGuideSheet)
- Indirect: `contributing/relay-adapters.md` and `contributing/adapter-catalog.md` need documentation updates
- Tests: Existing adapter tests may need schema updates; new component tests for guide panel and help disclosure

## 5) Research

Research completed at `research/20260314_plugin_integration_setup_docs_patterns.md`. Key findings:

### Potential Solutions

**1. Slack Manifest URL (One-Click Create)**

- Description: Generate a URL-encoded YAML manifest and embed it in `https://api.slack.com/apps?new_app=1&manifest_yaml=<encoded>`. User clicks one button, Slack pre-fills everything.
- Pros: Eliminates the most error-prone part of Slack setup (scope configuration, socket mode, events). Confirmed working URL scheme.
- Cons: If Slack changes the manifest format, the URL breaks. Manifest must be kept in sync with adapter requirements.
- Complexity: Low
- Maintenance: Low (manifest is static, changes rarely)

**2. Per-Field Help Disclosures (Pattern D from research)**

- Description: Add `helpMarkdown` to `ConfigField`. Renders as a collapsible "Where do I find this?" section below each field. Uses the Home Assistant `data_description` / VS Code walkthrough step media pattern.
- Pros: Targeted help at the exact moment of need. Progressive disclosure — experts skip it, beginners expand it.
- Cons: Adds visual density to the form if many fields have help. Need to design the collapsed/expanded states well.
- Complexity: Medium
- Maintenance: Low

**3. Adapter Docs Folder + Setup Guide Panel (Patterns B+C from research)**

- Description: Each adapter gets a `docs/` folder with `setup.md`. Content loaded at server startup, served via catalog API as `setupGuide` field. Rendered in a slide-out Sheet from the right alongside the wizard.
- Pros: Proper authoring DX (real `.md` files), scalable to multiple docs later, side-by-side form + guide UX.
- Cons: Requires build copy step for `.md` files. Adds a new UI surface (Sheet component). Content must be maintained alongside adapter code.
- Complexity: Medium-High
- Maintenance: Medium

**4. Enhanced setupInstructions Rendering**

- Description: Upgrade the existing blue info box to render markdown instead of plain text.
- Pros: Immediate improvement to all adapters with zero schema changes. Links, bold, numbered lists all work.
- Cons: Doesn't solve the "too much info for a small box" problem — just makes the box richer.
- Complexity: Low
- Maintenance: None

### Recommendation

**All four solutions are complementary and should be implemented together.** They form a layered documentation system:

| Layer                      | What                                          | When User Sees It                                     |
| -------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| Enhanced setupInstructions | Brief markdown summary in info box            | Always visible at top of configure step               |
| Per-field helpMarkdown     | Collapsible "Where do I find this?" per field | On demand, when user needs help with a specific field |
| Setup guide panel          | Full guide in Sheet/drawer                    | On demand, via "Setup Guide" button                   |
| One-click create button    | Pre-filled Slack App creation                 | During Slack setup specifically                       |

### Security Considerations

- Slack manifest URL contains no secrets — only scope/feature configuration
- `helpMarkdown` and `setupGuide` content comes from trusted adapter code, not user input — XSS risk is minimal but markdown renderer should still sanitize
- Plugin adapters' docs content should be treated as potentially untrusted — sanitize before rendering

### Performance Considerations

- `setupGuide` content adds to catalog API payload size — for a few KB of markdown per adapter this is negligible
- Markdown rendering in the Sheet is lazy (only when opened) — no impact on wizard load time
- `helpMarkdown` collapsibles are collapsed by default — no rendering cost until expanded

## 6) Decisions

| #   | Decision                 | Choice                                                                                      | Rationale                                                                                                                                                |
| --- | ------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Guide panel placement    | Sheet/drawer from the right                                                                 | Non-destructive, side-by-side with form, follows existing shadcn Sheet pattern in the codebase                                                           |
| 2   | Content authoring format | Real `.md` files in `docs/` per adapter                                                     | DX excellence — syntax highlighting, preview, linting, clean diffs. Writing markdown inside TypeScript template literals is a poor authoring experience. |
| 3   | Content delivery         | Files copied to `dist/` at build, loaded at server startup, served via existing catalog API | No new endpoints needed. Robust for both built-in and plugin adapters. One-line build script addition.                                                   |
| 4   | Docs scope for v1        | Single `setup.md` per adapter                                                               | Tight scope, expandable to `troubleshooting.md`, `advanced.md` later. Each adapter gets one comprehensive guide.                                         |

---
slug: real-brand-adapter-logos
number: 170
created: 2026-03-23
status: ideation
---

# Real Brand Adapter Logos

**Slug:** real-brand-adapter-logos
**Author:** Claude Code
**Date:** 2026-03-23
**Branch:** preflight/real-brand-adapter-logos

---

## 1) Intent & Assumptions

- **Task brief:** The Telegram, Slack, and Claude adapters currently use generic emoji icons (`✈️`, `#`, `🤖`) instead of the actual brand logos. Update the icon system to display recognizable brand SVG logos for all adapters.
- **Assumptions:**
  - SVG paths will be sourced from Simple Icons (simpleicons.org), a CC0-licensed collection
  - SVGs will be embedded as inline React components in `@dorkos/icons` (no runtime fetch)
  - The `iconEmoji` field on `AdapterManifest` will be replaced with a typed `iconId` field
  - All consumers of `iconEmoji` are internal — no third-party plugin compatibility concern
  - Webhook adapter will get a distinctive SVG icon too (not a brand logo, but a recognizable symbol)
  - `telegram-chatsdk` adapter shares the Telegram logo
- **Out of scope:**
  - Adding logos for future/hypothetical adapters
  - Redesigning the icon package architecture beyond what's needed
  - Adding color variants of logos (monochrome only, styled by parent context)

## 2) Pre-reading Log

- `packages/icons/src/logos.tsx`: DorkOS logo component — inline SVG pattern with color variants. Establishes the convention for SVG components in this package.
- `packages/icons/src/registry.ts`: Semantic icon registry mapping names to Lucide components. Shows how icons are organized.
- `packages/icons/src/brand.ts`: Brand color constants. Could be extended with adapter brand colors if needed.
- `packages/icons/package.json`: Exports `./registry`, `./subsystems`, `./brand`, `./logos`. New `./adapters` export needed.
- `packages/shared/src/relay-adapter-schemas.ts`: Defines `AdapterManifestSchema` with `iconEmoji: z.string().optional()`.
- `packages/relay/src/adapters/telegram/telegram-adapter.ts`: `TELEGRAM_MANIFEST` with `iconEmoji: '\u2708\uFE0F'`.
- `packages/relay/src/adapters/slack/slack-adapter.ts`: `SLACK_MANIFEST` with `iconEmoji: '#'`.
- `packages/relay/src/adapters/claude-code/claude-code-adapter.ts`: `CLAUDE_CODE_MANIFEST` with `iconEmoji: '🤖'`.
- `packages/relay/src/adapters/webhook/webhook-adapter.ts`: `WEBHOOK_MANIFEST` (has iconEmoji too).
- `apps/client/src/layers/features/relay/ui/AdapterCardHeader.tsx`: Renders `iconEmoji` as `<span role="img">`.
- `apps/client/src/layers/features/relay/ui/CatalogCard.tsx`: Renders `iconEmoji` as `<span role="img">` at 18px.
- `apps/client/src/layers/features/mesh/ui/AdapterNode.tsx`: Has separate `PLATFORM_ICONS` map with hard-coded Lucide icons (`MessageSquare` for telegram, `Webhook` for webhook, `Bot` fallback).
- `contributing/adapter-catalog.md`: Documents the adapter catalog system.
- `contributing/relay-adapters.md`: Adapter development guide.

## 3) Codebase Map

**Primary Components/Modules:**

- `packages/icons/src/` — Icon package, home for new adapter logo components
- `packages/shared/src/relay-adapter-schemas.ts` — `AdapterManifest` Zod schema
- `packages/relay/src/adapters/*/` — Adapter manifest definitions (5 adapters)
- `apps/client/src/layers/features/relay/ui/AdapterCardHeader.tsx` — Renders adapter icon in card header
- `apps/client/src/layers/features/relay/ui/CatalogCard.tsx` — Renders adapter icon in catalog grid
- `apps/client/src/layers/features/mesh/ui/AdapterNode.tsx` — Topology graph adapter node with `PLATFORM_ICONS`

**Shared Dependencies:**

- `@dorkos/shared/relay-schemas` — Types consumed by both server and client
- `@dorkos/icons` — React icon components consumed by client

**Data Flow:**

```
Adapter Manifest (server) → JSON serialization → HTTP → Client components
  ├── AdapterCardHeader.tsx → renders iconEmoji as <span>
  ├── CatalogCard.tsx → renders iconEmoji as <span>
  └── AdapterNode.tsx → ignores iconEmoji, uses hard-coded PLATFORM_ICONS map
```

**Feature Flags/Config:** None.

**Potential Blast Radius:**

- Direct: ~12 files (schema, 5 manifests, 3 client components, icons package, tests)
- Indirect: Dev showcase files with mock manifests (`RelayShowcases.tsx`, `adapter-wizard-showcase-data.ts`)
- Tests: `AdapterCardHeader.test.tsx`, `CatalogCard.test.tsx`, `AdapterNode.test.tsx`, `slack-adapter.test.ts`

## 5) Research

**Potential Solutions:**

**1. Simple Icons SVG paths as inline React components (Recommended)**

- Description: Source SVG path data from simpleicons.org (CC0 license), create React components in `@dorkos/icons/adapters`. Each component accepts `size` and `className` props.
- Pros:
  - CC0 license — no usage restrictions
  - Consistent quality across all icons
  - No runtime dependency or network requests
  - Tree-shakeable — only imported icons are bundled
  - Established pattern in the codebase (`logos.tsx` already does this)
- Cons:
  - Manual copy of SVG paths (one-time effort)
  - Need to check for updates if brands change logos
- Complexity: Low
- Maintenance: Low

**2. Install `simple-icons` npm package**

- Description: Add `simple-icons` as a dependency and import SVG data at build time.
- Pros: Automatic updates when package updates
- Cons: Large package (3000+ icons, only need ~4), adds dependency
- Complexity: Low
- Maintenance: Low but adds bloat

**3. Static SVG files in public assets**

- Description: Place `.svg` files in a public directory, reference via URL.
- Pros: Easy to swap files
- Cons: Runtime HTTP requests, can't style with CSS/Tailwind, breaks the React component pattern
- Complexity: Medium
- Maintenance: Medium

**Recommendation:** Approach 1 — inline React components sourced from Simple Icons. Matches existing `logos.tsx` pattern, zero dependencies, CC0 licensed, tree-shakeable.

**Brand Logo Sources (Simple Icons):**

- Telegram: `si-telegram` — paper plane logo
- Slack: `si-slack` — hash/octothorpe logo
- Claude/Anthropic: `si-anthropic` or `si-claude` — Anthropic logo
- Webhook: No brand logo — use a custom webhook-style SVG (arrow + endpoint)

## 6) Decisions

| #   | Decision        | Choice                             | Rationale                                                                                                                                                                                                                                         |
| --- | --------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Logo source     | Simple Icons (simpleicons.org)     | CC0 license, consistent quality, 3000+ brands including all needed ones. Copy SVG paths into inline React components — no runtime dependency.                                                                                                     |
| 2   | Schema approach | Replace `iconEmoji` with `iconId`  | Cleaner typed field. All consumers are internal — no backwards-compat concern. Emojis were always a placeholder.                                                                                                                                  |
| 3   | Adapter scope   | All adapters including webhook     | Telegram, Slack, Claude get brand logos. Webhook gets a distinctive SVG icon. `telegram-chatsdk` shares the Telegram logo.                                                                                                                        |
| 4   | Slack logo risk | Styled `#` fallback, not real logo | Slack Brand ToS explicitly prohibits logo use without Marketplace listing. Ship a styled `#` in Slack purple (`#4A154B`, bold) instead — zero-risk and immediately recognizable. Upgrade to real logo if/when DorkOS pursues Marketplace listing. |
| 5   | Trademark note  | Add disclaimer comment in source   | Comment in `adapter-logos.tsx`: "Telegram, Slack, and Anthropic/Claude are trademarks of their respective owners. Logos identify connected services and do not imply endorsement."                                                                |

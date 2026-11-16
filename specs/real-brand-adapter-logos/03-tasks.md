# Real Brand Adapter Logos -- Task Breakdown

**Spec:** `specs/real-brand-adapter-logos/02-specification.md`
**Generated:** 2026-03-23

## Summary

10 tasks across 3 phases to replace placeholder emoji icons on adapter manifests with recognizable brand SVG logos rendered as inline React components.

---

## Phase 1: Schema + Icons (no UI changes)

### Task 1.1 -- Create adapter logo SVG components and registry map

**Size:** Medium | **Priority:** High | **Parallel with:** 1.2

Create `packages/icons/src/adapter-logos.tsx` with four brand logo components (`TelegramLogo`, `AnthropicLogo`, `WebhookIcon`, `SlackIcon`) and the `ADAPTER_LOGO_MAP` registry that maps adapter type strings to their logo components.

- `TelegramLogo`: Inline SVG using Simple Icons `si-telegram` path, `fill="currentColor"`
- `AnthropicLogo`: Inline SVG using Simple Icons `si-anthropic` path, `fill="currentColor"`
- `WebhookIcon`: Wraps Lucide `Webhook` icon (already in deps)
- `SlackIcon`: Styled `#` character in SVG with Slack purple (`#4A154B`), avoids ToS issues
- `ADAPTER_LOGO_MAP`: Maps `telegram`, `telegram-chatsdk`, `claude-code`, `slack`, `webhook` to components

**Files:** `packages/icons/src/adapter-logos.tsx` (create)

---

### Task 1.2 -- Add adapter-logos export to @dorkos/icons package.json

**Size:** Small | **Priority:** High | **Parallel with:** 1.1

Add `"./adapter-logos": "./src/adapter-logos.tsx"` to the `exports` field in `packages/icons/package.json`.

**Files:** `packages/icons/package.json` (edit)

---

### Task 1.3 -- Replace iconEmoji with iconId in schema and all adapter manifests

**Size:** Large | **Priority:** High | **Parallel with:** 1.1, 1.2

Multi-part change:

- **Schema:** Replace `iconEmoji: z.string().optional()` with `iconId: z.string().optional()` in `AdapterManifestSchema`
- **Manifests:** Update all 5 adapter manifests (`telegram`, `slack`, `claude-code`, `webhook`, `telegram-chatsdk`)
- **Test fixtures:** Update `relay-catalog-schemas.test.ts`, `AdapterCard.test.tsx`, `RelayHealthBar.test.tsx`
- **Onboarding:** Update `AdapterSetupStep.tsx` data and local type
- **Docs:** Update `relay-adapters.md`, `adapter-catalog.md`, `api-reference.md`

**Files:**

- `packages/shared/src/relay-adapter-schemas.ts` (edit)
- `packages/relay/src/adapters/telegram/telegram-adapter.ts` (edit)
- `packages/relay/src/adapters/slack/slack-adapter.ts` (edit)
- `packages/relay/src/adapters/claude-code/claude-code-adapter.ts` (edit)
- `packages/relay/src/adapters/webhook/webhook-adapter.ts` (edit)
- `packages/relay/src/adapters/telegram-chatsdk/manifest.ts` (edit)
- `packages/shared/src/__tests__/relay-catalog-schemas.test.ts` (edit)
- `apps/client/src/layers/features/relay/__tests__/AdapterCard.test.tsx` (edit)
- `apps/client/src/layers/features/relay/ui/__tests__/RelayHealthBar.test.tsx` (edit)
- `apps/client/src/layers/features/onboarding/ui/AdapterSetupStep.tsx` (edit)
- `contributing/relay-adapters.md` (edit)
- `contributing/adapter-catalog.md` (edit)
- `contributing/api-reference.md` (edit)

---

## Phase 2: Client Components

### Task 2.1 -- Create AdapterIcon resolver component

**Size:** Small | **Priority:** High | **Depends on:** 1.1, 1.2

Create `apps/client/src/layers/features/relay/ui/AdapterIcon.tsx` -- a shared helper that resolves `iconId` to the correct brand logo via `ADAPTER_LOGO_MAP`, with `adapterType` fallback and Lucide `Bot` as ultimate fallback.

**Files:** `apps/client/src/layers/features/relay/ui/AdapterIcon.tsx` (create)

---

### Task 2.2 -- Update AdapterCardHeader to use AdapterIcon

**Size:** Small | **Priority:** High | **Depends on:** 1.3, 2.1 | **Parallel with:** 2.3, 2.4

Replace the conditional emoji `<span>` with `<AdapterIcon iconId={manifest.iconId} adapterType={manifest.type} size={16}>`. Remove the conditional wrapper (AdapterIcon always renders). Update TSDoc and inline comments.

**Files:** `apps/client/src/layers/features/relay/ui/AdapterCardHeader.tsx` (edit)

---

### Task 2.3 -- Update CatalogCard to use AdapterIcon

**Size:** Small | **Priority:** High | **Depends on:** 1.3, 2.1 | **Parallel with:** 2.2, 2.4

Replace the conditional emoji `<span>` with `<AdapterIcon iconId={manifest.iconId} adapterType={manifest.type} size={20}>`. Remove the conditional wrapper.

**Files:** `apps/client/src/layers/features/relay/ui/CatalogCard.tsx` (edit)

---

### Task 2.4 -- Replace PLATFORM_ICONS with AdapterIcon in AdapterNode

**Size:** Small | **Priority:** High | **Depends on:** 1.3, 2.1 | **Parallel with:** 2.2, 2.3

Remove the `PLATFORM_ICONS` map and unused Lucide imports (`MessageSquare`, `Webhook`, `Bot`). Update `PlatformIcon` to delegate to `<AdapterIcon>`. Keep the `PlatformIcon` wrapper to preserve call sites.

**Files:** `apps/client/src/layers/features/mesh/ui/AdapterNode.tsx` (edit)

---

### Task 2.5 -- Update dev showcase files to use iconId

**Size:** Small | **Priority:** Medium | **Depends on:** 1.3, 2.1

Update mock manifests in `RelayShowcases.tsx`, `adapter-wizard-showcase-data.ts`, and `AdapterSetupStep.tsx` to use `iconId` instead of `iconEmoji`. Update rendering code in `AdapterSetupStep.tsx` to use `AdapterIcon`.

**Files:**

- `apps/client/src/dev/showcases/RelayShowcases.tsx` (edit)
- `apps/client/src/dev/showcases/adapter-wizard-showcase-data.ts` (edit)
- `apps/client/src/layers/features/onboarding/ui/AdapterSetupStep.tsx` (edit)

---

## Phase 3: Tests

### Task 3.1 -- Update AdapterCardHeader tests

**Size:** Small | **Priority:** High | **Depends on:** 2.2 | **Parallel with:** 3.2

Update `baseManifest` fixture from `iconEmoji: '...'` to `iconId: 'telegram'`. Replace emoji text assertion with SVG element assertion. Remove `role="img"` checks.

**Files:** `apps/client/src/layers/features/relay/ui/__tests__/AdapterCardHeader.test.tsx` (edit)

---

### Task 3.2 -- Update CatalogCard tests

**Size:** Small | **Priority:** High | **Depends on:** 2.3 | **Parallel with:** 3.1

Rename icon tests: "renders adapter icon when iconId provided" (assert SVG), "renders fallback icon when iconId not provided" (assert Bot SVG). Remove `role="img"` assertions.

**Files:** `apps/client/src/layers/features/relay/ui/__tests__/CatalogCard.test.tsx` (edit)

---

### Task 3.3 -- Full verification suite

**Size:** Medium | **Priority:** High | **Depends on:** 3.1, 3.2, 2.4, 2.5

Run `pnpm typecheck`, `pnpm test -- --run`, `pnpm lint`. Verify no remaining `iconEmoji` references in production TypeScript files.

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1 ──┐
  1.2 ──┤
  1.3 ──┘
         ↓
Phase 2:
  2.1 (depends on 1.1, 1.2)
         ↓
  2.2 ──┐
  2.3 ──┤ (all depend on 1.3 + 2.1, parallel with each other)
  2.4 ──┘
  2.5 (depends on 1.3, 2.1)
         ↓
Phase 3:
  3.1 (depends on 2.2) ──┐
  3.2 (depends on 2.3) ──┤
                          ↓
  3.3 (depends on 3.1, 3.2, 2.4, 2.5) -- final verification
```

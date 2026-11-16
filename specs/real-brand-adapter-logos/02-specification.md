---
slug: real-brand-adapter-logos
number: 170
created: 2026-03-23
status: specified
spec-author: Claude Code
ideation: specs/real-brand-adapter-logos/01-ideation.md
---

# Real Brand Adapter Logos — Specification

## Overview

Replace placeholder emoji icons on adapter manifests (`✈️`, `#`, `🤖`, `🔗`) with recognizable brand SVG logos rendered as inline React components. Evolve the `AdapterManifest` schema from a loose `iconEmoji: string` field to a typed `iconId` field that maps to SVG components on the client.

**Motivation:** The current emoji icons are generic placeholders that don't communicate brand identity. Users scanning the adapter catalog or topology graph should instantly recognize Telegram, Slack, Claude, and Webhook adapters by their visual identity.

## Technical Design

### 1. New Icon Components (`packages/icons/src/adapter-logos.tsx`)

Create a new module in `@dorkos/icons` following the existing `DorkLogo` pattern in `logos.tsx`. Each component is an inline SVG with `size` and `className` props.

**Components:**

| Component       | Source                                  | Notes                                                    |
| --------------- | --------------------------------------- | -------------------------------------------------------- |
| `TelegramLogo`  | Simple Icons `si-telegram` SVG path     | Official paper plane mark                                |
| `AnthropicLogo` | Simple Icons `si-anthropic` SVG path    | Used for Claude Code adapter                             |
| `WebhookIcon`   | Lucide `Webhook` icon (already in deps) | Not a brand — reuse existing icon                        |
| `SlackIcon`     | Styled `#` character component          | Slack ToS prohibits logo use without Marketplace listing |

**Component interface:**

```typescript
interface AdapterLogoProps {
  /** Icon size in pixels. */
  size?: number;
  className?: string;
}
```

**Adapter logo registry map:**

```typescript
/**
 * Maps adapter type identifiers to their logo components.
 *
 * Telegram, Slack, and Anthropic/Claude are trademarks of their respective owners.
 * Logos are used to identify connected services and do not imply endorsement.
 */
export const ADAPTER_LOGO_MAP: Record<string, React.ComponentType<AdapterLogoProps>> = {
  telegram: TelegramLogo,
  'telegram-chatsdk': TelegramLogo,
  'claude-code': AnthropicLogo,
  slack: SlackIcon,
  webhook: WebhookIcon,
};
```

**SlackIcon implementation:** Render a styled `#` character in Slack purple (`#4A154B`) with `font-weight: 900`, wrapped in an SVG-like container for consistent sizing. This avoids Slack Brand ToS issues while remaining instantly recognizable. The real Slack logo SVG can be swapped in later if DorkOS pursues Marketplace listing.

**Package export:** Add `"./adapter-logos": "./src/adapter-logos.tsx"` to `packages/icons/package.json` exports.

### 2. Schema Evolution (`packages/shared/src/relay-adapter-schemas.ts`)

Replace the `iconEmoji` field with `iconId`:

```typescript
// Before
iconEmoji: z.string().optional(),

// After
iconId: z.string().optional(),
```

**Why `iconId` over `iconEmoji`:**

- Typed identifier that maps to a React component registry on the client
- Cleaner than embedding rendering concerns (emojis) in a data schema
- All consumers are internal — no backwards-compat concern for third-party plugins
- The adapter `type` field already serves as a natural icon identifier, but having `iconId` as a separate optional field allows plugin adapters to declare their own icon identifiers in the future

**Note:** The `iconId` value will match the adapter's `type` field for all built-in adapters. The field exists as a separate concept because plugin adapters may have a `type` of `'plugin'` but want to declare a specific brand icon.

### 3. Manifest Updates (`packages/relay/src/adapters/*/`)

Update all five adapter manifests to replace `iconEmoji` with `iconId`:

| Adapter          | File                                 | Before                      | After                        |
| ---------------- | ------------------------------------ | --------------------------- | ---------------------------- |
| Telegram         | `telegram/telegram-adapter.ts`       | `iconEmoji: '\u2708\uFE0F'` | `iconId: 'telegram'`         |
| Slack            | `slack/slack-adapter.ts`             | `iconEmoji: '#'`            | `iconId: 'slack'`            |
| Claude Code      | `claude-code/claude-code-adapter.ts` | `iconEmoji: '🤖'`           | `iconId: 'claude-code'`      |
| Webhook          | `webhook/webhook-adapter.ts`         | `iconEmoji: '🔗'`           | `iconId: 'webhook'`          |
| Telegram ChatSDK | `telegram-chatsdk/manifest.ts`       | `iconEmoji: '\u2708\uFE0F'` | `iconId: 'telegram-chatsdk'` |

### 4. Client Component: `AdapterIcon` Helper

Create a shared helper component that resolves `iconId` to the correct logo component. This centralizes the lookup logic and provides a fallback for unknown adapter types.

**Location:** `apps/client/src/layers/features/relay/ui/AdapterIcon.tsx`

```typescript
import { ADAPTER_LOGO_MAP, type AdapterLogoProps } from '@dorkos/icons/adapter-logos';
import { Bot } from 'lucide-react';

interface AdapterIconProps extends AdapterLogoProps {
  /** Adapter icon identifier from the manifest. */
  iconId?: string;
  /** Adapter type — used as fallback lookup key when iconId is absent. */
  adapterType?: string;
}

/** Resolves an adapter's iconId to the corresponding brand logo component. */
export function AdapterIcon({ iconId, adapterType, size = 16, className }: AdapterIconProps) {
  const Logo = ADAPTER_LOGO_MAP[iconId ?? ''] ?? ADAPTER_LOGO_MAP[adapterType ?? ''];
  if (Logo) return <Logo size={size} className={className} />;
  return <Bot className={className} style={{ width: size, height: size }} />;
}
```

### 5. Client Component Updates

**`AdapterCardHeader.tsx`** — Replace emoji `<span>` with `<AdapterIcon>`:

```typescript
// Before
{manifest.iconEmoji && (
  <span className="text-sm" role="img" aria-hidden>
    {manifest.iconEmoji}
  </span>
)}

// After
<AdapterIcon iconId={manifest.iconId} adapterType={manifest.type} size={16} className="text-muted-foreground shrink-0" />
```

**`CatalogCard.tsx`** — Replace emoji `<span>` with `<AdapterIcon>`:

```typescript
// Before
{manifest.iconEmoji && (
  <span className="text-lg" role="img" aria-hidden>
    {manifest.iconEmoji}
  </span>
)}

// After
<AdapterIcon iconId={manifest.iconId} adapterType={manifest.type} size={20} className="text-muted-foreground shrink-0" />
```

**`AdapterNode.tsx`** — Replace `PLATFORM_ICONS` map with `AdapterIcon`:

```typescript
// Before
const PLATFORM_ICONS: Record<string, React.ElementType> = {
  telegram: MessageSquare,
  webhook: Webhook,
};

function PlatformIcon({ adapterType }: { adapterType: string }) {
  const Icon = PLATFORM_ICONS[adapterType] ?? Bot;
  return <Icon className="text-muted-foreground size-4 shrink-0" />;
}

// After
import { AdapterIcon } from '@/layers/features/relay/ui/AdapterIcon';

function PlatformIcon({ adapterType }: { adapterType: string }) {
  return <AdapterIcon adapterType={adapterType} size={16} className="text-muted-foreground shrink-0" />;
}
```

This removes the duplicate `PLATFORM_ICONS` map and the hard-coded Lucide imports (`MessageSquare`, `Webhook`, `Bot` in the const map — `Bot` stays as the fallback in `AdapterIcon`).

### 6. Dev Showcase Updates

Update mock manifests in dev showcases to use `iconId` instead of `iconEmoji`:

- `apps/client/src/dev/showcases/RelayShowcases.tsx`: Replace `iconEmoji` with `iconId` on mock manifests
- `apps/client/src/dev/showcases/adapter-wizard-showcase-data.ts`: Replace `iconEmoji` with `iconId`

### 7. Test Updates

**`AdapterCardHeader.test.tsx`:**

- Update `baseManifest` fixture: replace `iconEmoji: '📨'` with `iconId: 'telegram'`
- Update assertions: instead of checking for `role="img"`, check for SVG element or the `AdapterIcon` component rendering

**`CatalogCard.test.tsx`:**

- Update test "renders icon emoji when provided": rename to "renders adapter icon when iconId provided", pass `iconId: 'slack'`, assert SVG renders
- Update test "does not render icon emoji when not provided": rename to "renders fallback icon when iconId not provided", assert `Bot` fallback renders
- Remove `role="img"` assertions (SVGs use `aria-hidden` instead)

**`AdapterNode.test.tsx`:**

- No direct icon assertions currently — verify tests still pass with the `PlatformIcon` refactor

## Implementation Phases

### Phase 1: Schema + Icons (no UI changes)

1. Create `packages/icons/src/adapter-logos.tsx` with all logo components + `ADAPTER_LOGO_MAP`
2. Add `"./adapter-logos"` export to `packages/icons/package.json`
3. Update `AdapterManifestSchema` in `packages/shared/src/relay-adapter-schemas.ts`: replace `iconEmoji` with `iconId`
4. Update all 5 adapter manifests to use `iconId`

### Phase 2: Client components

5. Create `AdapterIcon` helper component at `apps/client/src/layers/features/relay/ui/AdapterIcon.tsx`
6. Update `AdapterCardHeader.tsx` to use `AdapterIcon`
7. Update `CatalogCard.tsx` to use `AdapterIcon`
8. Update `AdapterNode.tsx` — replace `PLATFORM_ICONS` with `AdapterIcon`
9. Update dev showcase files

### Phase 3: Tests

10. Update `AdapterCardHeader.test.tsx`
11. Update `CatalogCard.test.tsx`
12. Verify `AdapterNode.test.tsx` passes
13. Run full test suite, typecheck, lint

## File Manifest

| File                                                                            | Action     | Description                                 |
| ------------------------------------------------------------------------------- | ---------- | ------------------------------------------- |
| `packages/icons/src/adapter-logos.tsx`                                          | **Create** | Brand logo SVG components + registry map    |
| `packages/icons/package.json`                                                   | **Edit**   | Add `./adapter-logos` export                |
| `packages/shared/src/relay-adapter-schemas.ts`                                  | **Edit**   | Replace `iconEmoji` with `iconId`           |
| `packages/relay/src/adapters/telegram/telegram-adapter.ts`                      | **Edit**   | `iconEmoji` → `iconId: 'telegram'`          |
| `packages/relay/src/adapters/slack/slack-adapter.ts`                            | **Edit**   | `iconEmoji` → `iconId: 'slack'`             |
| `packages/relay/src/adapters/claude-code/claude-code-adapter.ts`                | **Edit**   | `iconEmoji` → `iconId: 'claude-code'`       |
| `packages/relay/src/adapters/webhook/webhook-adapter.ts`                        | **Edit**   | `iconEmoji` → `iconId: 'webhook'`           |
| `packages/relay/src/adapters/telegram-chatsdk/manifest.ts`                      | **Edit**   | `iconEmoji` → `iconId: 'telegram-chatsdk'`  |
| `apps/client/src/layers/features/relay/ui/AdapterIcon.tsx`                      | **Create** | Shared icon resolver component              |
| `apps/client/src/layers/features/relay/ui/AdapterCardHeader.tsx`                | **Edit**   | Use `AdapterIcon`                           |
| `apps/client/src/layers/features/relay/ui/CatalogCard.tsx`                      | **Edit**   | Use `AdapterIcon`                           |
| `apps/client/src/layers/features/mesh/ui/AdapterNode.tsx`                       | **Edit**   | Replace `PLATFORM_ICONS` with `AdapterIcon` |
| `apps/client/src/dev/showcases/RelayShowcases.tsx`                              | **Edit**   | `iconEmoji` → `iconId`                      |
| `apps/client/src/dev/showcases/adapter-wizard-showcase-data.ts`                 | **Edit**   | `iconEmoji` → `iconId`                      |
| `apps/client/src/layers/features/relay/ui/__tests__/AdapterCardHeader.test.tsx` | **Edit**   | Update fixtures + assertions                |
| `apps/client/src/layers/features/relay/ui/__tests__/CatalogCard.test.tsx`       | **Edit**   | Update fixtures + assertions                |

## Acceptance Criteria

1. All adapter cards in the Relay panel show recognizable brand SVGs instead of emojis
2. Topology graph nodes show brand SVGs instead of generic Lucide icons
3. Adapter catalog shows brand SVGs for each adapter type
4. Unknown/plugin adapter types gracefully fall back to the `Bot` Lucide icon
5. Slack uses a styled `#` symbol (not the official logo) to respect brand terms
6. Telegram ChatSDK adapter shares the Telegram logo
7. All existing tests pass with updated fixtures
8. `pnpm typecheck` passes across all packages
9. `pnpm lint` passes
10. No runtime dependencies added — all SVGs are inline

## Non-Goals

- Color variants of logos (monochrome only, styled by `className`)
- Animated logos or hover effects on icons
- Logo tooltips or brand attribution in the UI
- Supporting user-uploaded custom adapter icons
- Slack Marketplace integration for real logo usage

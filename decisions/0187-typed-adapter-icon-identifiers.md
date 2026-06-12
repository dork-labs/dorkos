---
number: 187
title: Typed Adapter Icon Identifiers Replace Emoji Icons
status: accepted
created: 2026-03-23
spec: real-brand-adapter-logos
superseded-by: null
---

# 0187. Typed Adapter Icon Identifiers Replace Emoji Icons

## Status

Accepted

## Context

Adapter manifests used a loose `iconEmoji: string` field to store placeholder emoji characters (`✈️`, `#`, `🤖`, `🔗`) for visual identification. These emojis were rendered as text spans in client components, while the topology graph maintained a separate hard-coded `PLATFORM_ICONS` map of Lucide components. This created two disconnected icon systems, neither of which displayed actual brand logos.

The manifests are JSON-serialized from server to client, so React components cannot be embedded directly in the schema. A mapping layer is needed to bridge the serialization boundary.

## Decision

Replace `iconEmoji: z.string().optional()` with `iconId: z.string().optional()` on the `AdapterManifest` schema. The `iconId` value is a string identifier (matching the adapter's `type` for built-in adapters) that maps to an SVG React component via `ADAPTER_LOGO_MAP` in `@dorkos/icons/adapter-logos`. A shared `AdapterIcon` component on the client resolves `iconId` to the correct SVG component with a `Bot` Lucide fallback for unknown types.

Brand SVG paths are sourced from Simple Icons (CC0 license) and embedded as inline React components — no runtime dependencies. Slack uses a styled `#` character instead of the official logo to comply with Slack Brand Terms of Service.

## Consequences

### Positive

- Adapter cards, catalog, and topology graph show recognizable brand SVGs
- Single icon resolution path (`AdapterIcon`) replaces two disconnected systems
- Type-safe identifier instead of arbitrary emoji strings
- Zero runtime dependencies — all SVGs are inline React components
- Extensible for future plugin adapters declaring custom icon identifiers

### Negative

- Manual SVG path maintenance if brands update their logos (low frequency)
- Slack cannot use the real logo without Marketplace listing
- One-time migration effort across manifests, client components, and tests

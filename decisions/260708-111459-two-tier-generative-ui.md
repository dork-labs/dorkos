---
id: 260708-111459
title: Two-tier generative UI — declarative widget catalog plus MCP Apps
status: proposed
created: 2026-07-08
spec: gen-ui-tier1
superseded-by: null
---

# 260708-111459. Two-tier generative UI — declarative widget catalog plus MCP Apps

## Status

Proposed

## Context

Agents need to present rich UI (cards, tables, charts, interactive widgets, third-party mini-apps) in chat and in the canvas. The July 2026 standards landscape (`research/20260708_generative_ui_standards_dorkos.md`) splits into two viable postures: catalog-constrained declarative JSON rendered by host-owned components (A2UI, json-render — safe by construction, native look, streamable) and sandboxed-code mini-apps (MCP Apps/SEP-1865 — the only multi-vendor standard with a native "installing a package installs its UI" distribution story, matching DorkOS's MCP server + marketplace architecture). No single standard covers both native-feeling everyday widgets and third-party rich apps.

## Decision

We will build generative UI in two tiers. Tier 1: a DorkOS-owned declarative widget catalog rendered by first-party shadcn/React components, for everyday structured content (spec `gen-ui-tier1`). Tier 2: MCP Apps (SEP-1865) host support for sandboxed third-party and rich interactive UI, mapped onto existing surfaces (inline → chat block, fullscreen → canvas, pip → floating). AG-UI is not adopted (our durable SSE stream already fills that layer); open-json-ui and C1 are not adopted.

## Consequences

### Positive

- Everyday widgets are theme-native, XSS-immune (no code execution), and streamable; rich third-party UI rides an Anthropic+OpenAI-governed standard instead of a proprietary invention.
- Marketplace packages get a standards-based path to ship UI (MCP server bundles tools + `ui://` resources).

### Negative

- Two rendering stacks to maintain; contributors must learn which tier a use case belongs to.
- MCP Apps requires MCP resources support on `/mcp` (currently tools-only) before Tier 2 can land.

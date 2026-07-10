---
id: 260708-111500
title: Widgets are fence-delivered assistant content, not a render tool
status: accepted
created: 2026-07-08
spec: gen-ui-tier1
superseded-by: null
---

# 260708-111500. Widgets are fence-delivered assistant content, not a render tool

## Status

Accepted

## Context

Tier-1 widgets need a delivery mechanism from model to client. A `render_ui` MCP tool (like `control_ui`) gives validation acks but requires per-runtime adapter wiring (cf. the Codex `control_ui` stub + event-mapper translation), places widgets at tool-card positions, and cannot stream. Assistant text already flows uniformly from all three runtimes (Claude Code, Codex, OpenCode) through streamdown on the client.

## Decision

Widgets are emitted as ` ```dorkos-ui ` fenced JSON blocks inside ordinary assistant text, validated client-side against the catalog schema, and rendered in place of the code block. The syntax is taught via the static prompt context blocks (the `<ui_tools>` precedent). The distinction is principled: _content_ tolerates no-ack and benefits from streaming and prose placement; _control_ (open panel, open canvas) keeps the acked, gated `control_ui` tool — including placing a widget in the canvas via a `widget` canvas content type.

## Consequences

### Positive

- Zero per-runtime adapter work; widgets weave into prose; the Artifacts-style pattern is proven at scale.
- Invalid output degrades to an error card with raw JSON — chat never breaks.

### Negative

- The agent gets no signal that a widget rendered or failed validation (accepted: same posture as markdown).
- Prompt-taught syntax costs static context tokens and depends on model compliance rather than a tool schema.

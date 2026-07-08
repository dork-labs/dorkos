# Generative UI Tier 1 — Ideation

**Date:** 2026-07-08 · **Status:** ideation → specified (same session)
**Research:** `research/20260708_generative_ui_standards_dorkos.md` (standards landscape, two-tier decision), `research/20260326_agent_ui_control_canvas_spec_research.md` (canvas/control_ui design)

## Problem

Agents can only respond with prose, tool-call cards, and the canvas's three content types. There is no way for an agent to present structured, interactive, native-feeling UI — a weather card, a list of Linear tickets, a chart — either inline in chat or in the canvas. The two-tier architecture decision (see research doc) assigns this to **Tier 1: a catalog-constrained declarative widget layer** rendered by host-owned React/shadcn components (Tier 2, MCP Apps, covers third-party sandboxed mini-apps and is out of scope here).

## Key design decisions

### D1 — Delivery mechanism: fenced block in assistant text (primary), not a tool

Candidates considered:

| Option                                            | Streams | Ack to agent | Runtime-neutral                                                                     | Placement          |
| ------------------------------------------------- | ------- | ------------ | ----------------------------------------------------------------------------------- | ------------------ |
| A. `render_ui` MCP tool → `ui_block` SSE event    | no      | yes          | needs per-runtime adapter wiring (cf. Codex `control_ui` stub + event-mapper dance) | tool-card position |
| B. ` ```dorkos-ui ` fenced JSON in assistant text | yes     | no           | **free** — assistant text already flows uniformly through streamdown                | woven into prose   |
| C. Both                                           | —       | —            | —                                                                                   | —                  |

**Chosen: B.** Rationale: widgets are _content_, not _control_. Content tolerates no-ack (same as markdown — the agent never learns a table rendered); control (open panel) needs ack/gating and already has `control_ui`. The fence needs zero per-runtime adapter work — Claude Code, Codex, and OpenCode all just emit text — and the syntax is taught through the existing static context-block infrastructure (`<ui_tools>` precedent in `context-builder.ts`, mirrored in codex/opencode `turn-input.ts`). This is the Claude Artifacts pattern applied to a strict catalog.

Canvas placement reuses `control_ui open_canvas` with a new `{ type: 'widget', definition }` canvas content type — control of _where_ stays a tool; the widget definition itself is the same schema either way.

### D2 — Wire format: our own Zod schema in `@dorkos/shared`, not json-render's

json-render (vercel-labs) validated the approach (catalog + Zod + streaming) but is a fast-moving single-vendor lab project; adopting its wire format would couple our persisted transcripts to it. The renderer is small (recursive switch over a discriminated union). **Own the schema (`@dorkos/shared/ui-widget`), hand-roll the renderer, borrow json-render's ideas.** If A2UI v1.0 becomes relevant for the A2A gateway, we add an A2UI emitter/adapter later — the flat, catalog-constrained shape keeps that translation mechanical.

### D3 — Render on fence completion in v1

Progressive intra-widget rendering (rendering a partially-streamed JSON tree) is deferred. v1 renders the widget when its fence closes; while streaming, show a lightweight "widget loading" skeleton. This removes partial-JSON parsing risk from v1; the schema carries a `version` field so nothing blocks a v1.1 streaming upgrade.

### D4 — Interactivity: three action kinds, one return channel

Actions are declared in the widget JSON, catalog-constrained (no code):

- `{ kind: 'agent', ... }` → POST `/api/sessions/:id/ui-action` → injected into the agent's next turn (modeled on `/submit-answers`)
- `{ kind: 'ui', command: UiCommand }` → local dispatch through `executeUiCommand` (no agent wake)
- `{ kind: 'url', href }` → link out (existing LinkSafetyModal conventions)

Split: PR D renders widgets (actions render but `agent` actions disabled with tooltip if channel absent); PR E ships the channel and enables them.

### D5 — Failure posture: never break chat

Invalid/unknown widget JSON renders an error card with the raw JSON collapsed underneath — never a crash, never silent drop. Unknown node types render a placeholder (forward compatibility for catalog growth, including skill-shipped templates later).

## Out of scope

Tier 2 / MCP Apps (separate work item), skill-shipped templates (PR G, builds on this schema), data-model/binding separation à la A2UI (v1 uses literal values), progressive intra-widget streaming, 3D.

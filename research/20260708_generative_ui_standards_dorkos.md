---
title: 'Generative UI Standards for DorkOS — Landscape & Adoption Recommendation'
date: 2026-07-08
type: external-best-practices
status: active
tags:
  [
    generative-ui,
    a2ui,
    mcp-apps,
    mcp-ui,
    json-render,
    ag-ui,
    canvas,
    skills,
    marketplace,
    chat-rendering,
  ]
searches_performed: 20
sources_count: 40
supersedes_for_this_topic:
  - research/20260323_ai_agent_host_ui_control_patterns.md (standards coverage only)
  - research/20260326_agent_ui_control_canvas_spec_research.md (canvas content-type coverage only)
---

# Generative UI Standards for DorkOS — Landscape & Adoption Recommendation

## Research Summary

Decision-grade comparison of generative-UI standards as of July 2026 (A2UI, MCP Apps/mcp-ui, Vercel json-render + AI SDK, AG-UI, open-json-ui/SimpleA2UI, C1/Thesys, W3C Gen-UI CG), plus an audit of DorkOS's current implementation state. **Recommendation: a two-tier architecture — (1) a catalog-constrained declarative JSON tier for native-feel in-chat/canvas widgets (json-render-style, rendered by host-owned shadcn React components; skills ship templates), and (2) MCP Apps (SEP-1865) as the interop tier for rich sandboxed mini-apps shipped by marketplace packages and third-party MCP servers.** AG-UI is not needed (our durable SSE stream already plays that role); open-json-ui and C1 are not adoption candidates.

---

## Part 1 — Current DorkOS State (audited 2026-07-08)

The `ext-platform-01-agent-ui-control` spec is **fully implemented** and has evolved since:

- **Canvas + control_ui shipped.** `UiCommandSchema` (`packages/shared/src/schemas.ts:2026`, 14 variants incl. `open_canvas`/`update_canvas`/`close_canvas`), `UiCanvasContentSchema` (line 1968: `url` | `markdown` (optionally file-backed/editable via Blintz) | `json`). Server MCP tools `control_ui` + `get_ui_state` (`apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts`), auto-approved, with Codex parity via `codex-ui-mcp-server.ts`. Client sink: `layers/shared/lib/ui-action-dispatcher.ts`.
- **The right panel is extension-registered, not hard-coded.** `extension-registry.ts` Zustand slots; canvas registers as a `right-panel` contribution (`app/init-extensions.ts`). `ExtensionAPI` (packages/extension-api) already exposes `registerComponent('right-panel', …)`, `openCanvas()`, `executeCommand(UiCommand)` — extensions can contribute React panels today.
- **Interactive round-trip precedent exists.** `question_prompt`/elicitation/approval SessionEvents flow out over the durable SSE stream (`packages/shared/src/session-stream.ts:202`); answers return via `POST /api/sessions/:id/submit-answers`, `/submit-elicitation`, `/approve` (`apps/server/src/routes/sessions.ts`). Adding a SessionEvent member is a two-edit change.
- **Gaps:** (1) in-chat generative UI — streamdown is used with no custom `components`/code-fence overrides; `ToolCallCard`/`OutputRenderer` special-case only `Edit` (diff view); no tool-name→component registry. (2) The MCP surface (`/mcp`, ~40 tools) is **tools-only**: no MCP resources, no `ui://`, no MCP Apps support anywhere. (3) Skills support `assets/`, `scripts/`, `references/` subdirs (`packages/skills/src/constants.ts`) + arbitrary `metadata` map, but no UI/template directory. (4) Marketplace package types (`agent|plugin|skill-pack|adapter`) have no UI contribution point; Harness Sync projects no UI artifacts.

---

## Part 2 — Standards Landscape (July 2026)

### A2UI (Google) — [github.com/google/A2UI](https://github.com/google/A2UI) · [a2ui.org](https://a2ui.org/)

Apache 2.0. Launched Nov 2025 at v0.8 experimental; **v0.9.1 stable, v1.0 RC as of mid-2026** (full 1.0 targeted Q4 2026). Declarative JSON: flat component list with ID references from a client-approved catalog; separate `dataModelUpdate` messages populate bound values; `userAction` messages carry interactions back to the agent over the transport. Streaming/incremental updates are first-class. Security: "declarative data, not executable code" — no HTML/JS injection surface. Native day-zero A2A transport binding (A2UI messages as A2A payloads). Renderers: Lit/Flutter mature; **React renderer newer/less proven**; SwiftUI/Compose planned. Production: Google Opal, Gemini Enterprise, Flutter GenUI SDK; OpenClaw added support Feb 2026; CopilotKit contributes + bridges.

### MCP Apps (SEP-1865) / mcp-ui — [modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps) · [mcpui.dev](https://mcpui.dev/)

**The most consequential development: a genuine multi-vendor standard**, jointly authored by Anthropic + OpenAI + mcp-ui's creator + the MCP UI Community WG. Announced Nov 21 2025; **live as an official MCP extension since Jan 26 2026** (`@modelcontextprotocol/ext-apps`).

- MCP servers declare UI as `ui://` resources (bundled HTML/JS); tools link to UI via `_meta`.
- Rendered in a **sandboxed iframe**; bidirectional **JSON-RPC over postMessage** (iframe can invoke tools via host, host pushes data in).
- **Formally specced display modes**: `inline` (in conversation flow), `fullscreen`, `pip` — declared via `appCapabilities.availableDisplayModes` in `ui/initialize`, switchable at runtime via `ui/request-display-mode`. The only standard with a negotiated multi-surface model.
- Security: iframe sandbox + pre-declared templates (no runtime HTML injection from tool output) + auditable JSON-RPC + optional consent gate for UI-initiated tool calls.
- **Only standard where a third-party package natively ships its own UI** (server bundles tools + `ui://` resources; installing the server installs the UI).
- Hosts live: **Claude (web/desktop), ChatGPT (Apps SDK is the same wire protocol), Goose, VS Code Insiders**; JetBrains/AWS Kiro/Antigravity exploring.
- SDKs: `@mcp-ui/server` (`createUIResource()`), `@mcp-ui/client` (`<AppRenderer/>` React component — production-hardened). Content types: `rawHtml`, `externalUrl`, `remoteDom` (less documented).
- Streaming caveat: the resource loads whole, then data streams _into_ the mounted app via postMessage — the UI structure itself is not token-streamed.

### Vercel json-render — [vercel-labs/json-render](https://github.com/vercel-labs/json-render)

Apache 2.0 **library, not a standard** (Vercel-owned). Launched Jan 2026; ~13k stars, 200+ releases. Developer defines a **catalog of components + actions as Zod schemas**; the LLM's structured output is constrained to that catalog; JSON tree renders progressively as tokens stream. Ships **36 prebuilt shadcn/ui components** + adjacent packages (PDF, email, Remotion video, OG images, React Three Fiber 3D). React first-class; Vue/Svelte/Solid/RN renderers. Security same category as A2UI (no code execution, Zod-validated). No protocol-level story for third-party packages shipping catalogs (app author composes).

### Vercel AI SDK generative UI / AI Elements

Not a standard — app-code convention (`tool-TOOLNAME` message parts → hand-mapped React components). AI Elements is chat-chrome components. No cross-vendor wire format; no distribution story.

### AG-UI (CopilotKit) — [ag-ui-protocol/ag-ui](https://github.com/ag-ui-protocol/ag-ui)

A **transport/event protocol** (SSE/WS, 16+ event types, RFC-6902 state deltas), not a UI payload format — it carries A2UI/Open-JSON-UI/MCP Apps payloads. CopilotKit-stewarded (raised $27M in 2026); broad framework integrations (vendor-reported). CopilotKit's useful taxonomy of the space: **static** (host owns components, agent picks + fills) / **declarative** (agent emits UI spec: A2UI, json-render) / **open-ended** (agent ships an app surface: MCP Apps).

### open-json-ui / SimpleA2UI — [dev.to article](https://dev.to/vishalmysore/a2ui-vs-open-json-ui-bridging-the-gap-5gk0)

Single-author concept + compiler (loose LLM-friendly JSON → strict A2UI). Useful framing of the loose-output-vs-strict-catalog tension; **no formal spec, governance, or independent adoption**. Not an adoption candidate.

### Others

- **C1 by Thesys** — commercial hosted API (any LLM → generative UI via proprietary Crayon React). Not open; not a candidate.
- **OpenAI Apps SDK** — ChatGPT's implementation of the MCP Apps wire protocol + app-store layer.
- **Claude Artifacts/Skills** — not portable protocols; orthogonal.
- **W3C Generative UI Community Group** — launched early 2026, exploring cross-vendor intermediate representations; pre-draft, watch only.

### Comparison table

|                     | A2UI                               | MCP Apps / mcp-ui                            | json-render                  | AI SDK gen-UI                   | AG-UI                               | open-json-ui        | C1               |
| ------------------- | ---------------------------------- | -------------------------------------------- | ---------------------------- | ------------------------------- | ----------------------------------- | ------------------- | ---------------- |
| Type                | Multi-vendor protocol (Google-led) | **Multi-vendor standard (Anthropic+OpenAI)** | Vercel OSS library           | Library convention              | Open protocol, CopilotKit-stewarded | Individual proposal | Commercial API   |
| Status (07/2026)    | v0.9.1 stable, v1.0 RC             | Live spec (2026-01-26)                       | Active, Jan 2026+            | AI SDK 5/6                      | Active                              | Blog/repo           | GA               |
| Payload             | Flat JSON components + data model  | `ui://` HTML/JS in sandboxed iframe          | Zod-constrained JSON tree    | Tool result → hand-mapped React | Event stream (payload-agnostic)     | Loose JSON → A2UI   | Proprietary JSON |
| Code execution      | None                               | Sandboxed iframe                             | None                         | Full (app code)                 | N/A                                 | None                | None             |
| Events → agent      | `userAction` over transport        | JSON-RPC postMessage → host relays           | Catalog actions via app code | App handlers                    | Native events                       | Inherits A2UI       | Function calls   |
| Outside-chat modes  | Host-defined surfaces              | **Specced: inline/fullscreen/pip**           | Host decides                 | Host decides                    | N/A                                 | Inherits A2UI       | Host decides     |
| 3rd party ships UI  | No bundling story                  | **Yes, natively**                            | No                           | No                              | No                                  | No                  | No               |
| Structure streaming | Yes                                | No (data-into-app only)                      | Yes                          | Partial                         | Yes                                 | Inherits            | Yes              |
| React maturity      | Newer                              | High (`<AppRenderer/>`)                      | High (36 shadcn comps)       | High                            | Mature hooks                        | Inherits            | High             |

---

## Part 3 — Recommendation for DorkOS

### Two-tier architecture

**Tier 1 — Declarative native widgets (first-party feel).** Catalog-constrained JSON rendered by host-owned React/shadcn components. Covers weather cards, Linear tickets, charts, tables, forms — themed, fast, streamable, zero code execution. Implement with **json-render as a library choice** (shadcn catalog matches our design system; React-first; progressive streaming) while keeping our wire schema in `@dorkos/shared` Zod so we could emit/accept A2UI later (the A2A gateway makes A2UI relevant for _external_ agent interop once v1.0 lands).

**Tier 2 — MCP Apps (SEP-1865) for rich/third-party UI.** DorkOS is an MCP host with a marketplace — MCP Apps is the only standard where "install a package → agent renders that package's UI" works natively, and it's the standard Claude + ChatGPT + VS Code already speak. Its `inline`/`fullscreen`/`pip` display modes map directly onto our chat-inline block / canvas / floating surfaces. Use `@mcp-ui/client` `<AppRenderer/>`. Covers 3D viewers, PDF annotators, games, vendor dashboards — anything beyond the catalog.

**Do not adopt:** AG-UI (our durable per-session SSE stream with seq/replay already fills that layer; adopting it is a rewrite for no payload benefit), open-json-ui (no governance/adoption), C1 (commercial, closed).

### Answers to the open product questions

1. **3D/images/PDFs are media rendering, not generative UI** — deterministic renderers keyed by MIME type. Extend `UiCanvasContentSchema` + an inline chat block with `image`/`pdf`/`model3d`(glTF)/`file` content types rendered by built-in viewers. They share the same _surfaces_ (inline block + canvas) and plumbing as generative UI but not the template/catalog machinery. Exotic viewers can arrive later as MCP Apps.
2. **Skills ship UI via a `ui/` subdirectory** (add `'ui'` to `SKILL_SUBDIRS`): declarative Tier-1 templates (JSON catalog components + data bindings — safe, no code, works for markdown-only skills). Code-level UI belongs to extensions (`ExtensionAPI.registerComponent`, exists today) and MCP Apps servers (`ui://` resources) — marketplace packages of type `plugin`/`adapter` bundle them. Harness Sync marks `ui/` as `drop` for non-DorkOS harnesses.
3. **React is the rendering technology, never the wire format.** Agents emit declarative JSON (Tier 1) or reference pre-declared `ui://` bundles (Tier 2); host React renders both. Agent-authored React executed in-app is ruled out.
4. **Interactivity reuses the existing round-trip.** New `ui_action` client→server channel (`POST /api/sessions/:id/ui-action`, modeled on `/submit-answers`) delivering catalog-declared actions into the agent's turn; local-only actions dispatch `UiCommand`s without waking the agent; Tier 2 uses the specced postMessage JSON-RPC bridge with tool calls relayed through the existing approval pipeline. Outbound rendering rides a new `ui_block` SessionEvent member (or per-tool rendering keyed on a `render_ui` tool).

### Phasing sketch

1. **Phase 1 — Native widget tier in chat + canvas**: `render_ui` MCP tool; DorkOS component catalog (card, table, chart, form, list…); catalog renderer registered in chat message pipeline + as canvas content type; `ui-action` return channel; media content types (image/pdf/3d).
2. **Phase 2 — Skills/marketplace templates**: `ui/` skill subdir; install-time catalog registration; marketplace validation.
3. **Phase 3 — MCP Apps host support**: `<AppRenderer/>` integration, display-mode negotiation (inline→chat block, fullscreen→canvas, pip→floating), consent gating for UI-initiated tool calls; optionally serve `ui://` resources from our own `/mcp` server so DorkOS tools get rich UI in _other_ hosts (Claude, ChatGPT).

---

## Sources

See inline links above; primary: [MCP Apps spec (2026-01-26)](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx), [MCP Apps announcement](https://blog.modelcontextprotocol.io/posts/2025-11-21-mcp-apps/), [a2ui.org spec v0.9](https://a2ui.org/specification/v0.9-a2ui/), [A2UI roadmap](https://a2ui.org/roadmap/), [vercel-labs/json-render](https://github.com/vercel-labs/json-render), [AI SDK generative UI docs](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces), [@mcp-ui/client](https://www.npmjs.com/package/@mcp-ui/client), [OpenAI Apps SDK](https://developers.openai.com/apps-sdk/build/chatgpt-ui), [CopilotKit gen-UI guide 2026](https://www.copilotkit.ai/blog/the-developer-s-guide-to-generative-ui-in-2026), [W3C Gen-UI CG](https://www.w3.org/community/gen-ui/).

## Gaps & Limitations

- CopilotKit adoption claims (Google/AWS/Microsoft "adopting" AG-UI) are vendor-reported, not independently verified.
- mcp-ui `remoteDom` content type wire format not confirmed in depth.
- A2UI display-mode negotiation (vs MCP Apps' `inline`/`fullscreen`/`pip`) could not be confirmed — evidence points to host-defined surfaces only.
- C1/Thesys sandboxing details are vendor-blog claims only.

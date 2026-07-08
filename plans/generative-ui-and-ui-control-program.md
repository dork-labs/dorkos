# Generative UI & Agent UI Control — Implementation Program

**Date:** 2026-07-08 · **Orchestrator:** Claude (Fable 5) session, subagent execution
**Research basis:** `research/20260708_generative_ui_standards_dorkos.md`, `research/20260326_agent_ui_control_canvas_spec_research.md`

## Goal

Ship the two-tier generative UI architecture (declarative native widgets + MCP Apps), fix the truthfulness gaps in the existing `control_ui` pipeline, modernize the external MCP server toward the 2026-07-28 spec RC, and give extensions an event subscription API.

## Operating protocol

- Orchestrator plans, dispatches, reviews results; **all code is written by subagents** (Opus for complex/architectural work, Sonnet 5 for mechanical/medium work).
- Every work item: **own worktree, own branch off `origin/main`, own PR**. No agent writes in the main checkout; orchestrator writes only non-code artifacts (plans/specs/research) in main.
- Every PR gets a **dedicated review agent** (Opus) applying `REVIEW.md` before it's declared ready; 🔴 findings go back to the implementing agent (resumed in place with its context).
- UI-touching PRs are **browser-tested** (dev server + Playwright/Chrome tools; `browser-testing` skill).
- Parallelism cap: ≤3 concurrent implementation agents.
- PRs are opened, reviewed, and reported — **merging is left to Dorian** (dependent work stacks on unmerged branches when needed).
- Progress is tracked in the session task list (Tasks #1–#11).

## Work items

### Wave 1 (parallel, independent)

| ID     | Item                                                                   | Model  | Scope anchor                                                                                                                                          |
| ------ | ---------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A (#2) | `control_ui` truthfulness + `uiState` efficiency                       | Opus   | `apps/server/src/services/runtimes/claude-code/mcp-tools/ui-tools.ts`, `shared/ui-tool-contract.ts`, `messaging/context-builder.ts`, client send path |
| B (#3) | External `/mcp` quick wins: tool annotations, structured output, icons | Sonnet | `apps/server/src/services/core/mcp-server.ts` + tool modules                                                                                          |
| C (#4) | Media content types (image/PDF/file) in canvas + inline chat           | Opus   | `UiCanvasContentSchema`, `features/canvas/ui/`, chat renderer                                                                                         |

### Wave 2 (after spec #5; A/C merged or stacked)

| ID     | Item                                                                                               | Model |
| ------ | -------------------------------------------------------------------------------------------------- | ----- |
| D (#6) | Gen-UI Tier 1: wire schema, widget catalog (shadcn), chat + canvas renderer, prompt teaching block | Opus  |
| E (#7) | Gen-UI Tier 1: `ui-action` return channel (modeled on `/submit-answers`)                           | Opus  |
| F (#8) | Extension events API: `api.events.subscribe`, manifest capability gating                           | Opus  |

### Wave 3

| ID      | Item                                                                              | Model  |
| ------- | --------------------------------------------------------------------------------- | ------ |
| G (#9)  | Skills `ui/` subdir + install-time template registration + Harness Sync drop rule | Sonnet |
| H (#10) | MCP resources on `/mcp` (stateless list/read; RC-shaped)                          | Sonnet |

### Wave 4

| ID      | Item                                                                                                                                                                  | Model |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| I (#11) | MCP Apps host support: `@mcp-ui/client` AppRenderer, display modes (inline→chat block, fullscreen→canvas, pip→floating), postMessage bridge through approval pipeline | Opus  |

## Key decisions (made by orchestrator, per delegation)

1. **Two-tier architecture** per `research/20260708_generative_ui_standards_dorkos.md`: declarative catalog tier (own Zod wire schema in `@dorkos/shared`; json-render evaluated as implementation library, not a wire-format commitment) + MCP Apps for third-party/rich UI.
2. **Media rendering ≠ generative UI**: image/PDF/file are deterministic content types on the existing canvas/chat surfaces.
3. **MCP work targets the 2026-07-28 RC shapes** (final ships in 3 weeks) — no investment in deprecated features (roots/sampling/logging), Tasks only against the new API if attempted.
4. **Flow usage**: this program follows the flow conventions (spec → decompose → execute-in-worktree → verify → PR) with the session task list as tracker; Linear ceremony is skipped for velocity since the whole program is captured here and in Tasks #1–#11.
5. **No autonomous merges.**

## Sequencing rationale

Wave 1 items are independent, small-to-medium, and de-risk the foundations Tier 1 builds on (honest `control_ui` semantics, canvas content-type extension pattern). The Tier-1 spec (#5) is written by the orchestrator while Wave 1 runs. PR D is the heart of the program; E/F/G build on its schema. H is independent but sequenced later to keep parallelism ≤3. I lands last on top of D + H.

---
slug: doe-engine
number: 261007-225912
created: 2026-10-07
status: ideation
---

# Doe: a standalone business agent engine

**Slug:** doe-engine
**Author:** Codex
**Date:** 2026-10-07

## 1) Intent & Assumptions

- **Task brief:** DOR-2786 builds `packages/doe`, workspace name `@dorkos/doe`, ready for later publication as `@dork-labs/doe`. It has no DorkOS runtime imports. DOR-2787 starts only after this package is merged and the first ticket is closed.
- **Assumptions:** A Node host supplies model credentials, paths, permission decisions, tool definitions and context. Doe owns the loop facade, prompt, durable model history and compaction. It does not own DorkOS accounts, schedules, room rules or display history.
- **Out of scope:** The DorkOS runtime facade and UI, default runtime changes, onboarding, the heartbeat runner, cloud contracts, model tiers, a per-turn router, general-purpose agent hiring and runtime plugins.

## 2) Pre-reading Log

- `.temp/vision-202610/16-codex-vision-context.md`, followed by `15-codex-doe-prompt.md`: business work first; reuse before code; two tickets in sequence; merged PRs are the completion gate.
- `AGENTS.md`, `plans/2026-10-vision-reset.md`, `meta/VISION.md`, `meta/PRINCIPLES.md`, `meta/VOICE.md`, `meta/ROADMAP.md`: engine developer name Doe; app label DorkOS; retain existing trust protections until their separate tickets ship.
- `research/20261007_dorkos-runtime.md`: Pi core behind an engine port; full model messages survive restarts and compaction; separate coding builder; reject Anthropic subscription tokens.
- `meta/PROACTIVE-AGENTS.md`, `research/20261007_agent-teams-role-play.md`: own outcomes, act/act-then-tell/ask/stay quiet, report up, raise once, protect people's hours; quiet beat completion is structured.
- `contributing/adding-a-runtime.md`, `packages/shared/src/agent-runtime.ts`, `packages/test-utils/src/runtime-conformance.ts`: the future facade must preserve approvals, bounded stops, real context counts, durable history and honest capability declarations.
- `services/core/cloud/credits-inference.ts`: credits are chosen explicitly; unavailable credits refuse rather than changing the payer.
- Pi 1.0.4 published packages, unpacked in `.temp/doe-reuse`: the full product already includes deferred tool search; the original research's missing-tool-search claim is outdated.

## 3) Codebase Map

- `packages/doe/`: new, isolated product package. Follow existing Node workspace build, lint and Vitest patterns, without workspace product dependencies.
- `packages/decisions/`: reference for package scaffolding; used only by the future host through a beat decision hook.
- `apps/server/src/services/runtimes/shared/`: future host supplies room, identity, memory, tools and credentials here; engine does not import it.
- `packages/harness/`: future host discovers authoritative instruction/skill trees directly; no vendor projection in Doe.
- Data flow: host context + explicit model selection → engine request → streaming events + append-only model records → host display mapping.
- Blast radius for Part 1: package, lockfile, root Vitest project census, spec and changelog. No runtime registration or default changes.

## 5) Research

Reuse the MIT Pi core loop and model layer, and a standalone MCP client. Lift Pi's independent search algorithm and applicable pure compaction/edit utilities with attribution. Do not install a community extension merely to obtain a utility: most require the full product's extension runtime. See the capability-by-capability reuse table and full-product comparison in `02-specification.md`.

The full product can replace its prompt, default tools, resource loader and state directories. Its SDK avoids CLI-only upload commands, so it is a real option. However, its public SDK also owns settings, model/auth resolution, session projection, extension lifecycle and cache warming. Keeping our independent SQLite model store and owned compaction would still require a second persistence layer and adapters. Select core plus extracted utilities, retaining the full product as a source rather than a runtime dependency.

## 6) Decisions

| Decision         | Choice                                                      | Rationale                                                                      |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Persona          | Business colleague; separate builder                        | No coding advice or shell in the main agent                                    |
| Base             | Pi core 1.0.4, pinned                                       | Research audited this version; 1.1.0 exists but needs a separate upgrade audit |
| Tool loading     | Deferred registry with fixed initial schema budget          | New host capabilities require no engine edit                                   |
| Model history    | Append-only SQLite records and explicit context checkpoints | Preserve opaque reasoning/signatures; compaction never deletes originals       |
| Heartbeats       | One beat turn, structured end, decision hook                | Leave DOR-2788 a clean seam without building its service                       |
| Workflow display | Pending host clarification                                  | Codex exposes no TaskCreate/TaskList; canonical task files remain available    |

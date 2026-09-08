---
number: 302
title: Scaffold agent instruction files, never generate them
status: accepted
created: 2026-06-29
spec: harness-sync
superseded-by: null
---

# 302. Scaffold agent instruction files, never generate them

## Status

Accepted (implemented in spec: harness-sync, `packages/harness/src/scaffold/instructions.ts`)

## Context

`AGENTS.md` is the cross-tool instruction standard (read natively by Codex and Cursor), while Claude Code reads `CLAUDE.md` and supports `@path` imports — this repo already uses the zero-duplication pattern `.claude/CLAUDE.md = @../AGENTS.md`. Content-generating sync tools (rulesync) _inline_ instruction text into each tool's file, which duplicates the content and destroys the `@import`, regressing the recommended setup. The Harness Sync engine must project instructions across harnesses without falling into that trap.

## Decision

We will treat `AGENTS.md` as hand-authored and canonical, and have the projector **scaffold per-harness pointers only** — `CLAUDE.md = @../AGENTS.md`, a Gemini `GEMINI.md` pointer, a Copilot `.github/copilot-instructions.md` pointer — while Codex/Cursor read `AGENTS.md` directly (no-op). The generator **excludes** the `agentsmd`/`claudecode` instruction targets from content generation by default, and **never overwrites a hand-authored instruction file's body**: on divergence it stops and surfaces the conflict for human review. The same scaffolding runs in `createAgentWorkspace`, so every new and templated agent inherits the pattern.

## Amendment — 2026-09-08 (DOR-1851)

This ADR's rule reaches one file it does not name. `.agents/harness.manifest.json` is not an instruction file, but `scaffold/manifest.ts` has always cited ADR-302 for its own write-if-absent policy — the manifest is hand-authored, so the engine scaffolds one when a repo has none and never touches it again.

That made a harness added later unreachable. Detection ran once, when the manifest was written; a repo that grew a `.cursor/` a month afterwards never enabled Cursor, was never projected to, and was never told (contract TR-11). The rule was right about not rewriting somebody's file and wrong about never being able to add to it.

Two changes, and the line between them is the point:

- **Detection re-runs on every plan, as a report.** `detectHarnessFootprints` looks for each harness's own files, and every harness found that the manifest does not enable lands in `ProjectionPlan.notEnabled`. `dorkos harness sync` prints one line per harness and exits exactly as it would have. It is a notice, never drift: a person who runs Cursor on a different project is not wrong, and a failing command nobody can clear is how people learn to stop reading the output. `AGENTS.md` is excluded from these signals on purpose — every DorkOS repo has one, so reading it as a Codex footprint would print an unclearable line on every sync of every repo.
- **`--enable <harness>` is the one path that writes the manifest**, and it requires `--fix`. It performs a text insertion of one array element: the file is never parsed and reprinted, because a round-trip through `JSON.stringify` would silently reflow every line of a file whose four-space indent, one-line array and key order are the person's. The insertion is verified against the reparsed document before it is written, so surgery that cannot prove it did the right thing writes nothing. A byte diff of the run is exactly the inserted element and its separator.

So the decision above holds with one stated exception: the engine still never rewrites a hand-authored file, and it may now ADD one element to one list, when a person asks for that by name.

ADR-0301 owns the manifest's existence and its schema; this one owns the write policy the code cites, which is why the exception is stated here.

## Consequences

### Positive

- Zero instruction duplication; preserves Anthropic's recommended `@import` setup.
- Every DorkOS repo and every created/templated agent inherits the best-practice instruction layout.
- Instruction content has exactly one source of truth (`AGENTS.md`), so it cannot drift across harnesses.

### Negative

- One more scaffolding responsibility in agent creation.
- The engine must implement conflict detection (stop-on-divergence) rather than blind overwrite.

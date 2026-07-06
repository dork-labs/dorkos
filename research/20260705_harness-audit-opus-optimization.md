---
title: 'Harness Audit & Opus Optimization — Findings, Changes, and Deferred Work'
date: 2026-07-05
type: internal-audit
status: active
tags: [harness, claude-code, hooks, skills, commands, agents-md, opus, context-engineering]
---

# Harness Audit & Opus Optimization

Full audit of the Claude Code harness (hooks, rules, commands, skills, AGENTS.md, self-maintenance loops, repo feedback loops) against one question: **what gets the best coding results from Opus-class models?** Eight parallel audit agents measured and read everything; the changes shipped in the `harness/opus-optimization` branch. This report records the findings, the principles applied, and what was deliberately deferred.

## Guiding principles (from Anthropic docs + measured evidence)

1. **Feedback beats instruction.** A fast, targeted, model-visible verification signal (typecheck/lint diagnostics with file:line) improves results more than any prompt text. Hook stdout is invisible to the model on most events — only stderr + exit 2 (or `additionalContext` JSON) reaches it.
2. **Always-loaded context must earn its cost.** Official guidance: keep CLAUDE.md under ~200 lines; bloat causes instruction-dropping. Skills' descriptions load every session (the retrieval index); bodies load on demand.
3. **Opus-class models need goals + constraints, not scripts.** Anthropic's own Opus migration guidance says to _remove_ CRITICAL/MUST scaffolding, forced status-update cadences, and step-by-step micromanagement — they cause over-triggering and over-engineering. Keyword thinking escalation ("think hard"/"megathink"/"ultrathink") is deprecated; use `alwaysThinkingEnabled` / effort settings.
4. **Hooks are for deterministic enforcement; prompts are for judgment.** And hooks must be silent on success — standing nags train everyone to ignore all hook output.
5. **Maintenance loops must dispose where they create.** A pipeline that mints debt inside the shipping workflow but disposes of it in a separate human ceremony diverges structurally.

## Key findings (measured 2026-07-05)

### The edit-time feedback loop was broken four ways

- Every Edit/Write paid **11–20s** of PostToolUse hooks; on failure the model saw only "X failed" — all diagnostics were piped to stdout and lost.
- `lint-changed.sh` was a **complete no-op**: it ran eslint from the repo root, whose config ignores `apps/**` and `packages/**`. FSD layer rules, SDK confinement, and TSDoc were unenforced at edit time.
- `test-changed.sh` ran `vitest related`, which the barrel-import graph fans out to ~half the suite (82 test files for one edit) — whole-suite cost at per-edit frequency, and false-failing on stale dists.
- `.claude/rules/testing.md` had invalid YAML `paths:` frontmatter (individually-quoted globs), breaking path-scoped loading.

### Model-era scaffolding had rotted

- `thinking-level.sh` injected the deprecated "megathink" keyword into every prompt.
- The `/system:*` commands (307–945 lines each) were template-era artifacts referencing Prisma, ClaudeKit, `dal.md`/`security.md` rules, and `database-expert`/`documentation-expert` agents — none of which exist. ~20 command files referenced the dead `Task`/`TaskOutput` tool API; 11 used stale MCP tool names.
- `styling-with-tailwind-shadcn` taught the **wrong component system** (basecn + render-prop; reality is Radix + asChild, 144 uses) plus phantom fonts, type scale, and utilities. `orchestrating-parallel-work` taught nonexistent tool APIs verbatim.
- ~2,700 lines of dead commands (template machinery, completed one-shot migrations, question-tree theater).

### Maintenance loops accumulated debt by design

13 draft ADRs (creation rides shipping; curation was a separate ceremony last run 22 days prior), 16+ proposed ADRs parked, docs/research markers never stamped (gitignored, per-checkout), a Stop hook burning 9.5s to compute a 110-line nag the model never saw, and 3.4s of SessionStart scans emitting three standing nags per session.

### Repo feedback loops (for agents) had sharp edges

Pre-push forked the turbo cache key (`--retry=2` in passthrough) so a green dev test run bought nothing at push time (81–125s re-run). Warm turbo cache is excellent (<0.5s) but per-worktree. `@dorkos/server:test` shows real flake. Targeted verification (`--filter` typecheck = 3.6s vs 28s full) was undocumented.

## Changes shipped

- **Hooks**: diagnostics now reach the model (stderr + exit 2, capped); lint runs from the file's workspace (with a tripwire so the no-op can't silently return); typecheck is incremental (~1s warm); test-changed removed from the edit chain (targeted tests are the model's job; pre-push is the gate). Per-edit chain: **~8.5s broken → ~2.3s working**. Five SessionStart hooks → one `session-maintenance.sh` digest (≤5 lines, silent when healthy, 0.3–0.45s). Checkpointing is worktree-only (multi-agent race fix). File protection moved to native tool-scoped `permissions.deny`; file-guard narrowed to Bash. `alwaysThinkingEnabled: true` replaces the deprecated keyword hook.
- **ADR pipeline**: draft status eliminated — `/adr:from-spec` applies the significance rubric at extraction (≥2 criteria → proposed/accepted; else not written). One-time cleanup: 13 drafts triaged (11 accepted, 1 proposed, 1 archived), proposed backlog swept 17 → 5, all dispositions verified against code. `/system:release` gained a harness-maintenance phase; markers are now committed.
- **Always-loaded context**: AGENTS.md 226 → ~150 lines — structural drift fixed (4 missing packages, 4 missing service domains, 4 missing routes), inspiration compressed to pointers, and high-value gotchas added (targeted verification, bare-vitest false-fail, stale-dist, ports, Express 5). Rules: testing.md fixed, server-structure.md rewritten (35 lines), api.md de-templated, components.md 12.2KB → 5KB (Base UI block cut; utilities table now states site-vs-client truth), three generic rules merged into `conventions.md` (10 rules → 8).
- **Commands**: 47 → 42 files, 15,063 → 7,755 lines; all phantom references removed; `/system:ask|update|review` rewritten as goals+constraints (37/54/47 lines); `/research:curate` non-interactive by default.
- **Skills**: 12 fixed (including full rewrites of the styling and parallel-work skills from ground truth); TDD and clarifying-requirements cut to ~150 lines each; `executing-specs` fork deleted (ADR-0297); cross-references (DOCS.md, writing-adrs, parallel-execution guide) updated.
- **Build plumbing**: pre-push now shares the dev turbo cache key (verified identical hashes via `--dry=json`); `pnpm verify` composite added; phantom `coverage/**` outputs removed.

## Deferred (recommendations, not shipped)

1. **User-scope plugin sprawl** — ~16 plugins enabled globally (posthog alone injects ~100 skill descriptions into every session in every repo; vercel ~40). This is the single largest remaining context tax and lives in `~/.claude/settings.json`, outside the repo. Recommendation: disable plugins not used routinely (`/plugin`), keeping project-relevant ones. Per-project disabling via `enabledPlugins: false` overrides is not confirmed to work.
2. **Turborepo remote/shared cache** — cache is per-worktree; the worktree-per-agent policy means every agent pays cold cost (~2min). A shared `TURBO_CACHE_DIR` or remote cache would fix it. Infra decision.
3. **De-flake `@dorkos/server:test`** — failed 2 of 3 pre-push runs during the audit on an idle machine. A flaky 2-minute gate trains agents toward `--no-verify`. Worth a ticket.
4. **Client CSS utility gap (product bug)** — client components use `shadow-soft`, `card-interactive`, `focus-ring`, `container-default`, `shadow-elevated/modal` which are defined only in the site's CSS — no-ops in the client (PromoCard, PackageCard, AdapterNode, MemoryRecallBlock, +). Either port the utilities to `apps/client/src/index.css` or remove the usages.
5. **turbo.json task graph** — `typecheck` dependsOn `^build` and `lint` dependsOn `^lint` widen targeted runs (11.5s vs 3.6s). Worth revisiting; left alone to avoid changing build semantics in this pass.
6. **REVIEW.md severity taxonomy** — only 2 levels; fine for the nit cap, revisit if review volume grows.

## Verification approach

Hook changes were verified empirically in the worktree: simulated PostToolUse stdin with real files, injected type/lint faults to confirm stderr plumbing and exit codes, timed warm/cold runs, and proved the pre-push cache-key unification via `turbo --dry=json` hash comparison. Prompt-artifact changes (commands/skills/rules) were verified by reference-greps (zero phantom references remain) and frontmatter parses. Behavioral A/B of prompt changes against Opus was considered and skipped: per-change effects are below measurement noise on real tasks; the changes instead follow Anthropic's published Opus-tuning guidance directly.

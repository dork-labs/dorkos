# Claude Code Harness

This directory contains the **Claude Code Harness** — the customization framework that lets Claude Code work effectively on this project: context, commands, expertise, and automation that bridge sessions and keep multi-agent work consistent.

**Design stance:** this harness runs Opus-class models. Components state goals, constraints, project-specific facts, and verification criteria — not step-by-step micromanagement, fill-in-the-blank output templates, or question trees for decisions the model can make. AGENTS.md is the highest-leverage file in the harness; every line of always-loaded context must earn its cost.

## Harness Inventory

| Component     | Count | Location                                                                     |
| ------------- | ----- | ---------------------------------------------------------------------------- |
| Commands      | 42    | `.claude/commands/`                                                          |
| Agents        | 7     | `.claude/agents/`                                                            |
| Skills        | 30    | `.claude/skills/` (13 Claude-only dirs + 17 symlinks into `.agents/skills/`) |
| Shared Skills | 17    | `.agents/skills/` (canonical, projected to other harnesses)                  |
| Rules         | 8     | `.claude/rules/`                                                             |
| Claude Hooks  | 9     | `.claude/hooks/`, wired in `.claude/settings.json`                           |
| Git Hooks     | —     | `lefthook.yml` (pre-commit/pre-push) + `.claude/git-hooks/` (post-commit)    |
| ADRs          | 249   | `decisions/` (+87 archived)                                                  |
| Guides        | 28    | `contributing/` (+ INDEX.md)                                                 |

The `/flow` workflow engine (commands + stage skills) is **not** in this repo — it lives in the external marketplace plugin (`dork-labs/marketplace`, `plugins/flow/`; ADR-0297) and its commands exist only when loaded via `--plugin-dir`.

## Commands (User-Invoked)

| Namespace    | Commands                                           | Purpose                                                       |
| ------------ | -------------------------------------------------- | ------------------------------------------------------------- |
| `adr/`       | create, from-spec, list, review                    | ADRs — extraction applies the significance rubric at creation |
| `app/`       | cleanup, runtime-upgrade, upgrade                  | Dependency and dead-code management                           |
| `cc/notify/` | on, off, status                                    | Notification sounds                                           |
| `cc/ide/`    | set, reset                                         | VS Code color schemes                                         |
| `changelog/` | backfill                                           | Changelog backfill from git commits                           |
| `chat/`      | self-test, session-switch-test                     | Chat UI self-testing in a live browser                        |
| `debug/`     | api, browser, data, logs, performance, test, types | Systematic debugging                                          |
| `docs/`      | coverage, reconcile, status                        | Documentation coverage, drift, health                         |
| `git/`       | commit, push                                       | Version control with validation                               |
| `research/`  | curate                                             | Research library curation (non-interactive by default)        |
| `spec/`      | audit, doc-update, feedback                        | Spec-file utilities                                           |
| `system/`    | ask, learn, release, review, update                | Harness maintenance                                           |
| `worktree/`  | create, list, remove                               | Git worktree management                                       |
| root         | browsertest, browsertest:maintain, handoff-prompt  | Browser tests; session handoff                                |

## Agents (Tool-Invoked)

Agents run in isolated context windows via the Agent tool.

| Agent                   | Specialty                                 | When to Use                                            |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `react-tanstack-expert` | React 19, TanStack Query, data fetching   | Component architecture, query/caching work             |
| `typescript-expert`     | Type system, generics, build errors       | Complex types, build failures                          |
| `product-manager`       | Roadmap, prioritization, scope            | Strategic product decisions                            |
| `research-expert`       | Web research, information gathering       | External research (non-Claude-Code topics)             |
| `code-search`           | Finding files, patterns, functions        | Focused file lists (vs `Explore` for full answers)     |
| `context-isolator`      | Read-only aggregation in isolated context | Large reads/log analysis that would bloat main context |
| `code-reviewer`         | Code review, production readiness         | Batch-level review after major work, before merge      |

Built-in agents also available: `Explore` (comprehensive codebase answers), `claude-code-guide` (authoritative Claude Code/SDK/API documentation).

## Skills (Model-Invoked)

Skills load their description into every session (the retrieval index) and their body on demand. Shared, cross-harness skills live canonically in `.agents/skills/` and are symlinked into `.claude/skills/`; Claude-only skills live directly in `.claude/skills/`. `dorkos harness sync --check|--fix` (packages/harness) projects shared skills to other harnesses.

**Two-tier commands & portable skills.** Some workflows exist as both a slash command and a portable skill (recorded in `.agents/harness.manifest.json` `commandMappings`): the command carries project-specific orchestration, the skill carries the portable methodology — e.g. `/debug:test` defers to `debugging-test-failures`. This duplication is intentional; keep the pairs consistent when editing either half.

| Skill                            | Expertise / When Applied                                                  |
| -------------------------------- | ------------------------------------------------------------------------- |
| `adding-config-fields`           | Config field lifecycle (Zod → conf migration)                             |
| `browser-testing`                | Playwright browser-test methodology (apps/e2e)                            |
| `capturing-product-media`        | Regenerate the marketing site's product stills + loops (apps/e2e/capture) |
| `clarifying-requirements`        | AskUserQuestion discipline for vague/ambiguous requests                   |
| `creating-pull-requests`         | PR flow + automated-review labels                                         |
| `debugging-systematically`       | Debugging methodology + DorkOS ground-truth paths                         |
| `debugging-test-failures`        | Test-failure diagnosis (portable twin of `/debug:test`)                   |
| `debugging-typescript-errors`    | Type-error tracing (portable twin of `/debug:types`)                      |
| `designing-frontend`             | Calm Tech design language, UI decisions                                   |
| `maintaining-dev-playground`     | Dev playground coverage when editing UI components                        |
| `managing-specs`                 | Spec file management, timestamp ids, archive lifecycle                    |
| `marketplace-dev`                | Marketplace package development                                           |
| `opensrc`                        | Fetching dependency source for implementation context                     |
| `orchestrating-parallel-work`    | Agent-tool fan-out, batching, background agents                           |
| `organizing-fsd-architecture`    | FSD layer placement (defers to rules/fsd-layers.md for the import matrix) |
| `reading-session-transcripts`    | DorkOS session URL → JSONL resolution (claude-code runtime)               |
| `receiving-code-review`          | Technical evaluation of inbound review feedback                           |
| `requesting-code-review`         | Dispatching code-reviewer for batch-level verification                    |
| `styling-with-tailwind-shadcn`   | Tailwind v4 + shadcn/Radix implementation patterns                        |
| `syncing-agent-skills`           | Cross-harness skill sync (`dorkos harness sync` first)                    |
| `test-driven-development`        | TDD iron law + repo test commands                                         |
| `upgrading-runtime-dependencies` | Runtime SDK changelog analysis                                            |
| `verification-before-completion` | Evidence before completion claims                                         |
| `visual-companion`               | Browser-based visual mockups/diagrams                                     |
| `working-in-worktrees`           | Worktree isolation decision + mechanics                                   |
| `writing-adrs`                   | ADR quality, significance rubric, lifecycle                               |
| `writing-changelogs`             | Human-friendly changelog entries                                          |
| `writing-developer-guides`       | Guide structure for AI consumption (contributing/)                        |

## Rules (Path-Triggered)

Rules inject context when Claude edits matching files (`paths:` frontmatter — a single comma-separated scalar; individually-quoted lists are invalid YAML and break loading).

| Rule                  | Applies To                                 | Key Guidance                                       |
| --------------------- | ------------------------------------------ | -------------------------------------------------- |
| `agent-storage.md`    | mesh package, manifest, agents/mesh routes | File-first write-through (ADR-0043)                |
| `api.md`              | `apps/server/src/routes/**/*.ts`           | Zod validation, thin routes, error shapes          |
| `components.md`       | `apps/client/src/**/*.tsx`                 | Radix/shadcn patterns, a11y, which utilities exist |
| `conventions.md`      | `**/*.ts, **/*.tsx`                        | TSDoc format, file-size thresholds, DRY/complexity |
| `dork-home.md`        | server + packages src                      | dorkHome parameter convention, no `os.homedir()`   |
| `fsd-layers.md`       | `apps/client/src/layers/**`                | FSD layer dependency rules, barrel imports         |
| `server-structure.md` | `apps/server/src/{services,routes}/**`     | Domain placement for new services, thin routes     |
| `testing.md`          | `**/__tests__/**, **/*.test.ts(x)`         | Vitest patterns, mock Transport, FakeAgentRuntime  |

## Hooks (Event-Triggered)

Wired in `settings.json`, scripts in `.claude/hooks/`. All hook commands use the `cd "$(git rev-parse --show-toplevel)" &&` prefix (CWD safety under subagents). Hooks are silent on success; failures reach the model as stderr + exit 2 with file/line diagnostics.

| Event              | Hooks                                                              | Behavior                                                                                                                       |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `PreToolUse(Bash)` | file-guard                                                         | Blocks bash access to secrets (`.env`, keys); file-tool access is denied natively via `permissions.deny` tool-scoped rules     |
| `PostToolUse(W/E)` | format-changed, typecheck-changed, lint-changed, check-any-changed | Prettier; incremental workspace `tsc --noEmit` (~1s warm); workspace-scoped eslint; `any`-type detection. ~2-3s total per edit |
| `PostToolUse(W)`   | spec-status-sync                                                   | Spec manifest write-through + ADR extraction/review reminders via `additionalContext`                                          |
| `Stop`             | create-checkpoint (worktrees only), check-docs-changed             | Checkpointing skips the shared main checkout (multi-agent race); docs reminder                                                 |
| `SessionStart`     | session-maintenance                                                | ≤5-line `[Harness]` digest: ADR drift, review backlog (≥10 proposed), docs/research staleness. Silent when healthy             |

Test running is deliberately **not** a per-edit hook — the model runs targeted tests (`pnpm vitest run <path>`), and lefthook's pre-push gate runs the full suite with the same turbo cache key as `pnpm test -- --run` (a green dev run makes push near-instant).

Git hooks: lefthook (`lefthook.yml`) runs prettier/lint/typecheck at pre-commit and the test suite at pre-push; `.claude/git-hooks/` (post-commit changelog populator) installs via `.claude/scripts/install-git-hooks.sh`.

## ADR Pipeline

There is no `draft` status. `/adr:from-spec` scores each candidate against the 4-criteria significance rubric at extraction: score ≥2 → written as `proposed` (or `accepted` if the spec already shipped); score ≤1 → never written (listed in the summary for auditability). `/adr:review` moves proposed ADRs to accepted/deprecated/superseded/archived once implemented; `/system:release` runs it as part of release maintenance; the session-start digest surfaces backlog ≥10. `node .claude/scripts/adr-drift-check.mjs` validates manifest ↔ files.

## Component Selection

```
User explicitly invokes? ────────────────► COMMAND
Needs isolated context or specific tools? ► AGENT
Teaches reusable expertise? ─────────────► SKILL
Applies only to specific file paths? ────► RULE
Must happen deterministically at events? ► HOOK
Project-wide context, every session? ────► AGENTS.md
```

Naming: commands `verb`/`noun`; agents `domain-expert`; skills `verb-ing-noun` (gerund); rules `topic.md`; hooks `action-target`.

## Core Workflows

**Feature development** runs through the `/flow` plugin (capture → triage → ideate → specify → decompose → execute → verify → done), installed from the DorkOS Marketplace and projected into `.claude/` by Harness Sync (`.claude/commands/flow/`, `.claude/skills/flow__*`). Without the plugin installed, use specs in `specs/<slug>/` + `/worktree:create` for execution isolation; there is no in-repo fallback skill.

**Debugging**: `/debug:browser|types|test|api|data|logs|performance` — each defers methodology to its twin skill and carries the project-specific entry points.

**Harness maintenance**: `/system:ask` (how do I…), `/system:learn` (experiment, then codify), `/system:update` (add/change a process), `/system:review` (audit for staleness/consistency/Opus-fit), `/system:release` (release + harness-maintenance phase).

**Parallel execution**: fan out independent work as multiple Agent calls in one message; `run_in_background: true` for long tasks (completion notifies automatically). Patterns and decision framework: `contributing/parallel-execution.md` + the `orchestrating-parallel-work` skill.

## Maintaining the Harness

### Adding a New Command

1. Create `.claude/commands/[namespace]/[name].md`
2. Include YAML frontmatter:
   ```yaml
   ---
   description: What this command does
   argument-hint: [expected arguments]
   allowed-tools: Tool1, Tool2, Tool3
   ---
   ```
3. Write goals + constraints + verification, not step-scripting. Document in this README; update AGENTS.md only if significant.

### Adding a New Agent

1. Create `.claude/agents/[category]/[name].md`
2. Include YAML frontmatter:
   ```yaml
   ---
   name: agent-name
   description: When to use this agent (include triggers)
   tools: Tool1, Tool2
   model: sonnet
   ---
   ```
3. Document in this README under Agents.

### Adding a New Skill

1. Shared (cross-harness) → create `.agents/skills/[skill-name]/SKILL.md` + symlink at `.claude/skills/[skill-name]`; Claude-only → create directly in `.claude/skills/`.
2. Gerund name; description must state concrete trigger conditions ("Use when …") — it is the retrieval index.
3. Keep SKILL.md under 500 lines; push detail to reference files (one level deep).
4. Document in this README under Skills.

### Adding a New Rule

1. Create `.claude/rules/[topic].md` with `paths:` frontmatter — **one comma-separated scalar**:
   ```yaml
   ---
   paths: apps/server/src/**/*.ts, packages/*/src/**/*.ts
   ---
   ```
2. Verify the globs match real files. Document in this README under Rules.

### Adding a New Claude Hook

1. Create the script in `.claude/hooks/[name].{sh,mjs}`; wire it in `.claude/settings.json`.
2. **CWD-safety (required):** prefix with `cd "$(git rev-parse --show-toplevel)" &&`.
3. **Budget:** per-edit hooks must stay ~1s warm; anything slower belongs at Stop, pre-commit, or pre-push.
4. **Plumbing:** silent on success. Failures → diagnostics on **stderr** + exit 2 (stdout is invisible to the model on most events). To inject context on success, emit `hookSpecificOutput.additionalContext` JSON.
5. `chmod +x`; document in this README; add options to `.claude/hooks-config.json` if configurable.

### Adding a New Git Hook

1. Create in `.claude/git-hooks/`, register in `.claude/scripts/install-git-hooks.sh`, run it to install.

**Principle — auto-git hooks must be idempotent and replay-safe.** Any hook that silently runs `git add`, `git commit --amend`, or `git stash` will eventually fire during a concurrent commit or a replay (cherry-pick/rebase). Skip when a git operation is in flight (`index.lock`, MERGE/REBASE/CHERRY_PICK state — see `create-checkpoint.sh`), and make the effect idempotent (see `changelog-populator.py`'s dedup + lock re-entry guard). Two hooks shipped without this and corrupted commits.

### Script Directory Conventions

`.claude/hooks/` = Claude Code lifecycle automation. `.claude/git-hooks/` = git automation. `.claude/scripts/` = manual utilities (id allocation, drift checks, worktree setup).

### Review Cycle

Run `/system:review` periodically (and after multi-component changes): it checks inventory counts, broken/phantom references, frontmatter validity, ADR drift, staleness vs code, and Opus-fit.

## Troubleshooting

- **Commands not loading** — check the file exists under `.claude/commands/`; commands load at session start.
- **Hooks not running** — validate settings.json JSON; test manually: `echo '{"tool_name":"Edit","tool_input":{"file_path":"<abs path>"}}' | .claude/hooks/<hook>`; check the script is executable.
- **Rule not triggering** — its `paths:` must be a single scalar of comma-separated globs; test patterns with `find`.
- **Agent failures** — agents run isolated; check `tools:` frontmatter covers what the agent needs.

## References

- [Claude Code Best Practices](https://code.claude.com/docs/en/best-practices)
- [Effective Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Equipping Agents for the Real World with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [Writing a Good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)

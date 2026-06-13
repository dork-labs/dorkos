# Claude Code Harness

This directory contains the **Claude Code Harness** — the complete customization framework that enables Claude Code to work effectively on this project. The harness provides context, commands, expertise, and automation that bridges coding sessions and maintains consistency across multiple conversations.

## What is a Harness?

A **harness** is the underlying infrastructure that runs an AI coding agent. It includes:

- **System Context** — Project instructions (AGENTS.md) that teach Claude about this codebase
- **Commands** — Slash commands for common workflows (`/git:commit`, `/spec:create`, etc.)
- **Agents** — Specialized experts for complex tasks (`typescript-expert`, `react-tanstack-expert`)
- **Skills** — Reusable expertise applied automatically (`debugging-systematically`, `designing-frontend`)
- **Rules** — Path-specific guidance triggered when editing certain files
- **Hooks** — Automated validation at lifecycle events (typecheck, lint, test)

**Key insight**: AGENTS.md is "the highest leverage point of the harness" — it deserves careful, intentional curation.

## Harness Inventory

| Component     | Count | Location                                                                   |
| ------------- | ----- | -------------------------------------------------------------------------- |
| Commands      | 56    | `.claude/commands/`                                                        |
| Agents        | 7     | `.claude/agents/`                                                          |
| Skills        | 33    | `.claude/skills/` (Claude-visible entries; may include symlinks)           |
| Shared Skills | 18    | `.agents/skills/` (canonical shared skill directories)                     |
| Rules         | 10    | `.claude/rules/`                                                           |
| Claude Hooks  | 15    | `.claude/hooks/`, configured in `.claude/settings.json`                    |
| Git Hooks     | 1     | `.claude/git-hooks/`, installed via `.claude/scripts/install-git-hooks.sh` |
| MCP Servers   | 1     | `.mcp.json` (shadcn); playwright & context7 via plugins                    |
| ADRs          | 218   | `decisions/` (+ 67 archived)                                               |
| Guides        | 25    | `contributing/` (24 guides + INDEX.md)                                     |

## Component Types

### Commands (User-Invoked)

Slash commands are triggered explicitly by typing `/command`. They're expanded prompts that provide step-by-step instructions.

| Namespace      | Commands                                                                     | Purpose                                                                                 |
| -------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `spec/`        | create, decompose, execute, feedback, doc-update, migrate, tasks-sync, audit | Specification workflow (uses built-in task tools with `[slug] [P#]` subject convention) |
| `git/`         | commit, push                                                                 | Version control with validation                                                         |
| `debug/`       | browser, types, test, api, data, logs, rubber-duck, performance              | Systematic debugging                                                                    |
| `docs/`        | coverage, reconcile, status                                                  | Documentation coverage, drift detection, health dashboard                               |
| `adr/`         | create, list, from-spec, curate, review                                      | Architecture Decision Records                                                           |
| `system/`      | ask, update, review, learn, release                                          | Harness maintenance                                                                     |
| `app/`         | upgrade, runtime-upgrade, cleanup                                            | Application dependency and code management                                              |
| `cc/notify/`   | on, off, status                                                              | Notification sounds                                                                     |
| `cc/ide/`      | set, reset                                                                   | VS Code color schemes                                                                   |
| `template/`    | check, update                                                                | Upstream template updates                                                               |
| `worktree/`    | create, list, remove                                                         | Git worktree management                                                                 |
| `browsertest/` | (root), maintain                                                             | Browser test execution, maintenance, health audit                                       |
| `changelog/`   | backfill                                                                     | Changelog backfill from git commits                                                     |
| `research/`    | curate                                                                       | Research file curation and status management                                            |
| `chat/`        | self-test, session-switch-test                                               | Chat UI self-testing & session-switch testing in live browser session                   |
| `linear/`      | idea, done                                                                   | Linear Loop — idea capture and completion reporting                                     |
| root           | ideate, ideate-to-spec, review-recent-work, pm                               | Feature development, product management loop                                            |

### Agents (Tool-Invoked)

Agents run in isolated context windows via the Task tool. Use for complex, multi-step tasks that benefit from separate context or specialized tool access.

**Built-in agents** (provided by Claude Code):

| Agent               | Specialty                                           | When to Use                                                             |
| ------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| `Explore`           | Codebase exploration, understanding how things work | Open-ended questions, architecture understanding, comprehensive answers |
| `claude-code-guide` | Claude Code documentation                           | Questions about Claude Code features, hooks, skills, MCP                |

**Project agents** (defined in `.claude/agents/`):

| Agent                   | Specialty                                       | When to Use                                             |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| `react-tanstack-expert` | React, TanStack Query, server/client components | Data fetching, state management, component architecture |
| `typescript-expert`     | Type system, generics, build errors             | Complex types, build failures, type patterns            |
| `product-manager`       | Roadmap, prioritization, scope management       | Strategic decisions, feature prioritization             |
| `research-expert`       | Web research, information gathering             | External research (non-Claude Code topics)              |
| `code-search`           | Finding files, patterns, functions              | Locating code by pattern or content                     |
| `context-isolator`      | Read-only data aggregation in isolated context  | Large reads, log analysis, summarization tasks          |
| `code-reviewer`         | Code review, production readiness               | After major tasks, features, or before merge            |

**Explore vs code-search:**

- `Explore` — Returns comprehensive answers with explanations ("How does the transport layer work?")
- `code-search` — Returns focused file lists only ("Find files using useSessionId")

**Agent vs Skill**: Agents EXECUTE tasks in isolated context. Skills TEACH expertise in main conversation.

### Skills (Model-Invoked)

Skills provide reusable expertise that Claude applies automatically when relevant. They teach "how to think" about problems.

Shared, cross-agent skills now live canonically in `.agents/skills/`. Claude continues to discover them through matching entries in `.claude/skills/`, which may be symlinks. Skills that remain tightly coupled to Claude-only tools can continue to live directly in `.claude/skills/`.

**Two-tier commands & portable skills.** Several rich workflows exist as both a slash command _and_ a portable skill — this is intentional, not a half-finished migration. The slash command (e.g. `/spec:execute`, `/debug:test`, `/pm`) is Claude's canonical, heavier path: it uses Claude-specific orchestration and stays the real implementation. The matching portable skill (e.g. `implementing-specifications`, `debugging-test-failures`, `running-product-loop`) is the vendor-neutral equivalent shared with Codex via `.agents/skills/`; in Claude it doubles as the natural-language entry point. The command-to-skill mapping is recorded in `.agents/harness.manifest.json` (`commandMappings`); the design rationale ("honesty over false parity") lives in `.agents/skills/syncing-agent-skills/references/sync-harnesses-spec.md`. This is a staged migration — the command remains canonical for Claude while shared skills carry cross-tool workflow intent.

| Skill                            | Expertise                                              | When Applied                                                              |
| -------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `adding-config-fields`           | Config field lifecycle (Zod → conf migration)          | Adding, renaming, or removing user config fields                          |
| `capturing-linear-ideas`         | Direct Linear idea capture                             | Quick backlog intake (portable twin of `/linear:idea`)                    |
| `clarifying-requirements`        | Identifying gaps, asking clarifying questions          | Vague requests, ambiguous scope, hidden complexity                        |
| `closing-linear-loop`            | Linear issue completion and pulse checks               | Marking issues done (portable twin of `/linear:done`)                     |
| `debugging-systematically`       | Debugging methodology, troubleshooting patterns        | Investigating bugs, tracing issues                                        |
| `debugging-test-failures`        | Evidence-based test failure diagnosis                  | Debugging failing tests (portable twin of `/debug:test`)                  |
| `debugging-typescript-errors`    | Type error tracing and minimal fixes                   | Resolving type mismatches (portable twin of `/debug:types`)               |
| `designing-frontend`             | Calm Tech design language, UI decisions                | Planning UI, reviewing designs, hierarchy decisions                       |
| `ideating-features`              | Feature ideation and decision synthesis                | Shaping briefs into ideation outputs (portable twin of `/ideate`)         |
| `implementing-specifications`    | Portable specification execution workflow              | Implementing a spec, tool-agnostically (portable twin of `/spec:execute`) |
| `styling-with-tailwind-shadcn`   | Tailwind CSS v4, Shadcn UI implementation              | Writing styles, building components, theming                              |
| `writing-developer-guides`       | Developer guide structure for AI agents                | Creating/updating files in contributing/                                  |
| `orchestrating-parallel-work`    | Parallel agent execution, batch scheduling             | Coordinating multiple concurrent tasks, optimizing task ordering          |
| `working-in-worktrees`           | Worktree isolation decision, mechanics, cleanup safety | Code changes in a shared checkout, dispatching tasks, executing specs     |
| `writing-changelogs`             | Human-friendly changelog entries, release notes        | Populating changelog, preparing releases                                  |
| `organizing-fsd-architecture`    | Feature-Sliced Design layer placement, imports         | Structuring client code, creating features, reviewing architecture        |
| `executing-specs`                | Parallel spec implementation, incremental persistence  | Orchestrating `/spec:execute` with batch result tracking                  |
| `writing-adrs`                   | Architecture Decision Records, decision signals        | Creating ADRs, extracting decisions from specs, ADR quality               |
| `browser-testing`                | Browser test methodology, Playwright patterns          | Writing and maintaining DorkOS browser tests                              |
| `reading-session-transcripts`    | DorkOS session URL → JSONL file resolution             | User shares session URLs, asks to read transcripts/chats                  |
| `running-product-loop`           | Product loop assessment and next-action execution      | Product triage & next-step decisions (portable twin of `/pm`)             |
| `test-driven-development`        | TDD methodology, red-green-refactor cycle              | Implementing features, bug fixes, before writing code                     |
| `verification-before-completion` | Evidence-based completion claims                       | Before claiming work is complete, committing, or creating PRs             |
| `receiving-code-review`          | Technical evaluation of review feedback                | Receiving code review, before implementing suggestions                    |
| `requesting-code-review`         | Dispatching code-reviewer subagent                     | After major tasks, features, or before merge                              |
| `visual-companion`               | Browser-based visual mockups and diagrams              | When user would understand better by seeing than reading                  |
| `linear-loop`                    | Loop methodology, Linear integration, template routing | Working with Linear issues, running `/pm`, product loop                   |
| `maintaining-dev-playground`     | Dev playground coverage and updates                    | Editing UI components, checking playground candidacy                      |
| `managing-specs`                 | Spec file management and organization                  | Creating, validating, or organizing spec files                            |
| `marketplace-dev`                | Marketplace package development                        | Creating agents, plugins, skill-packs for marketplace                     |
| `opensrc`                        | Dependency source code fetching                        | Understanding library internals, reading package source                   |
| `syncing-agent-skills`           | Claude Code ↔ Codex skill synchronization strategy     | Creating, migrating, renaming, or auditing shared skills                  |
| `upgrading-runtime-dependencies` | Runtime SDK changelog analysis, impact assessment      | Upgrading SDK-level deps behind an abstraction boundary                   |

### Rules (Path-Triggered)

Rules inject context-specific guidance when Claude works with matching files. Each rule has `paths:` frontmatter with glob patterns.

| Rule                  | Applies To                                                                                                                           | Key Guidance                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `api.md`              | `apps/server/src/routes/**/*.ts`                                                                                                     | Zod validation, service layer usage, error handling   |
| `testing.md`          | `**/__tests__/**/*.ts`, `**/*.test.ts`                                                                                               | Vitest patterns, mocking, component testing           |
| `components.md`       | `apps/client/src/**/*.tsx`                                                                                                           | Shadcn patterns, accessibility, styling               |
| `fsd-layers.md`       | `apps/client/src/layers/**/*.ts(x)`                                                                                                  | FSD layer dependency rules, barrel imports            |
| `server-structure.md` | `apps/server/src/services/**/*.ts`, `routes/**/*.ts`                                                                                 | Service count monitoring, domain grouping thresholds  |
| `code-quality.md`     | `**/*.ts`, `**/*.tsx`                                                                                                                | DRY violations, complexity limits, naming conventions |
| `file-size.md`        | `**/*.ts`, `**/*.tsx`                                                                                                                | File size thresholds, extraction patterns             |
| `agent-storage.md`    | `packages/mesh/src/**/*.ts`, `packages/shared/src/manifest.ts`, `apps/server/src/routes/agents.ts`, `apps/server/src/routes/mesh.ts` | File-first write-through, ADR-0043                    |
| `dork-home.md`        | `apps/server/src/**/*.ts`, `packages/*/src/**/*.ts`                                                                                  | dorkHome parameter convention, no os.homedir()        |
| `documentation.md`    | `**/*.ts`, `**/*.tsx`                                                                                                                | TSDoc standards, barrel export docs                   |

### Hooks (Event-Triggered)

Hooks run automatically at lifecycle events. Configured in `settings.json` with scripts in `.claude/hooks/`.

**Important:** All hook commands use `cd "$(git rev-parse --show-toplevel)" &&` prefix to ensure they run from the repo root, even when subagents change the working directory.

Git hooks (post-commit, etc.) are separate and live in `.claude/git-hooks/`. Install via `.claude/scripts/install-git-hooks.sh`.

| Event              | Hooks                                                                                                                                       | Purpose                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `PreToolUse`       | file-guard                                                                                                                                  | Block access to sensitive files (.env, .key, .pem)                                                 |
| `PostToolUse`      | format-changed, typecheck-changed, lint-changed, check-any-changed, test-changed, auto-extract-adrs, spec-status-sync, adr-acceptance-check | Format, validate, and test code after edits; ADR extraction/acceptance; sync spec status           |
| `UserPromptSubmit` | thinking-level                                                                                                                              | Adjust Claude's thinking mode based on prompt complexity                                           |
| `Stop`             | create-checkpoint, check-docs-changed, autonomous-check                                                                                     | Session cleanup, checkpoint creation, doc reminders, prevent premature stop during autonomous work |
| `SessionStart`     | check-adr-curation, check-adr-review                                                                                                        | Remind about draft/proposed ADRs needing curation or review                                        |

### MCP Servers

External tools available via Model Context Protocol. Only `shadcn` is a project server declared in `.mcp.json`; `playwright` and `context7` are provided by enabled plugins.

| Server       | Source      | Purpose                                                           |
| ------------ | ----------- | ----------------------------------------------------------------- |
| `shadcn`     | `.mcp.json` | Shadcn UI component registry, examples, and installation commands |
| `playwright` | plugin      | Browser automation and visual debugging                           |
| `context7`   | plugin      | Library documentation lookup                                      |

### Guides

All documentation lives in `contributing/`:

| Guide                                  | Content                                                                |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `project-structure.md`                 | FSD layer hierarchy, directory layout, adding features                 |
| `architecture.md`                      | Hexagonal architecture, Transport interface, Electron compatibility    |
| `design-system.md`                     | Color palette, typography, spacing, motion specs                       |
| `api-reference.md`                     | OpenAPI spec, Scalar docs UI, Zod schema patterns                      |
| `configuration.md`                     | Config file system, settings reference, CLI commands, precedence       |
| `development-workflow.md`              | Dogfood dev workflow (`pnpm dev:dogfood`), preview + built-CLI cockpit |
| `interactive-tools.md`                 | Tool approval, AskUserQuestion, TaskList flows                         |
| `keyboard-shortcuts.md`                | Keyboard shortcuts and hotkeys                                         |
| `obsidian-plugin-development.md`       | Plugin lifecycle, Vite build, Electron quirks                          |
| `data-fetching.md`                     | TanStack Query patterns, Transport abstraction, SSE streaming          |
| `state-management.md`                  | Zustand vs TanStack Query decision guide                               |
| `animations.md`                        | Motion library patterns                                                |
| `styling-theming.md`                   | Tailwind v4, dark mode, Shadcn                                         |
| `parallel-execution.md`                | Parallel agent execution patterns, batching                            |
| `browser-testing.md`                   | Browser test patterns, Playwright MCP, test architecture               |
| `relay-adapters.md`                    | Relay adapter system, adapter lifecycle, plugin contracts              |
| `environment-variables.md`             | Env var reference, Turbo passthrough, dotenv patterns                  |
| `adapter-catalog.md`                   | Adapter catalog management, setup wizard, config fields                |
| `extension-authoring.md`               | Extension authoring guide                                              |
| `marketplace-installs.md`              | Marketplace install pipeline, transactions, testing                    |
| `marketplace-packages.md`              | Marketplace package development and structure                          |
| `marketplace-registry.md`              | Registry repo layout, marketplace.json schema, submission flow         |
| `marketplace-telemetry.md`             | Install telemetry: Neon + Drizzle, schema, privacy contract            |
| `external-agent-marketplace-access.md` | Connect external AI agents to the DorkOS marketplace MCP               |

Skills often reference these guides for detailed patterns while keeping SKILL.md files concise.

**Keeping guides up to date:**

- `/docs:status` — Health dashboard showing guide freshness, TODO stubs, overall score
- `/docs:reconcile` — Check for documentation drift against recent commits (covers both contributing/ guides and docs/ MDX)
- `/spec:execute` — Suggests doc review when implementation touches guide areas
- `check-docs-changed` hook — Session-end reminder for affected guides and external docs; blocks if INDEX.md is missing

## Architecture

### Invocation Models

```
┌─────────────────────────────────────────────────────────────────┐
│                    INVOCATION TYPES                             │
├─────────────────────────────────────────────────────────────────┤
│  USER-INVOKED     │  TOOL-INVOKED    │  AUTO-INVOKED           │
│  (Commands)       │  (Agents)        │  (Skills, Rules, Hooks) │
│                   │                  │                         │
│  /spec:create     │  Task(typescript- │  Skills: when relevant  │
│  /git:commit      │    expert)       │  Rules: when editing    │
│  /ideate          │  Task(research-  │    matching files       │
│                   │    expert)       │  Hooks: at lifecycle    │
│                   │                  │    events               │
└─────────────────────────────────────────────────────────────────┘
```

### Component Selection Guide

```
User explicitly invokes? ────────────────► COMMAND
        │
        ▼
Needs isolated context or specific tools? ► AGENT
        │
        ▼
Teaches reusable expertise? ─────────────► SKILL
        │
        ▼
Applies only to specific file types? ────► RULE
        │
        ▼
Must happen at lifecycle events? ────────► HOOK
        │
        ▼
Project-wide documentation? ─────────────► AGENTS.md
```

### Naming Conventions

| Component | Pattern              | Examples                                     |
| --------- | -------------------- | -------------------------------------------- |
| Commands  | `verb` or `noun`     | create, commit, execute                      |
| Agents    | `domain-expert`      | typescript-expert, react-tanstack-expert     |
| Skills    | `verb-ing-noun`      | debugging-systematically, designing-frontend |
| Rules     | `topic` (kebab-case) | api, testing, components                     |
| Hooks     | `action-target`      | file-guard, lint-changed                     |

## Directory Structure

```
.agents/
└── skills/                # Canonical shared skills for Codex + Claude
    ├── browser-testing/
    ├── capturing-linear-ideas/
    ├── closing-linear-loop/
    ├── debugging-systematically/
    ├── debugging-test-failures/
    ├── debugging-typescript-errors/
    ├── designing-frontend/
    ├── ideating-features/
    ├── implementing-specifications/
    ├── opensrc/
    ├── organizing-fsd-architecture/
    ├── running-product-loop/
    ├── syncing-agent-skills/
    ├── verification-before-completion/
    ├── visual-companion/
    ├── writing-adrs/
    ├── writing-changelogs/
    └── writing-developer-guides/

.claude/
├── README.md              # This file — harness documentation
├── settings.json          # Hooks, permissions, environment
├── settings.local.json    # Local overrides, MCP servers
│
├── commands/              # Slash commands (56 total)
│   ├── adr/               # Architecture Decision Records
│   ├── app/               # Application maintenance
│   ├── spec/              # Specification workflow
│   ├── git/               # Version control
│   ├── debug/             # Debugging commands
│   ├── docs/              # Documentation maintenance
│   ├── system/            # Harness maintenance
│   ├── changelog/         # Changelog management
│   ├── research/          # Research library management
│   ├── cc/                # Claude Code configuration
│   │   ├── notify/        # Notification sounds
│   │   └── ide/           # IDE color schemes
│   ├── template/          # Upstream template management
│   ├── worktree/          # Git worktree management
│   ├── chat/              # Chat UI testing
│   ├── browsertest.md     # Browser test execution
│   ├── browsertest:maintain.md  # Browser test health audit
│   ├── ideate.md          # Feature ideation
│   ├── ideate-to-spec.md  # Ideation → specification
│   └── review-recent-work.md
│
├── agents/                # Specialized agents (7 total)
│   ├── react/
│   │   └── react-tanstack-expert.md
│   ├── typescript/
│   │   └── typescript-expert.md
│   ├── code-search.md
│   ├── code-reviewer.md
│   ├── context-isolator.md
│   ├── product-manager.md
│   └── research-expert.md
│
├── skills/                # Claude-visible skills (33 total; some are symlinks)
│   ├── adding-config-fields/
│   ├── browser-testing/
│   ├── capturing-linear-ideas/
│   ├── clarifying-requirements/
│   ├── closing-linear-loop/
│   ├── debugging-systematically/
│   ├── debugging-test-failures/
│   ├── debugging-typescript-errors/
│   ├── designing-frontend/
│   ├── executing-specs/
│   ├── ideating-features/
│   ├── implementing-specifications/
│   ├── linear-loop/
│   ├── maintaining-dev-playground/
│   ├── managing-specs/
│   ├── marketplace-dev/
│   ├── opensrc/
│   ├── orchestrating-parallel-work/
│   ├── organizing-fsd-architecture/
│   ├── reading-session-transcripts/
│   ├── receiving-code-review/
│   ├── requesting-code-review/
│   ├── running-product-loop/
│   ├── syncing-agent-skills/
│   ├── styling-with-tailwind-shadcn/
│   ├── test-driven-development/
│   ├── upgrading-runtime-dependencies/
│   ├── verification-before-completion/
│   ├── visual-companion/
│   ├── working-in-worktrees/
│   ├── writing-adrs/
│   ├── writing-changelogs/
│   └── writing-developer-guides/
│
├── config/                # Static configuration
│   └── runtime-deps.json  # Package → codebase mapping for /app:runtime-upgrade
│
└── rules/                 # Path-specific guidance (10 total)
    ├── agent-storage.md   # File-first write-through (ADR-0043)
    ├── api.md             # API route handlers
    ├── code-quality.md    # DRY, complexity, naming
    ├── components.md      # UI components
    ├── documentation.md   # TSDoc standards
    ├── dork-home.md       # dorkHome parameter convention
    ├── file-size.md       # File size limits
    ├── fsd-layers.md      # FSD layer imports
    ├── server-structure.md # Server size monitoring
    └── testing.md         # Test patterns
```

## Core Workflows

### Feature Development

```
1. /ideate <task>              # Structured ideation
2. /ideate-to-spec <path>      # Transform to specification
3. /spec:decompose <path>      # Break into tasks
4. /spec:execute <path>        # Implement with agents
5. /spec:feedback <path>       # Process feedback
6. /git:commit                 # Commit with validation
7. /git:push                   # Push with full checks
```

### Debugging

```
/debug:browser [issue]         # Visual/interaction issues
/debug:types [file-or-error]   # TypeScript errors
/debug:test [test-path]        # Failing tests
/debug:api [endpoint]          # Data flow issues
/debug:data [table]            # Database inspection
/debug:logs [search-term]      # Server log analysis
/debug:rubber-duck [problem]   # Structured problem articulation
/debug:performance [area]      # Performance issues
```

### Harness Maintenance

```
/system:ask [question]         # How to do something
/system:update [description]   # Add/modify processes
/system:review [area]          # Audit for consistency
/system:learn [topic]          # Learn through experimentation, then codify
```

## Parallel Execution

Several commands use parallel background agents for efficiency. This pattern provides 3-6x speedup and 80-90% context savings.

### Commands with Parallel Execution

| Command           | Pattern                   | Agents                                                                      |
| ----------------- | ------------------------- | --------------------------------------------------------------------------- |
| `/ideate`         | Parallel research         | `Explore` + `research-expert` run simultaneously                            |
| `/spec:execute`   | Dependency-aware batching | Tasks grouped by dependencies, each batch runs in parallel                  |
| `/spec:decompose` | Analysis + disk output    | Background agent writes `03-tasks.json` to disk; main context creates tasks |
| `/debug:api`      | Parallel diagnostics      | Component, route, service agents investigate simultaneously                 |
| `/debug:browser`  | Parallel diagnostics      | Visual, console, network, accessibility checks in parallel                  |

### How It Works

1. **Background agents** run via `Task(..., run_in_background: true)`
2. **Task IDs** are stored to collect results later
3. **TaskOutput** waits for completion: `TaskOutput(task_id, block: true)`
4. **Results synthesized** in main context

### When Parallel Helps

- Multiple independent analysis tasks (research, diagnostics)
- Heavy computation that doesn't need user interaction
- Batch operations with dependency graphs
- Multiple expert perspectives on the same problem

### Monitoring

Use `/tasks` to see running background agents and their status.

### Reference

See `contributing/parallel-execution.md` for complete patterns and decision framework.

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
3. Document in this README under Commands section
4. Update AGENTS.md if significant

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
3. Document in this README under Agents section
4. Update AGENTS.md under "Agents" table

### Adding a New Skill

1. Decide whether the skill is shared or Claude-only
2. Use gerund naming: `verb-ing-noun`
3. For a shared skill, create `.agents/skills/[skill-name]/SKILL.md` and add a per-skill symlink at `.claude/skills/[skill-name]`
4. For a Claude-only skill, create `.claude/skills/[skill-name]/SKILL.md`
5. Include YAML frontmatter:
   ```yaml
   ---
   name: verb-ing-noun
   description: What it does. Use when [trigger conditions].
   ---
   ```
6. Keep SKILL.md under 500 lines (use reference files for details)
7. Document in this README under Skills section
8. Update AGENTS.md under "Skills" table when the skill changes repo-level guidance or should be called out explicitly

### Adding a New Rule

1. Create `.claude/rules/[topic].md`
2. Include paths frontmatter:
   ```yaml
   ---
   paths: src/path/**/*.ts, other/path/**/*.tsx
   ---
   ```
3. Document in this README under Rules section
4. Update AGENTS.md "Path-Specific Rules" section

### Adding a New Claude Hook

1. Create the script in `.claude/hooks/[name].{sh,mjs}`
2. Add to `.claude/settings.json` under the appropriate lifecycle event
3. **CWD-safety (required):** Prefix the command with `cd "$(git rev-parse --show-toplevel)" &&`
   ```json
   {
     "type": "command",
     "command": "cd \"$(git rev-parse --show-toplevel)\" && node .claude/hooks/my-hook.mjs"
   }
   ```
   This prevents `MODULE_NOT_FOUND` errors when subagents change the working directory.
4. Make shell scripts executable: `chmod +x .claude/hooks/my-hook.sh`
5. Document in this README under the Hooks table
6. If the hook has user-configurable options, add them to `.claude/hooks-config.json`

### Adding a New Git Hook

1. Create the script in `.claude/git-hooks/[name].py` (or `.sh`)
2. Register it in `.claude/scripts/install-git-hooks.sh` by adding to `HOOK_DEFS`
3. Run `.claude/scripts/install-git-hooks.sh` to install

**Principle — auto-git hooks must be idempotent and replay-safe.** Any hook that silently runs `git add`, `git commit --amend`, or `git stash` will eventually fire during a concurrent commit (another agent in a shared checkout) or a replay (cherry-pick/rebase). Guard against both: skip when a git operation is in flight (`index.lock`, MERGE/REBASE/CHERRY_PICK state — see `create-checkpoint.sh`), and make the effect idempotent so re-running on already-applied content is a no-op (see `changelog-populator.py`'s dedup + `.changelog-populator.lock` re-entry guard). Two hooks shipped without this and corrupted commits in multi-agent/cherry-pick flows.

### Script Directory Conventions

```
.claude/
├── hooks/           # Claude Code lifecycle hooks (settings.json)
│                    # PreToolUse, PostToolUse, Stop, UserPromptSubmit, etc.
├── git-hooks/       # Git hooks (post-commit, pre-push, etc.)
│                    # Installed as symlinks into .git/hooks/
└── scripts/         # Standalone utility scripts (not hooks)
                     # Install helpers, backfill scripts, etc.
```

**Key distinction:** `.claude/hooks/` = Claude Code automation. `.claude/git-hooks/` = Git automation. `.claude/scripts/` = Manual utilities.

### Review Cycle

Run `/system:review` periodically to:

- Validate cross-references between components
- Check for outdated documentation
- Identify missing or conflicting patterns
- Audit skills for extraction candidates
- Verify hook configurations

## Integration Points

### With AGENTS.md

AGENTS.md is the **primary source of truth** for project context. This README documents the harness structure; AGENTS.md documents:

- Technology stack and versions
- Architecture patterns (hexagonal, Transport interface)
- Code conventions
- Monorepo structure and commands

**Update AGENTS.md when**:

- Adding significant new commands or agents
- Changing core workflows
- Modifying architectural patterns

### With Developer Guides

Developer guides in `contributing/` provide detailed patterns. Skills often reference these guides for comprehensive documentation while keeping SKILL.md concise.

## Troubleshooting

### Commands Not Loading

```bash
# Check command files exist
ls -la .claude/commands/

# Restart Claude Code
# Commands load on session start
```

### Hooks Not Running

```bash
# Verify settings.json syntax
cat .claude/settings.json | python3 -m json.tool

# Test hooks manually
echo '{}' | .claude/hooks/thinking-level.sh

# Check shell scripts are executable
ls -la .claude/hooks/
```

### Rules Not Triggering

- Verify `paths:` frontmatter uses correct glob syntax
- Test patterns: `find . -path "[pattern]" -type f`
- Rules only trigger when editing matching files

### Agent Failures

- Agents run in isolated context (no access to main conversation)
- Check `tools:` in frontmatter includes needed tools
- Review agent instructions for missing context

## References

- [Anthropic - Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Claude Code Documentation](https://code.claude.com/docs/)
- [Writing a Good AGENTS.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)

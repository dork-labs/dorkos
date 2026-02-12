# Claude Code Harness

This directory contains the **Claude Code Harness** — the complete customization framework that enables Claude Code to work effectively on this project. The harness provides context, commands, expertise, and automation that bridges coding sessions and maintains consistency across multiple conversations.

## What is a Harness?

A **harness** is the underlying infrastructure that runs an AI coding agent. It includes:

- **System Context** — Project instructions (CLAUDE.md) that teach Claude about this codebase
- **Commands** — Slash commands for common workflows (`/git:commit`, `/spec:create`, etc.)
- **Agents** — Specialized experts for complex tasks (`prisma-expert`, `typescript-expert`)
- **Skills** — Reusable expertise applied automatically (`debugging-systematically`, `designing-frontend`)
- **Rules** — Path-specific guidance triggered when editing certain files
- **Hooks** — Automated validation at lifecycle events (typecheck, lint, test)

**Key insight**: CLAUDE.md is "the highest leverage point of the harness" — it deserves careful, intentional curation.

## Harness Inventory

| Component | Count | Location |
|-----------|-------|----------|
| Commands | 49 | `.claude/commands/` |
| Agents | 7 | `.claude/agents/` |
| Skills | 13 | `.claude/skills/` |
| Rules | 5 | `.claude/rules/` |
| Hooks | 8 | `.claude/settings.json` |
| MCP Servers | 5 | `.mcp.json` |
| Developer Guides | 14 + INDEX | `developer-guides/` |

## Component Types

### Commands (User-Invoked)

Slash commands are triggered explicitly by typing `/command`. They're expanded prompts that provide step-by-step instructions.

| Namespace | Commands | Purpose |
|-----------|----------|---------|
| `spec/` | create, decompose, execute, feedback, doc-update, migrate | Specification workflow (uses built-in task tools with `[slug] [P#]` subject convention) |
| `git/` | commit, push | Version control with validation |
| `debug/` | browser, types, test, api, data, logs, rubber-duck, performance | Systematic debugging |
| `docs/` | reconcile | Documentation drift detection |
| `roadmap/` | show, add, open, validate, analyze, prioritize, enrich, clear | Product roadmap management |
| `system/` | ask, update, review, learn | Harness maintenance |
| `app/` | upgrade, cleanup | Application dependency and code management |
| `db/` | migrate, studio | Database operations |
| `dev/` | scaffold | Feature scaffolding |
| `cc/notify/` | on, off, status | Notification sounds |
| `cc/ide/` | set, reset | VS Code color schemes |
| `template/` | check, update | Upstream template updates |
| root | ideate, ideate-to-spec, review-recent-work | Feature development |

### Agents (Tool-Invoked)

Agents run in isolated context windows via the Task tool. Use for complex, multi-step tasks that benefit from separate context or specialized tool access.

**Built-in agents** (provided by Claude Code):

| Agent | Specialty | When to Use |
|-------|-----------|-------------|
| `Explore` | Codebase exploration, understanding how things work | Open-ended questions, architecture understanding, comprehensive answers |
| `claude-code-guide` | Claude Code documentation | Questions about Claude Code features, hooks, skills, MCP |

**Project agents** (defined in `.claude/agents/`):

| Agent | Specialty | When to Use |
|-------|-----------|-------------|
| `prisma-expert` | Database design, migrations, queries, Neon PostgreSQL | Schema changes, DAL patterns, query optimization |
| `react-tanstack-expert` | React, TanStack Query, server/client components | Data fetching, state management, component architecture |
| `typescript-expert` | Type system, generics, build errors | Complex types, build failures, type patterns |
| `zod-forms-expert` | Zod schemas, React Hook Form, Shadcn Form | Form validation, schema design, form components |
| `product-manager` | Roadmap, prioritization, scope management | Strategic decisions, feature prioritization |
| `research-expert` | Web research, information gathering | External research (non-Claude Code topics) |
| `code-search` | Finding files, patterns, functions | Locating code by pattern or content |

**Explore vs code-search:**
- `Explore` — Returns comprehensive answers with explanations ("How does auth work?")
- `code-search` — Returns focused file lists only ("Find files using Prisma")

**Agent vs Skill**: Agents EXECUTE tasks in isolated context. Skills TEACH expertise in main conversation.

### Skills (Model-Invoked)

Skills provide reusable expertise that Claude applies automatically when relevant. They teach "how to think" about problems.

| Skill | Expertise | When Applied |
|-------|-----------|--------------|
| `proactive-clarification` | Identifying gaps, asking clarifying questions | Vague requests, ambiguous scope, hidden complexity |
| `debugging-systematically` | Debugging methodology, troubleshooting patterns | Investigating bugs, tracing issues |
| `designing-frontend` | Calm Tech design language, UI decisions | Planning UI, reviewing designs, hierarchy decisions |
| `styling-with-tailwind-shadcn` | Tailwind CSS v4, Shadcn UI implementation | Writing styles, building components, theming |
| `organizing-fsd-architecture` | Feature-Sliced Design, layer organization | Structuring features, file placement, imports |
| `working-with-prisma` | Prisma 7 patterns, DAL conventions | Schema design, database queries, migrations |
| `generating-images-replicate` | Replicate MCP for image generation, processing | Image generation, background removal, upscaling |
| `vectorizing-images` | Raster-to-vector conversion with @neplex/vectorizer | Converting PNG/JPG to SVG, logo production |
| `managing-roadmap-moscow` | MoSCoW prioritization, roadmap utilities | Product planning, prioritization decisions |
| `writing-developer-guides` | Developer guide structure for AI agents | Creating/updating files in developer-guides/ |
| `orchestrating-parallel-work` | Parallel agent execution, batch scheduling | Coordinating multiple concurrent tasks, optimizing task ordering |
| `changelog-writing` | Human-friendly changelog entries, release notes | Populating changelog, preparing releases |
| `posthog-nextjs-app-router` | PostHog analytics integration | Adding analytics to Next.js App Router |

### Rules (Path-Triggered)

Rules inject context-specific guidance when Claude works with matching files. Each rule has `paths:` frontmatter with glob patterns.

| Rule | Applies To | Key Guidance |
|------|------------|--------------|
| `api.md` | `apps/server/src/routes/**/*.ts` | Zod validation, DAL usage, error handling |
| `dal.md` | `apps/server/src/services/**/*.ts`, `packages/shared/src/**/*.ts` | Auth checks, query/mutation patterns |
| `security.md` | `**/auth/**`, `**/password/**`, `**/token/**` | No sensitive logging, hashing, session validation |
| `testing.md` | `**/__tests__/**/*.ts`, `**/*.test.ts` | Vitest patterns, mocking, component testing |
| `components.md` | `apps/client/src/components/**/*.tsx`, `apps/client/src/**/*.tsx` | Shadcn patterns, accessibility, styling |

### Hooks (Event-Triggered)

Hooks run automatically at lifecycle events. Configured in `settings.json` with local scripts in `.claude/scripts/hooks/`.

| Event | Hooks | Purpose |
|-------|-------|---------|
| `PreToolUse` | file-guard | Block access to sensitive files (.env, .key, .pem) |
| `PostToolUse` | typecheck-changed, lint-changed, check-any-changed, test-changed | Validate code after edits |
| `UserPromptSubmit` | thinking-level | Adjust Claude's thinking mode based on prompt complexity |
| `Stop` | create-checkpoint, check-docs-changed | Session cleanup, checkpoint creation, doc reminders |

### MCP Servers

External tools available via Model Context Protocol.

| Server | Purpose |
|--------|---------|
| `playwright` | Browser automation and visual debugging |
| `context7` | Library documentation lookup |
| `shadcn` | Component registry and examples |
| `mcp-dev-db` | Direct database inspection (dev only) |
| `replicate` | AI image generation, background removal, upscaling |

### Developer Guides

Detailed implementation patterns in `developer-guides/`:

| Guide | Content |
|-------|---------|
| `INDEX.md` | **Coverage map** — maps code areas to guides, maintenance tracking |
| `01-project-structure.md` | FSD architecture, file naming, directory layout |
| `02-environment-variables.md` | T3 Env configuration, adding new variables |
| `03-database-prisma.md` | Prisma 7, DAL patterns, naming conventions |
| `04-forms-validation.md` | React Hook Form + Zod + Shadcn Form |
| `05-data-fetching.md` | TanStack Query patterns, mutations |
| `06-state-management.md` | Zustand vs TanStack Query decision guide |
| `07-animations.md` | Motion library patterns |
| `08-styling-theming.md` | Tailwind v4, dark mode, Shadcn |
| `09-authentication.md` | BetterAuth, sessions, OTP patterns |
| `10-metadata-seo.md` | Metadata API, favicons, Open Graph, SEO, AEO |
| `11-parallel-execution.md` | Parallel agent execution patterns, batching, context savings |
| `12-site-configuration.md` | Site configuration, feature toggles, env overrides |
| `13-autonomous-roadmap-execution.md` | **⭐ Novel Feature** — Autonomous workflow, `/roadmap:work` |
| `14-template-updates.md` | Template update system, `/template:check`, `/template:update` |

Skills often reference these guides for detailed patterns while keeping SKILL.md files concise.

**Keeping guides up to date:**
- `/docs:reconcile` — Check for documentation drift against recent commits
- `/spec:execute` — Suggests doc review when implementation touches guide areas
- `check-docs-changed` hook — Session-end reminder for affected guides

## Architecture

### Invocation Models

```
┌─────────────────────────────────────────────────────────────────┐
│                    INVOCATION TYPES                             │
├─────────────────────────────────────────────────────────────────┤
│  USER-INVOKED     │  TOOL-INVOKED    │  AUTO-INVOKED           │
│  (Commands)       │  (Agents)        │  (Skills, Rules, Hooks) │
│                   │                  │                         │
│  /spec:create     │  Task(prisma-    │  Skills: when relevant  │
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
Project-wide documentation? ─────────────► CLAUDE.md
```

### Naming Conventions

| Component | Pattern | Examples |
|-----------|---------|----------|
| Commands | `verb` or `noun` | create, commit, scaffold |
| Agents | `domain-expert` | prisma-expert, typescript-expert |
| Skills | `verb-ing-noun` | debugging-systematically, designing-frontend |
| Rules | `topic` (kebab-case) | api, dal, security |
| Hooks | `action-target` | file-guard, lint-changed |

## Directory Structure

```
.claude/
├── README.md              # This file — harness documentation
├── settings.json          # Hooks, permissions, environment
├── settings.local.json    # Local overrides, MCP servers
│
├── commands/              # Slash commands (49 total)
│   ├── app/               # Application maintenance
│   ├── spec/              # Specification workflow
│   ├── git/               # Version control
│   ├── debug/             # Debugging commands
│   ├── roadmap/           # Product roadmap
│   ├── system/            # Harness maintenance
│   ├── db/                # Database operations
│   ├── dev/               # Development scaffolding
│   ├── cc/                # Claude Code configuration
│   │   ├── notify/        # Notification sounds
│   │   └── ide/           # IDE color schemes
│   ├── template/          # Upstream template management
│   │   ├── check.md       # Check for updates
│   │   └── update.md      # Apply updates
│   ├── ideate.md          # Feature ideation
│   ├── ideate-to-spec.md  # Ideation → specification
│   └── review-recent-work.md
│
├── agents/                # Specialized agents (7 total)
│   ├── database/
│   │   └── prisma-expert.md
│   ├── react/
│   │   └── react-tanstack-expert.md
│   ├── typescript/
│   │   └── typescript-expert.md
│   ├── forms/
│   │   └── zod-forms-expert.md
│   ├── code-search.md
│   ├── product-manager.md
│   └── research-expert.md
│
├── skills/                # Reusable expertise (13 total)
│   ├── proactive-clarification/
│   ├── debugging-systematically/
│   ├── designing-frontend/
│   ├── styling-with-tailwind-shadcn/
│   ├── organizing-fsd-architecture/
│   ├── working-with-prisma/
│   ├── generating-images-replicate/
│   ├── vectorizing-images/
│   ├── managing-roadmap-moscow/
│   ├── writing-developer-guides/
│   └── orchestrating-parallel-work/
│
└── rules/                 # Path-specific guidance (5 total)
    ├── api.md             # API route handlers
    ├── dal.md             # Data Access Layer
    ├── security.md        # Security-critical code
    ├── testing.md         # Test patterns
    └── components.md      # UI components
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

### Roadmap Management

```
/roadmap:show                  # Display summary
/roadmap:open                  # Open visualization
/roadmap:add <title>           # Add new item
/roadmap:prioritize            # Get suggestions
/roadmap:analyze               # Full health check
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

| Command | Pattern | Agents |
|---------|---------|--------|
| `/ideate` | Parallel research | `Explore` + `research-expert` run simultaneously |
| `/spec:execute` | Dependency-aware batching | Tasks grouped by dependencies, each batch runs in parallel |
| `/spec:decompose` | Analysis isolation | Heavy decomposition runs in background agent |
| `/debug:api` | Parallel diagnostics | Component, action, DAL agents investigate simultaneously |
| `/debug:browser` | Parallel diagnostics | Visual, console, network, accessibility checks in parallel |

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

See `developer-guides/11-parallel-execution.md` for complete patterns and decision framework.

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
4. Update CLAUDE.md if significant

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
4. Update CLAUDE.md under "Agents" table

### Adding a New Skill

1. Create `.claude/skills/[skill-name]/SKILL.md`
2. Use gerund naming: `verb-ing-noun`
3. Include YAML frontmatter:
   ```yaml
   ---
   name: verb-ing-noun
   description: What it does. Use when [trigger conditions].
   ---
   ```
4. Keep SKILL.md under 500 lines (use reference files for details)
5. Document in this README under Skills section
6. Update CLAUDE.md under "Skills" table

### Adding a New Rule

1. Create `.claude/rules/[topic].md`
2. Include paths frontmatter:
   ```yaml
   ---
   paths: src/path/**/*.ts, other/path/**/*.tsx
   ---
   ```
3. Document in this README under Rules section
4. Update CLAUDE.md "Path-Specific Rules" section

### Review Cycle

Run `/system:review` periodically to:
- Validate cross-references between components
- Check for outdated documentation
- Identify missing or conflicting patterns
- Audit skills for extraction candidates
- Verify hook configurations

## Integration Points

### With CLAUDE.md

CLAUDE.md is the **primary source of truth** for project context. This README documents the harness structure; CLAUDE.md documents:
- Technology stack and versions
- Architecture patterns (FSD layers, DAL rules)
- Code conventions
- Command and agent reference tables
- Calculation rules

**Update CLAUDE.md when**:
- Adding significant new commands or agents
- Changing core workflows
- Modifying architectural patterns

### With UI Documentation Pages

The template includes interactive documentation at `/system/` that displays harness information to users. These pages must stay synchronized with the actual harness.

| Page | Path | Content |
|------|------|---------|
| System Overview | `/system` | Links to design system and Claude Code docs |
| Claude Code Harness | `/system/claude-code` | Stats, commands, agents, skills, workflows |

**Synchronization**: `/system:update` automatically updates these pages when harness components change. `/system:review` validates that UI pages match the actual harness state.

**Arrays to update in the Claude Code harness UI page**:
- `harnessStats` — Component counts
- `commandNamespaces` — Command namespace listings
- `agents` — Agent definitions
- `skills` — Skill definitions

**Update UI pages when**:
- Adding/removing commands, agents, skills, or rules
- Changing hook or MCP server counts
- Modifying core workflows displayed in the UI

### With Developer Guides

Developer guides in `developer-guides/` provide detailed patterns. Skills often reference these guides for comprehensive documentation while keeping SKILL.md concise.

### With Roadmap

The roadmap system (`/roadmap/*`) integrates with the spec workflow:
- Roadmap items link to specifications
- `/ideate --roadmap-id` connects ideation to roadmap
- Status updates flow bidirectionally

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
echo '{}' | .claude/scripts/hooks/thinking-level.sh

# Check shell scripts are executable
ls -la .claude/scripts/hooks/
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
- [Writing a Good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)

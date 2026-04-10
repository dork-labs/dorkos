---
title: 'OpenClaw and AI Coding Tool Convention Markdown Files'
date: 2026-03-21
type: external-best-practices
status: active
tags: [openclaw, AGENTS.md, AGENTS.md, convention-files, ai-coding-tools, cursor, copilot, codex]
searches_performed: 13
sources_count: 28
---

## Research Summary

"Open Claw" (officially styled **OpenClaw**) is a viral, open-source personal AI agent that went public in late 2025 and is unrelated to AI code editors like Cursor or Windsurf — it is a general-purpose autonomous agent framework that runs locally and connects LLMs to your files, messaging apps, and system tools. It uses a rich set of workspace markdown convention files (SOUL.md, AGENTS.md, TOOLS.md, MEMORY.md, etc.) injected into every agent session. **NOPE.md** is a separate, standalone open-standard security framework (`nope-md.vercel.app`) for defining hard safety boundaries on AI agents — it is complementary to AGENTS.md, not part of OpenClaw's official workspace file set. The broader AI coding tool ecosystem has converged on `AGENTS.md` as the emerging cross-tool universal standard, alongside tool-specific files like `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`, and `copilot-instructions.md`.

---

## Key Findings

1. **OpenClaw is a personal autonomous AI agent, not a code editor**: It is the open-source successor to "Clawdbot" / "MoltBot," created by Austrian developer Peter Steinberger in November 2025 and now stewarded by an open-source foundation after Steinberger joined OpenAI in February 2026. It has 310,000+ GitHub stars. It runs on your machine and connects LLMs to WhatsApp, Telegram, Slack, Discord, email, calendars, and the local filesystem — functioning as a personal operating-system-level agent.

2. **OpenClaw's workspace is entirely markdown-file-driven**: Every session injects a directory of `.md` files into the agent's system prompt. This is the core personality/configuration mechanism. The minimal viable workspace is: `AGENTS.md` + `SOUL.md` + `TOOLS.md`.

3. **NOPE.md is a standalone open-standard security framework for AI agents**: Available at `nope-md.vercel.app`, it defines what an AI agent _cannot_ do — a strict, non-negotiable boundary layer separate from operational rules. It has its own CLI (`npx nope-md init`) and ships example files like `research-agent.md` and `dev-assistant.md`. It is complementary to (not a replacement for) AGENTS.md.

4. **The AI coding tool convention file landscape has fragmented then partially reconverged**: Every major AI coding tool invented its own convention file (AGENTS.md, .cursorrules, copilot-instructions.md, etc.), and AGENTS.md has emerged as a cross-tool universal standard stewarded by the Agentic AI Foundation under the Linux Foundation, used in 60,000+ open-source projects.

5. **OpenClaw uses `AGENTS.md` as its core rules file but has a much richer workspace file set** that goes well beyond what coding-focused tools use — personality (SOUL.md), identity (IDENTITY.md), daily heartbeat checks (HEARTBEAT.md), subagent delegation (SUBAGENT-POLICY.md), and daily session logs (memory/YYYY-MM-DD.md).

---

## Detailed Analysis

### What Is OpenClaw?

OpenClaw (github.com/openclaw/openclaw) is an open-source personal AI agent framework, not a code editor or IDE plugin. It is the evolutionary successor to two earlier projects:

- **Clawdbot** — original name, November 2025, by Peter Steinberger
- **MoltBot** — intermediate name during community growth phase
- **OpenClaw** — current name after open-source foundation transfer, February 2026

It runs on Mac, Windows, and Linux. Its core proposition is: connect any LLM (including local models) to real software — managing files, controlling browsers, sending messages, automating workflows. Users interact with it through their existing messaging apps (Slack, Discord, WhatsApp, iMessage, Telegram, Signal), making it feel less like a "tool" and more like a persistent background agent.

The project has 310,000+ GitHub stars, 58,000+ forks, and 1,200+ contributors as of early 2026, making it one of the fastest-growing open-source AI projects.

The OpenClaw codebase has its own `AGENTS.md` (contributor guidelines) and a `AGENTS.md` symlink at the repo root — a nod to the convention file ecosystem it operates within.

### OpenClaw's Workspace Convention Files

Every OpenClaw agent session loads a workspace directory of markdown files into the system prompt. The full set, in injection order:

#### Core Files (Minimal Viable Workspace: AGENTS.md + SOUL.md + TOOLS.md)

| File           | Purpose                                                                                                                                                                                  | Required? |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `SOUL.md`      | Agent personality, values, tone, behavioral limits. First file injected.                                                                                                                 | Core      |
| `AGENTS.md`    | Operational rules: security, data handling, communication style, task execution. Loaded every request.                                                                                   | Core      |
| `IDENTITY.md`  | 5-line anchor: name, persona, emoji, avatar. Structurally hardens against identity-replacement injection attacks. Loads before everything else in security-hardened setups.              | Core      |
| `USER.md`      | Who you (the owner) are — timezone, email accounts, preferences, context.                                                                                                                | Core      |
| `TOOLS.md`     | Environment-specific notes: IDs, paths, secret locations. Does not control which tools are active (that's `openclaw.json` profiles) — gives the agent context about your specific setup. | Core      |
| `MEMORY.md`    | Long-term durable facts and preferences that persist indefinitely. Private chat content. Confidential.                                                                                   | Core      |
| `HEARTBEAT.md` | Periodic health check checklists. In AI SAFE² governance setups: includes daily C/D ratio review, security scanner calls, sub-agent activity monitoring.                                 | Optional  |

#### Additional Optional Files

| File                        | Purpose                                                                |
| --------------------------- | ---------------------------------------------------------------------- |
| `SUBAGENT-POLICY.md`        | Guidelines for delegating work to sub-agents.                          |
| `BOOTSTRAP.md`              | First-run onboarding instructions. Deleted after use.                  |
| `BOOT.md`                   | Startup hook actions.                                                  |
| `memory/YYYY-MM-DD.md`      | Daily session logs — agent writes what happened and what it learned.   |
| `checklists/<operation>.md` | High-risk operation checklists (e.g., deploy-prod.md, delete-data.md). |
| `skills/<name>/SKILL.md`    | Individual skill files (in the skills subsystem). See below.           |

#### Skills Subsystem

OpenClaw also has a separate **Skills** subsystem. Skills are installed as directories containing:

- `SKILL.md` — YAML frontmatter (name, description, version, environment requirements) + step-by-step instructions
- `scripts/` — executable code
- `references/` — API docs, schemas, domain knowledge
- `assets/` — files used in output

Skills can be workspace-local, globally installed, or bundled. The ClawHub directory (`github.com/openclaw/clawhub`) catalogs 5,400+ community skills.

### About NOPE.md — What It Actually Is

**NOPE.md** (`nope-md.vercel.app`) is a real, standalone open-standard security framework for AI agents — distinct from OpenClaw's workspace file convention. Its purpose:

> Define what an AI agent **cannot** do — a strict, non-negotiable safety boundary layer.

Key characteristics:

- **Core purpose**: Prevents unauthorized or dangerous actions if an agent is compromised or misbehaves. Think of it as a security perimeter, not an operational rulebook.
- **Tooling**: Interactive CLI setup via `npx nope-md init` walks developers through security decisions.
- **Presets**: Ships example files for common agent types:
  - `research-agent.md` — limits browsing scope and data access
  - `dev-assistant.md` — defines allowed vs. disallowed code modification actions
  - Monitoring presets
- **Relationship to AGENTS.md**: Complementary. `AGENTS.md` defines what an agent _should_ do. `NOPE.md` defines what it _must never_ do, with harder enforcement semantics.
- **Relationship to OpenClaw**: Not an official OpenClaw workspace file, but compatible — can be added as an additional workspace file or referenced from AGENTS.md.

The distinction is meaningful: `AGENTS.md` is instructional; `NOPE.md` is a safety constraint layer. This mirrors the separation between capability configuration and security policy in traditional software systems.

### The Broader AI Coding Convention File Landscape

Every major AI coding tool has converged on the idea of a markdown file in the project root that the AI reads before acting. The landscape as of March 2026:

#### Tool-Specific Files

| File                                     | Tool                          | Notes                                                                                                                                                          |
| ---------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                              | Claude Code                   | Project-level instructions, read at session start. Can also be at `~/.claude/AGENTS.md` for global user instructions. Supports nested files in subdirectories. |
| `GEMINI.md`                              | Gemini CLI                    | Same concept, Google's flavor.                                                                                                                                 |
| `.cursorrules`                           | Cursor                        | Legacy format, still widely used.                                                                                                                              |
| `.cursor/rules/*.mdc`                    | Cursor (current)              | Directory-based scoped rules with glob-pattern frontmatter. `frontend.mdc`, `backend.mdc`, etc. activated contextually.                                        |
| `copilot-instructions.md`                | GitHub Copilot                | Single file at `.github/copilot-instructions.md`.                                                                                                              |
| `.github/instructions/*.instructions.md` | GitHub Copilot (current)      | Scoped instruction files with glob-pattern frontmatter, since July 2025.                                                                                       |
| `.windsurfrules`                         | Windsurf                      | Legacy format.                                                                                                                                                 |
| `.windsurf/rules/*.md`                   | Windsurf (current)            | Directory-based like Cursor's current format.                                                                                                                  |
| `AGENTS.md`                              | OpenAI Codex CLI, many others | See below — now a cross-tool standard.                                                                                                                         |

#### AGENTS.md as Universal Standard

AGENTS.md emerged in mid-2025 from a collaboration between Sourcegraph, OpenAI, Google, Cursor, and others. It is now maintained by the **Agentic AI Foundation under the Linux Foundation**. As of 2026:

- Used natively by: Codex CLI, GitHub Copilot, Cursor, Windsurf, Amp, Devin, Continue.dev, Aider, OpenHands
- Used by 60,000+ open-source projects
- OpenClaw uses it as its core rules file (though with a different semantic — OpenClaw's AGENTS.md is operational/behavioral rules, not just coding conventions)

Key structural features of AGENTS.md:

- Can be placed in project root AND in any subdirectory/package (nearest file in directory tree takes precedence)
- Covers six core areas: commands, testing, project structure, code style, git workflow, and boundaries
- Designed to be small, concrete, and example-driven

#### What an ETH Zurich Study Found (2026)

A recent research paper found that AGENTS.md files may sometimes **hinder** AI coding agents when they contain LLM-generated boilerplate. Researchers recommend:

- Omit LLM-generated context files
- Limit human-written instructions to non-inferable details (highly specific tooling, custom build commands)
- The more obvious/generic the instruction, the less value it adds

### Claude Code's Multi-Level AGENTS.md System

For DorkOS's context specifically, Claude Code's convention file system is the most relevant:

- `~/.claude/AGENTS.md` — Global user-level instructions (always loaded)
- `<project>/AGENTS.md` — Project-level instructions (DorkOS's current AGENTS.md)
- `<subdirectory>/AGENTS.md` — Subdirectory-level rules (DorkOS uses `.claude/rules/*.md` for this)
- Nested `.claude/rules/` directory with scoped rule files (9 rule files in the DorkOS repo)

Claude Code does NOT natively read OpenClaw workspace files (SOUL.md, IDENTITY.md, etc.) — those are specific to the OpenClaw agent runtime.

---

## Complete File Reference: OpenClaw Workspace

```
~/.openclaw/workspace/
├── SOUL.md              # Personality, values, tone (injected first)
├── IDENTITY.md          # Name/persona anchor (anti-injection hardening)
├── AGENTS.md            # Operational rules (loaded every request)
├── USER.md              # Who you are
├── TOOLS.md             # Environment-specific context
├── MEMORY.md            # Long-term durable memory (confidential)
├── HEARTBEAT.md         # Health checks (optional)
├── SUBAGENT-POLICY.md   # Subagent delegation rules (optional)
├── BOOTSTRAP.md         # First-run setup (delete after use)
├── BOOT.md              # Startup hooks (optional)
├── memory/
│   └── YYYY-MM-DD.md    # Daily session logs (agent-written)
├── checklists/
│   └── <operation>.md   # High-risk operation checklists (optional)
└── skills/
    └── <skill-name>/
        └── SKILL.md     # Skill definition + instructions
```

---

## Sources & Evidence

- OpenClaw GitHub repository: [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)
- OpenClaw official docs: [docs.openclaw.ai](https://docs.openclaw.ai)
- OpenClaw overview - DigitalOcean: [What is OpenClaw? Your Open-Source AI Assistant for 2026](https://www.digitalocean.com/resources/articles/what-is-openclaw)
- KDnuggets explainer: [OpenClaw Explained: The Free AI Agent Tool Going Viral Already in 2026](https://www.kdnuggets.com/openclaw-explained-the-free-ai-agent-tool-going-viral-already-in-2026)
- Milvus blog complete guide: [What Is OpenClaw? Complete Guide to the Open-Source AI Agent](https://milvus.io/blog/openclaw-formerly-clawdbot-moltbot-explained-a-complete-guide-to-the-autonomous-ai-agent.md)
- OpenClaw workspace file manager skill: [win4r/openclaw-workspace](https://github.com/win4r/openclaw-workspace)
- Matt Berman's OpenClaw markdown files gist: [Matt's Markdown Files · GitHub](https://gist.github.com/mberman84/663a7eba2450afb06d3667b8c284515b)
- OpenClaw default AGENTS.md reference: [Default AGENTS.md - OpenClaw](https://docs.openclaw.ai/reference/AGENTS.default)
- SOUL.md template: [SOUL.md Template - OpenClaw](https://docs.openclaw.ai/reference/templates/SOUL)
- SOUL.md open-source project: [aaronjmars/soul.md](https://github.com/aaronjmars/soul.md)
- OpenClaw skills docs: [Skills - OpenClaw](https://docs.openclaw.ai/tools/skills)
- ClawHub skill directory: [openclaw/clawhub](https://github.com/openclaw/clawhub)
- Awesome OpenClaw skills catalog: [VoltAgent/awesome-openclaw-skills](https://github.com/VoltAgent/awesome-openclaw-skills)
- DeployHQ complete config files guide: [AGENTS.md, AGENTS.md, and Every AI Config File Explained](https://www.deployhq.com/blog/ai-coding-config-files-guide)
- AGENTS.md open standard: [agentsmd/agents.md](https://github.com/agentsmd/agents.md)
- AGENTS.md official site: [agents.md](https://agents.md/)
- Builder.io AGENTS.md guide: [Improve your AI code output with AGENTS.md](https://www.builder.io/blog/agents-md)
- GitHub Blog on AGENTS.md: [How to write a great agents.md: Lessons from over 2,500 repositories](https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/)
- InfoQ ETH Zurich research: [New Research Reassesses the Value of AGENTS.md Files for AI Coding](https://www.infoq.com/news/2026/03/agents-context-file-value-review/)
- HumanLayer on AGENTS.md: [Writing a good AGENTS.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)
- Builder.io AGENTS.md guide: [How to Write a Good AGENTS.md File](https://www.builder.io/blog/claude-md-guide)
- OpenAI Codex AGENTS.md docs: [Custom instructions with AGENTS.md – Codex](https://developers.openai.com/codex/guides/agents-md)
- Medium guide to AI memory files: [The Complete Guide to AI Agent Memory Files (AGENTS.md, AGENTS.md, and Beyond)](https://medium.com/data-science-collective/the-complete-guide-to-ai-agent-memory-files-claude-md-agents-md-and-beyond-49ea0df5c5a9)
- AI SAFE² / SOUL.md governance: [GitHub - aaronjmars/soul.md](https://github.com/aaronjmars/soul.md)

---

## Research Gaps & Limitations

- **NOPE.md**: Confirmed as a real open-standard project at `nope-md.vercel.app`. Initial research incorrectly found no source — the project is not affiliated with OpenClaw and does not appear in the OpenClaw docs, which explains the miss.
- **OpenClaw internals**: Some documentation pages returned 403 errors (Medium articles), so the full universe of community-created workspace file patterns may be larger than documented here.
- **OpenClaw coding-specific skills**: The `awesome-openclaw-skills/categories/coding-agents-and-ides.md` catalog was not fully fetched; it may reveal additional convention files specific to coding workflows.

---

## Search Methodology

- Searches performed: 13
- Most productive search terms: "OpenClaw AI coding tool open source", "OpenClaw SKILL.md markdown convention files", "AGENTS.md AGENTS.md CURSOR.md AI coding convention markdown files 2026", "OpenClaw markdown files NOPE.md SOUL.md TOOLS.md IDENTITY.md"
- Primary information sources: GitHub (openclaw/openclaw, agentsmd/agents.md, win4r/openclaw-workspace), docs.openclaw.ai, deployhq.com, agents.md, milvus.io, kdnuggets.com, infoq.com

---
title: 'AI Agent Workspace Starter Templates — GitHub Seeding Research'
date: 2026-03-23
type: external-best-practices
status: active
tags: [agent-workspace, templates, github, scaffolding, degit, giget, starter]
searches_performed: 12
sources_count: 22
---

## Research Summary

This report identifies 7 practical GitHub starter templates suitable for seeding new AI agent workspaces in DorkOS, covering the full spectrum from a blank agent workspace to language-specific stacks. It also evaluates programmatic cloning tools (degit, tiged, giget, GitHub Template API) and recommends `giget` from the UnJS ecosystem as the best programmatic implementation choice. All templates listed have real GitHub presence, meaningful star counts, and active maintenance as of early 2026.

---

## Key Findings

1. **giget is the clear winner for programmatic template downloading** — it's the only tool with a true Node.js programmatic API, 3M weekly npm downloads, active maintenance by UnJS (who also maintain Nuxt, Nitro, h3), and support for GitHub, GitLab, Bitbucket, Sourcehut, and custom registries in a single `downloadTemplate()` call.

2. **GitHub's own Template API (`POST /repos/{owner}/{repo}/generate`) is viable but too heavy** — it creates a remote repository on GitHub under the user's account, requiring OAuth. For local workspace seeding (which is the DorkOS use case), giget's tarball-based approach (no git history, no remote repo creation) is far more appropriate.

3. **The most important template slot to get right is the blank workspace** — developers evaluating DorkOS will judge the blank slate. It should ship a well-crafted `AGENTS.md`, a minimal directory structure, and nothing else. Complexity lives in the other templates.

4. **Next.js Boilerplate (ixartz) is the strongest opinionated web starter** — 12.8k stars, Next.js 16, Tailwind CSS 4, Drizzle ORM, Vitest, Playwright, and notably already includes "AI coding agent instructions for Claude Code, Codex, Cursor, OpenCode, and Copilot." A natural fit.

5. **The T3 Stack (create-t3-app) is developer-culturally significant** — 28.7k stars, interactive CLI, and extremely well-known among senior TypeScript developers (Kai's cohort). Including it signals that DorkOS is for real TypeScript developers, not beginners.

6. **For backend/API work, Express TypeScript Boilerplate (edwinhern) is the right pick** — 1.2k stars, is a GitHub template repo, uses Vitest + Supertest (same as DorkOS), Zod, and a clean layered architecture. Low friction for Claude Code to navigate.

7. **FastAPI full-stack template is the canonical Python entry point** — maintained by the FastAPI org itself, stars in the thousands, includes Docker, PostgreSQL, and CI. The only Python entry that matters for the catalog.

---

## Recommended Template Catalog (7 entries)

### 1. `blank-agent`

**Display Label:** Blank Workspace
**Description:** A minimal AGENTS.md, `.claude/` rules directory, and clean project scaffold — the fastest way to start from scratch with Claude Code.
**Source:** DorkOS-owned template (self-hosted, not a GitHub clone). Ship this as `dorkos/blank-agent-template` on GitHub.
**Why it works for AI agents:** The blank slate is the most important default. It should communicate DorkOS conventions: where memory goes, how to structure rules, where `decisions/` and `research/` live. This is a DorkOS-authored template that demonstrates the platform's own architectural opinions. It gives Claude Code immediate context about how to operate.

**Suggested file structure:**

```
/
├── AGENTS.md                  # Agent instructions (project conventions)
├── .claude/
│   ├── README.md              # Explains the .claude/ directory
│   └── rules/                 # Contextual rules (empty, ready to populate)
├── decisions/                 # ADRs (empty)
├── research/                  # Research artifacts (empty)
└── README.md                  # Human-readable project readme
```

---

### 2. `nextjs-app`

**Display Label:** Next.js App
**Description:** Next.js 16 + TypeScript + Tailwind CSS 4 + Drizzle ORM + Vitest + Playwright — production-grade full-stack web app with AI agent instructions pre-configured.
**GitHub URL:** `github:ixartz/Next-js-Boilerplate`
**Stars:** 12,800+
**Why it works for AI agents:** Already ships AI coding agent instructions for Claude Code, Codex, Cursor, and others — meaning the repository maintainer understands this use case. It uses the same toolchain as DorkOS (Drizzle, Vitest, TypeScript strict mode), so Claude Code can navigate it without re-learning conventions. Tailwind CSS 4 + App Router keeps it current for 2026.

---

### 3. `t3-fullstack`

**Display Label:** T3 Stack (Full-Stack TypeScript)
**Description:** Next.js + tRPC + Prisma + Tailwind + TypeScript — the gold-standard typesafe full-stack setup for serious TypeScript developers.
**GitHub URL:** `github:t3-oss/create-t3-app` (via `npm create t3-app@latest` scaffold)
**Stars:** 28,700+
**Why it works for AI agents:** Kai's cohort knows T3. It's culturally significant to senior TypeScript devs. The strict end-to-end type safety is well-suited for AI agent work because Claude Code can trace the full type chain from database to API to client — fewer "what does this field actually accept?" ambiguities. tRPC makes the API boundary explicit in TypeScript, not implicit in docs.

**Note:** T3 is a CLI scaffolder, not a simple repo clone. The DorkOS agent workspace picker should invoke `npx create-t3-app@latest .` rather than `giget`. Or, use the official starter output committed to a template repo.

---

### 4. `vite-react`

**Display Label:** Vite + React SPA
**Description:** React 19 + TypeScript + Vite + TanStack Router + TanStack Query + Tailwind CSS — a fast, minimal single-page app with the same stack DorkOS uses internally.
**GitHub URL:** `github:RicardoValdovinos/vite-react-boilerplate`
**Stars:** 1,000+
**Why it works for AI agents:** Shares the exact stack DorkOS's own client uses (TanStack Router, TanStack Query, Zustand, Tailwind, Vitest). Claude Code already understands these conventions from working on DorkOS itself. This minimizes context-switching when an agent moves between the DorkOS client code and a new project. Playwright E2E is included, which enables verification-driven agent loops.

---

### 5. `express-api`

**Display Label:** Express REST API
**Description:** Express + TypeScript + Zod + Vitest + Swagger — a clean, feature-grouped REST API with type-safe validation and interactive docs.
**GitHub URL:** `github:edwinhern/express-typescript`
**Stars:** 1,200+
**Is GitHub Template:** Yes (marked as public template)
**Why it works for AI agents:** Feature-grouped folder structure (`/features/{name}/`) is ideal for AI navigation — Claude Code can reason about "what belongs to this feature" rather than traversing scattered file types. Zod validation means schema and runtime behavior are co-located. Vitest + Supertest mirrors DorkOS's own test setup, so the agent has prior pattern knowledge. ServiceResponse abstraction makes response shapes predictable and easy to enumerate.

---

### 6. `fastapi-python`

**Display Label:** FastAPI Python API
**Description:** FastAPI + PostgreSQL + Docker + SQLModel + GitHub Actions — the official full-stack Python API template maintained by the FastAPI organization.
**GitHub URL:** `github:fastapi/full-stack-fastapi-template`
**Stars:** Maintained by FastAPI org (category-defining repo)
**Why it works for AI agents:** The only Python backend template worth including. Being maintained by the FastAPI org means it tracks the framework's own best practices. Claude Code has extremely strong FastAPI training data. The Docker-first setup means Claude Code can run and test the API without environment configuration debates. SQLModel (Pydantic + SQLAlchemy hybrid) provides explicit types, which Claude Code leverages well.

---

### 7. `ts-library`

**Display Label:** TypeScript Library (npm)
**Description:** TypeScript + tsup + Vitest + Changesets — a minimal, zero-config npm package starter with dual ESM/CJS output and automated release tooling.
**GitHub URL:** `github:jasonsturges/tsup-npm-package`
**Stars:** Active, maintained
**Why it works for AI agents:** tsup gives Claude Code a single `tsup.config.ts` to reason about instead of a webpack labyrinth. Changesets makes versioning explicit in the filesystem (changelog entries as files), which is well-suited to commit-by-commit agent workflows. Dual ESM/CJS output is the standard expectation for libraries in 2026 and this template handles it automatically.

---

### Optional 8th: `cli-tool`

**Display Label:** Node.js CLI Tool
**Description:** TypeScript + oclif OR commander + tsup + Vitest — a structured CLI tool starter with argument parsing, help generation, and release packaging.
**GitHub URL:** `github:kucherenko/cli-typescript-starter` or oclif via `npx oclif generate`
**Stars:** Moderate
**Why it works for AI agents:** CLI tools are a natural output of autonomous agent work (building tools that other agents or humans use). oclif provides structured command definitions with TypeScript types, which gives Claude Code clear extension points.

---

## Programmatic Cloning — Tool Recommendation

### Recommended: `giget` (UnJS)

```typescript
import { downloadTemplate } from 'giget';

const { dir } = await downloadTemplate('github:ixartz/Next-js-Boilerplate', {
  dir: '/path/to/new/workspace',
  force: false,
  auth: process.env.GITHUB_TOKEN, // optional, for private templates
});
```

| Criterion               | giget               | tiged              | degit            | GitHub Template API |
| ----------------------- | ------------------- | ------------------ | ---------------- | ------------------- |
| Maintenance             | Active (UnJS)       | Active (community) | Abandoned (2020) | Active (GitHub)     |
| Programmatic API        | Full TypeScript API | Basic event API    | Basic event API  | REST, needs OAuth   |
| Weekly downloads        | ~3M                 | ~100K              | ~500K            | N/A                 |
| Private repo support    | Yes (auth token)    | Yes (fixed)        | Broken           | Yes (OAuth)         |
| Creates remote repo     | No                  | No                 | No               | Yes                 |
| Custom registries       | Yes                 | No                 | No               | No                  |
| No git history          | Yes                 | Yes                | Yes              | No (full history)   |
| GitHub/GitLab/Bitbucket | All three           | GitHub-first       | GitHub-first     | GitHub only         |

**Key advantages of giget for DorkOS:**

- Powers Nuxt's `nuxi init` — battle-tested in production CLIs at scale
- `downloadTemplate()` is a clean async function with typed options — no event emitter patterns
- Returns `{ dir, source, url }` — easy to confirm success and present to user
- Supports subdirectory extraction (`github:owner/repo/packages/my-template`) — useful if DorkOS hosts templates as subdirs in a monorepo
- Custom registry support: DorkOS could host a `registry.json` at `https://templates.dorkos.ai` for curated templates discoverable without knowing exact GitHub coordinates

### GitHub Template API (when to use it instead)

If DorkOS later wants to create an actual GitHub repository for the user (not just scaffold locally), the GitHub REST API supports:

```
POST /repos/{template_owner}/{template_repo}/generate
Body: { name, owner, description, private, include_all_branches }
```

This requires OAuth with `repo` scope. Appropriate for a "create new GitHub repo from template" flow — not for the initial local workspace seeding use case.

---

## Template Taxonomy Decisions

### What makes a template "good for AI agent work"?

1. **Typed API surfaces** — Claude Code reasons about types, not docs. Zod schemas, TypeScript strict mode, and tRPC-style contracts dramatically reduce ambiguity.

2. **Test suite included** — The agent verification loop depends on `pnpm test` working out of the box. Templates without tests force the agent to build a test harness before doing any real work.

3. **Clear folder conventions** — Feature-grouped directories outperform function-grouped directories for AI navigation. `features/auth/` is better than `controllers/`, `services/`, `repositories/` in parallel.

4. **Docker or CI included** — Means the agent can run the full system and observe real behavior rather than simulated behavior.

5. **Low configuration surface** — Each required configuration decision is a potential failure point for an agent. Templates that make opinionated defaults (eslint, prettier, tsconfig) are preferable.

### What to avoid in the catalog

- Templates that are primarily UI theme kits (they look good in screenshots, add nothing for autonomous coding work)
- Templates requiring paid services to run locally (Supabase-required, Clerk-required with no mock)
- Templates with outdated tooling (webpack 4, Jest, CRA — agents may apply patterns that don't compose)
- Templates with extremely high star counts but no TypeScript (signals a different audience)

---

## Blank Workspace — Recommended `AGENTS.md` Starting Point

For the DorkOS-owned `blank-agent` template, the `AGENTS.md` should be minimal but high-signal:

```markdown
# Project

[Short description of what this project does]

## Tech Stack

[List key languages, frameworks, and tools]

## Commands

\`\`\`bash

# Install dependencies

# Run dev server

# Run tests

# Build

\`\`\`

## Architecture

[Brief description of folder structure and key conventions]

## Agent Rules

- Always run tests before marking a task complete
- Keep code changes minimal and focused — one concern per commit
- Document non-obvious decisions with a comment explaining _why_
  \`\`\`

The goal is under 100 lines. Enough for Claude Code to orient, not enough to constrain.

---

## Search Methodology

- Searches performed: 12
- Primary sources: GitHub repository pages, npm package pages, pkgpulse.com comparison article
- Most productive search terms: "express typescript boilerplate github 2025", "giget downloadTemplate programmatic", "Next.js boilerplate github stars 2025", "tsup npm package starter template"
- Star counts verified by fetching live GitHub pages for the top candidates

---

## Research Gaps

- **FastAPI full-stack template star count not directly verified** — the FastAPI org maintains it; canonical status assumed from search result placement and org affiliation
- **CLI tool template** — fewer standout options exist vs. web starters. oclif's own `generate` command may be a better recommendation than a specific repo clone, but requires special handling in DorkOS (run a scaffolder instead of cloning)
- **Python non-FastAPI options** (Flask, Django) not researched — DorkOS audience skews TypeScript-first; Python coverage via FastAPI is sufficient for v1
- **Monorepo starter templates** not included — Turborepo's own starters are worth a follow-on look if the catalog expands

---

## Sources & Evidence

- [giget vs degit vs tiged: Git Template Downloading in Node.js (2026)](https://www.pkgpulse.com/blog/giget-vs-degit-vs-tiged-git-template-downloading-nodejs-2026) — comparison of maintenance, downloads, API quality
- [unjs/giget — GitHub](https://github.com/unjs/giget) — programmatic API reference, 708 stars
- [ixartz/Next-js-Boilerplate — GitHub](https://github.com/ixartz/Next-js-Boilerplate) — 12.8k stars, includes Claude Code agent instructions
- [t3-oss/create-t3-app — GitHub](https://github.com/t3-oss/create-t3-app) — 28.7k stars, TypeScript full-stack gold standard
- [RicardoValdovinos/vite-react-boilerplate — GitHub](https://github.com/RicardoValdovinos/vite-react-boilerplate) — 1k stars, TanStack stack
- [edwinhern/express-typescript — GitHub](https://github.com/edwinhern/express-typescript) — 1.2k stars, marked GitHub template
- [fastapi/full-stack-fastapi-template — GitHub](https://github.com/fastapi/full-stack-fastapi-template) — official FastAPI org template
- [jasonsturges/tsup-npm-package — GitHub](https://github.com/jasonsturges/tsup-npm-package) — tsup-based library template
- [kucherenko/cli-typescript-starter — GitHub](https://github.com/kucherenko/cli-typescript-starter) — CLI tool TypeScript starter
- [study8677/antigravity-workspace-template — GitHub](https://github.com/study8677/antigravity-workspace-template) — 1k+ stars, AGENTS.md + multi-IDE agent config
- [GitHub REST API: Create a repository using a template](https://docs.github.com/en/rest/repos/repos#create-a-repository-using-a-template) — official API reference
- [degit — GitHub](https://github.com/Rich-Harris/degit) — unmaintained since 2020, kept for reference
```

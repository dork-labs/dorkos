---
slug: world-class-documentation
---

# Tasks: World-Class Documentation

**Spec:** [02-specification.md](./02-specification.md)
**Decomposed:** 2026-02-17
**Total Tasks:** 10
**Phases:** 6

---

## Task Overview

| #   | Phase | Task                                             | Dependencies | Parallel Group |
| --- | ----- | ------------------------------------------------ | ------------ | -------------- |
| 1   | P1    | Fix API docs bug and all navigation gaps         | None         | A              |
| 2   | P2    | Rewrite quickstart page with Fumadocs components | 1            | B              |
| 3   | P2    | Enhance index landing page with hero and Cards   | 1            | B              |
| 4   | P2    | Enhance installation page with multi-target Tabs | 1            | B              |
| 5   | P2    | Enhance CLI usage guide with TypeTable and Steps | 1            | B              |
| 6   | P3    | Enhance slash-commands and tunnel-setup guides   | 1            | B              |
| 7   | P4    | Enhance integrations and self-hosting pages      | 1            | B              |
| 8   | P5    | Enhance contributing section pages               | 1            | B              |
| 9   | P6    | Create concepts section (3 new pages)            | 1            | B              |
| 10  | Final | Build verification and link audit                | 2-9          | C              |

**Parallel execution:** Tasks 2-9 can ALL run in parallel after Task 1 completes. Task 10 runs after all content tasks finish.

---

## Task 1: [P1] Fix API docs bug and all navigation gaps

**Phase:** 1 - Quick Wins
**Dependencies:** None
**Estimated effort:** Small

### Objective

Fix the broken API docs rendering and all meta.json navigation gaps.

### Changes Required

#### 1a. Fix API Docs Bug

**File:** `apps/web/src/components/api-page.tsx`

Remove the `'use client'` directive at line 1. The `APIPage` component from `fumadocs-openapi/ui` is an async Server Component that performs file I/O to load the OpenAPI spec. The `'use client'` directive forces it into client rendering where async I/O fails with "suspended by uncached promise" errors.

**Before:**

```typescript
'use client';
export { APIPage } from '@/lib/openapi';
```

**After:**

```typescript
export { APIPage } from '@/lib/openapi';
```

Then regenerate the API docs:

```bash
npm run docs:export-api
npm run generate:api-docs -w apps/web
```

#### 1b. Fix Root Navigation

**File:** `docs/meta.json`

Add `integrations`, `self-hosting`, and `concepts` to the pages array. Final order:

```json
{
  "title": "Documentation",
  "pages": [
    "getting-started",
    "guides",
    "concepts",
    "integrations",
    "api",
    "self-hosting",
    "contributing",
    "changelog"
  ]
}
```

#### 1c. Fix Guides Navigation

**File:** `docs/guides/meta.json`

Add the 3 missing guide pages. Final state:

```json
{
  "title": "Guides",
  "pages": [
    "cli-usage",
    "obsidian-plugin",
    "tool-approval",
    "slash-commands",
    "keyboard-shortcuts",
    "tunnel-setup"
  ]
}
```

#### 1d. Create Concepts Navigation

**File:** `docs/concepts/meta.json` (NEW directory + file)

Create directory `docs/concepts/` and meta.json:

```json
{
  "title": "Concepts",
  "pages": ["architecture", "sessions", "transport"]
}
```

### Acceptance Criteria

- [ ] `'use client'` removed from `apps/web/src/components/api-page.tsx`
- [ ] API docs regenerated successfully (`docs:export-api` + `generate:api-docs`)
- [ ] `docs/meta.json` contains all 8 sections in correct order
- [ ] `docs/guides/meta.json` lists all 6 guide pages
- [ ] `docs/concepts/meta.json` created with 3 pages
- [ ] `npm run build -w apps/web` succeeds

---

## Task 2: [P2] Rewrite quickstart page with Fumadocs components

**Phase:** 2 - High-Traffic Pages
**Dependencies:** Task 1
**Estimated effort:** Medium

### Objective

Rewrite `docs/getting-started/quickstart.mdx` into a full quickstart using Fumadocs components. Target: user gets first Claude response within 5 minutes of reading.

### Current State

The page has basic text with numbered lists and plain markdown. No Fumadocs components are used.

### Content Outline

The rewritten page must include:

1. **Prerequisites** — `<Callout type="info">` listing Node 20+, Claude Code CLI installed, Anthropic API key
2. **Install DorkOS** — `<Tabs groupId="pkg" persist>` with tabs for npm, pnpm, yarn, bun showing `npm install -g dorkos` etc.
3. **Start the server** — Code block with expected terminal output. Use `// [!code highlight]` on the URL line to highlight where to open the browser.
4. **Open the UI** — Description of what the user sees when they open `http://localhost:4242`
5. **Send first message** — Example prompt (e.g., "What files are in this directory?"), expected response showing tool approval flow
6. **Next steps** — `<Cards>` component linking to: CLI usage (`/docs/guides/cli-usage`), Configuration (`/docs/getting-started/configuration`), Obsidian plugin (`/docs/guides/obsidian-plugin`)

### Fumadocs Components to Use

```tsx
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { Tabs, Tab } from 'fumadocs-ui/components/tabs';
import { Callout } from 'fumadocs-ui/components/callout';
import { Cards, Card } from 'fumadocs-ui/components/card';
```

### Source Files for Accuracy

- `packages/cli/src/cli.ts` — CLI flags, default port (4242), startup behavior
- `apps/server/src/index.ts` — Server startup output format

### Acceptance Criteria

- [ ] Uses `<Steps>` for the procedural walkthrough
- [ ] Uses `<Tabs>` for package manager alternatives
- [ ] Uses `<Callout>` for prerequisites
- [ ] Uses `<Cards>` for next steps
- [ ] Code blocks are copy-paste-runnable
- [ ] Has valid frontmatter with `title` and `description`
- [ ] No TODO/placeholder content remains

---

## Task 3: [P2] Enhance index landing page with hero and Cards

**Phase:** 2 - High-Traffic Pages
**Dependencies:** Task 1
**Estimated effort:** Medium

### Objective

Rewrite `docs/index.mdx` from a plain link list into a proper landing page with hero text, audience Cards, feature highlights, and clear CTAs.

### Current State

The page has a title, one-paragraph description, and three sections of bullet-point links. No Fumadocs components.

### Content Outline

1. **Hero section** — "A web UI and REST API for Claude Code" with one-line value proposition. Keep it concise.
2. **"Who is this for?" section** — 3 `<Card>` items:
   - End users: Chat with Claude Code through a browser instead of the terminal
   - Integrators: Build custom clients using the REST/SSE API and Transport interface
   - Contributors: Help improve DorkOS — open source on GitHub
3. **Feature highlights** — `<Cards>` grid:
   - Chat UI with markdown rendering
   - Tool approval flows
   - Session sync across clients (CLI, web, Obsidian)
   - Obsidian plugin
   - Self-hosting support
   - Slash command discovery
4. **Getting started CTA** — Prominent link to quickstart (`/docs/getting-started/quickstart`)
5. **Section navigation** — `<Cards>` for each doc section: Getting Started, Guides, Concepts, Integrations, API Reference, Self-Hosting, Contributing

### Fumadocs Components to Use

```tsx
import { Cards, Card } from 'fumadocs-ui/components/card';
```

### Acceptance Criteria

- [ ] Uses `<Cards>` / `<Card>` for audience, features, and section navigation
- [ ] Has clear hero text answering "what is this?"
- [ ] Links to quickstart as primary CTA
- [ ] All internal links are valid
- [ ] Has valid frontmatter with `title` and `description`

---

## Task 4: [P2] Enhance installation page with multi-target Tabs

**Phase:** 2 - High-Traffic Pages
**Dependencies:** Task 1
**Estimated effort:** Medium

### Objective

Enhance `docs/getting-started/installation.mdx` with multi-target installation support using Fumadocs Tabs and Callouts.

### Current State

The page covers npm-only installation with plain markdown. No Fumadocs components.

### Content Outline

1. **Installation method Tabs** — `<Tabs groupId="install-target" persist>` for:
   - **npm CLI** (global install): `npm install -g dorkos` with package manager sub-tabs (`<Tabs groupId="pkg" persist>` for npm/pnpm/yarn/bun)
   - **Obsidian plugin**: Install via Obsidian community plugins browser, or manual install steps
   - **Self-hosted** (from source): `git clone` + `npm install` + `npm run build` + `npm start`
2. **Node version warning** — `<Callout type="warn">` for Node 20+ requirement
3. **API key setup** — `<Steps>` for getting and configuring `ANTHROPIC_API_KEY` (with shell profile persistence tip)
4. **Verification** — `dorkos --version` expected output with `// [!code highlight]`
5. **Next steps** — `<Cards>` linking to: Quickstart, CLI Usage, Configuration

### Fumadocs Components to Use

```tsx
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { Tabs, Tab } from 'fumadocs-ui/components/tabs';
import { Callout } from 'fumadocs-ui/components/callout';
import { Cards, Card } from 'fumadocs-ui/components/card';
```

### Acceptance Criteria

- [ ] Uses `<Tabs>` for install targets and package managers
- [ ] Uses `<Callout type="warn">` for Node version requirement
- [ ] Uses `<Steps>` for API key setup
- [ ] Uses `<Cards>` for next steps
- [ ] Code blocks are copy-paste-runnable
- [ ] Has valid frontmatter

---

## Task 5: [P2] Enhance CLI usage guide with TypeTable and Steps

**Phase:** 2 - High-Traffic Pages
**Dependencies:** Task 1
**Estimated effort:** Medium

### Objective

Enhance `docs/guides/cli-usage.mdx` with Fumadocs TypeTable for flags, Steps for procedures, and Callouts for important notes.

### Current State

The page has substantial content with plain markdown tables and code blocks. Needs Fumadocs component adoption.

### Changes Required

1. **Global flags** — Replace markdown table with `<TypeTable>` component:
   - `--port`/`-p` (number, default 4242)
   - `--dir`/`-d` (string, cwd)
   - `--boundary`/`-b` (string, home dir)
   - `--tunnel`/`-t` (boolean)
   - `--log-level`/`-l` (string, "info")
   - `--yes`/`-y` (boolean)
   - `--help`/`-h`
   - `--version`/`-v`
2. **Config subcommands** — Wrap in `<Steps>` showing: `dorkos config get <key>`, `set <key> <value>`, `list`, `reset`, `edit`, `path`, `validate`
3. **Init wizard** — Add section for `dorkos init` interactive setup, `--yes` for non-interactive
4. **Config precedence** — `<Callout type="info">`: CLI flags > env vars > `~/.dork/config.json` > defaults
5. **Environment variables** — Replace markdown table with `<TypeTable>`
6. **Examples** — Real commands with expected output, `// [!code highlight]` on key lines
7. **Next steps** — `<Cards>` linking to: Configuration, Tunnel Setup, Quickstart

### Fumadocs Components to Use

```tsx
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { Callout } from 'fumadocs-ui/components/callout';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { Cards, Card } from 'fumadocs-ui/components/card';
```

### Source Files for Accuracy

- `packages/cli/src/cli.ts` — CLI flags and defaults
- `packages/cli/src/config-commands.ts` — Config subcommand implementations
- `contributing/configuration.md` — Config system documentation

### Acceptance Criteria

- [ ] Uses `<TypeTable>` for CLI flags and env vars
- [ ] Uses `<Steps>` for config subcommands
- [ ] Uses `<Callout>` for config precedence note
- [ ] Uses `<Cards>` for next steps
- [ ] All flags/defaults match source code
- [ ] Has valid frontmatter

---

## Task 6: [P3] Enhance slash-commands and tunnel-setup guides

**Phase:** 3 - Guides
**Dependencies:** Task 1
**Estimated effort:** Medium

### Objective

Enhance the two remaining guide pages (`docs/guides/slash-commands.mdx` and `docs/guides/tunnel-setup.mdx`) with Fumadocs components.

### Current State

Both pages have substantive content in plain markdown. Need Fumadocs component adoption and next-steps links.

### Changes for `docs/guides/slash-commands.mdx`

1. **Command structure** — Replace the file tree with `<Files>` / `<Folder>` / `<File>` component
2. **Frontmatter fields** — Replace markdown table with `<TypeTable>`
3. **Creating a custom command** — Wrap in `<Steps>` (create file, add frontmatter, write instructions, refresh)
4. **Namespace tip** — `<Callout type="info">` explaining project (`.claude/commands/`) vs user (`~/.claude/commands/`) namespace
5. **Example** — Add a complete `/review` command example with full markdown content
6. **Next steps** — `<Cards>` linking to: Keyboard Shortcuts, Tool Approval, CLI Usage

### Changes for `docs/guides/tunnel-setup.mdx`

1. **Environment variables** — Replace markdown table with `<TypeTable>`
2. **Setup steps** — Wrap Quick Start in `<Steps>`
3. **Security warning** — `<Callout type="warn">` for always using `TUNNEL_AUTH` in production
4. **How it works** — Wrap in `<Steps>` (server starts, tunnel creates, URL appears, failure is non-blocking)
5. **Next steps** — `<Cards>` linking to: Deployment, Reverse Proxy, CLI Usage

### Fumadocs Components to Use

```tsx
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { Callout } from 'fumadocs-ui/components/callout';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { Cards, Card } from 'fumadocs-ui/components/card';
import { Files, Folder, File } from 'fumadocs-ui/components/files';
```

### Source Files for Accuracy

- `apps/server/src/services/command-registry.ts` — CommandEntry schema, scanning logic
- `apps/server/src/services/tunnel-manager.ts` — TunnelConfig, TunnelStatus

### Acceptance Criteria

- [ ] Both pages use appropriate Fumadocs components
- [ ] Both pages have "next steps" `<Cards>` at the end
- [ ] `<TypeTable>` replaces plain markdown tables
- [ ] `<Steps>` wraps all procedural content
- [ ] No TODO/placeholder content remains

---

## Task 7: [P4] Enhance integrations and self-hosting pages

**Phase:** 4 - Integrations & Self-Hosting
**Dependencies:** Task 1
**Estimated effort:** Medium-Large

### Objective

Enhance all 4 pages in the integrations and self-hosting sections with Fumadocs components.

### Current State

All 4 pages have substantive content in plain markdown. Need Fumadocs component adoption and next-steps links.

### Changes for `docs/integrations/building-integrations.mdx`

1. **Transport interface** — Introduce the concept with a brief explanation of hexagonal architecture
2. **Key Transport methods** — Replace or supplement the code block with `<TypeTable>` showing method signatures, descriptions
3. **Implementation options** — Wrap Option 1/2/3 in `<Steps>` or `<Tabs>` (REST API vs Custom Transport vs React Integration)
4. **StreamEvent types** — Replace markdown table with `<TypeTable>`
5. **Next steps** — `<Cards>` linking to: SSE Protocol, Concepts > Transport, API Reference

### Changes for `docs/integrations/sse-protocol.mdx`

1. **Event types** — Replace all 3 markdown tables (Text, Tool, Interactive, Control) with `<TypeTable>` components
2. **Connection lifecycle** — Wrap in `<Steps>`
3. **SSE buffering warning** — `<Callout type="warn">` about disabling proxy buffering
4. **Code example** — Add a JavaScript `fetch()` + `ReadableStream` example for SSE consumption
5. **Next steps** — `<Cards>` linking to: Building Integrations, Reverse Proxy, API Reference

### Changes for `docs/self-hosting/deployment.mdx`

1. **Production setup** — Wrap in `<Steps>` (install, configure, run)
2. **Environment variables** — Replace markdown table with `<TypeTable>`
3. **Production recommendations** — `<Callout type="info">` for NODE_ENV=production, boundary settings
4. **Security** — `<Callout type="warn">` about API key security and boundary configuration
5. **Next steps** — `<Cards>` linking to: Reverse Proxy, Tunnel Setup, CLI Usage

### Changes for `docs/self-hosting/reverse-proxy.mdx`

1. **Proxy configs** — Wrap nginx/Caddy in `<Tabs>` (already has both, just needs component wrapping)
2. **SSE settings** — Replace markdown table with `<TypeTable>`
3. **Critical SSE warning** — `<Callout type="error">` for SSE buffering must be disabled
4. **Common issues** — Use `<Callout type="warn">` for each troubleshooting item
5. **Next steps** — `<Cards>` linking to: Deployment, SSE Protocol, Tunnel Setup

### Fumadocs Components to Use

```tsx
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { Tabs, Tab } from 'fumadocs-ui/components/tabs';
import { Callout } from 'fumadocs-ui/components/callout';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { Cards, Card } from 'fumadocs-ui/components/card';
```

### Source Files for Accuracy

- `packages/shared/src/transport.ts` — Transport interface
- `packages/shared/src/schemas.ts` — StreamEvent types
- `contributing/api-reference.md` — API reference details
- `apps/server/src/services/tunnel-manager.ts` — Tunnel config

### Acceptance Criteria

- [ ] All 4 pages use appropriate Fumadocs components
- [ ] All 4 pages have "next steps" `<Cards>` at the end
- [ ] `<TypeTable>` replaces all plain markdown tables for config/type references
- [ ] `<Steps>` wraps all procedural content
- [ ] `<Tabs>` used for nginx/Caddy configs in reverse-proxy page
- [ ] No TODO/placeholder content remains

---

## Task 8: [P5] Enhance contributing section pages

**Phase:** 5 - Contributing
**Dependencies:** Task 1
**Estimated effort:** Medium

### Objective

Enhance all 3 pages in the contributing section with Fumadocs components.

### Current State

All 3 pages have substantive content in plain markdown. Need Fumadocs component adoption, file tree components, and next-steps links.

### Changes for `docs/contributing/development-setup.mdx`

1. **Prerequisites** — `<Callout type="info">` for Node 20+, npm 10+, git, Claude API key
2. **Clone and install** — Wrap in `<Steps>`
3. **Environment setup** — `<Steps>` for copy .env.example, set API key
4. **Common commands** — Replace markdown table with `<TypeTable>`
5. **Project structure** — Replace the markdown table with `<Files>` / `<Folder>` / `<File>` component showing the monorepo layout
6. **Important note** — `<Callout type="warn">` for using `npm run` scripts (not bare `turbo`) to ensure `.env` is loaded
7. **Next steps** — `<Cards>` linking to: Architecture, Testing, API Reference

### Changes for `docs/contributing/architecture.mdx`

1. **Data flow diagram** — Keep ASCII art but wrap in a `<Callout type="info">` or leave as code block
2. **FSD layers** — Replace markdown table with `<TypeTable>` for layers
3. **Monorepo structure** — Replace code block with `<Files>` / `<Folder>` component
4. **Transport implementations** — Use `<Tabs>` for HttpTransport vs DirectTransport comparison
5. **Testing pattern** — Keep code block but add `// [!code highlight]` on key lines
6. **Next steps** — `<Cards>` linking to: Testing, Building Integrations, SSE Protocol, Concepts > Architecture

### Changes for `docs/contributing/testing.mdx`

1. **Running tests** — `<Tabs>` for all/single/watch modes
2. **Test file structure** — Replace code block with `<Files>` / `<Folder>` / `<File>` component
3. **jsdom requirement** — `<Callout type="info">` for the `@vitest-environment jsdom` directive requirement
4. **Component test pattern** — `<Steps>` showing: mock Transport, wrap in providers, render, assert
5. **Mock Transport factory** — `<Callout type="info">` about `createMockTransport()` from `@dorkos/test-utils`
6. **Next steps** — `<Cards>` linking to: Development Setup, Architecture

### Fumadocs Components to Use

```tsx
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { Tabs, Tab } from 'fumadocs-ui/components/tabs';
import { Callout } from 'fumadocs-ui/components/callout';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { Cards, Card } from 'fumadocs-ui/components/card';
import { Files, Folder, File } from 'fumadocs-ui/components/files';
```

### Source Files for Accuracy

- `CLAUDE.md` — Commands section, architecture overview
- `.claude/rules/testing.md` — Testing rules and patterns
- `packages/test-utils/` — Mock factory implementation
- `contributing/architecture.md` — Detailed architecture docs

### Acceptance Criteria

- [ ] All 3 pages use appropriate Fumadocs components
- [ ] All 3 pages have "next steps" `<Cards>` at the end
- [ ] `<Files>` component used for project structure and test file layout
- [ ] `<TypeTable>` replaces plain markdown tables
- [ ] `<Steps>` wraps all procedural content
- [ ] No TODO/placeholder content remains

---

## Task 9: [P6] Create concepts section (3 new pages)

**Phase:** 6 - Concepts Section
**Dependencies:** Task 1 (for meta.json)
**Estimated effort:** Medium

### Objective

Create 3 new pages in the `docs/concepts/` directory: `architecture.mdx`, `sessions.mdx`, `transport.mdx`. These are user-facing "explanation" pages (Diataxis framework), not implementation details.

### Note

Task 1 creates `docs/concepts/meta.json`. This task creates the actual content pages.

### Page 1: `docs/concepts/architecture.mdx`

**Frontmatter:**

```yaml
---
title: Architecture
description: How DorkOS connects to Claude Code and where your data lives
---
```

**Content outline:**

1. **What DorkOS is** — A web UI + REST/SSE API for Claude Code, built with the Claude Agent SDK
2. **System diagram** — ASCII art or description: User -> DorkOS Client -> Transport -> DorkOS Server -> Claude Agent SDK -> Claude API
3. **Three deployment modes** — `<Cards>` showing:
   - Standalone CLI (`dorkos` npm package)
   - Obsidian plugin (embedded in Obsidian sidebar)
   - Self-hosted (git clone + build)
4. **Where data lives** — JSONL transcript files on disk at `~/.claude/projects/{slug}/`. No external database. All clients (CLI, web, Obsidian) read the same files.
5. **Next steps** — `<Cards>` linking to: Sessions, Transport, Contributing > Architecture (for deeper dive)

### Page 2: `docs/concepts/sessions.mdx`

**Frontmatter:**

```yaml
---
title: Sessions
description: How DorkOS manages conversation sessions using SDK transcript files
---
```

**Content outline:**

1. **What is a session?** — A conversation with Claude Code, stored as a JSONL file
2. **Where sessions live** — `~/.claude/projects/{project-slug}/{session-id}.jsonl`
3. **Session ID** — UUID derived from the JSONL filename
4. **Cross-client visibility** — `<Callout type="info">` explaining that ALL clients see the same sessions (CLI-started, DorkOS-started, etc.)
5. **No separate database** — The transcript files ARE the database. `TranscriptReader` scans them to build the session list.
6. **Session metadata** — Title (from first user message), timestamps (from file stats), preview text (from last assistant message). Extracted on every request.
7. **Session locking** — Brief explanation of `X-Client-Id` header preventing concurrent writes
8. **Session sync** — Brief explanation of how `sync_update` SSE events keep clients in sync when JSONL files change
9. **Next steps** — `<Cards>` linking to: Architecture, Transport, SSE Protocol

### Page 3: `docs/concepts/transport.mdx`

**Frontmatter:**

```yaml
---
title: Transport
description: The abstraction that lets DorkOS run as a web app or an Obsidian plugin
---
```

**Content outline:**

1. **Why Transport exists** — Decouple the UI from the backend. Same React app, different communication layer. This is the hexagonal architecture "port".
2. **HttpTransport** — `<Card>` or section: REST/SSE over the network. Used by standalone web mode. Constructor takes `{ baseUrl }`.
3. **DirectTransport** — `<Card>` or section: In-process function calls. Used by Obsidian plugin. Constructor takes service instances. No network overhead.
4. **When to use each** — `<Callout type="info">`: HttpTransport for standalone/self-hosted, DirectTransport for embedded plugins
5. **How to inject** — Brief code example of `TransportProvider` React context wrapping the app
6. **Building your own** — Link to Building Integrations guide for custom Transport implementations
7. **Next steps** — `<Cards>` linking to: Architecture, Sessions, Building Integrations

### Fumadocs Components to Use

```tsx
import { Callout } from 'fumadocs-ui/components/callout';
import { Cards, Card } from 'fumadocs-ui/components/card';
import { Files, Folder, File } from 'fumadocs-ui/components/files';
```

### Acceptance Criteria

- [ ] All 3 files created in `docs/concepts/`
- [ ] Each has valid frontmatter with `title` and `description`
- [ ] Each uses appropriate Fumadocs components
- [ ] Each has "next steps" `<Cards>` at the end
- [ ] Content is user-facing (explains concepts, not implementation details)
- [ ] No code-heavy implementation details (that belongs in contributing/)
- [ ] `npm run build -w apps/web` succeeds with all 3 new pages

---

## Task 10: [Final] Build verification and link audit

**Phase:** Final
**Dependencies:** Tasks 2-9 (all content tasks)
**Estimated effort:** Small

### Objective

Verify the entire documentation site builds successfully and all internal links are valid.

### Steps

1. **Build the web app:**

   ```bash
   npm run build -w apps/web
   ```

   Must succeed with zero errors. This catches MDX syntax errors, broken imports, missing frontmatter, and invalid Fumadocs component usage.

2. **Navigation audit** — Verify every page listed in a `meta.json` has a corresponding `.mdx` file:
   - `docs/meta.json` → 8 sections
   - `docs/getting-started/meta.json` → all pages
   - `docs/guides/meta.json` → 6 pages
   - `docs/concepts/meta.json` → 3 pages
   - `docs/integrations/meta.json` → 2 pages
   - `docs/self-hosting/meta.json` → 2 pages
   - `docs/contributing/meta.json` → 3 pages

3. **Content quality audit** — For each non-API page, verify:
   - [ ] Uses at least one Fumadocs component (Steps, Cards, Tabs, Callouts, TypeTable, or Files)
   - [ ] Has valid frontmatter with `title` and `description`
   - [ ] Has "next steps" links at the end (no dead ends)
   - [ ] No TODO/placeholder content remains
   - [ ] Code blocks are syntactically valid

4. **API docs verification** — After the `'use client'` fix, verify the API docs render by checking:
   - The `docs/api/` directory contains generated MDX files
   - The `api-page.tsx` no longer has `'use client'`

5. **Link audit** — Grep all MDX files for internal links (`/docs/...`) and verify each target exists

### Acceptance Criteria

- [ ] `npm run build -w apps/web` succeeds
- [ ] All meta.json entries have corresponding MDX files
- [ ] All internal links point to existing pages
- [ ] No TODO comments remain in any docs MDX file
- [ ] Every page uses at least one Fumadocs component
- [ ] Every page has next-steps navigation

---

## Execution Notes

### Parallel Execution Strategy

After Task 1 completes, Tasks 2-9 have NO dependencies on each other and can all run in parallel. This is ideal for multi-agent execution:

- **Group A (prerequisite):** Task 1
- **Group B (parallel):** Tasks 2, 3, 4, 5, 6, 7, 8, 9
- **Group C (verification):** Task 10

### Fumadocs Component Import Reference

All pages should use these imports as needed:

```tsx
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { Tabs, Tab } from 'fumadocs-ui/components/tabs';
import { Callout } from 'fumadocs-ui/components/callout';
import { Cards, Card } from 'fumadocs-ui/components/card';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { Files, Folder, File } from 'fumadocs-ui/components/files';
```

Code block highlighting: `// [!code highlight]` on key lines.

### Content Accuracy Sources

Always verify content against source code, not just the spec:

| Topic               | Source File                                        |
| ------------------- | -------------------------------------------------- |
| CLI flags           | `packages/cli/src/cli.ts`                          |
| Config subcommands  | `packages/cli/src/config-commands.ts`              |
| Transport interface | `packages/shared/src/transport.ts`                 |
| StreamEvent types   | `packages/shared/src/schemas.ts`                   |
| Command registry    | `apps/server/src/services/command-registry.ts`     |
| Tunnel config       | `apps/server/src/services/tunnel-manager.ts`       |
| Server routes       | `apps/server/src/routes/`                          |
| Testing patterns    | `.claude/rules/testing.md`, `packages/test-utils/` |
| Architecture        | `contributing/architecture.md`                     |
| Configuration       | `contributing/configuration.md`                    |

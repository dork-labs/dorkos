# Documentation Infrastructure — Task Breakdown

Last Decompose: 2026-02-16

**Spec**: `specs/documentation-infrastructure/02-specification.md`
**Mode**: Full

---

## Phase 0: Directory Rename

### Task 0.1: Rename guides/ to contributing/

**Objective**: Rename the `guides/` directory to `contributing/` to make the target audience self-documenting.

**Implementation**:
- Rename `guides/` → `contributing/` (git mv to preserve history)
- Update all references across the codebase:
  - `CLAUDE.md` — guides table, monorepo structure diagram, all `guides/` paths
  - `.claude/rules/` — any rules referencing `guides/` paths
  - `.claude/skills/` — any skills referencing `guides/` paths (e.g., `writing-developer-guides`, `organizing-fsd-architecture`)
  - `apps/client/`, `apps/server/` — any import comments or documentation references
  - `specs/` — other spec files that reference `guides/`
  - Root `package.json` or config files with `guides/` paths
- Verify no broken references remain: `grep -r "guides/" --include="*.md" --include="*.ts" --include="*.json"`

**Acceptance Criteria**:
- `guides/` directory no longer exists
- `contributing/` directory contains all former `guides/` files
- All references across the codebase updated
- Git history preserved via `git mv`
- Build (`npm run build`) and tests (`npm test`) still pass
- No remaining references to `guides/` that should point to `contributing/` (note: `docs/guides/` is a separate Fumadocs section and should NOT be renamed)

**Dependencies**: None — this is a prerequisite for all other tasks

---

## Phase 1: OSS Files (Core)

### Task 1.1: Create LICENSE file (MIT)

**Objective**: Add root `LICENSE` file with MIT license text.

**Implementation**:
- Create `/LICENSE` at the repository root
- Use the standard MIT license template
- Copyright line: `Copyright (c) 2025 Dork Labs`
- Year matches what is declared in existing `package.json` files

**Acceptance Criteria**:
- `LICENSE` file exists at repo root
- Contains full MIT license text
- Copyright holder is "Dork Labs"

**Dependencies**: None

---

### Task 1.2: Rewrite root README.md

**Objective**: Replace the current root `README.md` with a version targeting npm users and open-source contributors.

**Implementation**:
- Read the current `README.md` to understand existing content
- Rewrite following this structure:
  1. **Header**: `# DorkOS` with one-line description
  2. **Badges**: npm version (`https://img.shields.io/npm/v/dorkos`), license (`https://img.shields.io/npm/l/dorkos`), GitHub stars
  3. **What is DorkOS?**: 2-3 sentences describing it as a web UI + REST/SSE API for Claude Code built with the Claude Agent SDK
  4. **Install**: `npm install -g dorkos` then `dorkos`
  5. **Screenshot**: Placeholder for UI screenshot/GIF (use `<!-- TODO: Add screenshot -->` comment)
  6. **Features**: Bullet list — chat UI, tool approval flows, slash commands, SSE streaming, session sync, Obsidian plugin, ngrok tunneling, OpenAPI docs
  7. **Documentation**: Link to `https://docs.dorkos.ai` (future)
  8. **Quick Start (Development)**: `git clone`, `npm install`, `cp .env.example .env`, add `ANTHROPIC_API_KEY`, `npm run dev`
  9. **Contributing**: Brief note + link to `CONTRIBUTING.md`
  10. **License**: MIT, link to `LICENSE`

**Acceptance Criteria**:
- README.md is rewritten with all sections above
- No references to pre-monorepo structure
- CLI install instructions are prominent
- Links to CONTRIBUTING.md and LICENSE are valid relative paths

**Dependencies**: Task 1.1 (LICENSE must exist for link)

---

### Task 1.3: Create CHANGELOG.md

**Objective**: Create a changelog using Keep a Changelog format.

**Implementation**:
- Create `/CHANGELOG.md` at repo root
- Use [Keep a Changelog](https://keepachangelog.com/) format
- Include header linking to the format spec
- Add `[Unreleased]` section (empty, with subsection headers commented as guidance)
- Add `[0.1.0] - 2025-XX-XX` section covering the initial release. Include key items:
  - **Added**: Web UI for Claude Code sessions, REST/SSE API, tool approval flows, slash command discovery, session sync across clients, Obsidian plugin, ngrok tunnel support, OpenAPI documentation at `/api/docs`, CLI package (`dorkos`)
- Add comparison links at the bottom: `[Unreleased]: https://github.com/dork-labs/dorkos/compare/v0.1.0...HEAD`

**Acceptance Criteria**:
- CHANGELOG.md exists at repo root
- Follows Keep a Changelog format
- Has `[Unreleased]` and `[0.1.0]` sections
- Comparison links point to correct GitHub repo

**Dependencies**: None

---

### Task 1.4: Create CONTRIBUTING.md

**Objective**: Create a contributor onboarding guide.

**Implementation**:
- Create `/CONTRIBUTING.md` at repo root
- Sections:
  1. **Welcome**: Brief welcoming statement
  2. **Prerequisites**: Node.js 20+, npm 10+, Claude API key (`ANTHROPIC_API_KEY`)
  3. **Getting Started**: Fork, clone, `npm install`, `cp .env.example .env`, add API key, `npm run dev`
  4. **Monorepo Structure**: Brief table of `apps/` (client, server, obsidian-plugin) and `packages/` (cli, shared, typescript-config, test-utils) with one-line descriptions
  5. **Development Commands**: Table of `npm run dev`, `npm test`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format`
  6. **Architecture**: Brief mention of hexagonal architecture with Transport interface; link to `contributing/architecture.md` for deep dive
  7. **Client Architecture (FSD)**: Brief mention of Feature-Sliced Design layers; link to `contributing/01-project-structure.md`
  8. **Testing**: Vitest, tests in `__tests__/` dirs, `npm test` to run all, `npx vitest run <file>` for single file
  9. **Code Style**: ESLint + Prettier enforced; run `npm run lint` and `npm run format` before committing
  10. **Pull Request Process**: Fork, create feature branch, make changes, ensure tests pass and linting is clean, open PR with description
  11. **Commit Conventions**: Conventional-style prefixes (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`)
  12. **Code of Conduct**: `<!-- TODO: Add Code of Conduct -->` placeholder with note that one will be adopted

**Acceptance Criteria**:
- CONTRIBUTING.md exists at repo root
- All sections above are present
- Commands are accurate per CLAUDE.md
- Links to internal guides are valid relative paths

**Dependencies**: None

---

### Task 1.5: Create packages/cli/README.md

**Objective**: Create the npm package page README for the `dorkos` CLI.

**Implementation**:
- Create `/packages/cli/README.md`
- This is what npmjs.com displays on the package page
- Sections:
  1. **Header**: `# dorkos` with one-line description and badges (npm version, license)
  2. **What is DorkOS?**: 2-3 sentences — web-based interface and REST/SSE API for Claude Code
  3. **Installation**: `npm install -g dorkos`
  4. **Usage**: Run `dorkos` to start; opens browser automatically; describe the web UI briefly
  5. **Configuration**: Environment variables table:
     - `ANTHROPIC_API_KEY` (required) - Claude API key
     - `DORKOS_PORT` (default: 4242) - Server port
     - `DORKOS_DEFAULT_CWD` - Default working directory
     - `TUNNEL_ENABLED` - Enable ngrok tunnel
     - `NGROK_AUTHTOKEN` - ngrok auth token
     - `TUNNEL_DOMAIN` - Custom tunnel domain
     - `TUNNEL_AUTH` - Tunnel basic auth (user:pass)
  6. **Config Directory**: `~/.dork/` created on startup
  7. **Tunnel Support**: Brief ngrok tunnel description with env var references
  8. **API Documentation**: Running instance serves OpenAPI docs at `/api/docs`
  9. **Links**: Full documentation at `https://docs.dorkos.ai`, GitHub at `https://github.com/dork-labs/dorkos`
  10. **License**: MIT

**Acceptance Criteria**:
- `packages/cli/README.md` exists
- All env vars documented accurately (cross-reference with CLAUDE.md and server code)
- Install command is `npm install -g dorkos`
- Links to GitHub and docs site are present

**Dependencies**: None

---

## Phase 2: Docs Content Structure

### Task 2.1: Scaffold docs/ directory with meta.json files

**Objective**: Create the full `docs/` directory structure with all `meta.json` navigation files.

**Implementation**:
- Create the following directories:
  - `docs/`
  - `docs/getting-started/`
  - `docs/guides/`
  - `docs/integrations/`
  - `docs/api/`
  - `docs/self-hosting/`
  - `docs/contributing/`

- Create `docs/meta.json`:
  ```json
  {
    "title": "Documentation",
    "pages": [
      "getting-started",
      "guides",
      "integrations",
      "api",
      "self-hosting",
      "contributing"
    ]
  }
  ```

- Create `docs/getting-started/meta.json`:
  ```json
  {
    "title": "Getting Started",
    "pages": [
      "installation",
      "quickstart",
      "configuration"
    ],
    "defaultOpen": true
  }
  ```

- Create `docs/guides/meta.json`:
  ```json
  {
    "title": "Guides",
    "pages": [
      "cli-usage",
      "obsidian-plugin",
      "tunnel-setup",
      "tool-approval",
      "slash-commands",
      "keyboard-shortcuts"
    ]
  }
  ```

- Create `docs/integrations/meta.json`:
  ```json
  {
    "title": "Integrations",
    "pages": [
      "building-integrations",
      "sse-protocol"
    ]
  }
  ```

- Create `docs/api/meta.json`:
  ```json
  {
    "title": "API Reference",
    "root": true,
    "icon": "BookIcon"
  }
  ```

- Create `docs/api/.gitkeep` (empty file — API docs generated at build time)

- Create `docs/self-hosting/meta.json`:
  ```json
  {
    "title": "Self-Hosting",
    "pages": [
      "deployment",
      "reverse-proxy"
    ]
  }
  ```

- Create `docs/contributing/meta.json`:
  ```json
  {
    "title": "Contributing",
    "pages": [
      "development-setup",
      "architecture",
      "testing"
    ]
  }
  ```

**Acceptance Criteria**:
- All 7 directories exist under `docs/`
- All 7 `meta.json` files exist with correct content
- `docs/api/.gitkeep` exists
- All `meta.json` files are valid JSON
- Page references in `meta.json` match the `.mdx` filenames that will be created in subsequent tasks

**Dependencies**: None

---

### Task 2.2: Create docs/index.mdx (docs landing page)

**Objective**: Create the documentation landing page.

**Implementation**:
- Create `docs/index.mdx` with frontmatter and content:
  ```mdx
  ---
  title: DorkOS Documentation
  description: Web-based interface and REST/SSE API for Claude Code
  ---

  # DorkOS Documentation

  DorkOS is a web-based interface and REST/SSE API for Claude Code, built with the Claude Agent SDK. It provides a chat UI for interacting with Claude Code sessions, with tool approval flows and slash command discovery.

  ## Getting Started

  New to DorkOS? Start here:

  - [Installation](/docs/getting-started/installation) — Install via npm and start your first session
  - [Quickstart](/docs/getting-started/quickstart) — Walk through your first conversation
  - [Configuration](/docs/getting-started/configuration) — Environment variables and options

  ## Guides

  - [CLI Usage](/docs/guides/cli-usage) — Command-line options and workflows
  - [Obsidian Plugin](/docs/guides/obsidian-plugin) — Use DorkOS inside Obsidian
  - [Tool Approval](/docs/guides/tool-approval) — Understanding tool approval flows
  - [Keyboard Shortcuts](/docs/guides/keyboard-shortcuts) — Navigate the UI efficiently

  ## For Developers

  - [API Reference](/docs/api) — REST and SSE API documentation
  - [Building Integrations](/docs/integrations/building-integrations) — Create custom clients using the Transport interface
  - [Architecture](/docs/contributing/architecture) — System architecture overview
  ```

**Acceptance Criteria**:
- `docs/index.mdx` exists with valid frontmatter
- Contains links to key sections
- Written for external users (not internal agents)

**Dependencies**: Task 2.1 (directory structure must exist)

---

### Task 2.3: Create docs/getting-started/ section

**Objective**: Create the three Getting Started MDX files with full content.

**Implementation**:

Create `docs/getting-started/installation.mdx`:
```mdx
---
title: Installation
description: Install DorkOS via npm and start your first session
---

# Installation

## Prerequisites

- [Node.js](https://nodejs.org/) 20 or later
- npm 10 or later
- A Claude API key ([get one here](https://console.anthropic.com/))

## Install

Install DorkOS globally via npm:

\`\`\`bash
npm install -g dorkos
\`\`\`

## Set Your API Key

DorkOS needs your Anthropic API key to communicate with Claude:

\`\`\`bash
export ANTHROPIC_API_KEY=your-key-here
\`\`\`

To persist this, add it to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.).

## Start DorkOS

\`\`\`bash
dorkos
\`\`\`

The server starts on port 4242 and opens your browser automatically.

## Verify

Visit [http://localhost:4242](http://localhost:4242) to see the DorkOS interface.
```

Create `docs/getting-started/quickstart.mdx`:
```mdx
---
title: Quickstart
description: Walk through your first DorkOS conversation
---

# Quickstart

This guide walks you through your first conversation with Claude Code via DorkOS.

## Start a Session

1. Launch DorkOS with `dorkos`
2. The web interface opens in your browser
3. Type a message in the chat input and press Enter

## Working Directory

DorkOS operates in a working directory, just like Claude Code CLI. By default, it uses the directory where you launched `dorkos`. You can change the working directory using the directory picker in the sidebar.

## Tool Approval

When Claude wants to use a tool (read files, run commands, etc.), you will see an approval prompt. Review the tool call and approve or deny it.

## Slash Commands

Type `/` in the chat input to see available slash commands. These are loaded from `.claude/commands/` in your working directory.

## Sessions

Your conversations are saved as sessions. Use the sidebar to switch between sessions or start new ones. Sessions are stored as SDK transcript files and are visible across all Claude Code clients (CLI, DorkOS, etc.).
```

Create `docs/getting-started/configuration.mdx`:
```mdx
---
title: Configuration
description: Environment variables and configuration options for DorkOS
---

# Configuration

DorkOS is configured via environment variables.

## Required

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |

## Optional

| Variable | Default | Description |
|---|---|---|
| `DORKOS_PORT` | `4242` | Port for the DorkOS server |
| `DORKOS_DEFAULT_CWD` | Current directory | Default working directory for sessions |

## Tunnel Configuration

DorkOS supports ngrok tunnels for remote access.

| Variable | Description |
|---|---|
| `TUNNEL_ENABLED` | Set to `true` to enable ngrok tunnel |
| `NGROK_AUTHTOKEN` | Your ngrok authentication token |
| `TUNNEL_DOMAIN` | Custom tunnel domain (optional) |
| `TUNNEL_AUTH` | Basic auth for the tunnel in `user:pass` format (optional) |

## Config Directory

DorkOS creates a `~/.dork/` directory on startup for storing configuration.
```

**Acceptance Criteria**:
- All three `.mdx` files exist in `docs/getting-started/`
- Each has valid frontmatter with `title` and `description`
- Content is user-facing (not agent-facing)
- Commands and env vars match what is documented in CLAUDE.md

**Dependencies**: Task 2.1 (directory structure must exist)

---

### Task 2.4: Create placeholder MDX files for remaining sections

**Objective**: Create placeholder `.mdx` files for all sections defined in the content architecture that are not covered by other tasks.

**Implementation**:

Each placeholder file should have:
- Valid frontmatter (`title`, `description`)
- A heading
- A brief content outline (3-5 bullet points of what the page will cover)
- A `<!-- TODO: Write full content -->` comment

Files to create:

**docs/guides/**:
- `cli-usage.mdx` — Title: "CLI Usage", covers: running dorkos command, available flags, environment variables, config directory
- `tunnel-setup.mdx` — Title: "Tunnel Setup", covers: enabling ngrok, auth tokens, custom domains, basic auth, health check
- `slash-commands.mdx` — Title: "Slash Commands", covers: what slash commands are, `.claude/commands/` directory, frontmatter format, using commands in the UI

**docs/integrations/**:
- `building-integrations.mdx` — Title: "Building Integrations", covers: Transport interface, HttpTransport vs DirectTransport, creating custom clients, React context injection
- `sse-protocol.mdx` — Title: "SSE Protocol", covers: event types (text_delta, tool_call_start, etc.), message format, session sync events, connection lifecycle

**docs/self-hosting/**:
- `deployment.mdx` — Title: "Deployment", covers: production build, running with `npm start`, environment variables, systemd service example
- `reverse-proxy.mdx` — Title: "Reverse Proxy", covers: nginx configuration, Caddy configuration, SSE proxy considerations, WebSocket-like keep-alive

**docs/contributing/**:
- `development-setup.mdx` — Title: "Development Setup", covers: prerequisites, cloning, installing, running dev servers, running tests
- `testing.mdx` — Title: "Testing", covers: Vitest setup, running tests, writing component tests with mock Transport, writing service tests

**Acceptance Criteria**:
- All 9 placeholder `.mdx` files exist in their correct directories
- Each has valid frontmatter
- Each has a content outline
- Filenames match what is referenced in corresponding `meta.json` files

**Dependencies**: Task 2.1 (directory structure must exist)

---

## Phase 3: OpenAPI Export Pipeline

### Task 3.1: Create scripts/export-openapi.ts

**Objective**: Create a script that exports the OpenAPI spec to a static JSON file for future Fumadocs consumption.

**Implementation**:
- Create `scripts/export-openapi.ts`:
  ```typescript
  /**
   * Export the OpenAPI spec to a static JSON file.
   *
   * Used by the marketing site to generate API reference docs via Fumadocs OpenAPI plugin.
   * Run with: npm run docs:export-api
   */
  import { writeFileSync, mkdirSync } from 'fs';
  import { dirname } from 'path';
  import { generateOpenAPISpec } from '../apps/server/src/services/openapi-registry';

  const OUTPUT_PATH = 'docs/api/openapi.json';

  const spec = generateOpenAPISpec();

  // Ensure directory exists
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

  writeFileSync(OUTPUT_PATH, JSON.stringify(spec, null, 2));
  console.log(`OpenAPI spec exported to ${OUTPUT_PATH}`);
  ```

- Note: The import path `../apps/server/src/services/openapi-registry` uses the function `generateOpenAPISpec()` which is already exported from that module.

**Acceptance Criteria**:
- `scripts/export-openapi.ts` exists
- Imports `generateOpenAPISpec` from the server's openapi-registry
- Writes output to `docs/api/openapi.json`
- Creates parent directory if it doesn't exist
- Has TSDoc comment explaining purpose

**Dependencies**: Task 2.1 (docs/api/ directory should exist, but script also creates it via mkdirSync)

---

### Task 3.2: Add docs:export-api script to root package.json

**Objective**: Add the npm script to run the OpenAPI export.

**Implementation**:
- Edit `/package.json` to add the `docs:export-api` script:
  ```json
  "docs:export-api": "dotenv -- tsx scripts/export-openapi.ts"
  ```
- This should be added to the existing `"scripts"` block
- Uses `dotenv` (already a dev dependency) for env loading and `tsx` for TypeScript execution
- Check if `tsx` is already a dependency; if not, install it as a devDependency

**Acceptance Criteria**:
- `npm run docs:export-api` runs without error
- Produces `docs/api/openapi.json` with valid OpenAPI 3.1.0 content
- Script uses `dotenv` prefix consistent with other scripts

**Dependencies**: Task 3.1 (script must exist)

---

### Task 3.3: Export initial docs/api/openapi.json and add to .gitignore

**Objective**: Run the export script to generate the initial openapi.json and ensure it is gitignored (it is a build artifact).

**Implementation**:
- Run `npm run docs:export-api` to generate `docs/api/openapi.json`
- Add `docs/api/openapi.json` to `.gitignore` (this is a generated file, not source)
- Remove the `docs/api/.gitkeep` file since `openapi.json` will exist (or keep `.gitkeep` and gitignore only `openapi.json` — prefer gitignoring the generated file)
- Verify the generated JSON is valid OpenAPI 3.1.0 spec

**Acceptance Criteria**:
- `docs/api/openapi.json` can be generated by running the script
- `docs/api/openapi.json` is listed in `.gitignore`
- The generated spec has `openapi: "3.1.0"` and `info.title: "DorkOS API"`
- `docs/api/.gitkeep` remains so the directory is tracked by git

**Dependencies**: Task 3.2 (script must be wired up)

---

### Task 3.4: Add test for the OpenAPI export

**Objective**: Add a test that validates the OpenAPI spec generation.

**Implementation**:
- Create `scripts/__tests__/export-openapi.test.ts`:
  ```typescript
  import { describe, it, expect } from 'vitest';
  import { generateOpenAPISpec } from '../../apps/server/src/services/openapi-registry';

  describe('export-openapi', () => {
    it('generates valid OpenAPI 3.1.0 spec', () => {
      const spec = generateOpenAPISpec();
      expect(spec.openapi).toBe('3.1.0');
      expect(spec.info.title).toBe('DorkOS API');
      expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
    });

    it('includes all registered endpoints', () => {
      const spec = generateOpenAPISpec();
      const paths = Object.keys(spec.paths);

      // Core endpoints should be present
      expect(paths).toContain('/api/sessions');
      expect(paths).toContain('/api/health');
    });

    it('produces valid JSON when serialized', () => {
      const spec = generateOpenAPISpec();
      const json = JSON.stringify(spec, null, 2);
      expect(() => JSON.parse(json)).not.toThrow();
    });
  });
  ```

- Ensure the test file is picked up by the vitest workspace configuration. Check `vitest.workspace.ts` to see if `scripts/` is included; if not, either add it or move the test to `apps/server/src/services/__tests__/openapi-registry.test.ts` instead.

**Acceptance Criteria**:
- Test file exists and passes
- Validates OpenAPI version, title, and that paths are non-empty
- Runs with `npx vitest run` (either from scripts/ or apps/server/)

**Dependencies**: Task 3.1 (depends on the export function being importable)

---

## Phase 4: Content Migration (Incremental)

### Task 4.1: Adapt contributing/keyboard-shortcuts.md to docs/contributing/keyboard-shortcuts.mdx

**Objective**: Adapt the internal keyboard shortcuts guide into a user-facing docs page.

**Implementation**:
- Read `contributing/keyboard-shortcuts.md` for source content
- Create `docs/contributing/keyboard-shortcuts.mdx` with:
  - Frontmatter: `title: "Keyboard Shortcuts"`, `description: "Navigate DorkOS efficiently with keyboard shortcuts"`
  - Rewrite for end users (not Claude Code agents)
  - Organize shortcuts by category (navigation, chat, session management)
  - Use a table format for each shortcut group
  - Remove any internal references to FSD layers, file paths, or implementation details
  - Keep the content practical and task-oriented

**Acceptance Criteria**:
- `docs/contributing/keyboard-shortcuts.mdx` exists with valid frontmatter
- Content is rewritten for end users
- No internal file paths or implementation details
- All shortcuts from the source guide are included

**Dependencies**: Task 2.1 (directory structure)

---

### Task 4.2: Adapt contributing/interactive-tools.md to docs/guides/tool-approval.mdx

**Objective**: Adapt the internal interactive tools guide into a user-facing tool approval docs page.

**Implementation**:
- Read `contributing/interactive-tools.md` for source content
- Create `docs/guides/tool-approval.mdx` with:
  - Frontmatter: `title: "Tool Approval"`, `description: "Understanding how tool approval works in DorkOS"`
  - Explain the concept: Claude Code tools require user approval before executing
  - Describe the approval UI: what users see, how to approve/deny
  - Explain permission modes (if relevant to end users)
  - Describe the AskUserQuestion flow (Claude asks questions, user responds)
  - Remove internal implementation details (SSE events, React components, code patterns)
  - Focus on the user experience and workflow

**Acceptance Criteria**:
- `docs/guides/tool-approval.mdx` exists with valid frontmatter
- Content explains tool approval from the user's perspective
- No internal code references or implementation details
- Covers approve, deny, and question prompt flows

**Dependencies**: Task 2.1 (directory structure)

---

### Task 4.3: Adapt contributing/obsidian-plugin-development.md to docs/guides/obsidian-plugin.mdx

**Objective**: Adapt the internal Obsidian plugin development guide into a user-facing setup guide.

**Implementation**:
- Read `contributing/obsidian-plugin-development.md` for source content
- Create `docs/guides/obsidian-plugin.mdx` with:
  - Frontmatter: `title: "Obsidian Plugin"`, `description: "Use DorkOS inside Obsidian as a sidebar plugin"`
  - Focus on **setup and usage**, not development internals
  - Installation instructions (how to install the plugin in Obsidian)
  - Configuration (vault setup, API key)
  - Using the plugin (opening the sidebar, starting sessions, working directory)
  - Features available in Obsidian mode vs standalone
  - Troubleshooting common issues
  - Remove all Vite build config details, Electron compatibility internals, ItemView patterns, React mounting details

**Acceptance Criteria**:
- `docs/guides/obsidian-plugin.mdx` exists with valid frontmatter
- Content is a user setup guide, not a developer reference
- No build system or Electron internals
- Covers installation, configuration, and usage

**Dependencies**: Task 2.1 (directory structure)

---

### Task 4.4: Adapt contributing/architecture.md to docs/contributing/architecture.mdx

**Objective**: Adapt the internal architecture guide into a simplified contributor-facing architecture overview.

**Implementation**:
- Read `contributing/architecture.md` for source content
- Create `docs/contributing/architecture.mdx` with:
  - Frontmatter: `title: "Architecture"`, `description: "High-level architecture overview for DorkOS contributors"`
  - Simplified version of the architecture for contributors (not agents)
  - Key concepts: monorepo structure, hexagonal architecture, Transport interface
  - Server overview: Express, routes, services, Agent SDK integration
  - Client overview: React, FSD layers (brief), Zustand + TanStack Query
  - Data flow: how a message goes from UI to Claude and back (SSE streaming)
  - Session storage: SDK JSONL transcripts as source of truth
  - Diagram or description of the Transport abstraction (HttpTransport vs DirectTransport)
  - Remove: detailed FSD layer enforcement rules, specific file paths for every component, agent-specific instructions, PostToolUse hook details

**Acceptance Criteria**:
- `docs/contributing/architecture.mdx` exists with valid frontmatter
- Simplified but accurate architecture overview
- Covers server, client, shared package, and Transport interface
- Accessible to new contributors without deep codebase knowledge
- No agent-specific instructions

**Dependencies**: Task 2.1 (directory structure)

---

## Post-Implementation

### Task 5.1: Update CLAUDE.md to reference docs/ directory

**Objective**: Add a reference to the new `docs/` directory in `CLAUDE.md`.

**Implementation**:
- Edit `/CLAUDE.md` to add a brief section about the `docs/` directory:
  - Add to the monorepo structure diagram: `docs/` directory with description
  - Add a note in the appropriate section explaining that `docs/` contains user-facing MDX content structured for Fumadocs, while `contributing/` remains the internal developer documentation
  - Add `npm run docs:export-api` to the Commands section

**Acceptance Criteria**:
- CLAUDE.md references `docs/` directory
- Distinction between `docs/` (external) and `contributing/` (internal) is clear
- `docs:export-api` command is documented

**Dependencies**: All Phase 1-3 tasks

---

## Dependency Graph

```
Phase 0 (must complete first):
  0.1 Rename guides/ → contributing/

Phase 1 (all can run in parallel except 1.2 depends on 1.1; all depend on 0.1):
  1.1 LICENSE
  1.2 README.md  [depends on: 1.1]
  1.3 CHANGELOG.md
  1.4 CONTRIBUTING.md
  1.5 packages/cli/README.md

Phase 2 (2.1 first, then rest in parallel; all depend on 0.1):
  2.1 Scaffold docs/ structure
  2.2 docs/index.mdx  [depends on: 2.1]
  2.3 getting-started/ section  [depends on: 2.1]
  2.4 Placeholder MDX files  [depends on: 2.1]

Phase 3 (sequential):
  3.1 scripts/export-openapi.ts  [depends on: 2.1]
  3.2 Add npm script  [depends on: 3.1]
  3.3 Export initial JSON  [depends on: 3.2]
  3.4 Add test  [depends on: 3.1]

Phase 4 (all depend on 0.1 and 2.1, can run in parallel):
  4.1 keyboard-shortcuts.mdx  [depends on: 0.1, 2.1]
  4.2 tool-approval.mdx  [depends on: 0.1, 2.1]
  4.3 obsidian-plugin.mdx  [depends on: 0.1, 2.1]
  4.4 architecture.mdx  [depends on: 0.1, 2.1]

Post-Implementation:
  5.1 Update CLAUDE.md  [depends on: all Phase 0-3 tasks]
```

## Parallel Execution Opportunities

- **Phase 0**: Task 0.1 must complete before all other phases (prerequisite rename).
- **Phase 1**: Tasks 1.1, 1.3, 1.4, 1.5 can all run in parallel. Task 1.2 waits for 1.1.
- **Phase 2**: After 2.1, tasks 2.2, 2.3, 2.4 can all run in parallel.
- **Phase 3**: Tasks 3.1 and 3.4 can run together once 2.1 is done. 3.2 needs 3.1. 3.3 needs 3.2.
- **Phase 4**: All four tasks (4.1-4.4) can run in parallel after 0.1 and 2.1.
- **Cross-phase**: Phase 1 and Phase 2 can run in parallel (no dependencies between them, both only depend on 0.1).

## Critical Path

0.1 -> 2.1 -> 3.1 -> 3.2 -> 3.3 (longest chain)
All Phases -> 5.1

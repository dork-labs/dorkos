---
slug: world-class-documentation
---

# Specification: World-Class Documentation

**Status:** Draft
**Authors:** Claude Code
**Date:** 2026-02-17
**Spec Number:** 37

---

## Overview

Create world-class documentation for DorkOS by fixing the broken API docs, filling 9 stub pages with substantive content, enhancing existing pages, adding a concepts section, and adopting Fumadocs components throughout. The goal is documentation that passes the "30-second test" (what is this? is it for me? how do I start?) and provides no dead ends.

## Background / Problem Statement

An audit of the DorkOS documentation site (`apps/web` rendering MDX from `docs/`) revealed:

1. **9 of 17 MDX pages are stubs** — containing only `{/* TODO */}` comments and bullet point placeholders
2. **API docs are broken** — `apps/web/src/components/api-page.tsx` has a `'use client'` directive on what is actually a Server Component, causing "suspended by uncached promise" errors
3. **Navigation gaps** — `docs/meta.json` is missing `integrations` and `self-hosting` sections; `docs/guides/meta.json` is missing 3 of 6 guide pages
4. **Zero Fumadocs component usage** — Steps, Cards, Tabs, Callouts, TypeTable are all available but unused
5. **No concepts/explanation section** — the Diátaxis framework identifies four documentation types (tutorials, how-to guides, reference, explanation); DorkOS is missing the "explanation" layer entirely

Rich internal documentation exists in `contributing/` that can be adapted for external audiences.

## Goals

- Replace all 9 stub pages with substantive, copy-paste-runnable content
- Fix API docs rendering so `/docs/api/*` pages work correctly
- Fix all navigation gaps in meta.json files
- Adopt Fumadocs components (Steps, Cards, Tabs, Callouts, TypeTable, Files) throughout every page
- Add a `concepts/` section with 3 explanation pages (architecture, sessions, transport)
- Enhance index page with hero, Cards, and clear CTAs
- Ensure every page ends with "next steps" links (no dead ends)
- Enhance installation and quickstart pages with multi-target support

## Non-Goals

- Video tutorials, blog posts, or marketing copy
- Internationalization / translation
- Changelog population (deferred to later)
- Restructuring the existing directory/filename hierarchy (it's mostly correct)
- Creating a separate docs search system (Fumadocs built-in search is sufficient)

## Technical Dependencies

| Dependency         | Version | Purpose                                                       |
| ------------------ | ------- | ------------------------------------------------------------- |
| `fumadocs-core`    | 16.6.2  | Core docs framework, MDX processing                           |
| `fumadocs-ui`      | 16.6.2  | UI components (Callout, Steps, Cards, Tabs, TypeTable, Files) |
| `fumadocs-mdx`     | 12.1.1  | MDX source loader                                             |
| `fumadocs-openapi` | 10.3.5  | OpenAPI → MDX generation, APIPage Server Component            |
| `next`             | 16.x    | App router, Server Components                                 |

All dependencies are already installed in `apps/web/package.json`. No new packages needed.

## Detailed Design

### Phase 1: Quick Wins (Bug Fix + Navigation)

#### 1a. Fix API Docs Bug

**File:** `apps/web/src/components/api-page.tsx`

**Change:** Remove the `'use client'` directive at line 1. The `APIPage` component from `fumadocs-openapi/ui` is an async Server Component that performs file I/O to load the OpenAPI spec. The `'use client'` directive forces it into client rendering where async I/O fails.

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

#### 1b. Fix Navigation Gaps

**File:** `docs/meta.json` — Add `integrations` and `self-hosting` to the pages array, plus `concepts` (new section). Final order: `getting-started`, `guides`, `concepts`, `integrations`, `api`, `self-hosting`, `contributing`, `changelog`.

**File:** `docs/guides/meta.json` — Add `cli-usage`, `slash-commands`, `tunnel-setup` to the pages array.

**File:** `docs/concepts/meta.json` — Create new file with pages: `architecture`, `sessions`, `transport`.

### Phase 2: High-Traffic Pages

#### 2a. Rewrite `docs/getting-started/quickstart.mdx`

Full quickstart using `<Steps>` component. Target: user gets first Claude response within 5 minutes of reading.

Content outline:

1. Prerequisites (`<Callout type="info">` — Node 20+, Claude Code CLI installed)
2. Install DorkOS (`<Tabs groupId="pkg" persist>` — npm/pnpm/yarn/bun)
3. Start the server (code block with expected terminal output, `// [!code highlight]` on URL line)
4. Open the UI (browser screenshot description)
5. Send first message (example prompt, expected response)
6. Next steps (`<Cards>` linking to: CLI usage, configuration, Obsidian plugin)

Source: `packages/cli/src/cli.ts` for flags/defaults, `apps/server/src/index.ts` for startup output.

#### 2b. Write `docs/guides/cli-usage.mdx`

Full CLI reference page.

Content outline:

- Overview of `dorkos` command
- Global flags table (`<TypeTable>`) — `--port`/`-p` (number, default 4242), `--dir`/`-d` (string, cwd), `--boundary`/`-b` (string, home dir), `--tunnel`/`-t` (boolean), `--log-level`/`-l` (string, "info"), `--yes`/`-y` (boolean), `--help`/`-h`, `--version`/`-v`
- Config subcommands (`<Steps>`): `dorkos config get <key>`, `set <key> <value>`, `list`, `reset`, `edit`, `path`, `validate`
- Init wizard: `dorkos init` — interactive setup, `--yes` for non-interactive
- Config precedence (`<Callout type="info">`): CLI flags > env vars > `~/.dork/config.json` > defaults
- Examples section with real commands and expected output

Source: `packages/cli/src/cli.ts`, `packages/cli/src/config-commands.ts`, `contributing/configuration.md`.

#### 2c. Enhance `docs/index.mdx`

Landing page rewrite.

Content outline:

- Hero text: "A web UI and REST API for Claude Code" with one-line value prop
- "Who is this for?" section with 3 Cards (end users, integrators, contributors)
- Feature highlights as Cards (chat UI, tool approval, session sync, Obsidian plugin, self-hosting)
- Getting started CTA linking to quickstart
- Section navigation using `<DocsCategory>` or explicit Cards per section

#### 2d. Enhance `docs/getting-started/installation.mdx`

Content additions:

- `<Tabs groupId="install-target" persist>` for: npm CLI (global install), Obsidian plugin (community plugins), self-hosted (git clone + build)
- Package manager tabs within each target (`<Tabs groupId="pkg" persist>`)
- Verification step with expected `dorkos --version` output
- `<Callout type="warn">` for Node version requirement
- Next steps Cards

### Phase 3: Guides

#### 3a. Write `docs/guides/slash-commands.mdx`

Content outline:

- What are slash commands
- Directory structure: `.claude/commands/` with `*.md` files
- YAML frontmatter format (parsed by gray-matter): `description`, `allowed-tools`, `argument-hint`
- Creating a custom command (`<Steps>`)
- Namespace support: `project:`, `user:` namespaces from `.claude/commands/` and `~/.claude/commands/`
- How commands appear in the UI command palette
- Example: creating a `/review` command

Source: `apps/server/src/services/command-registry.ts` (CommandEntry schema, scanning logic).

#### 3b. Write `docs/guides/tunnel-setup.mdx`

Content outline:

- Why tunnels (access DorkOS from mobile, share with teammates)
- Prerequisites: ngrok account, authtoken
- Environment variables (`<TypeTable>`): `TUNNEL_ENABLED`, `NGROK_AUTHTOKEN`, `TUNNEL_PORT`, `TUNNEL_AUTH` (user:pass for basic auth), `TUNNEL_DOMAIN` (custom domain)
- Setup steps (`<Steps>`)
- Health check: `GET /api/health` includes `tunnel` field when enabled
- `<Callout type="warn">` for security (always use TUNNEL_AUTH in production)
- CLI shortcut: `dorkos --tunnel`

Source: `apps/server/src/services/tunnel-manager.ts` (TunnelConfig, TunnelStatus).

### Phase 4: Integrations & Self-Hosting

#### 4a. Write `docs/integrations/building-integrations.mdx`

Content outline:

- The Transport interface concept (hexagonal architecture port)
- `HttpTransport` — REST/SSE adapter for standalone web usage. Constructor takes `{ baseUrl }`. All methods map to HTTP endpoints.
- `DirectTransport` — In-process adapter for embedded usage (Obsidian plugin). Constructor takes service instances directly. No network overhead.
- Creating a custom Transport adapter (`<Steps>` showing the interface contract)
- React integration via `TransportProvider` context
- Key Transport methods table (`<TypeTable>`): createSession, listSessions, sendMessage, approveTool, denyTool, etc.

Source: `packages/shared/src/transport.ts`, `contributing/architecture.md`.

#### 4b. Write `docs/integrations/sse-protocol.mdx`

Content outline:

- SSE wire format overview
- Event types table (`<TypeTable>`): `text_delta`, `tool_call_start`, `tool_call_delta`, `tool_call_end`, `tool_result`, `approval_required`, `question_prompt`, `error`, `done`, `session_status`, `task_update`
- Connection lifecycle: POST `/api/sessions/:id/messages` → SSE stream
- Session sync protocol: GET `/api/sessions/:id/stream` → persistent SSE (events: `sync_connected`, `sync_update`)
- ETag caching: `If-None-Match` header on GET `/messages`, 304 responses
- Session locking: `X-Client-Id` header, 409 response when locked
- Code example: connecting with EventSource/fetch
- `<Callout type="warn">` for SSE buffering (must disable in proxies)

Source: `contributing/api-reference.md`, `packages/shared/src/schemas.ts` (StreamEvent types).

#### 4c. Write `docs/self-hosting/deployment.mdx`

Content outline:

- Build steps (`<Steps>`): `git clone`, `npm install`, `npm run build`, `npm start`
- Environment variables (`<TypeTable>`): `DORKOS_PORT`, `DORKOS_DEFAULT_CWD`, `DORKOS_BOUNDARY`, `NODE_ENV`, `ANTHROPIC_API_KEY`
- Production config recommendations (`<Callout>`)
- systemd service unit example (code block)
- Docker considerations (if applicable)
- Health check endpoint for monitoring

#### 4d. Write `docs/self-hosting/reverse-proxy.mdx`

Content outline:

- Why a reverse proxy (TLS, domain name, SSE buffering)
- nginx config (`<Tabs>` for nginx vs Caddy):
  - `proxy_buffering off` for SSE
  - `proxy_read_timeout` extended for long-lived SSE connections
  - WebSocket-like keep-alive headers
- Caddy config (simpler, auto-TLS)
- HTTPS/TLS setup notes
- `<Callout type="error">` for critical: SSE buffering must be disabled

### Phase 5: Contributing

#### 5a. Write `docs/contributing/development-setup.mdx`

Content outline:

- Prerequisites (`<Callout>`): Node 20+, npm 10+, git
- Clone and install (`<Steps>`)
- `.env` setup: copy `.env.example`, set `ANTHROPIC_API_KEY`
- Start dev servers: `npm run dev` (starts both client :3000 and server :4242)
- Project structure overview (`<Files>` / `<Folder>` component)
- Running tests: `npm test`
- Linting: `npm run lint`

Source: `CLAUDE.md` (Commands section).

#### 5b. Write `docs/contributing/architecture.mdx`

Content outline:

- System overview diagram (ASCII art): User → DorkOS Client → Transport → DorkOS Server → Claude Agent SDK → Claude API
- Hexagonal architecture explanation
- Transport interface as the core port
- FSD layers in the client (`<Files>` component showing layer hierarchy)
- Server service layer overview
- Data flow: message send → SSE stream → UI update
- Session storage: JSONL files, no separate database

Source: `contributing/architecture.md` (adapt for external audience — less implementation detail, more conceptual).

#### 5c. Write `docs/contributing/testing.mdx`

Content outline:

- Test framework: Vitest + React Testing Library
- Running tests (`<Tabs>` for all/single/watch)
- Test file location: `__tests__/` directories alongside source
- Component test pattern (`<Steps>`): mock Transport → wrap in providers → render → assert
- Service test pattern: mock `fs/promises` → call service → assert
- Hook test pattern: `renderHook` with wrapper
- Mock Transport factory: `createMockTransport()` from `@dorkos/test-utils`
- `<Callout type="info">` for jsdom environment directive requirement

Source: `.claude/rules/testing.md`, `packages/test-utils/`.

### Phase 6: Concepts Section (New)

#### 6a. Create `docs/concepts/` directory

New `docs/concepts/meta.json`:

```json
{
  "title": "Concepts",
  "pages": ["architecture", "sessions", "transport"]
}
```

Add `"concepts"` to root `docs/meta.json` between `"guides"` and `"api"`.

#### 6b. Write `docs/concepts/architecture.mdx`

User-facing system overview (not implementation details):

- What DorkOS is: a web UI + REST/SSE API for Claude Code
- How it connects: DorkOS → Claude Agent SDK → Claude API
- The three deployment modes: standalone CLI, Obsidian plugin, self-hosted
- Where data lives: JSONL transcript files on disk (no external database)

#### 6c. Write `docs/concepts/sessions.mdx`

Session model explanation:

- Sessions are JSONL files in `~/.claude/projects/{project-slug}/`
- Session ID = UUID (from filename)
- All clients see the same sessions (CLI-started, DorkOS-started, etc.)
- No separate session store — transcript files are the single source of truth
- Session metadata (title, timestamps) extracted from file content/stats

#### 6d. Write `docs/concepts/transport.mdx`

Transport abstraction explanation:

- Why it exists: decouple UI from backend (hexagonal architecture)
- `HttpTransport`: REST/SSE over the network — for standalone web usage
- `DirectTransport`: in-process function calls — for Obsidian plugin (no network)
- When to use each
- How to inject via `TransportProvider` React context

### Fumadocs Component Adoption (Applied Throughout All Pages)

Every page must use appropriate Fumadocs components:

| Component                            | Import                              | Usage                                                          |
| ------------------------------------ | ----------------------------------- | -------------------------------------------------------------- |
| `<Steps>` / `<Step>`                 | `fumadocs-ui/components/steps`      | All procedural content                                         |
| `<Cards>` / `<Card>`                 | `fumadocs-ui/components/card`       | Index page, section landings, next steps                       |
| `<Tabs>` / `<Tab>`                   | `fumadocs-ui/components/tabs`       | Install commands (groupId="pkg" persist), multi-target content |
| `<Callout type="info\|warn\|error">` | `fumadocs-ui/components/callout`    | Notes, warnings, tips                                          |
| `<TypeTable>`                        | `fumadocs-ui/components/type-table` | CLI flags, config options, env vars, event types               |
| `<Files>` / `<Folder>` / `<File>`    | `fumadocs-ui/components/files`      | Project structure diagrams                                     |
| `// [!code highlight]`               | Built-in                            | Key lines in code blocks                                       |

## User Experience

### Before (Current State)

- 9 of 17 pages show only placeholder bullet points
- API reference pages error with "suspended by uncached promise"
- Navigation sidebar is missing entire sections (integrations, self-hosting)
- No visual hierarchy — all content is plain markdown
- Dead ends — pages don't link to next steps

### After (Target State)

- All pages have substantive, runnable content
- API reference renders correctly with interactive try-it-out forms
- Full navigation sidebar with all sections visible
- Rich visual hierarchy with Steps, Cards, Tabs, Callouts, TypeTable
- Every page ends with "next steps" Cards
- New concepts section explains the system for non-contributors
- 30-second test passes: landing page immediately communicates what/who/how

## Testing Strategy

### Build Verification

- `npm run build -w apps/web` must succeed (catches MDX syntax errors, broken imports, missing frontmatter)
- All new MDX files must have valid frontmatter (`title`, `description`)
- All Fumadocs component imports must resolve

### Navigation Verification

- Every page listed in a `meta.json` must have a corresponding `.mdx` file
- Every `.mdx` file in a section must be listed in its `meta.json`
- Root `docs/meta.json` must include all section directories

### API Docs Verification

- After removing `'use client'`, verify `/docs/api/api/sessions/get` renders without errors
- Verify the OpenAPI spec at `docs/api/openapi.json` is up-to-date by running `npm run docs:export-api`

### Link Verification

- All "next steps" Cards must link to valid pages
- No broken internal links between doc pages

### Content Quality Checklist (Per Page)

- [ ] Uses appropriate Fumadocs components (not plain markdown for structured content)
- [ ] Code blocks are copy-paste-runnable
- [ ] Has "next steps" or navigation at the end
- [ ] No placeholder/TODO content remains
- [ ] Frontmatter includes `title` and `description`

## Performance Considerations

- **No runtime impact** — all changes are to MDX content and one Server Component fix
- **Build time** — adding ~15 MDX pages may slightly increase Next.js build time, but Fumadocs handles this efficiently with its MDX loader
- **Bundle size** — Fumadocs UI components are already in the bundle (imported by the docs layout); using them in MDX adds zero JS weight

## Security Considerations

- No security impact — changes are documentation content only
- The API docs bug fix (removing `'use client'`) actually improves security posture by keeping the OpenAPI spec loading server-side
- Code examples in docs should not include real API keys or secrets
- Self-hosting docs should emphasize `TUNNEL_AUTH` for production tunnel usage

## Documentation

This spec IS the documentation improvement. No additional documentation updates needed beyond what's specified in the implementation phases.

## Implementation Phases

### Phase 1: Quick Wins

- Fix API docs bug (1 line change in `api-page.tsx`)
- Regenerate API docs (`docs:export-api` + `generate:api-docs`)
- Fix `docs/meta.json` (add integrations, self-hosting, concepts)
- Fix `docs/guides/meta.json` (add 3 missing guides)
- Create `docs/concepts/meta.json`

### Phase 2: High-Traffic Pages

- Rewrite `docs/getting-started/quickstart.mdx`
- Write `docs/guides/cli-usage.mdx`
- Enhance `docs/index.mdx`
- Enhance `docs/getting-started/installation.mdx`

### Phase 3: Guides

- Write `docs/guides/slash-commands.mdx`
- Write `docs/guides/tunnel-setup.mdx`

### Phase 4: Integrations & Self-Hosting

- Write `docs/integrations/building-integrations.mdx`
- Write `docs/integrations/sse-protocol.mdx`
- Write `docs/self-hosting/deployment.mdx`
- Write `docs/self-hosting/reverse-proxy.mdx`

### Phase 5: Contributing

- Write `docs/contributing/development-setup.mdx`
- Write `docs/contributing/architecture.mdx`
- Write `docs/contributing/testing.mdx`

### Phase 6: Concepts Section

- Create `docs/concepts/architecture.mdx`
- Create `docs/concepts/sessions.mdx`
- Create `docs/concepts/transport.mdx`
- Update root `docs/meta.json` with concepts section

## Acceptance Criteria

1. All 9 stub pages replaced with substantive content (no TODO comments remain)
2. API docs render correctly at `/docs/api/*` without console errors
3. All pages use appropriate Fumadocs components (Steps, Cards, Tabs, Callouts, TypeTable)
4. All `meta.json` files list all their child pages (no navigation gaps)
5. `concepts/` section exists with 3 pages (architecture, sessions, transport)
6. Index page has hero text, feature Cards, and clear CTAs
7. Every guide/page has "next steps" links (no dead ends)
8. All code blocks are copy-paste-runnable
9. `npm run build -w apps/web` succeeds
10. New content draws from internal `contributing/` docs and source code for accuracy

## Open Questions

None — all clarifications were resolved during ideation:

- Concepts section: Yes, add it
- Quickstart strategy: One quickstart (npm CLI) + install target Cards
- Fumadocs components: Full adoption
- Changelog: Deferred to later
- API docs: Fix bug + regenerate
- Priority: Quick wins first, then systematic content fill

## References

- [Ideation document](../world-class-documentation/01-ideation.md)
- [Research: World-Class Developer Docs](../../research/20260217_world_class_developer_docs.md)
- [Diátaxis Framework](https://diataxis.fr/)
- [Fumadocs Documentation](https://fumadocs.dev/)
- [Contributing: API Reference](../../contributing/api-reference.md)
- [Contributing: Architecture](../../contributing/architecture.md)
- [Contributing: Configuration](../../contributing/configuration.md)

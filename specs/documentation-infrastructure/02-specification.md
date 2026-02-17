# Documentation Infrastructure

## Status

Draft

## Authors

Claude (spec:create) — 2026-02-16

## Overview

Establish the documentation infrastructure for DorkOS as an open-source npm package. This spec covers two concerns: (1) scaffolding a `docs/` directory in this repo with MDX content structured for Fumadocs consumption, and (2) creating the standard OSS files (README, CHANGELOG, CONTRIBUTING, CLI README) that are currently missing or stale.

The docs content lives in this repo alongside the code it documents. A separate Next.js marketing site (future, out of scope) will consume `docs/` at build time via git submodule and render it at `docs.dorkos.ai` using Fumadocs.

### Documentation Directory Convention

The repo uses two documentation directories with distinct audiences:

| Directory | Audience | Format | Purpose |
|---|---|---|---|
| `contributing/` | Maintainers & Claude Code agents | Markdown | Deep implementation details, code patterns, FSD layers, internal workflows |
| `docs/` | External users & integrators | MDX (Fumadocs) | Task-oriented guides, API reference, getting started, contributor onboarding |

The `contributing/` directory (formerly `guides/`) contains internal developer documentation optimized for people (and AI agents) actively working on the DorkOS codebase. The `docs/` directory contains user-facing content published to `docs.dorkos.ai`.

Note: `docs/contributing/` is a subsection of the Fumadocs site (simplified contributor onboarding for external contributors), while root-level `contributing/` contains deep internal documentation. These serve different audiences at different depths.

## Background / Problem Statement

DorkOS is preparing for open-source release as an npm package (`dorkos`). The current documentation situation has several gaps:

1. **Stale README** — References pre-monorepo structure, missing CLI install instructions, incomplete env vars and API endpoints
2. **No CHANGELOG** — Git history exists but no human-readable changelog for npm consumers
3. **No CONTRIBUTING.md** — No contributor onboarding guide despite being open-source
4. **No CLI README** — `packages/cli/README.md` is missing; this is what npm displays on the package page
5. **No LICENSE file** — MIT is declared in package.json but no root LICENSE file exists
6. **Internal-only docs** — 13 detailed guides in `contributing/` (formerly `guides/`) but written for internal development (Claude Code agents), not external users
7. **No docs publishing pipeline** — API docs exist via Scalar UI at `/api/docs` but only on running instances; no static public docs site

## Goals

- Scaffold `docs/` directory with MDX content structured for Fumadocs consumption
- Rewrite root README.md for open-source consumers and npm users
- Create CHANGELOG.md with Keep a Changelog format
- Create CONTRIBUTING.md with contributor onboarding
- Create `packages/cli/README.md` for the npm package page
- Add root LICENSE file (MIT)
- Define the content architecture that maps existing `contributing/` (formerly `guides/`) to user-facing docs
- Establish the OpenAPI-to-docs pipeline so API reference can be published statically
- Add a `scripts/generate-api-docs.ts` that exports the OpenAPI spec to a JSON file for future Fumadocs consumption

## Non-Goals

- Building the Next.js marketing site (separate repo, future work)
- Setting up Fumadocs, Vercel deployment, or the docs.dorkos.ai subdomain
- Writing all docs content from scratch — this spec creates the structure and key files; content will be adapted from existing `contributing/` incrementally
- Versioned documentation (latest-only for now; versioning deferred to post-1.0)
- Removing or replacing the existing `contributing/` directory (it continues to serve as internal dev docs and Claude Code agent context)
- Search integration, i18n, or analytics for the docs site

## Technical Dependencies

| Dependency | Purpose | Notes |
|---|---|---|
| Fumadocs | Docs framework | Not installed in this repo — only the content structure is created here. Fumadocs lives in the marketing site repo. |
| `@asteasolutions/zod-to-openapi` | OpenAPI generation | Already installed; used by `openapi-registry.ts` |
| MDX | Content format | `.mdx` files in `docs/` — no build tooling needed in this repo |

No new dependencies are added to this repo. The `docs/` directory contains plain MDX files and JSON configuration that Fumadocs will consume from the marketing site.

## Detailed Design

### 1. Content Architecture (`docs/`)

The `docs/` directory follows Fumadocs conventions: MDX files for content, `meta.json` for navigation ordering.

```
docs/
├── index.mdx                      # Docs landing page
├── meta.json                      # Root navigation order
├── getting-started/
│   ├── meta.json
│   ├── installation.mdx           # npm install, prerequisites
│   ├── quickstart.mdx             # First session walkthrough
│   └── configuration.mdx          # Env vars, config options
├── guides/
│   ├── meta.json
│   ├── cli-usage.mdx              # CLI commands and options
│   ├── obsidian-plugin.mdx        # Obsidian plugin setup (adapted from contributing/)
│   ├── tunnel-setup.mdx           # ngrok tunnel configuration
│   ├── tool-approval.mdx          # Tool approval flows (adapted from contributing/)
│   ├── slash-commands.mdx         # Slash command usage
│   └── keyboard-shortcuts.mdx     # Shortcuts reference (adapted from contributing/)
├── integrations/
│   ├── meta.json
│   ├── building-integrations.mdx  # Transport interface, custom clients
│   └── sse-protocol.mdx           # SSE streaming protocol reference
├── api/
│   ├── meta.json                  # Auto-generated by Fumadocs OpenAPI plugin
│   └── .gitkeep                   # Placeholder — API docs generated at build time
├── self-hosting/
│   ├── meta.json
│   ├── deployment.mdx             # Production deployment guide
│   └── reverse-proxy.mdx          # nginx/Caddy configuration
└── contributing/
    ├── meta.json
    ├── development-setup.mdx      # Dev environment setup
    ├── architecture.mdx           # Architecture overview (adapted from contributing/)
    └── testing.mdx                # Testing patterns
```

### 2. Navigation Configuration

Each `meta.json` controls sidebar ordering in Fumadocs.

**Root `docs/meta.json`:**
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

**Section-level example (`docs/getting-started/meta.json`):**
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

**API section (`docs/api/meta.json`):**
```json
{
  "title": "API Reference",
  "root": true,
  "icon": "BookIcon"
}
```

### 3. MDX Frontmatter Convention

All docs use this frontmatter schema (validated by Fumadocs + Zod in the marketing site):

```yaml
---
title: Installation
description: Install DorkOS via npm and start your first session
---
```

Only `title` is required. `description` is recommended for SEO. No custom fields needed for v1.

### 4. Content Strategy: contributing/ vs docs/

| `contributing/` (internal) | `docs/` (external) |
|---|---|
| Written for Claude Code agents and maintainers | Written for end users and integrators |
| Deep implementation details, code patterns | Task-oriented, outcome-focused |
| References internal file paths and FSD layers | References public APIs and CLI commands |
| Stays in repo, not published | Published to docs.dorkos.ai |

The directory name `contributing/` (formerly `guides/`) makes the audience self-documenting: this content is for people contributing to DorkOS development.

Some `contributing/` content will be adapted into `docs/`:
- `contributing/architecture.md` → `docs/contributing/architecture.mdx` (simplified)
- `contributing/interactive-tools.md` → `docs/guides/tool-approval.mdx` (user-facing)
- `contributing/keyboard-shortcuts.md` → `docs/guides/keyboard-shortcuts.mdx` (direct adaptation)
- `contributing/obsidian-plugin-development.md` → `docs/guides/obsidian-plugin.mdx` (setup only, not dev internals)
- `contributing/api-reference.md` → Replaced by auto-generated API docs

### 5. OpenAPI Spec Export

Add a script that exports the OpenAPI spec to a static JSON file. This file will be consumed by the marketing site's Fumadocs OpenAPI plugin at build time.

**`scripts/export-openapi.ts`:**
```typescript
import { writeFileSync } from 'fs';
import { generateOpenAPISpec } from '../apps/server/src/services/openapi-registry';

const spec = generateOpenAPISpec();
writeFileSync('docs/api/openapi.json', JSON.stringify(spec, null, 2));
console.log('OpenAPI spec exported to docs/api/openapi.json');
```

**Root `package.json` addition:**
```json
{
  "scripts": {
    "docs:export-api": "dotenv -- tsx scripts/export-openapi.ts"
  }
}
```

The marketing site's build step will:
1. Clone/submodule this repo
2. Run `npm run docs:export-api` to generate the spec
3. Use `fumadocs-openapi` to render API docs from the spec

### 6. Root README.md Rewrite

The new README targets two audiences: **npm users** (quick install + run) and **open-source contributors** (dev setup). Structure:

```
# DorkOS

[One-line description]
[Badges: npm version, license, GitHub stars]

## What is DorkOS?
[2-3 sentences: web UI + REST API for Claude Code]

## Install
[npm install -g dorkos / dorkos]

## Screenshot
[Screenshot or GIF of the UI]

## Features
[Bullet list of key features]

## Documentation
[Link to docs.dorkos.ai]

## Development
[Quick dev setup for contributors]

## Contributing
[Link to CONTRIBUTING.md]

## License
[MIT]
```

### 7. CHANGELOG.md

Use [Keep a Changelog](https://keepachangelog.com/) format. Initialize with an `[Unreleased]` section and a `[0.1.0]` section covering the initial release. The existing `changelog-populator.py` git hook will populate future entries.

### 8. CONTRIBUTING.md

Covers:
- Prerequisites (Node.js 20+, npm, Claude API key)
- Fork + clone + install workflow
- Monorepo structure overview (apps, packages)
- Running dev servers, tests, linting
- FSD architecture rules (link to `contributing/01-project-structure.md`)
- PR process and commit conventions
- Link to Code of Conduct (future)

### 9. packages/cli/README.md

This is the npm package page. Covers:
- What DorkOS is (brief)
- Installation (`npm install -g dorkos`)
- Usage (`dorkos` command, flags, env vars)
- Configuration (`~/.dork/` directory, env vars)
- Tunnel support (ngrok)
- Link to full docs at docs.dorkos.ai
- Link to GitHub repo
- License

### 10. LICENSE File

MIT license text with `Copyright (c) 2025 Dork Labs` at the root of the repo.

## User Experience

**npm user journey:**
1. Discovers `dorkos` on npm → reads `packages/cli/README.md` (rendered on npmjs.com)
2. Installs globally → `npm install -g dorkos`
3. Runs `dorkos` → server starts, opens browser
4. Needs help → clicks "Documentation" link → `docs.dorkos.ai`
5. Wants to integrate → reads API reference and SSE protocol docs

**Contributor journey:**
1. Finds repo on GitHub → reads root `README.md`
2. Wants to contribute → reads `CONTRIBUTING.md`
3. Sets up dev environment → follows dev setup guide
4. Explores architecture → `docs/contributing/architecture.mdx` or `contributing/` for deeper internals

## Testing Strategy

No automated tests for documentation content. Validation is structural:

- **CI check**: Verify all `meta.json` files are valid JSON and reference existing `.mdx` files
- **Link checking**: Dead link detection in MDX files (deferred to marketing site CI)
- **OpenAPI export**: `npm run docs:export-api` runs without error (can be added to CI)

### Test: OpenAPI export script

```typescript
// scripts/__tests__/export-openapi.test.ts
describe('export-openapi', () => {
  it('generates valid OpenAPI 3.1.0 spec', () => {
    const spec = generateOpenAPISpec();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('DorkOS API');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });
});
```

## Performance Considerations

None — this spec only adds static files (MDX, JSON, Markdown). No runtime impact on the server or client.

The OpenAPI export script runs in < 1 second (in-memory schema generation, single file write).

## Security Considerations

- **No secrets in docs**: MDX content must not contain API keys, tokens, or internal URLs
- **OpenAPI spec exposure**: The exported `openapi.json` is intentionally public — it describes the same endpoints already documented in the README and accessible via `/api/docs`
- **LICENSE file**: Explicitly declares MIT license, clarifying legal terms for contributors and users

## Documentation

This spec IS the documentation plan. After implementation:
- Update `CLAUDE.md` to reference the new `docs/` directory
- Add a `docs/README.md` explaining the content structure for contributors who want to edit docs

## Implementation Phases

### Phase 1: OSS Files (Core)

Create the standard open-source files:
- `LICENSE` (MIT)
- Rewrite `README.md`
- Create `CHANGELOG.md`
- Create `CONTRIBUTING.md`
- Create `packages/cli/README.md`

### Phase 2: Docs Content Structure

Scaffold the `docs/` directory:
- Create directory structure with `meta.json` files
- Create `docs/index.mdx` (docs landing page)
- Create `docs/getting-started/` section (installation, quickstart, configuration)
- Create placeholder `.mdx` files for all other sections with frontmatter and brief content outlines

### Phase 3: OpenAPI Export Pipeline

- Create `scripts/export-openapi.ts`
- Add `docs:export-api` script to root `package.json`
- Export initial `docs/api/openapi.json`
- Add test for the export script

### Phase 4: Content Migration (Incremental)

Adapt existing `contributing/` content into user-facing `docs/` pages:
- `contributing/keyboard-shortcuts.md` → `docs/guides/keyboard-shortcuts.mdx`
- `contributing/interactive-tools.md` → `docs/guides/tool-approval.mdx`
- `contributing/obsidian-plugin-development.md` → `docs/guides/obsidian-plugin.mdx`
- `contributing/architecture.md` → `docs/contributing/architecture.mdx`

This phase is incremental and can be done over multiple PRs.

## Open Questions

1. **Screenshot/GIF for README**: Do we have a current screenshot of the UI to include in the README? If not, should we capture one as part of this work?
2. **Code of Conduct**: Should we adopt a standard CoC (e.g., Contributor Covenant) now or defer?
3. **Marketing site repo name**: Will it be `dork-labs/dorkos-web`, `dork-labs/website`, or something else? Affects submodule setup docs.
4. **Copyright holder**: Is it "Dork Labs" or another entity for the LICENSE file?
5. **Existing contributing/ cleanup**: Some files in `contributing/` are heavily agent-focused (e.g., `13-autonomous-roadmap-execution.md`). Should these be excluded from the public repo entirely, or are they fine as internal docs?

## References

- [Fumadocs documentation](https://fumadocs.dev)
- [Keep a Changelog](https://keepachangelog.com/)
- [Fumadocs OpenAPI integration](https://fumadocs.dev/docs/integrations/openapi)
- [Scalar API documentation](https://github.com/scalar/scalar)
- Existing internal docs: `contributing/`, `CLAUDE.md`, `contributing/api-reference.md`
- npm package: [npmjs.com/package/dorkos](https://www.npmjs.com/package/dorkos)
- GitHub: [github.com/dork-labs/dorkos](https://github.com/dork-labs/dorkos)

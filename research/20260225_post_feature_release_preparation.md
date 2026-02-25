# Post-Feature Release Preparation: Relay + Mesh for DorkOS

**Date:** 2026-02-25
**Research Mode:** Deep Research
**Context:** DorkOS v0.3.0 → v0.4.0 (Relay + Mesh features)

---

## Research Summary

After building the Relay (inter-agent messaging) and Mesh (agent discovery/registry) subsystems, DorkOS needs a coordinated release preparation across four domains: documentation, CHANGELOG/versioning, npm publishing verification, and marketing site updates. This report provides structured, project-specific recommendations grounded in current best practices. The current version is `0.3.0`; Relay + Mesh constitute new backward-compatible features, making this a **minor release (0.4.0)**.

---

## Key Findings

### 1. Version Decision: 0.4.0 (Minor)
Relay and Mesh add new opt-in capabilities behind feature flags (`DORKOS_RELAY_ENABLED`, `DORKOS_MESH_ENABLED`). No existing API contracts are broken. Per SemVer: new backward-compatible functionality = MINOR bump. If either feature involved removing/changing existing endpoints, it would be MAJOR.

### 2. Documentation Gap: No Relay or Mesh Docs Exist
The `docs/` tree has thorough coverage of sessions, transport, Pulse, and integrations — but no pages for Relay or Mesh at all. Both features have significant surface area (new env vars, REST endpoints, MCP tools, SSE event types, Zod schemas) that must be documented before a public release.

### 3. package.json Is Largely Sound But Has Gaps
The CLI package.json is well-structured (has `files`, `bin`, `engines`, `type: module`, `license`, `repository`). Key gaps: (a) `keywords` do not reflect new capabilities, (b) no `exports` field for potential future subpath exports from `@dorkos/shared`, (c) `@anthropic-ai/claude-agent-sdk: latest` is a risky dependency pin.

### 4. No Changesets / Automated Versioning Tooling
The project currently lacks Changesets or any automated changelog tooling. The `changelog.mdx` is manually maintained. This works at current scale but will become painful with more frequent releases.

### 5. Marketing Site Has No Feature Spotlight Pattern
The `docs/index.mdx` is a navigation hub. There is no blog post, "What's New" callout, or feature spotlight for Relay or Mesh. These features need both documentation and a discovery surface.

---

## Detailed Analysis

### Section 1: Documentation Architecture for Relay and Mesh

#### The Diátaxis Framework (Recommended)

The industry-standard framework for technical documentation is [Diátaxis](https://diataxis.fr/), which separates content into four distinct types based on user need:

| Type | Purpose | User Mindset |
|---|---|---|
| **Tutorial** | Learning-oriented, guided experience | "I want to learn this" |
| **How-to Guide** | Task-oriented, practical steps | "I want to accomplish X" |
| **Reference** | Information-oriented, exhaustive facts | "I need to look this up" |
| **Explanation/Concept** | Understanding-oriented, background context | "I want to understand why" |

DorkOS's existing docs structure maps well onto this: `concepts/` = Explanation, `guides/` = How-to, `api/` = Reference, `getting-started/` = Tutorial.

#### Required Docs for Relay

**Concepts (Explanation):**
- `docs/concepts/relay.mdx` — What is Relay, why it exists, the message envelope model, pub/sub topology, delivery guarantees, trace model. Answers: "How does inter-agent messaging work in DorkOS?"

**Guides (How-to):**
- `docs/guides/relay-getting-started.mdx` — Enable Relay (`DORKOS_RELAY_ENABLED=true`), understand the SSE event types (`relay_message`, `relay_receipt`, `message_delivered`), send a message via API, use the Relay panel in the UI.
- `docs/guides/relay-adapters.mdx` — How ClaudeCodeAdapter works, how Pulse integrates with Relay dispatch, writing custom adapters.
- `docs/guides/relay-access-control.mdx` — Subject-based ACL, configuring endpoint permissions, dead-letter queue behavior.

**Reference:**
- Relay is partially covered by auto-generated OpenAPI at `/docs/api`. Verify all Relay endpoints appear in `openapi.json` (POST/GET /messages, GET /endpoints, GET /inbox, GET /dead-letters, GET /metrics, GET /stream SSE).
- Consider a `docs/integrations/relay-mcp-tools.mdx` covering the MCP tool surface: `relay_send`, `relay_inbox`, `relay_list_endpoints`, `relay_get_trace`, `relay_get_metrics`.

#### Required Docs for Mesh

**Concepts (Explanation):**
- `docs/concepts/mesh.mdx` — What is Mesh, the discovery vs. registry distinction, agent manifests, health model, lifecycle events, topology graph. Answers: "How does agent discovery work in DorkOS?"

**Guides (How-to):**
- `docs/guides/mesh-getting-started.mdx` — Enable Mesh (`DORKOS_MESH_ENABLED=true`), discover agents via POST /discover, register via POST /agents, use the Mesh panel and topology graph.
- `docs/guides/mesh-agent-manifests.mdx` — How to write an `AgentManifest`, required vs. optional fields, capability declarations.
- `docs/guides/mesh-access-control.mdx` — Denying agents, managing the denied list, understanding the access control model.

**Reference:**
- Verify Mesh endpoints appear in OpenAPI: POST /discover, POST/GET/PATCH/DELETE /agents, POST /deny, GET/DELETE /denied, GET /status, GET /agents/:id/health, POST /agents/:id/heartbeat.
- `docs/integrations/mesh-mcp-tools.mdx` covering: `mesh_discover`, `mesh_register`, `mesh_deny`, `mesh_list`, `mesh_unregister`, `mesh_status`, `mesh_inspect`.

#### Fumadocs Structure Updates

Fumadocs uses `meta.json` files to control sidebar ordering. Two approaches for Relay/Mesh:

**Option A: Add to existing sections (lower friction)**

Add Relay and Mesh as new entries under `docs/concepts/meta.json` and `docs/guides/meta.json`. Good for incremental docs growth.

```json
// docs/concepts/meta.json
{
  "title": "Concepts",
  "pages": ["architecture", "sessions", "transport", "relay", "mesh"]
}

// docs/guides/meta.json
{
  "title": "Guides",
  "pages": [
    "cli-usage",
    "obsidian-plugin",
    "tool-approval",
    "slash-commands",
    "tunnel-setup",
    "keyboard-shortcuts",
    "relay-getting-started",
    "relay-adapters",
    "relay-access-control",
    "mesh-getting-started",
    "mesh-agent-manifests",
    "mesh-access-control"
  ]
}
```

**Option B: Add top-level sections (recommended for two major subsystems)**

Create `docs/relay/` and `docs/mesh/` as top-level doc sections, each with their own `meta.json`. Add these to `docs/meta.json`:

```json
// docs/meta.json
{
  "title": "Documentation",
  "pages": [
    "getting-started",
    "guides",
    "concepts",
    "relay",
    "mesh",
    "integrations",
    "api",
    "self-hosting",
    "contributing",
    "changelog"
  ]
}
```

This scales better as Relay and Mesh grow and gives each subsystem a discoverable home in the nav.

#### MDX Doc Frontmatter Pattern

Each MDX file should follow the existing pattern with `title` and `description` frontmatter:

```mdx
---
title: Relay
description: Inter-agent messaging with subject-based pub/sub routing, delivery guarantees, and distributed tracing.
---

import { Callout } from 'fumadocs-ui/components/callout'
import { Tab, Tabs } from 'fumadocs-ui/components/tabs'

<Callout type="info">
  Relay requires `DORKOS_RELAY_ENABLED=true` and is disabled by default.
</Callout>
```

Use Fumadocs components liberally: `<Callout>` for feature-flag warnings, `<Tabs>` for showing different env var configurations, `<Cards>` for linking to sub-guides.

---

### Section 2: CHANGELOG and Versioning

#### Current State

The `docs/changelog.mdx` is manually maintained, follows Keep a Changelog format, and is accurate. This is a solid foundation.

#### Keep a Changelog Principles (Applied to v0.4.0)

From [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), the standard entry structure:

```markdown
## [0.4.0] - 2026-02-25

### Added

- Add Relay inter-agent messaging subsystem with subject-based pub/sub routing,
  delivery guarantees, distributed tracing (SQLite), and SSE streaming
- Add Relay REST API: POST/GET /messages, GET /endpoints, GET /inbox,
  GET /dead-letters, GET /metrics, GET /stream SSE
- Add Relay MCP tools: relay_send, relay_inbox, relay_list_endpoints,
  relay_get_trace, relay_get_metrics
- Add Relay panel in UI with activity feed, message rows, endpoint list,
  inbox view, message trace, and delivery metrics dashboard
- Add Mesh agent discovery and registry with manifest-based discovery,
  health monitoring, lifecycle events, and network topology graph
- Add Mesh REST API: POST /discover, POST/GET/PATCH/DELETE /agents,
  POST /deny, GET/DELETE /denied, GET /status, GET /agents/:id/health
- Add Mesh MCP tools: mesh_discover, mesh_register, mesh_deny, mesh_list,
  mesh_unregister, mesh_status, mesh_inspect
- Add Mesh panel in UI: candidate cards, agent cards, register dialog,
  topology graph, stats header, health detail, and Access tab
- Add ClaudeCodeAdapter for Relay-based session dispatch
- Add Relay trace store (SQLite) for end-to-end message delivery tracking
- Add adapter manager for server-side adapter lifecycle management

### Changed

- Session POST endpoint returns 202 + receipt when DORKOS_RELAY_ENABLED=true
- SSE stream carries additional relay event types when Relay enabled
- Pulse scheduler routes job dispatch through Relay when DORKOS_RELAY_ENABLED=true
```

#### Automating Future Changelogs

For the current release, manual is fine. For future releases, consider adopting [Changesets](https://github.com/changesets/changesets) — the tool Turborepo officially recommends:

```bash
npm install -D @changesets/cli -w packages/cli
npx changeset init
```

Workflow per PR:
1. `npx changeset` — describe what changed (patch/minor/major)
2. PR review includes the changeset file
3. On merge to main: `npx changeset version` bumps versions + updates CHANGELOG
4. `npx changeset publish` publishes to npm

This fits naturally into the Turborepo workflow: `turbo run build lint test && changeset version && changeset publish`.

#### Semver Decision for Relay + Mesh

- Both features are **opt-in via env flag** — users who don't set `DORKOS_RELAY_ENABLED` or `DORKOS_MESH_ENABLED` see no change.
- No existing endpoints are removed or breaking-changed.
- New endpoints, event types, and MCP tools are additive.
- **Decision: 0.4.0 (minor bump)** is correct.

If a future release removes the legacy (non-Relay) message path or changes existing endpoint shapes, that would be **major**.

---

### Section 3: npm Publishing Preparation

#### Current package.json Analysis

The CLI `packages/cli/package.json` is reviewed against current best practices:

**Strengths:**
- `"type": "module"` — correct for ESM-first package
- `"bin"` field is present with correct path
- `"files"` array restricts what gets published (good — only `dist/`, `LICENSE`, `README.md`)
- `"engines"` specifies Node >= 18
- `"license"`, `"author"`, `"repository"`, `"homepage"`, `"bugs"` all present
- `"prepublishOnly"` runs the build automatically

**Issues and Recommendations:**

**1. Risky Dependency Pin: `@anthropic-ai/claude-agent-sdk: latest`**

Using `latest` for a core SDK dependency is dangerous — a breaking SDK change would silently break all installed versions of `dorkos`. Fix:

```json
"@anthropic-ai/claude-agent-sdk": "^0.x.y"  // pin to current major.minor
```

Run `npm ls @anthropic-ai/claude-agent-sdk` to find the exact version currently installed, then pin to it with a `^` range.

**2. Keywords Don't Reflect New Features**

Current keywords: `claude, claude-code, agent-sdk, dorkos, ai-platform, webui, sse, rest-api`

Add for discoverability with Relay and Mesh:

```json
"keywords": [
  "claude",
  "claude-code",
  "agent-sdk",
  "dorkos",
  "ai-platform",
  "webui",
  "sse",
  "rest-api",
  "multi-agent",
  "agent-messaging",
  "agent-discovery",
  "relay",
  "mesh",
  "pub-sub",
  "mcp"
]
```

**3. No `exports` Field**

Since this is a CLI (`bin` package), subpath exports are not critical for `dorkos` itself. However, `packages/shared` (which exports Zod schemas used by external integrators) may benefit from an explicit `exports` map if it becomes publishable in the future. For now, confirm `@dorkos/shared` is private (internal workspace dependency only).

**4. publint Validation (Run Before Publish)**

Install and run [publint](https://publint.dev/) against the built package:

```bash
cd packages/cli
npm run build
npx publint
```

Key things publint will catch:
- Binary files missing shebangs (the CLI entry needs `#!/usr/bin/env node`)
- Export conditions in wrong order (`types` must be first, `default` must be last)
- Referenced files that don't exist after build
- Missing `"files"` field to scope the published artifact

**5. Are-The-Types-Wrong (ATTW)**

If `@dorkos/shared` ever becomes publishable, run ATTW before publish:

```bash
npx @arethetypeswrong/cli packages/shared
```

This catches TypeScript declaration file misconfiguration that publint doesn't cover.

**6. Dry-Run Before Publish**

Always do a dry run to verify what files will be included:

```bash
npm pack --dry-run -w packages/cli
```

Check the output list: it should only contain `dist/`, `package.json`, `README.md`, `LICENSE`. If anything unexpected appears, update the `"files"` array.

**7. README.md Is in `files` but Needs Updating**

Verify `packages/cli/README.md` (or repo root `README.md` if that is what ships) mentions Relay and Mesh. The README is the npm package page's content — it's the first thing people see.

#### Pre-Publish Checklist (Ordered)

```
Pre-publish checklist for dorkos 0.4.0:

[ ] 1. Pin @anthropic-ai/claude-agent-sdk to a specific version range (not "latest")
[ ] 2. Update version in packages/cli/package.json to 0.4.0
[ ] 3. Update keywords array to include relay, mesh, multi-agent, pub-sub, mcp
[ ] 4. Update README.md to document Relay and Mesh features
[ ] 5. Run full build: npm run build -w packages/cli
[ ] 6. Run publint: npx publint (from packages/cli/)
[ ] 7. Dry-run: npm pack --dry-run -w packages/cli — verify file list
[ ] 8. Run tests: npm test -- --run
[ ] 9. Run typecheck: npm run typecheck
[ ] 10. Verify the binary shebang is present in dist/bin/cli.js
[ ] 11. Update docs/changelog.mdx with 0.4.0 entry
[ ] 12. Commit and tag: git tag v0.4.0
[ ] 13. Publish: npm publish -w packages/cli
[ ] 14. Verify on npm: npx dorkos@0.4.0 --version
```

---

### Section 4: Marketing Site and Feature Announcement

#### What the Site Currently Has

The `docs/index.mdx` is a navigation hub with `<Cards>` for each section. There is no dedicated "What's New" or "Blog" page referenced in the nav — although the `docs/changelog.mdx` exists and 0.3.0 notes mention "blog infrastructure."

#### Recommended Announcement Patterns

**Pattern 1: What's New Callout on the Index Page**

Add a temporary `<Callout>` at the top of `docs/index.mdx` for new major features:

```mdx
import { Callout } from 'fumadocs-ui/components/callout'

<Callout type="info" title="New in 0.4.0: Relay & Mesh">
  DorkOS now supports **inter-agent messaging** (Relay) and **agent discovery** (Mesh).
  [Learn about Relay →](/docs/relay) · [Learn about Mesh →](/docs/mesh)
</Callout>
```

Remove after one release cycle.

**Pattern 2: Blog Post (Release Notes Post)**

If the blog infrastructure mentioned in the 0.3.0 changelog is functional, publish a release notes post:

```
apps/web/content/blog/0-4-0-relay-mesh.mdx
```

A good release notes post structure:
1. **TL;DR / Summary** — 2-3 sentences, what shipped and why it matters
2. **Feature spotlight: Relay** — what problem it solves, one code/config snippet
3. **Feature spotlight: Mesh** — same treatment
4. **How to upgrade** — `npm install -g dorkos@latest` + new env vars to set
5. **What's next** — tease the roadmap

**Pattern 3: Changelog Page Update**

The `docs/changelog.mdx` is already linked in `docs/meta.json`. Add the 0.4.0 entry there first — it is the lowest-friction announcement and is immediately visible to users checking the docs.

**Pattern 4: Feature Cards on Index**

Add `<Cards>` for Relay and Mesh to `docs/index.mdx` alongside the existing concepts section:

```mdx
## Agent Coordination

<Cards>
  <Card title="Relay" href="/docs/relay">
    Inter-agent messaging with subject-based pub/sub and delivery tracing.
  </Card>
  <Card title="Mesh" href="/docs/mesh">
    Agent discovery, registry, and network topology visualization.
  </Card>
  <Card title="Pulse" href="/docs/guides/pulse">
    Autonomous cron-scheduled agent jobs.
  </Card>
</Cards>
```

This gives Relay and Mesh permanent discoverability on the homepage.

---

### Section 5: OpenAPI Coverage Verification

Before release, verify the Relay and Mesh routes are properly registered in `openapi-registry.ts` so that `/api/openapi.json` includes them. Run:

```bash
npm run docs:export-api
```

Then inspect the output at `docs/api/openapi.json`. Confirm:
- All `/api/relay/*` endpoints appear with request/response schemas
- All `/api/mesh/*` endpoints appear with request/response schemas
- SSE stream endpoints (`GET /relay/stream`, `GET /mesh/...`) are documented

If any endpoints are missing, add them to `openapi-registry.ts` before publishing. The auto-generated API reference at `/docs/api` is one of the most valuable parts of the docs.

---

## Recommended Docs File Structure

Given the above analysis, the target docs tree for 0.4.0:

```
docs/
├── relay/
│   ├── meta.json          # { "title": "Relay", "pages": ["index", "adapters", "access-control", "mcp-tools"] }
│   ├── index.mdx          # Concept: what is Relay, message model, delivery guarantees
│   ├── adapters.mdx       # How-to: ClaudeCodeAdapter, custom adapters
│   ├── access-control.mdx # How-to: ACL, subject permissions, dead-letter queue
│   └── mcp-tools.mdx      # Reference: relay_send, relay_inbox, relay_get_trace, etc.
├── mesh/
│   ├── meta.json          # { "title": "Mesh", "pages": ["index", "agent-manifests", "access-control", "mcp-tools"] }
│   ├── index.mdx          # Concept: what is Mesh, discovery vs registry, health model
│   ├── agent-manifests.mdx # How-to: writing AgentManifest, capability declarations
│   ├── access-control.mdx # How-to: denying agents, managing denied list
│   └── mcp-tools.mdx      # Reference: mesh_discover, mesh_register, mesh_status, etc.
└── meta.json              # Add "relay" and "mesh" to pages array
```

---

## Research Gaps and Limitations

- The blog infrastructure in `apps/web` was not inspected directly to confirm whether it can publish blog posts — the 0.3.0 changelog entry says it was added, but the structure is unknown. Verify before writing a release post.
- ATTW and publint have not been run against the actual build artifact — the recommendations are based on known best practices applied to the `package.json` contents.
- The `@anthropic-ai/claude-agent-sdk: latest` risk is flagged but the exact current version was not resolved.

---

## Contradictions and Disputes

- **Manual vs. Automated Changelog:** Keep a Changelog recommends human-written entries for readability, while Conventional Commits + Changesets advocates automation. For DorkOS at current velocity, the hybrid approach (Changesets for version bumping, human-curated entries in `changelog.mdx`) is the best balance.
- **Minor vs. Major for Feature-Flagged Features:** Some camps argue that any new env var or API surface should be major. The consensus and SemVer spec both treat backward-compatible additions as minor, regardless of size. Feature flags make this unambiguous — nothing breaks for existing users.
- **Top-level docs sections vs. nesting under existing sections:** For small features, nesting under `concepts/` and `guides/` is fine. For subsystems with their own MCP tools, REST surface, and UI panels (as Relay and Mesh have), top-level sections give better discoverability and room to grow.

---

## Search Methodology

- Searches performed: 11
- Most productive search terms: "publint npm publish checklist", "Diátaxis documentation framework", "Fumadocs MDX structure", "Turborepo publishing libraries", "CHANGELOG best practices Keep a Changelog", "TypeScript monorepo release preparation"
- Primary information sources: publint.dev, diataxis.fr, keepachangelog.com, turborepo.dev, fumadocs.dev, conventionalcommits.org

---

## Sources

- [Turborepo: Publishing Libraries](https://turborepo.dev/docs/guides/publishing-libraries)
- [publint — npm package linter](https://publint.dev/)
- [publint Rules Reference](https://publint.dev/rules)
- [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
- [Diátaxis Documentation Framework](https://diataxis.fr/)
- [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- [Semantic Versioning 2.0.0](https://semver.org/)
- [Fumadocs](https://www.fumadocs.dev/)
- [Changesets CLI](https://github.com/changesets/changesets)
- [Guide to package.json exports field](https://hirok.io/posts/package-json-exports)
- [Building an npm package compatible with ESM and CJS in 2024](https://snyk.io/blog/building-npm-package-compatible-with-esm-and-cjs-2024/)
- [ATTW: Are the Types Wrong](https://github.com/spautz/attw-before-publish)
- [Nx: Versioning and Releasing in a Monorepo](https://nx.dev/blog/versioning-and-releasing-packages-in-a-monorepo)

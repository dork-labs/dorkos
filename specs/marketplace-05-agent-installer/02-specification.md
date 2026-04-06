---
slug: marketplace-05-agent-installer
number: 228
created: 2026-04-06
status: specified
parent-spec: dorkos-marketplace
project: dorkos-marketplace
sequence: 5
depends-on: [marketplace-01-foundation, marketplace-02-install]
depended-on-by: []
linear-issue: null
---

# Marketplace 05: Agent Installer (MCP Server) — Technical Specification

**Slug:** marketplace-05-agent-installer
**Author:** Claude Code
**Date:** 2026-04-06
**Project:** DorkOS Marketplace (5 specs total)
**Sequence:** 5 of 5 — final spec

---

## Overview

This specification exposes the DorkOS Marketplace as an **MCP server**, fulfilling Vision 2 (AI-Native Discovery) from the parent ideation. Any AI agent that speaks MCP — Claude Code, Cursor, Codex, Cline, ChatGPT, Gemini — can now search the DorkOS marketplace, get package details, install packages (with user confirmation), and even scaffold new packages on the fly.

It also introduces the **Personal Marketplace** concept: a per-user local marketplace at `~/.dork/personal-marketplace/` where agents can create packages on demand. This is the foundation for Vision 3 (Build-to-Install Pipeline) — full automation comes in v2, but the file layout and tooling are in place from day one.

After this spec ships, the DorkOS Marketplace is no longer a feature OF DorkOS — it's a service that other agent tools query. DorkOS positions itself as **infrastructure** for the AI agent ecosystem.

### Why

The current state (after specs 01-04) gives users a great browse-and-install experience inside DorkOS, plus a public web marketplace. But DorkOS is just one of many AI tools developers use. A user in Cursor who needs a "Stripe integration agent" shouldn't have to switch to DorkOS to discover one — Cursor itself should be able to query the DorkOS marketplace via MCP and surface relevant options.

This is the highest-leverage 10x move from the brief: **the marketplace as MCP server makes DorkOS the npm of AI agents.**

The Personal Marketplace foundation enables the Build-to-Install pattern: agents can scaffold packages on demand (`marketplace_create_package`), which lays the groundwork for the full Vision 3 in v2 where agents test and publish packages automatically.

### Source Documents

- `specs/marketplace-05-agent-installer/01-ideation.md` — This spec's ideation
- `specs/dorkos-marketplace/01-ideation.md` — Parent project ideation (Visions 2 and 3)
- `specs/marketplace-02-install/02-specification.md` — Install API consumed by MCP tools
- `apps/server/src/services/core/mcp-server.ts` — Existing MCP server (extended here)
- `apps/server/src/services/runtimes/claude-code/mcp-tools/` — Existing MCP tool patterns

---

## Goals

- Add 7 marketplace MCP tools to the existing `/mcp` server
- Implement personal marketplace at `~/.dork/personal-marketplace/`
- Implement `marketplace_create_package` for agent-driven scaffolding
- Implement simple recommendation function
- Reuse existing MCP server's auth (`MCP_API_KEY`) and anonymous read-only mode
- Implement install confirmation flow for agent-initiated installs
- Document external MCP discovery (how Claude Code / Cursor / Codex users connect)
- Comprehensive Vitest coverage for all tools
- Zero changes to existing `/mcp` server beyond additive tool registration

## Non-Goals

- Foundation, install, browse UI (specs 01-03)
- Public web marketplace and registry (spec 04)
- Public personal marketplace sharing (deferred)
- Full Build-to-Install automation loop (`marketplace_create_package` only scaffolds, doesn't test+publish — that's v2)
- Live preview / sandbox (deferred)
- ML-based recommendations (deferred)
- Sigstore signing (deferred)

---

## Technical Dependencies

| Dependency                  | Version       | Purpose                                      |
| --------------------------- | ------------- | -------------------------------------------- |
| `@dorkos/marketplace`       | `workspace:*` | Schemas, parser, validator (spec 01)         |
| `@modelcontextprotocol/sdk` | (existing)    | Already used by the existing `/mcp` server   |
| `zod`                       | `^3.25.76`    | Tool input schemas                           |
| (services from spec 02)     | (internal)    | Marketplace installer, source manager, cache |

No new external dependencies.

---

## Detailed Design

### MCP Server Integration

DorkOS already exposes an MCP server at `/mcp` (Streamable HTTP transport, optional `MCP_API_KEY` auth). The marketplace tools are registered alongside existing tools without architectural changes.

```
apps/server/src/services/marketplace-mcp/
├── marketplace-mcp-tools.ts          # Tool definitions + handlers
├── tool-search.ts                    # marketplace_search implementation
├── tool-get.ts                       # marketplace_get
├── tool-list-marketplaces.ts         # marketplace_list_marketplaces
├── tool-list-installed.ts            # marketplace_list_installed
├── tool-install.ts                   # marketplace_install (with confirmation)
├── tool-uninstall.ts                 # marketplace_uninstall (with confirmation)
├── tool-recommend.ts                 # marketplace_recommend
├── tool-create-package.ts            # marketplace_create_package
├── personal-marketplace.ts           # Personal marketplace bootstrap + management
├── recommend-engine.ts               # Simple keyword/tag-based scoring
└── __tests__/
    ├── tool-search.test.ts
    ├── tool-get.test.ts
    ├── tool-list-marketplaces.test.ts
    ├── tool-list-installed.test.ts
    ├── tool-install.test.ts
    ├── tool-uninstall.test.ts
    ├── tool-recommend.test.ts
    ├── tool-create-package.test.ts
    ├── personal-marketplace.test.ts
    └── recommend-engine.test.ts
```

The existing MCP server picks these up via a registration helper:

```typescript
// apps/server/src/services/core/mcp-server.ts (modified)
import { registerMarketplaceTools } from '../marketplace-mcp/marketplace-mcp-tools.js';

export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({
    /* ... */
  });

  // Existing registrations
  registerExistingTools(server, deps);

  // Marketplace tools (new)
  registerMarketplaceTools(server, {
    installer: deps.marketplaceInstaller,
    sourceManager: deps.marketplaceSourceManager,
    confirmationProvider: deps.confirmationProvider,
  });

  return server;
}
```

### Tool Definitions

Each tool follows the existing MCP tool pattern in `apps/server/src/services/runtimes/claude-code/mcp-tools/`. All tools use Zod for input validation, return structured JSON, and emit clear errors.

#### `marketplace_search`

```typescript
{
  name: 'marketplace_search',
  description: 'Search the DorkOS marketplace for installable packages (agents, plugins, skill packs, adapters)',
  inputSchema: {
    query: z.string().optional().describe('Free-text search across name/description/tags'),
    type: z.enum(['agent', 'plugin', 'skill-pack', 'adapter']).optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    marketplace: z.string().optional().describe('Restrict to a specific marketplace source'),
    limit: z.number().int().min(1).max(100).default(20),
  },
  outputSchema: {
    results: z.array(z.object({
      name: z.string(),
      type: z.string(),
      description: z.string().optional(),
      category: z.string().optional(),
      tags: z.array(z.string()).optional(),
      marketplace: z.string(),
      installCount: z.number().optional(),
      featured: z.boolean().optional(),
    })),
    total: z.number(),
  },
}
```

Implementation:

```typescript
async function handleMarketplaceSearch(
  input: SearchInput,
  ctx: ToolContext
): Promise<SearchOutput> {
  const allMarketplaces = await ctx.sourceManager.listSources();
  const filtered = input.marketplace
    ? allMarketplaces.filter((s) => s.name === input.marketplace)
    : allMarketplaces;

  const allEntries: (MarketplaceJsonEntry & { marketplace: string })[] = [];
  for (const source of filtered) {
    const entries = await ctx.installer.fetchMarketplaceEntries(source.name);
    for (const e of entries) allEntries.push({ ...e, marketplace: source.name });
  }

  // Filter by type, category, tags, query
  let results = allEntries;
  if (input.type) results = results.filter((r) => r.type === input.type);
  if (input.category) results = results.filter((r) => r.category === input.category);
  if (input.tags?.length) {
    results = results.filter((r) => input.tags!.some((t) => r.tags?.includes(t)));
  }
  if (input.query) {
    const q = input.query.toLowerCase();
    results = results.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q) ||
        (r.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  }

  return {
    results: results.slice(0, input.limit),
    total: results.length,
  };
}
```

#### `marketplace_get`

Returns full details for a package, including the README content fetched from its source.

```typescript
{
  name: 'marketplace_get',
  description: 'Get full details for a marketplace package by name',
  inputSchema: {
    name: z.string(),
    marketplace: z.string().optional(),
  },
  outputSchema: {
    package: z.object({
      name: z.string(),
      type: z.string(),
      description: z.string().optional(),
      manifest: z.unknown(),
      readme: z.string().optional(),
      installCount: z.number().optional(),
    }),
  },
}
```

#### `marketplace_list_marketplaces`

```typescript
{
  name: 'marketplace_list_marketplaces',
  description: 'List configured marketplace sources',
  inputSchema: {},
  outputSchema: {
    sources: z.array(z.object({
      name: z.string(),
      source: z.string(),
      enabled: z.boolean(),
      packageCount: z.number(),
    })),
  },
}
```

#### `marketplace_list_installed`

```typescript
{
  name: 'marketplace_list_installed',
  description: 'List packages currently installed in this DorkOS instance',
  inputSchema: {
    type: z.enum(['agent', 'plugin', 'skill-pack', 'adapter']).optional(),
  },
  outputSchema: {
    installed: z.array(z.object({
      name: z.string(),
      version: z.string(),
      type: z.string(),
      installPath: z.string(),
      installedAt: z.string(),
      marketplace: z.string().optional(),
    })),
  },
}
```

#### `marketplace_install`

The install tool requires user confirmation. The MCP server has a `confirmationProvider` injected — for interactive sessions it triggers a prompt; for non-interactive (CI / agent automation), it returns `requires_confirmation` and the agent must follow up after the user approves out-of-band.

```typescript
{
  name: 'marketplace_install',
  description: 'Install a package from a configured marketplace. Requires user confirmation.',
  inputSchema: {
    name: z.string(),
    marketplace: z.string().optional(),
    type: z.enum(['agent', 'plugin', 'skill-pack', 'adapter']).optional(),
    projectPath: z.string().optional().describe('Project-local install (defaults to global)'),
  },
  outputSchema: z.union([
    z.object({
      status: z.literal('installed'),
      package: z.object({ name: z.string(), version: z.string(), type: z.string() }),
      installPath: z.string(),
    }),
    z.object({
      status: z.literal('requires_confirmation'),
      preview: z.unknown(),
      confirmationToken: z.string(),
      message: z.string(),
    }),
    z.object({
      status: z.literal('declined'),
      reason: z.string(),
    }),
  ]),
}
```

Implementation:

```typescript
async function handleMarketplaceInstall(
  input: InstallInput,
  ctx: ToolContext
): Promise<InstallOutput> {
  // 1. Build permission preview
  const preview = await ctx.installer.buildPermissionPreview(input.name, input.marketplace);

  // 2. Request user confirmation via injected provider
  const confirmation = await ctx.confirmationProvider.requestInstallConfirmation({
    packageName: input.name,
    marketplace: input.marketplace ?? 'dorkos-community',
    preview,
  });

  if (confirmation.status === 'pending') {
    return {
      status: 'requires_confirmation',
      preview,
      confirmationToken: confirmation.token,
      message:
        'User must confirm install before proceeding. Re-call this tool with the confirmationToken once the user has approved.',
    };
  }

  if (confirmation.status === 'declined') {
    return { status: 'declined', reason: confirmation.reason ?? 'User declined installation' };
  }

  // 3. Proceed with install
  const result = await ctx.installer.install({
    name: input.name,
    marketplace: input.marketplace,
    projectPath: input.projectPath,
  });

  return {
    status: 'installed',
    package: { name: result.packageName, version: result.version, type: result.type },
    installPath: result.installPath,
  };
}
```

The `confirmationProvider` interface lets the same MCP tool work in different contexts:

```typescript
export interface ConfirmationProvider {
  requestInstallConfirmation(req: {
    packageName: string;
    marketplace: string;
    preview: PermissionPreview;
  }): Promise<
    | { status: 'approved' }
    | { status: 'declined'; reason?: string }
    | { status: 'pending'; token: string }
  >;
}
```

- **In-app DorkOS context** — Provider opens the existing InstallConfirmationDialog from spec 03 (returns `approved`/`declined`).
- **External MCP client (e.g., Claude Code)** — Provider returns `pending` with a token; the user approves in the DorkOS UI; the agent re-calls the tool.
- **Server-side automation (CI)** — Provider auto-approves if `MARKETPLACE_AUTO_APPROVE=1` env is set; otherwise returns `pending`.

#### `marketplace_uninstall`

Same confirmation pattern as install.

#### `marketplace_recommend`

```typescript
{
  name: 'marketplace_recommend',
  description: 'Recommend marketplace packages based on a context description (e.g., "I need to track errors in my Next.js app")',
  inputSchema: {
    context: z.string().min(1).max(500).describe('Free-text description of the user\'s need'),
    type: z.enum(['agent', 'plugin', 'skill-pack', 'adapter']).optional(),
    limit: z.number().int().min(1).max(20).default(5),
  },
  outputSchema: {
    recommendations: z.array(z.object({
      name: z.string(),
      type: z.string(),
      description: z.string(),
      relevanceScore: z.number(),
      reason: z.string(),
    })),
  },
}
```

Implementation uses simple keyword + tag matching for v1:

```typescript
function recommend(packages: MarketplaceJsonEntry[], context: string, limit: number) {
  const tokens = tokenize(context.toLowerCase());

  const scored = packages.map((pkg) => {
    let score = 0;
    const reasons: string[] = [];

    // Match against name (high weight)
    for (const token of tokens) {
      if (pkg.name.toLowerCase().includes(token)) {
        score += 10;
        reasons.push(`name matches "${token}"`);
      }
    }

    // Match against description
    const desc = (pkg.description ?? '').toLowerCase();
    for (const token of tokens) {
      if (desc.includes(token)) {
        score += 3;
        reasons.push(`description matches "${token}"`);
      }
    }

    // Match against tags
    for (const tag of pkg.tags ?? []) {
      for (const token of tokens) {
        if (tag.toLowerCase() === token) {
          score += 5;
          reasons.push(`tag "${tag}"`);
        }
      }
    }

    // Featured boost
    if (pkg.featured) score += 2;

    return { pkg, score, reason: reasons.slice(0, 3).join(', ') };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
```

ML-based recommendations are deferred — this v1 approach handles the obvious cases ("error tracking nextjs" → posthog-monitor, sentry-monitor) without infrastructure.

#### `marketplace_create_package`

```typescript
{
  name: 'marketplace_create_package',
  description: 'Scaffold a new package in the user\'s personal marketplace. The package is created locally; publishing to public marketplace is a separate step.',
  inputSchema: {
    name: z.string().regex(/^[a-z][a-z0-9-]*$/),
    type: z.enum(['agent', 'plugin', 'skill-pack', 'adapter']),
    description: z.string().min(1).max(1024),
    author: z.string().optional(),
  },
  outputSchema: {
    status: z.enum(['created', 'requires_confirmation', 'failed']),
    packagePath: z.string().optional(),
    filesCreated: z.array(z.string()).optional(),
    confirmationToken: z.string().optional(),
    error: z.string().optional(),
  },
}
```

Uses the `createPackage()` scaffolder from spec 01 to create a new directory under `~/.dork/personal-marketplace/packages/`. Optionally registers it in the personal marketplace's `marketplace.json`.

This tool requires user confirmation (creating files on disk). The same `ConfirmationProvider` pattern as install applies.

### Personal Marketplace

```
~/.dork/personal-marketplace/
├── marketplace.json                  # Personal registry index
├── README.md
├── packages/
│   ├── my-custom-agent/             # User-created or agent-scaffolded packages
│   │   └── (full package contents)
│   └── another-thing/
└── .gitignore                       # Ignored by default; user can git init manually
```

**Bootstrap on server startup:**

```typescript
// apps/server/src/services/marketplace-mcp/personal-marketplace.ts
export async function ensurePersonalMarketplace(dorkHome: string): Promise<void> {
  const root = path.join(dorkHome, 'personal-marketplace');
  await fs.mkdir(path.join(root, 'packages'), { recursive: true });

  const manifestPath = path.join(root, 'marketplace.json');
  try {
    await fs.access(manifestPath);
  } catch {
    // Create empty marketplace.json
    await fs.writeFile(
      manifestPath,
      JSON.stringify(
        {
          name: 'personal',
          description:
            'Your personal DorkOS marketplace — packages you scaffold or maintain locally',
          plugins: [],
        },
        null,
        2
      )
    );
  }

  // Register as a marketplace source if not already registered
  const sources = await sourceManager.listSources();
  if (!sources.find((s) => s.name === 'personal')) {
    await sourceManager.addSource({
      name: 'personal',
      source: `file://${root}`,
      enabled: true,
    });
  }
}
```

The `personal` source is special: it uses a `file://` URL instead of git. The marketplace fetcher in spec 02 needs a small extension to support `file://` sources (read directly instead of cloning).

### Authentication & Discovery

**Existing MCP server auth** (no changes):

- `MCP_API_KEY` env var enables Bearer auth
- Endpoint: `https://dorkos.local/mcp` (or `http://localhost:6242/mcp` in dev)
- Streamable HTTP transport

**Tool-level auth:**

- Read-only tools (`marketplace_search`, `marketplace_get`, `marketplace_list_*`, `marketplace_recommend`) — Available without auth (anonymous read-only)
- Mutation tools (`marketplace_install`, `marketplace_uninstall`, `marketplace_create_package`) — Require valid `MCP_API_KEY` AND user confirmation

**External agent setup:**

A new `contributing/external-agent-marketplace-access.md` doc explains how users connect:

````markdown
# Connecting External AI Agents to the DorkOS Marketplace

DorkOS exposes its marketplace as an MCP server. Any AI agent that supports MCP can search and install DorkOS packages.

## Claude Code

```bash
claude mcp add --transport http dorkos-marketplace https://dorkos.local/mcp
```

If using `MCP_API_KEY`, append:

```bash
--header "Authorization: Bearer YOUR_KEY"
```

## Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "dorkos-marketplace": {
      "url": "http://localhost:6242/mcp",
      "transport": "streamable-http"
    }
  }
}
```

## Codex

Add to `~/.codex/config.toml`:

```toml
[[mcp_servers]]
name = "dorkos-marketplace"
url = "http://localhost:6242/mcp"
```

## Available Tools

- `marketplace_search` — Search for packages
- `marketplace_get` — Get package details
- `marketplace_recommend` — Get recommendations based on need
- `marketplace_install` — Install a package (requires confirmation)
- `marketplace_uninstall` — Remove a package
- `marketplace_create_package` — Scaffold a new package locally
- `marketplace_list_marketplaces` — List configured sources
- `marketplace_list_installed` — List installed packages
````

---

## Implementation Phases

### Phase 1 — Personal Marketplace Bootstrap

- `personal-marketplace.ts` — Create directory + manifest on server startup
- Extend marketplace fetcher in spec 02 to support `file://` sources
- Tests for bootstrap idempotency

### Phase 2 — Read-Only MCP Tools

- `tool-search.ts`, `tool-get.ts`, `tool-list-marketplaces.ts`, `tool-list-installed.ts`
- Tool registration helper
- Tests with mocked installer

### Phase 3 — Recommendation Engine

- `recommend-engine.ts` — Keyword + tag scoring
- `tool-recommend.ts`
- Tests with fixture packages

### Phase 4 — Confirmation Provider

- Define `ConfirmationProvider` interface
- Implement in-app provider (calls existing dialog from spec 03)
- Implement out-of-band token-based provider (for external MCP clients)
- Tests for both flows

### Phase 5 — Mutation Tools

- `tool-install.ts`, `tool-uninstall.ts`
- Wire to confirmation provider
- Failure-path tests

### Phase 6 — Package Creation Tool

- `tool-create-package.ts`
- Use `createPackage()` scaffolder from spec 01
- Auto-register in personal marketplace.json

### Phase 7 — Documentation & Discovery

- `contributing/external-agent-marketplace-access.md`
- Update parent CLAUDE.md
- Add example MCP client configurations to seed package READMEs

### Phase 8 — Polish

- Verify all tools appear in MCP `tools/list`
- End-to-end test: external Claude Code session searches and installs a DorkOS package
- CHANGELOG entry

---

## Testing Strategy

### Unit Tests

Each tool's handler tested in isolation with mocked dependencies.

### Integration Tests

End-to-end scenarios:

- External agent (mock MCP client) searches → gets results
- External agent recommends → relevant packages returned
- External agent installs → confirmation requested → user approves → package installed
- Agent creates package → personal marketplace updated → package validates

### MCP Client Compatibility

Manual testing against:

- Claude Code (`claude mcp add`)
- Cursor (`.cursor/mcp.json`)
- Codex (`~/.codex/config.toml`)

Verify each can list, search, and install.

---

## File Structure

### New files

```
apps/server/src/services/marketplace-mcp/
├── (all files listed above)

contributing/
└── external-agent-marketplace-access.md

apps/server/src/services/core/
└── (no new files; mcp-server.ts modified)
```

### Modified files

```
apps/server/src/services/core/mcp-server.ts        # Register marketplace tools
apps/server/src/services/marketplace/marketplace-installer.ts  # Add file:// source support
apps/server/src/index.ts                            # Wire ensurePersonalMarketplace
CLAUDE.md                                           # Document marketplace MCP tools
CHANGELOG.md                                        # Unreleased entry
```

### Unchanged

- Existing `/mcp` server transport, auth, base structure
- Existing MCP tools (Claude Code task tools, etc.)
- Foundation, install, browse UI, web pages
- Spec 04 telemetry (independent)

---

## Acceptance Criteria

- [ ] All 7 marketplace MCP tools registered with the existing `/mcp` server
- [ ] Tools discoverable via standard MCP `tools/list`
- [ ] All tool input schemas validate strictly (Zod)
- [ ] `marketplace_search` filters correctly across all dimensions
- [ ] `marketplace_get` returns full package details + README
- [ ] `marketplace_install` triggers confirmation flow before installing
- [ ] `marketplace_install` returns `requires_confirmation` for out-of-band cases
- [ ] `marketplace_recommend` returns relevant matches for sample queries
- [ ] `marketplace_create_package` scaffolds a valid package in personal marketplace
- [ ] Personal marketplace auto-created on server startup
- [ ] Personal marketplace appears in `marketplace_list_marketplaces` output
- [ ] `file://` source support works in marketplace fetcher
- [ ] Read-only tools work without `MCP_API_KEY`
- [ ] Mutation tools require `MCP_API_KEY` AND user confirmation
- [ ] External MCP client docs verified (Claude Code, Cursor, Codex)
- [ ] All tools have unit + integration tests
- [ ] No regression in existing MCP server behavior

---

## Risks & Mitigations

| Risk                                                   | Severity | Mitigation                                                                                   |
| ------------------------------------------------------ | :------: | -------------------------------------------------------------------------------------------- |
| Confirmation flow blocks agent automation              |  Medium  | Out-of-band token pattern lets agents return `requires_confirmation` without blocking        |
| External agents misuse install tool                    |  Medium  | Confirmation always required + MCP_API_KEY auth + permission preview shown to user           |
| Personal marketplace pollutes user's home directory    |   Low    | Only created on first MCP tool use; documented; user can delete if unused                    |
| Recommendation function returns irrelevant matches     |  Medium  | Score threshold filtering. Document as "v1, simple matching." Iterate based on user feedback |
| MCP server protocol drift breaks external clients      |   Low    | Use standard MCP SDK; pin to compatible versions; CI tests against real clients              |
| Large marketplace.json files slow `marketplace_search` |   Low    | Spec 02 cache layer + 1h TTL; results limited to 100; pagination via offset (future)         |
| Out-of-band confirmation token leaks                   |   Low    | Tokens are short-lived (5 min), one-use, scoped to a specific install request                |

---

## Out of Scope (Deferred)

| Item                                           | Spec |
| ---------------------------------------------- | ---- |
| Public personal marketplace publishing         | v2   |
| Full Build-to-Install loop (auto test+publish) | v2   |
| ML-based recommendations                       | v2   |
| Live preview / sandbox                         | v2   |
| Sigstore signing for personal packages         | v2   |
| Federated marketplace search across orgs       | v2   |

---

## Changelog

### 2026-04-06 — Initial specification

Created from `/ideate-to-spec specs/dorkos-marketplace/01-ideation.md` (batched generation).

This is spec 5 of 5 — the **final spec** for the DorkOS Marketplace project.

After this ships, the marketplace project is complete:

- **Spec 01** (foundation) — Schemas, parser, validator, CLI
- **Spec 02** (install) — Install machinery, transactions, HTTP API
- **Spec 03** (extension) — Dork Hub built-in browse UI
- **Spec 04** (web & registry) — dorkos.dev/marketplace, dorkos-community registry, seed packages, telemetry
- **Spec 05** (agent installer) — MCP server, personal marketplace, AI-native discovery

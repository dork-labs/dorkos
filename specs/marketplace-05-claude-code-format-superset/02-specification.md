---
slug: marketplace-05-claude-code-format-superset
number: 229
created: 2026-04-07
status: specified
parent-spec: dorkos-marketplace
project: dorkos-marketplace
sequence: 5
depends-on:
  [
    marketplace-01-foundation,
    marketplace-02-install,
    marketplace-03-browse,
    marketplace-04-web-and-registry,
  ]
depended-on-by: []
linear-issue: null
---

# Marketplace 05: Claude Code Marketplace Format Superset — Technical Specification

**Slug:** marketplace-05-claude-code-format-superset
**Author:** Claude Code
**Date:** 2026-04-07
**Project:** DorkOS Marketplace (5 specs total)
**Sequence:** 5 of 5

---

## Overview

This specification converts the DorkOS marketplace format from **aspirationally** "Claude Code-compatible" (what spec 04 shipped — a label unverified against reality) into a **strict superset** of Claude Code's marketplace format. The strict-superset framing is the load-bearing constraint; it is stronger than "compatible" and manifests as two testable invariants:

1. **Outbound invariant**: Any `marketplace.json` produced by DorkOS, using only CC-standard fields, must pass `claude plugin validate`. DorkOS-specific extensions live in a sidecar file (`dorkos.json`) that CC ignores entirely.
2. **Inbound invariant**: Any `marketplace.json` that passes `claude plugin validate` must install successfully via DorkOS's pipeline. No manual conversion. No "import" step. Native consumption of real Claude Code marketplaces.

The CC validator is the reference oracle. DorkOS does not get to subjectively decide what compatible means — CC's validator decides for us. CI runs validation as a gate.

### Why

Spec 04's `packages/marketplace/src/marketplace-json-schema.ts` is _labeled_ "Claude Code-compatible" and uses `.passthrough()` to preserve unknown fields. A verification pass against the current Claude Code marketplace spec (fetched fresh from `code.claude.com/docs/en/plugin-marketplaces` on 2026-04-07) found **six critical structural incompatibilities**. Neither direction works today:

- **Claude Code cannot consume our marketplace.** Missing `owner` field, wrong file location, `source` field is a string where CC expects a discriminated union of 5 object forms, `author` is a string where CC expects an object, top-level `description` where CC expects `metadata.description`, DorkOS extensions inline where CC enforces `additionalProperties: false`.
- **DorkOS cannot consume a Claude Code marketplace.** Our parser only handles `source: string`; a CC entry with `source: { source: "github", repo: "..." }` fails Zod validation immediately.

Additionally, the "monorepo support" question the user raised in-session is solved natively by CC's existing `git-subdir` source type with sparse cloning. DorkOS does not need to invent a parallel convention — adopting CC's format gives us monorepo support for free.

Finally, a major architectural unlock emerged during ideation research: the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) has `options.plugins: [{ type: "local", path }]` that auto-loads skills, commands, agents, hooks, and MCP servers from a local plugin directory. **DorkOS does not need to reimplement the CC plugin runtime.** The SDK handles it. DorkOS owns the install pipeline (downloading + materializing plugins to disk); the SDK owns the runtime activation (loading plugin primitives into agent sessions). They compose cleanly.

This spec ships before #28 deploys. Deploying #28 with the current (broken) schema would bake in incompatibility, block every Claude Code user from adding the DorkOS marketplace, and force a painful migration later. #28 is implicitly blocked by this spec until it lands.

### Source Documents

- `specs/marketplace-05-claude-code-format-superset/01-ideation.md` — This spec's ideation with 17 locked decisions
- `specs/marketplace-04-web-and-registry/02-specification.md` — Prior marketplace web and registry spec
- `specs/marketplace-04-web-and-registry/04-implementation.md` — What was shipped in spec 04 (will gain a forward-pointer to this spec)
- `code.claude.com/docs/en/plugin-marketplaces` — Current Claude Code marketplace spec (fetched 2026-04-07)
- `platform.claude.com/docs/en/agent-sdk/plugins` — Claude Agent SDK plugin loading API (fetched 2026-04-07)
- `github.com/hesreallyhim/claude-code-json-schema` — Unofficial reverse-engineered JSON Schema for `marketplace.json` and `plugin.json` (reference for the Zod port)
- `github.com/anthropics/claude-plugins-official` — Canonical CC marketplace (vendored snapshot is the inbound compatibility test fixture)
- `research/20260323_claude_code_plugin_marketplace_schema.md` — Prior schema research
- `research/20260329_claude_code_plugin_marketplace_extensibility.md` — CC plugin extensibility surface
- `research/20260329_ai_coding_agent_plugin_marketplaces.md` — Competitive landscape
- IETF RFC 6648 — "Deprecating the X- Prefix"

---

## Goals

- **Strict superset invariants hold**: `claude plugin validate` passes against DorkOS-generated `marketplace.json`; a real CC marketplace installs via DorkOS without manual conversion.
- **Fix the 6 current incompatibilities** in `packages/marketplace/src/marketplace-json-schema.ts` (source field, `owner`, `metadata`, `author` shape, file location, missing `strict`/CC component fields).
- **Add sidecar `dorkos.json`** for all DorkOS extensions (`type`, `layers`, `requires`, `featured`, `icon`, `dorkosMinVersion`, `pricing`). CC never sees it.
- **Implement 4 of 5 source type resolvers** in the install pipeline: relative path, github, url, git-subdir (npm deferred to marketplace-06).
- **Sparse-clone for `git-subdir`** using `git clone --filter=blob:none --no-checkout --depth=1` + cone-mode sparse-checkout. Bitbucket/GitLab/GitHub/Gitea compatibility with a documented fallback ladder.
- **Port CC schema to Zod** in `packages/marketplace/src/cc-validator.ts`, using `hesreallyhim/claude-code-json-schema` as reference. Weekly CI sync cron to track CC schema drift.
- **Auto-activate installed plugins** via Claude Agent SDK `options.plugins: [{ type: "local", path }]` at session start. Implementation in `apps/server/src/services/runtimes/claude-code/plugin-activation.ts`.
- **Rewrite the seed** as a same-repo monorepo: `dork-labs/marketplace` holds both `.claude-plugin/marketplace.json` AND `plugins/<name>/` subdirectories, with `metadata.pluginRoot: "./plugins"` for terse entries.
- **Rename the public marketplace** from `dorkos-community` to `dorkos` (install string becomes `/plugin install <pkg>@dorkos`).
- **Add `source_type` telemetry column** to `marketplace_install_events` Drizzle schema (tracks adoption per source form).
- **Full bidirectional test matrix**: 14 fixture-based tests (6 outbound + 8 inbound) across all 5 source types.
- **4 new ADRs** capturing architectural decisions: sidecar, same-repo monorepo, port-to-Zod validator, SDK plugin activation.
- **Unblock #28**: the seed goes from "9 repos" to "1 repo" once this spec lands.

## Non-Goals

- **npm source type install pipeline** — `source: { source: "npm", package: "..." }` is parsed and recognized by the schema, but the resolver is a stub that throws a structured "npm sources not yet supported in this DorkOS version — see marketplace-06" error. Full implementation is deferred to `marketplace-06-npm-sources` and requires separate security review of `--ignore-scripts`, transactional rollback redesign, and private-registry auth.
- **Reimplementing CC plugin runtime** — DorkOS does NOT parse or execute CC's `commands`, `agents`, `hooks`, `mcpServers`, `lspServers` fields itself. The Claude Agent SDK already does this when plugin paths are passed to `options.plugins`. These fields are stored as opaque metadata only.
- **Marketplace ToS and commerce paperwork** — A future paid-packages legal/commercial track. The schema slot for `pricing` IS in scope; the actual ToS, payment intermediary, author payout flow, and commerce permissions are not.
- **CC `extraKnownMarketplaces` / `enabledPlugins` settings interop** — reading `.claude/settings.json` from project workspaces. Deferred to a future spec.
- **Multi-runtime plugin activation abstraction** — an `AgentRuntime.activatePlugin(path)` interface for future non-CC runtimes. Premature; v1 wires plugin activation directly to the Claude Agent SDK runtime inside the existing ESLint boundary.
- **Community submission tooling** — a `dork marketplace submit` CLI for community contributors. Manual PRs to `dork-labs/marketplace` are sufficient for v1.
- **Validator parity with the actual CC binary** — shelling out to `claude plugin validate` in CI. Infeasible (auth, 200 MB binary, ~70% reliability). The Zod port is sufficient.
- **Private npm registry auth** — `.npmrc` token flow. Deferred with npm itself.
- **Spec 04 follow-ups** — Lighthouse audit, Playwright E2E, client UI polish. Those remain where they are.
- **Migration of existing live marketplaces** — no live `marketplace.json` files exist in production yet (#28 has not bootstrapped). This is "fix before first deploy," not a migration.

---

## Technical Dependencies

| Dependency                             | Version       | Purpose                                                                            |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `@dorkos/marketplace`                  | `workspace:*` | Schemas, types (this spec rewrites it)                                             |
| `zod`                                  | existing      | Schema validation                                                                  |
| `@anthropic-ai/claude-agent-sdk`       | existing      | `options.plugins: [{ type: "local", path }]` — loads plugin runtime from disk      |
| `@neondatabase/serverless`             | existing      | Drizzle Neon client (telemetry `source_type` column)                               |
| `drizzle-orm`, `drizzle-kit`           | existing      | Schema migration                                                                   |
| `@upstash/redis`                       | NOT used      | Spec 04's architectural pivot removed this                                         |
| `git` CLI                              | >=2.25        | Sparse-checkout cone mode (ubiquitous; CI images are 2.43+)                        |
| `hesreallyhim/claude-code-json-schema` | latest        | Reference for Zod port (not a code dep — read-only git submodule or periodic sync) |

No new package dependencies are added. All changes are to existing files or new files within existing workspaces.

---

## Detailed Design

### Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  registry repo: github.com/dork-labs/marketplace              │
│  ├── .claude-plugin/                                          │
│  │   ├── marketplace.json      ← CC-compatible, zero DorkOS   │
│  │   └── dorkos.json           ← sidecar: DorkOS extensions   │
│  ├── plugins/                                                 │
│  │   ├── code-reviewer/        ← package source (relative)    │
│  │   │   ├── .claude-plugin/plugin.json                       │
│  │   │   ├── README.md                                        │
│  │   │   └── skills/                                          │
│  │   ├── security-auditor/                                    │
│  │   └── ... (6 more)                                         │
│  ├── CONTRIBUTING.md                                          │
│  ├── README.md                                                │
│  └── .github/workflows/validate-submission.yml                │
└───────────────────────────────────────────────────────────────┘
              │
              │ HTTPS GET (apps/site ISR + apps/server install)
              ▼
┌───────────────────────────────────────────────────────────────┐
│  Fetch layer (both apps/site and apps/server)                 │
│  ┌────────────────────────┐  ┌────────────────────────────┐  │
│  │ fetchMarketplaceJson() │  │ fetchDorkosSidecar()       │  │
│  └────────────┬───────────┘  └────────┬───────────────────┘  │
│               │                       │                      │
│               └──────────┬────────────┘                      │
│                          ▼                                   │
│               ┌─────────────────────┐                        │
│               │ mergeMarketplace()  │                        │
│               │ → MergedEntry[]     │ keyed by name          │
│               └─────────────────────┘                        │
└───────────────────────────────────────────────────────────────┘
              │
              ▼
┌───────────────────────────────────────────────────────────────┐
│  Source dispatcher (in @dorkos/marketplace)                   │
│  ┌─────────────────────────────────────┐                      │
│  │ resolvePluginSource(entry.source)   │                      │
│  │ → { type, ...fields }               │                      │
│  │   'relative-path' | 'github'        │                      │
│  │   | 'url' | 'git-subdir' | 'npm'    │                      │
│  └─────────────────┬───────────────────┘                      │
└───────────────────────────────────────────────────────────────┘
              │
              ▼
┌───────────────────────────────────────────────────────────────┐
│  Install pipeline (apps/server/src/services/marketplace/)     │
│  source-resolvers/                                            │
│  ├── relative-path.ts    → cd into marketplace clone          │
│  ├── github.ts           → git clone at ref/sha               │
│  ├── url.ts              → git clone at ref/sha               │
│  ├── git-subdir.ts       → sparse clone + cone mode           │
│  └── npm.ts              → STUB: throw structured error       │
│                            (marketplace-06)                   │
│                          │                                    │
│                          ▼                                    │
│  marketplace-installer.ts (existing)                          │
│  → atomic transaction → ~/.dork/marketplace/packages/<name>/  │
└───────────────────────────────────────────────────────────────┘
              │
              ▼
┌───────────────────────────────────────────────────────────────┐
│  Runtime activation                                           │
│  apps/server/src/services/runtimes/claude-code/               │
│  plugin-activation.ts (NEW, ESLint-bounded)                   │
│  → for each enabled installed plugin: build                   │
│    { type: "local", path: "<install_dir>" }                   │
│  → pass to query() via options.plugins                        │
└───────────────────────────────────────────────────────────────┘
              │
              ▼
┌───────────────────────────────────────────────────────────────┐
│  @anthropic-ai/claude-agent-sdk                               │
│  query({ options: { plugins: [...] } })                       │
│  → auto-loads skills, commands, agents, hooks, mcpServers     │
│    from each plugin directory                                 │
│  → plugin skills namespaced: "<plugin-name>:<skill-name>"     │
└───────────────────────────────────────────────────────────────┘
```

### Component 1: Schema layer (`packages/marketplace/src/`)

#### 1a. `marketplace-json-schema.ts` — Rewrite

The existing file accepts `source: z.string().min(1)` and `author: z.string()`, uses `.passthrough()` top-level, and does not model `owner`, `metadata`, `strict`, or CC component fields. This file is fully rewritten.

**New schema shape** (pseudo-code, final Zod implementation in execution phase):

```typescript
// Five source forms as a discriminated union
const RelativePathSourceSchema = z
  .string()
  .regex(/^\.\//, 'Relative paths must start with "./"')
  .refine((s) => !s.includes('..'), 'Relative paths must not contain ".."');

const GithubSourceSchema = z.object({
  source: z.literal('github'),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Must be owner/repo format'),
  ref: z.string().optional(),
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});

const UrlSourceSchema = z.object({
  source: z.literal('url'),
  url: z.string().url(),
  ref: z.string().optional(),
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});

const GitSubdirSourceSchema = z.object({
  source: z.literal('git-subdir'),
  url: z.string(), // URL or owner/repo shorthand or git@ URL
  path: z.string().min(1),
  ref: z.string().optional(),
  sha: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
});

const NpmSourceSchema = z.object({
  source: z.literal('npm'),
  package: z.string().min(1),
  version: z.string().optional(),
  registry: z.string().url().optional(),
});

const PluginSourceSchema = z.union([
  RelativePathSourceSchema,
  GithubSourceSchema,
  UrlSourceSchema,
  GitSubdirSourceSchema,
  NpmSourceSchema,
]);

// Author is an object, not a string
const AuthorSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
});

// Owner is required at the top level
const OwnerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
});

// Metadata object with known optional fields
const MetadataSchema = z.object({
  description: z.string().optional(),
  version: z.string().optional(),
  pluginRoot: z.string().optional(),
});

// Plugin entry — CC-standard fields only
// DorkOS extensions live in the sidecar, NOT here
const MarketplaceJsonEntrySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be kebab-case'),
    source: PluginSourceSchema,
    description: z.string().optional(),
    version: z.string().optional(),
    author: AuthorSchema.optional(),
    homepage: z.string().url().optional(),
    repository: z.string().url().optional(),
    license: z.string().max(64).optional(),
    keywords: z.array(z.string()).max(50).optional(),
    category: z.string().max(64).optional(),
    tags: z.array(z.string().max(32)).max(20).optional(),
    strict: z.boolean().optional(),
    // CC component fields — opaque metadata, passed to SDK at runtime
    commands: z.unknown().optional(),
    agents: z.unknown().optional(),
    hooks: z.unknown().optional(),
    mcpServers: z.unknown().optional(),
    lspServers: z.unknown().optional(),
  })
  .passthrough(); // defensive: survive future CC additions

// Top-level document
const MarketplaceJsonSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be kebab-case')
      .refine(
        (name) => !RESERVED_MARKETPLACE_NAMES.has(name),
        'Reserved marketplace name — see CC reserved list'
      ),
    owner: OwnerSchema,
    metadata: MetadataSchema.optional(),
    plugins: z.array(MarketplaceJsonEntrySchema),
  })
  .passthrough();

// Reserved names per CC docs (fetched 2026-04-07)
const RESERVED_MARKETPLACE_NAMES = new Set([
  'claude-code-marketplace',
  'claude-code-plugins',
  'claude-plugins-official',
  'anthropic-marketplace',
  'anthropic-plugins',
  'agent-skills',
  'knowledge-work-plugins',
  'life-sciences',
]);
```

**Exports:**

- `MarketplaceJsonSchema` (renamed or new — replaces existing)
- `MarketplaceJsonEntrySchema`
- `PluginSourceSchema` and each of the 5 source-form sub-schemas
- `AuthorSchema`, `OwnerSchema`, `MetadataSchema`
- `RESERVED_MARKETPLACE_NAMES` constant
- Type exports: `MarketplaceJson`, `MarketplaceJsonEntry`, `PluginSource`, `GithubSource`, `UrlSource`, `GitSubdirSource`, `NpmSource`, `RelativePathSource`, `Author`, `Owner`, `Metadata`

#### 1b. `dorkos-sidecar-schema.ts` — NEW

The sidecar schema for `.claude-plugin/dorkos.json`. Indexed by plugin name; plugins in the sidecar must also exist in `marketplace.json` (drift produces a warning, not an error).

```typescript
const PricingSchema = z.object({
  model: z.enum(['free', 'paid', 'freemium', 'byo-license']),
  priceUsd: z.number().nonnegative().optional(),
  billingPeriod: z.enum(['one-time', 'monthly', 'yearly']).optional(),
  trialDays: z.number().int().nonnegative().optional(),
});

const DorkosEntrySchema = z.object({
  type: z.enum(['agent', 'plugin', 'skill-pack', 'adapter']).optional(),
  layers: z
    .array(
      z.enum([
        'skills',
        'tasks',
        'commands',
        'hooks',
        'extensions',
        'adapters',
        'mcp-servers',
        'lsp-servers',
        'agents',
      ])
    )
    .optional(),
  requires: z
    .array(
      z.string().regex(/^(adapter|plugin|skill-pack|agent):[a-z][a-z0-9-]*([@][\w.~^>=<!*-]+)?$/)
    )
    .optional(),
  featured: z.boolean().optional(),
  icon: z.string().max(64).optional(),
  dorkosMinVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/)
    .optional(),
  pricing: PricingSchema.optional(),
});

const DorkosSidecarSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  plugins: z.record(z.string(), DorkosEntrySchema),
});
```

**Exports:** `DorkosSidecarSchema`, `DorkosEntrySchema`, `PricingSchema`, type exports for each.

**Merge behavior** (implemented in `merge-marketplace.ts`, also new):

```typescript
interface MergedMarketplaceEntry {
  // All CC fields from MarketplaceJsonEntry
  name: string;
  source: PluginSource;
  description?: string;
  // ... all CC fields ...

  // DorkOS extensions (from sidecar). Undefined if not present in sidecar.
  dorkos?: DorkosEntry;
}

function mergeMarketplace(
  cc: MarketplaceJson,
  sidecar: DorkosSidecar | null
): MergedMarketplaceEntry[] {
  return cc.plugins.map((entry) => ({
    ...entry,
    dorkos: sidecar?.plugins[entry.name],
  }));
}
```

**Drift handling:**

- Plugin in `marketplace.json` but not in `dorkos.json`: merged entry has `dorkos: undefined`. Treated as a plugin with default extensions (type inferred as `plugin`, no layers, no pricing — `model: free` is implicit). Not an error.
- Plugin in `dorkos.json` but not in `marketplace.json`: warning logged with the orphaned name. Orphan is silently dropped from merged output. Not an error.

#### 1c. `marketplace-json-parser.ts` — Update

Current parser calls `MarketplaceJsonSchema.safeParse(raw)` and returns `{ ok, marketplace } | { ok: false, error }`. Update signature:

```typescript
export function parseMarketplaceJson(
  rawMarketplace: string
): { ok: true; marketplace: MarketplaceJson } | { ok: false; error: string };

export function parseDorkosSidecar(
  rawSidecar: string
): { ok: true; sidecar: DorkosSidecar } | { ok: false; error: string };

export function parseMarketplaceWithSidecar(
  rawMarketplace: string,
  rawSidecar: string | null
):
  | {
      ok: true;
      merged: MergedMarketplaceEntry[];
      marketplace: MarketplaceJson;
      sidecar: DorkosSidecar | null;
    }
  | { ok: false; error: string };
```

#### 1d. `source-resolver.ts` — NEW (pure function in `@dorkos/marketplace`)

Browser-safe (no Node.js deps). Single source of truth for source-form interpretation, consumed by both the server install pipeline and the site rendering layer:

```typescript
export type ResolvedSourceDescriptor =
  | { type: 'relative-path'; path: string; marketplaceRoot: string }
  | { type: 'github'; repo: string; ref?: string; sha?: string; cloneUrl: string }
  | { type: 'url'; url: string; ref?: string; sha?: string }
  | { type: 'git-subdir'; cloneUrl: string; subpath: string; ref?: string; sha?: string }
  | { type: 'npm'; package: string; version?: string; registry?: string };

export function resolvePluginSource(
  source: PluginSource,
  context: { marketplaceRoot?: string; pluginRoot?: string }
): ResolvedSourceDescriptor;
```

**`metadata.pluginRoot` semantics** (explicitly spec'd):

1. When `source` is a relative-path string and `metadata.pluginRoot` is set:
   - Resolved path = `<marketplaceRoot>/<pluginRoot>/<source>` (with leading `./` normalization on all segments)
   - Example: `pluginRoot: "./plugins"` + `source: "code-reviewer"` → `<root>/plugins/code-reviewer`
2. When `source` is a relative-path string AND already starts with `./`:
   - Resolved path = `<marketplaceRoot>/<source>` (pluginRoot ignored, because the leading `./` is explicit)
3. Trailing slashes on `pluginRoot` are normalized (stripped).
4. Absolute paths (`/...`) in `pluginRoot` are an error — `ResolvePluginSourceError`.
5. Relative paths containing `..` are an error — `ResolvePluginSourceError`.
6. Object-form sources (`github`, `url`, `git-subdir`, `npm`) ignore `pluginRoot` entirely.

#### 1e. `cc-validator.ts` — NEW (port of `hesreallyhim/claude-code-json-schema`)

A second-pass Zod schema that mirrors CC's actual validator behavior. Used by:

- `dorkos package validate-marketplace` CLI for outbound compatibility check
- `dorkos package validate-remote` CLI for inbound compatibility check
- Vitest tests for Direction A (DorkOS-produced marketplaces pass CC validator)

**Key difference from `MarketplaceJsonSchema` (Component 1a)**: `MarketplaceJsonSchema` uses `.passthrough()` (defensive against future CC additions). `cc-validator.ts` uses `.strict()` on plugin entries to mirror CC's `additionalProperties: false` behavior — so it will REJECT marketplaces that have DorkOS-specific inline fields at the plugin entry level, proving the sidecar strategy is necessary.

**Sync direction invariant**: `cc-validator.ts` MUST NOT be stricter than CC's actual CLI behavior for any field CC currently accepts. Looser-than-CC is fine; stricter-than-CC is a regression.

**Sync mechanism**: `scripts/sync-cc-schema.ts` weekly cron CI job. Fetches the latest reference schema from `hesreallyhim/claude-code-json-schema`, diffs against DorkOS's Zod port, and opens a pull request when differences appear. Not run on every PR — the reference schema changes slowly.

#### 1f. `package-validator.ts` — Update

Existing validator (`validatePackage`) operates on `.dork/manifest.json`. Unchanged. Add:

```typescript
export function validateMarketplaceJson(raw: string): {
  level: 'error' | 'warning';
  message: string;
  path?: string[];
}[];

export function validateMarketplaceJsonWithCcSchema(raw: string): {
  level: 'error' | 'warning';
  message: string;
  path?: string[];
}[];
```

The first uses the DorkOS (`.passthrough()`) schema; the second uses the strict CC schema from `cc-validator.ts`.

#### 1g. `index.ts` — Barrel updates

Add exports for all new symbols. Keep existing exports unchanged.

---

### Component 2: Server install pipeline (`apps/server/src/services/marketplace/`)

#### 2a. `package-fetcher.ts` — Refactor

Current `fetchFromGit(opts: { gitUrl: string })` assumes every source is a git URL. Refactor to dispatch:

```typescript
interface FetchPackageOptions {
  packageName: string;
  source: PluginSource;
  marketplaceRoot?: string; // for relative-path resolution
  pluginRoot?: string;      // for metadata.pluginRoot
  force?: boolean;
}

async fetchPackage(opts: FetchPackageOptions): Promise<FetchedPackage> {
  const resolved = resolvePluginSource(opts.source, {
    marketplaceRoot: opts.marketplaceRoot,
    pluginRoot: opts.pluginRoot,
  });

  switch (resolved.type) {
    case 'relative-path':
      return this.resolvers.relativePath(resolved, opts);
    case 'github':
      return this.resolvers.github(resolved, opts);
    case 'url':
      return this.resolvers.url(resolved, opts);
    case 'git-subdir':
      return this.resolvers.gitSubdir(resolved, opts);
    case 'npm':
      return this.resolvers.npm(resolved, opts); // throws structured deferred-error
  }
}
```

Constructor injection of `this.resolvers` (4 + 1 stub). Existing `fetchMarketplaceJson()` and `resolveMarketplaceJsonUrl()` are updated to fetch from `.claude-plugin/marketplace.json` (not root).

#### 2b. `source-resolvers/relative-path.ts` — NEW

When the marketplace was cloned as a whole (the user added the registry repo as a marketplace source), relative-path plugins are already on disk. No new clone. The resolver `cd`s into the subdirectory and returns the cached path:

```typescript
async function relativePathResolver(
  resolved: ResolvedSourceDescriptor & { type: 'relative-path' },
  opts: FetchPackageOptions
): Promise<FetchedPackage> {
  const fullPath = path.join(resolved.marketplaceRoot, resolved.path);
  if (!(await exists(fullPath))) {
    throw new PackageNotFoundError(
      `Plugin path ${resolved.path} not found in marketplace root ${resolved.marketplaceRoot}`
    );
  }
  return { path: fullPath, commitSha: 'relative-path', fromCache: true };
}
```

#### 2c. `source-resolvers/github.ts` — NEW

Handles `{ source: 'github', repo, ref?, sha? }`. Builds the git URL from `repo` (`https://github.com/${repo}.git`), delegates to `cloneRepository` with ref pinning. Largely the same as today's `fetchFromGit` but with object input.

#### 2d. `source-resolvers/url.ts` — NEW

Handles `{ source: 'url', url, ref?, sha? }`. Delegates to `cloneRepository(url, ...)`. Supports `https://`, `git@`, and `.git`-optional URLs (Azure DevOps, CodeCommit compatibility).

#### 2e. `source-resolvers/git-subdir.ts` — NEW

The most complex resolver. Implements the sparse-clone sequence:

```typescript
async function gitSubdirResolver(
  resolved: ResolvedSourceDescriptor & { type: 'git-subdir' },
  opts: FetchPackageOptions
): Promise<FetchedPackage> {
  const commitSha = await this.resolveCommitSha(resolved.cloneUrl, resolved.ref);
  const cached = await this.cache.getPackage(opts.packageName, commitSha);
  if (cached && !opts.force) return { path: cached.path, commitSha, fromCache: true };

  const destDir = await this.cache.putPackage(opts.packageName, commitSha);
  try {
    await this.sparseClone({
      cloneUrl: resolved.cloneUrl,
      subpath: resolved.subpath,
      ref: resolved.ref,
      sha: resolved.sha,
      destDir,
    });
  } catch (err) {
    if (isFilterUnsupportedError(err)) {
      this.logger.warn('git-subdir: partial clone unsupported, falling back to shallow clone');
      await this.fallbackShallowClone({ ... });
    } else {
      throw err;
    }
  }
  return { path: path.join(destDir, resolved.subpath), commitSha, fromCache: false };
}
```

**Sparse-clone command sequence** (the canonical implementation):

```bash
# Step 1: Partial + sparse clone (no checkout yet)
git clone \
  --filter=blob:none \
  --no-checkout \
  --depth=1 \
  "<cloneUrl>" \
  "<destDir>"

# Step 2: Initialize cone-mode sparse-checkout
cd "<destDir>"
git sparse-checkout init --cone

# Step 3: Restrict to the target subdirectory
git sparse-checkout set "<subpath>"

# Step 4: Materialize the checkout at the resolved ref
git checkout "<ref>"   # or "<sha>" if specified
```

**Fallback ladder** (when partial clone is unsupported):

1. Try the recommended sequence.
2. On `--filter` failure (older self-hosted git servers): `git clone --no-checkout --depth=1 <url> <dir>` + sparse-checkout steps. Bandwidth higher, correctness preserved.
3. On `--no-checkout` + sparse-checkout failure (git < 2.25): `git clone --depth=1 <url> <dir>` + `rm -rf` non-target directories. Log a warning.
4. Any other failure: hard error with actionable message.

Minimum git version is 2.25 (Jan 2020). CI runners and DorkOS Docker base images are 2.43+.

#### 2f. `source-resolvers/npm.ts` — NEW STUB

```typescript
async function npmResolver(
  resolved: ResolvedSourceDescriptor & { type: 'npm' },
  opts: FetchPackageOptions
): Promise<FetchedPackage> {
  throw new NpmSourceNotSupportedError({
    package: resolved.package,
    version: resolved.version,
    message:
      `npm sources (${resolved.package}) are not yet supported in this DorkOS version. ` +
      `Full npm install pipeline is tracked in spec marketplace-06-npm-sources. ` +
      `See https://docs.dorkos.ai/marketplace/source-types#npm for the roadmap.`,
    docs: 'https://docs.dorkos.ai/marketplace/source-types#npm',
  });
}
```

The error class `NpmSourceNotSupportedError` is a structured error caught by the install pipeline orchestrator and surfaced to the user as "This plugin uses an npm source, which will be supported in a future DorkOS release. The rest of the marketplace works normally."

#### 2g. `transaction.ts`, `marketplace-cache.ts`, `marketplace-installer.ts` — Minor updates

- `transaction.ts`: no logic change. The rollback model (git branch reset for git-based sources) still works because all 4 supported source types are git-based. npm stub doesn't reach the transaction layer.
- `marketplace-cache.ts`: cache key stays `packageName + commitSha`. Relative-path resolver uses commit SHA `'relative-path'` as a sentinel (bypasses cache lookups where inappropriate).
- `marketplace-installer.ts`: orchestrator updates to pass `marketplaceRoot` and `pluginRoot` through to the fetcher.

#### 2h. Update `fetchMarketplaceJson()` to use `.claude-plugin/marketplace.json` path

In `package-fetcher.ts:271`, `resolveMarketplaceJsonUrl(source)` currently builds `<base>/raw/main/marketplace.json`. Update to:

```typescript
function resolveMarketplaceJsonUrl(source: string): string {
  if (source.endsWith('.claude-plugin/marketplace.json')) return source;
  const base = source.replace(/\.git$/, '').replace(/\/$/, '');
  return `${base}/raw/main/.claude-plugin/marketplace.json`;
}
```

Also add a new function `resolveDorkosSidecarUrl(source: string)` that does the same for `.claude-plugin/dorkos.json`.

---

### Component 3: Plugin runtime activation (`apps/server/src/services/runtimes/claude-code/`)

This component lives inside the ESLint boundary that allows `@anthropic-ai/claude-agent-sdk` imports. It is the architectural unlock that removes CC runtime reimplementation from the spec.

#### 3a. `plugin-activation.ts` — NEW

```typescript
/**
 * Build the `options.plugins` array for a Claude Agent SDK `query()` call
 * from the user's currently enabled installed plugins.
 *
 * Each enabled plugin in ~/.dork/marketplace/packages/<name>/ becomes a
 * { type: 'local', path: '<absolute_path>' } entry. The SDK auto-loads
 * skills, commands, agents, hooks, and mcpServers from each plugin directory.
 *
 * Plugins that were installed but are not currently enabled are filtered out.
 * Plugins whose install directory no longer exists (uninstalled) are filtered out
 * and a warning is logged.
 *
 * @module services/runtimes/claude-code/plugin-activation
 */

import { access } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';

export interface ClaudeAgentSdkPlugin {
  type: 'local';
  path: string;
}

export interface BuildActivationOptions {
  /** Absolute path to the DorkOS data directory. */
  dorkHome: string;
  /** Names of plugins the user has enabled. */
  enabledPluginNames: string[];
  /** Logger for warnings about missing directories. */
  logger: Logger;
}

export async function buildClaudeAgentSdkPluginsArray(
  opts: BuildActivationOptions
): Promise<ClaudeAgentSdkPlugin[]> {
  const packagesDir = path.join(opts.dorkHome, 'marketplace', 'packages');
  const active: ClaudeAgentSdkPlugin[] = [];

  for (const name of opts.enabledPluginNames) {
    const pluginPath = path.join(packagesDir, name);
    try {
      await access(pluginPath);
      active.push({ type: 'local', path: pluginPath });
    } catch {
      opts.logger.warn('plugin-activation: enabled plugin directory missing', {
        packageName: name,
        expectedPath: pluginPath,
      });
    }
  }

  return active;
}
```

#### 3b. `claude-code-runtime.ts` — Update

Existing runtime file constructs `query()` call with `ClaudeAgentOptions`. Add plugin activation:

```typescript
import { buildClaudeAgentSdkPluginsArray } from './plugin-activation.js';

async startSession(...) {
  const enabledPlugins = await this.marketplaceService.getEnabledPlugins();
  const pluginsOption = await buildClaudeAgentSdkPluginsArray({
    dorkHome: this.dorkHome,
    enabledPluginNames: enabledPlugins.map((p) => p.name),
    logger: this.logger,
  });

  const options: ClaudeAgentOptions = {
    ...existingOptions,
    plugins: pluginsOption, // [] when no plugins enabled
  };

  return query({ prompt: ..., options });
}
```

When no plugins are enabled, `plugins: []` is passed (or omitted). Either is safe.

#### 3c. `marketplace-service.getEnabledPlugins()` — NEW or existing

A method on the marketplace service that returns the list of currently enabled installed plugins. May already exist from spec 03; if not, implement it as part of this spec.

---

### Component 4: Site fetch and UI (`apps/site/src/layers/features/marketplace/`)

#### 4a. `lib/fetch.ts` — Update

```typescript
// OLD (hardcoded):
const MARKETPLACE_URL =
  'https://raw.githubusercontent.com/dorkos-community/marketplace/main/marketplace.json';

// NEW:
const MARKETPLACE_URL =
  'https://raw.githubusercontent.com/dork-labs/marketplace/main/.claude-plugin/marketplace.json';
const DORKOS_SIDECAR_URL =
  'https://raw.githubusercontent.com/dork-labs/marketplace/main/.claude-plugin/dorkos.json';
```

Update `fetchMarketplaceJson()` to also fetch the sidecar in parallel:

```typescript
export async function fetchMarketplaceJson(): Promise<{
  marketplace: MarketplaceJson;
  sidecar: DorkosSidecar | null;
  merged: MergedMarketplaceEntry[];
}> {
  const [marketplaceRes, sidecarRes] = await Promise.all([
    fetch(MARKETPLACE_URL, { next: { revalidate: 3600 } }),
    fetch(DORKOS_SIDECAR_URL, { next: { revalidate: 3600 } }),
  ]);
  // parse both, call mergeMarketplace()
  // sidecar is optional — if 404, merged entries have dorkos: undefined
}
```

Update `fetchPackageReadme(source)` to handle 4 source forms (npm: 404):

```typescript
export async function fetchPackageReadme(source: PluginSource): Promise<string> {
  const resolved = resolvePluginSource(source, { marketplaceRoot: MARKETPLACE_ROOT });
  switch (resolved.type) {
    case 'relative-path':
      return fetchText(
        `https://raw.githubusercontent.com/dork-labs/marketplace/main/${resolved.path}/README.md`
      );
    case 'github':
      return fetchText(`https://raw.githubusercontent.com/${resolved.repo}/main/README.md`);
    case 'url':
      return fetchText(`${resolved.url.replace(/\.git$/, '')}/raw/main/README.md`);
    case 'git-subdir':
      return fetchText(
        `${resolved.cloneUrl.replace(/\.git$/, '')}/raw/main/${resolved.subpath}/README.md`
      );
    case 'npm':
      // npm README fetching is deferred with npm itself
      return '';
  }
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { next: { revalidate: 3600 } });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}
```

Graceful degradation: any fetch error returns empty string. The PackageReadme component already handles empty markdown by rendering nothing.

#### 4b. UI components — Minor updates

- `PackageHeader.tsx`: render `author.name` instead of `author` (object access).
- `InstallInstructions.tsx`: per-source-type install commands. Examples:
  - relative-path: `dorkos install <name>@dorkos`
  - github: `dorkos install <name>@dorkos` (same — resolver handles it)
  - git-subdir: same — resolver handles it
  - url: same
  - npm: "Coming soon — npm sources deferred to marketplace-06"
- `PackageCard.tsx`: no changes.
- `MarketplaceGrid.tsx`, `FeaturedAgentsRail.tsx`, `MarketplaceHeader.tsx`, `RelatedPackages.tsx`, `PermissionPreviewServer.tsx`: no logic changes.

#### 4c. Marketplace pages — Minor updates

- `app/(marketing)/marketplace/page.tsx`: no logic change (receives merged entries from the updated fetch).
- `app/(marketing)/marketplace/[slug]/page.tsx`: no logic change (fetch update is in `lib/fetch.ts`).
- `app/(marketing)/marketplace/privacy/page.tsx`: no change.

---

### Component 5: CLI validators (`packages/cli/src/commands/`)

#### 5a. `package-validate-marketplace.ts` — Update

Current flow:

1. Read file at path
2. Call `parseMarketplaceJson(raw)`
3. Report errors

New flow:

1. Read file at path
2. Call `parseMarketplaceJson(raw)` (DorkOS schema, passthrough)
3. If file is `.claude-plugin/marketplace.json`, also read `.claude-plugin/dorkos.json` (if exists) and call `parseDorkosSidecar(raw)`
4. Call `validateMarketplaceJsonWithCcSchema(raw)` (CC strict schema) as a second pass — if this fails, emit an error with the exact CC validator message; this is the outbound compatibility check
5. Enforce reserved marketplace name list
6. Emit a summary: (a) DorkOS validation status, (b) CC compatibility status, (c) sidecar status (present/absent/invalid), (d) reserved-name status

Exit codes:

- 0: all checks pass
- 1: validation errors
- 2: CC compatibility check fails (separate exit code for CI gates)

#### 5b. `package-validate-remote.ts` — Update

Same flow as `package-validate-marketplace.ts` but fetches via HTTP first. Updates the fetch URL to append `.claude-plugin/marketplace.json`.

#### 5c. `scripts/sync-cc-schema.ts` — NEW (in `packages/cli/` or `scripts/` workspace root)

Weekly CI cron script:

1. Fetch `https://raw.githubusercontent.com/hesreallyhim/claude-code-json-schema/main/schemas/marketplace.schema.json`
2. Read the current DorkOS Zod port from `packages/marketplace/src/cc-validator.ts`
3. Compute a structural diff (field additions, removals, type changes)
4. If diff is non-empty, open a pull request labeled `cc-schema-drift` with the diff in the description
5. If diff is empty, log "cc-schema: no drift" and exit 0

Implementation: shell script or TS script invoked via `pnpm` command. GitHub Actions workflow in `.github/workflows/cc-schema-sync.yml` runs weekly on Mondays at 10:00 UTC.

---

### Component 6: Telemetry schema update (`apps/site/src/db/schema.ts`)

Add `source_type` column to `marketplace_install_events`:

```typescript
export const marketplaceInstallEvents = pgTable(
  'marketplace_install_events',
  {
    // ... existing columns ...
    sourceType: text('source_type', {
      enum: ['relative-path', 'github', 'url', 'git-subdir', 'npm'],
    }).notNull(),
  }
  // ... indexes unchanged ...
);
```

Generate migration via `pnpm db:generate`. Privacy contract unchanged (no PII added). The server-side telemetry reporter (`apps/server/src/services/marketplace/telemetry-reporter.ts`) is updated to include `sourceType` in the payload it sends to `/api/telemetry/install`.

The Edge Function at `apps/site/src/app/api/telemetry/install/route.ts` gets the Zod schema updated to accept the new field and writes it through.

---

### Component 7: Seed fixture rewrite (`packages/marketplace/fixtures/`)

Current fixture: `packages/marketplace/fixtures/dorkos-community-marketplace.json` — a single file with 8 entries using bare GitHub URLs as `source`.

New structure:

```
packages/marketplace/fixtures/
├── dorkos-seed/
│   ├── .claude-plugin/
│   │   ├── marketplace.json       ← the new format
│   │   └── dorkos.json            ← the sidecar
│   ├── plugins/
│   │   ├── code-reviewer/         ← dir structure mirrors what
│   │   │   ├── .claude-plugin/    ← the live registry repo will look like
│   │   │   │   └── plugin.json
│   │   │   ├── README.md
│   │   │   └── skills/quality-review/SKILL.md
│   │   ├── security-auditor/
│   │   ├── docs-keeper/
│   │   ├── linear-integration/
│   │   ├── posthog-monitor/
│   │   ├── security-audit-pack/
│   │   ├── release-pack/
│   │   └── discord-adapter/
│   └── README.md
├── cc-compat/                     ← synthetic DorkOS-generated, tests Direction A
│   ├── minimal.json
│   ├── full-cc-fields.json
│   ├── sidecar-isolation.json + dorkos.json
│   ├── source-relative-path.json
│   ├── source-github.json
│   ├── source-url.json
│   ├── source-git-subdir.json
│   └── source-npm-stub.json       ← validates but triggers deferred error
├── cc-real/                       ← vendored real CC marketplaces, tests Direction B
│   ├── claude-plugins-official-snapshot.json  (pinned to commit)
│   └── claude-plugins-official-snapshot.sha   (manifest: fetch URL + commit sha + date)
└── legacy/
    └── dorkos-community-marketplace.json   ← preserved for 1 release for comparison
```

**Seed content** (8 entries, all using relative-path with `metadata.pluginRoot: "./plugins"`):

```json
{
  "name": "dorkos",
  "owner": {
    "name": "Dork Labs",
    "email": "hello@dorkos.ai"
  },
  "metadata": {
    "description": "Official marketplace for DorkOS — agents, plugins, skill packs, and adapters",
    "version": "0.1.0",
    "pluginRoot": "./plugins"
  },
  "plugins": [
    {
      "name": "code-reviewer",
      "source": "code-reviewer",
      "description": "Reviews your PRs every weekday morning, posts findings to Slack, files Linear issues for blockers",
      "author": { "name": "Dork Labs" },
      "license": "MIT",
      "category": "code-quality",
      "tags": ["review", "pr", "ci"],
      "keywords": ["code-review", "quality"]
    },
    { "name": "security-auditor", "source": "security-auditor", ... },
    { "name": "docs-keeper", "source": "docs-keeper", ... },
    { "name": "linear-integration", "source": "linear-integration", ... },
    { "name": "posthog-monitor", "source": "posthog-monitor", ... },
    { "name": "security-audit-pack", "source": "security-audit-pack", ... },
    { "name": "release-pack", "source": "release-pack", ... },
    { "name": "discord-adapter", "source": "discord-adapter", ... }
  ]
}
```

**Sidecar** (`dorkos.json`):

```json
{
  "$schema": "https://dorkos.ai/schemas/dorkos-marketplace.schema.json",
  "schemaVersion": 1,
  "plugins": {
    "code-reviewer": {
      "type": "agent",
      "layers": ["agents", "tasks"],
      "icon": "🔍",
      "featured": true,
      "pricing": { "model": "free" }
    },
    "security-auditor": {
      "type": "agent",
      "layers": ["agents", "tasks"],
      "icon": "🛡️",
      "featured": true,
      "pricing": { "model": "free" }
    },
    "docs-keeper": {
      "type": "agent",
      "layers": ["agents"],
      "icon": "📚",
      "featured": true,
      "pricing": { "model": "free" }
    },
    "linear-integration": {
      "type": "plugin",
      "layers": ["extensions", "adapters"],
      "icon": "📋",
      "pricing": { "model": "free" }
    },
    "posthog-monitor": {
      "type": "plugin",
      "layers": ["extensions", "tasks"],
      "icon": "📊",
      "pricing": { "model": "free" }
    },
    "security-audit-pack": {
      "type": "skill-pack",
      "layers": ["tasks"],
      "icon": "🔐",
      "pricing": { "model": "free" }
    },
    "release-pack": {
      "type": "skill-pack",
      "layers": ["tasks", "skills"],
      "icon": "🚀",
      "pricing": { "model": "free" }
    },
    "discord-adapter": {
      "type": "adapter",
      "layers": ["adapters"],
      "icon": "💬",
      "pricing": { "model": "free" }
    }
  }
}
```

Each plugin subdirectory has minimal content for v1:

- `.claude-plugin/plugin.json` — CC plugin manifest (name, description, version)
- `README.md` — human-readable description
- `skills/` or similar — stub content (real agent logic is "out of scope, separate engineering effort" per the original marketplace-04 spec)

---

### Component 8: Documentation updates

| File                                                         | Section         | Change                                                                                                                                                                              |
| ------------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contributing/marketplace-registry.md`                       | All             | Rewrite to reflect new format: sidecar, 5 source forms, `.claude-plugin/` file locations, same-repo monorepo pattern, `metadata.pluginRoot`, reserved names, CC compatibility pitch |
| `contributing/marketplace-installs.md`                       | Install flow    | Add source-type dispatch section explaining the 4 git resolvers + npm stub                                                                                                          |
| `contributing/marketplace-packages.md`                       | Entry structure | Document sidecar strategy and DorkOS extension fields location                                                                                                                      |
| `contributing/marketplace-telemetry.md`                      | Schema          | Add `source_type` column and privacy implications (none new)                                                                                                                        |
| `contributing/external-agent-marketplace-access.md`          | —               | Minor updates for new source forms                                                                                                                                                  |
| `docs/marketplace.mdx`                                       | Format          | Public-facing format documentation with all 5 source type examples                                                                                                                  |
| `specs/marketplace-04-web-and-registry/04-implementation.md` | Top             | Add forward-pointer: "⚠️ Schema superseded by marketplace-05-claude-code-format-superset. See that spec for the current `marketplace.json` format."                                 |

---

### Component 9: ADRs

Four new ADRs:

- **ADR-0236 — Sidecar `dorkos.json` for DorkOS marketplace extensions**
  - Context: CC uses `additionalProperties: false` on plugin entries. Inline extension approaches (`x-dorkos`, top-level passthrough) fail validation.
  - Decision: Separate sidecar file `.claude-plugin/dorkos.json` at the same path level as `marketplace.json`. Indexed by plugin name. DorkOS reads both; CC reads only `marketplace.json`.
  - Consequences: Positive — bulletproof from CC perspective, no risk of CC schema changes breaking DorkOS. Negative — second fetch required, merge logic needs drift handling.

- **ADR-0237 — Same-repo monorepo for the dork-labs/marketplace seed**
  - Context: Need to minimize repo sprawl while supporting both first-party seed packages and community contributions.
  - Decision: `dork-labs/marketplace` holds both the registry (`.claude-plugin/marketplace.json`) and the seed packages (`plugins/*/`). Community contributors add entries with `github` or `git-subdir` sources pointing to their own repos. This is the canonical CC walkthrough pattern.
  - Consequences: Positive — atomic catalog+code PRs, zero tooling overhead, lowest contributor friction, single repo. Negative — Dork Labs packages don't have independent release cadences until they graduate to their own repos.

- **ADR-0238 — Port-to-Zod CC validator with weekly sync cron**
  - Context: CC binary is closed-source; `claude plugin validate` shelling is infeasible in CI. Anthropic does not publish a stable schema URL. `hesreallyhim/claude-code-json-schema` is the community reference.
  - Decision: Port the CC schema to Zod in `packages/marketplace/src/cc-validator.ts`. Add a weekly CI cron that diffs against the reference and opens a PR on drift. Sync direction invariant: DorkOS schema MUST NOT be stricter than CC's CLI behavior.
  - Consequences: Positive — native Zod validation, no binary dep, no auth required. Negative — must track CC schema changes manually; schema drift risk requires ongoing maintenance.

- **ADR-0239 — Plugin runtime activation via Claude Agent SDK `options.plugins`**
  - Context: Need to execute installed plugins (skills, commands, agents, hooks, MCP servers). Reimplementing CC's runtime would double spec scope and diverge from CC's actual semantics.
  - Decision: Pass enabled installed plugin paths to the Claude Agent SDK via `options.plugins: [{ type: "local", path }]` at session start. The SDK auto-loads all CC component types. Implementation in `services/runtimes/claude-code/plugin-activation.ts` inside the existing ESLint boundary.
  - Consequences: Positive — zero CC runtime reimplementation, stays current with CC automatically, clean architectural split (DorkOS owns install, SDK owns runtime). Negative — plugin runtime works only when the active runtime is the Claude Agent SDK; future non-CC runtimes would need their own activation implementation.

---

## Implementation Phases

Phase ordering respects the dependency graph so tests can be written against the new schema before the install pipeline changes land. Holistic batch-level verification gates per stored feedback (`feedback_holistic_batch_gates.md`).

### Phase 1 — Foundations (parallel-safe after empirical step)

**1.1** — Empirical sidecar verification (load-bearing)

- Install Claude Code locally (`npm i -g @anthropic-ai/claude-code` or equivalent)
- Create two synthetic fixtures:
  - A: minimal CC marketplace.json with NO DorkOS fields inline (expected: `claude plugin validate` passes)
  - B: same file with `x-dorkos: { type: "agent" }` added to one plugin entry (expected: `claude plugin validate` fails with `additionalProperties: false` error)
- Run `claude plugin validate` against both
- Document result in an ephemeral research file `research/20260407_cc_validator_empirical_verify.md`
- If A passes and B fails: sidecar strategy is correct, proceed
- If B unexpectedly passes (CC has loosened validation): revisit ADR-0236 with an inline-extension alternative
- **This step blocks all schema work in Phase 1.2+**

**1.2** — Port CC schema to Zod (`packages/marketplace/src/cc-validator.ts`)

- Use `hesreallyhim/claude-code-json-schema` as reference
- Translate synthetic fixtures into Vitest tests
- Verify against the 5 source types
- Add reserved-name list

**1.3** — New schemas in `@dorkos/marketplace`

- Rewrite `marketplace-json-schema.ts`: 5 source forms, `owner`, `metadata`, `author` object, `strict`, opaque CC component fields, `.passthrough()` top-level
- New `dorkos-sidecar-schema.ts`: `DorkosSidecarSchema`, `DorkosEntrySchema`, `PricingSchema`
- New `merge-marketplace.ts`: `mergeMarketplace()` with drift handling
- New `source-resolver.ts`: `resolvePluginSource()` pure function, `metadata.pluginRoot` semantics
- Updated `marketplace-json-parser.ts`: add `parseDorkosSidecar()` and `parseMarketplaceWithSidecar()`
- Updated `package-validator.ts`: add `validateMarketplaceJson()` and `validateMarketplaceJsonWithCcSchema()`
- Updated `index.ts`: barrel exports

**1.4** — Schema tests

- Unit tests for `MarketplaceJsonSchema` — 5 source forms × valid/invalid cases
- Unit tests for `DorkosSidecarSchema` — drift handling, pricing shape
- Unit tests for `source-resolver.ts` — `metadata.pluginRoot` edge cases, `..` rejection
- Unit tests for `mergeMarketplace()` — orphan plugins, missing sidecars, both-present
- Unit tests for `cc-validator.ts` — reject inline DorkOS fields

**1.5** — Draft ADR-0236 (sidecar) and ADR-0238 (port-to-Zod)

**Batch 1 gate**: `pnpm typecheck` + `pnpm lint` + `pnpm test --filter @dorkos/marketplace` all pass.

### Phase 2 — Source resolution and install pipeline (depends on Phase 1)

**2.1** — `source-resolvers/relative-path.ts`

- Implementation + tests
- Mocked filesystem for test cases

**2.2** — `source-resolvers/github.ts`

- Implementation + tests
- Mocked git clone via existing `TemplateDownloader`

**2.3** — `source-resolvers/url.ts`

- Implementation + tests
- Same mocking pattern

**2.4** — `source-resolvers/git-subdir.ts`

- Implementation + tests
- Sparse-clone command sequence
- Fallback ladder for `--filter` rejection
- SHA pinning verification
- Mocked git subprocess for unit tests
- Integration test with a real public GitHub monorepo as fixture (small repo, e.g., an Astro Starlight integration)

**2.5** — `source-resolvers/npm.ts` STUB

- Throws `NpmSourceNotSupportedError` with structured message
- Unit test verifies the error shape

**2.6** — `package-fetcher.ts` refactor

- New `fetchPackage(opts)` dispatch
- Updated `resolveMarketplaceJsonUrl()` to use `.claude-plugin/marketplace.json`
- New `resolveDorkosSidecarUrl()` helper
- Constructor dependency injection for resolvers
- Tests: dispatch logic, URL resolution

**2.7** — `marketplace-installer.ts` and `transaction.ts` updates

- Pass `marketplaceRoot` and `pluginRoot` through
- Integration tests for all 4 supported source types + npm deferred-error
- Transaction rollback tests (unchanged rollback model, new test coverage for npm error path)

**Batch 2 gate**: `pnpm typecheck` + `pnpm lint` + `pnpm test --filter @dorkos/server` all pass. 4×4 matrix (4 source types × 4 package types) integration tests green.

### Phase 3 — Plugin runtime activation (depends on Phase 1)

**3.1** — `plugin-activation.ts`

- Implementation of `buildClaudeAgentSdkPluginsArray()`
- Filesystem access check (warn on missing dirs)
- Unit tests with a mocked filesystem

**3.2** — `claude-code-runtime.ts` wire-up

- Call `buildClaudeAgentSdkPluginsArray()` at session start
- Pass result to `query({ options: { plugins } })`
- Integration test: install a fixture plugin, start a session, verify `plugins` option is populated

**3.3** — `marketplace-service.getEnabledPlugins()` method

- Add if not already present
- Integration test

**3.4** — Draft ADR-0239 (SDK plugin activation)

**Batch 3 gate**: `pnpm typecheck` + `pnpm lint` pass. Plugin activation unit tests green.

### Phase 4 — Site fetch and UI updates (depends on Phase 1)

**4.1** — `apps/site/src/layers/features/marketplace/lib/fetch.ts` update

- New fetch URL (`.claude-plugin/marketplace.json`)
- New `fetchDorkosSidecar()`
- `fetchPackageReadme(source)` per-source dispatch
- Graceful 404 degradation
- Tests with mocked fetch

**4.2** — UI component updates

- `PackageHeader.tsx`: `author.name` rendering
- `InstallInstructions.tsx`: per-source-type install commands
- Component tests verify new shapes render correctly

**4.3** — `MarketplacePage` and `PackageDetailPage` — no logic changes (inherit)

- Regression tests verify the browse page still renders

**Batch 4 gate**: `pnpm typecheck` + `pnpm lint` + `pnpm test --filter @dorkos/site` all pass.

### Phase 5 — Seed rewrite and CLI validators (depends on Phases 1-4)

**5.1** — Seed fixture rewrite

- New `fixtures/dorkos-seed/` directory structure
- `.claude-plugin/marketplace.json` with 8 entries using relative-path sources + `metadata.pluginRoot: "./plugins"`
- `.claude-plugin/dorkos.json` with extensions for all 8
- `plugins/*/` subdirectories with stub content (manifest + README + empty skills/)
- Retain `legacy/dorkos-community-marketplace.json` for one release as reference

**5.2** — `cc-compat/` test fixtures (Direction A)

- 6 fixtures covering: minimal, full-cc-fields, sidecar-isolation, and 4 supported source types
- Tests run DorkOS `MarketplaceJsonSchema` AND `cc-validator.ts` against each

**5.3** — `cc-real/` test fixtures (Direction B)

- Vendored snapshot of `anthropics/claude-plugins-official/.claude-plugin/marketplace.json`
- Committed with pinned commit SHA and date in `claude-plugins-official-snapshot.sha`
- Test runs DorkOS parser + dispatcher against every entry
- Test verifies all 5 source types parse correctly (npm stub surfaces the deferred error)

**5.4** — `package-validate-marketplace.ts` CLI update

- Read sidecar alongside marketplace.json
- Run CC validator as second pass
- Enforce reserved name list
- New exit codes (0/1/2)
- Tests for all code paths

**5.5** — `package-validate-remote.ts` CLI update

- Fetch sidecar in parallel
- Same validation flow
- Tests with mocked HTTP

**5.6** — `scripts/sync-cc-schema.ts`

- Weekly cron script
- Fetch + diff + PR-open logic
- `.github/workflows/cc-schema-sync.yml` workflow

**Batch 5 gate**: All fixtures pass both DorkOS and CC validators appropriately. CLI validation tests green.

### Phase 6 — Telemetry schema and runtime-activation integration tests (depends on Phases 2+3)

**6.1** — Drizzle schema update

- Add `source_type` column to `marketplace_install_events`
- Generate migration via `pnpm db:generate`
- Apply migration on dev Neon DB
- Update `apps/site/src/app/api/telemetry/install/route.ts` Zod schema to accept new field
- Update `apps/server/src/services/marketplace/telemetry-reporter.ts` to include `sourceType` in payload

**6.2** — Runtime activation end-to-end test

- Install a fixture plugin via marketplace installer (mocked git clone)
- Start a Claude Agent SDK session via `claude-code-runtime.ts`
- Assert that the session's init message lists the plugin in `plugins` array
- Assert that `slash_commands` includes at least one plugin-namespaced command

**Batch 6 gate**: End-to-end install + runtime-activation test passes.

### Phase 7 — Documentation and spec 04 forward-pointer (depends on all prior phases)

**7.1** — Update 6 contributing/docs files (per Component 8 table)
**7.2** — Add forward-pointer to `specs/marketplace-04-web-and-registry/04-implementation.md`
**7.3** — Draft ADR-0237 (same-repo monorepo)
**7.4** — Update CLAUDE.md marketplace section with new org + repo + sidecar pattern
**7.5** — Update `CHANGELOG.md` under `## [Unreleased] → ### Changed`

**Batch 7 gate**: All docs updated. ADRs ready for `/adr:curate`.

### Phase 8 — Manual smoke tests and unblock #28

**8.1** — Install Claude Code locally
**8.2** — Manual: `claude plugin validate` against `fixtures/dorkos-seed/.claude-plugin/marketplace.json` → must pass
**8.3** — Bootstrap `github.com/dork-labs/marketplace` with the seed content (this is the execution of formerly-#28 but with the new schema)
**8.4** — Manual: `claude plugin marketplace add dork-labs/marketplace` in a local CC install → must succeed
**8.5** — Manual: `claude plugin install code-reviewer@dorkos` in the local CC install → must succeed and the plugin must be usable
**8.6** — Manual: in DorkOS, enable `code-reviewer` from the marketplace UI → start an agent session → verify the plugin skills appear in `slash_commands`
**8.7** — Document manual test results in `04-implementation.md`

**Batch 8 gate**: All manual tests pass. #28 deploy is unblocked and complete.

**Approximate task count after decomposition: ~24-28 tasks across 8 phases.**

---

## Acceptance Criteria

### Functional

1. **The six incompatibilities are fixed**:
   - ✅ `source` field accepts the 5 CC source forms as a discriminated union
   - ✅ `owner: { name, email? }` is required at the top level
   - ✅ `metadata: { description, version, pluginRoot }` is optional
   - ✅ `author: { name, email? }` (object, not string)
   - ✅ File location is `.claude-plugin/marketplace.json` (not root)
   - ✅ `strict` field and CC component fields (`commands`, `agents`, `hooks`, `mcpServers`, `lspServers`) are modeled (as opaque unknown)

2. **Strict superset invariants hold**:
   - ✅ The rewritten seed fixture (`fixtures/dorkos-seed/.claude-plugin/marketplace.json`) passes `claude plugin validate` when manually tested against a locally-installed Claude Code binary
   - ✅ The vendored snapshot of `anthropics/claude-plugins-official` parses via DorkOS's schema with no errors
   - ✅ For every plugin in the snapshot, DorkOS can construct a `ResolvedSourceDescriptor` via `resolvePluginSource()`
   - ✅ Source types the spec supports (relative-path, github, url, git-subdir) install successfully in integration tests; npm source surfaces a structured deferred-error

3. **DorkOS-specific extensions are in the sidecar, not inline**:
   - ✅ `fixtures/dorkos-seed/.claude-plugin/marketplace.json` contains zero DorkOS-specific fields
   - ✅ `fixtures/dorkos-seed/.claude-plugin/dorkos.json` contains all 8 plugins with their extensions
   - ✅ `cc-validator.ts` rejects a fixture that has `x-dorkos` inline (confirming the sidecar strategy is load-bearing)

4. **`git-subdir` sparse clone works on GitHub, GitLab, and at least one self-hosted git host**:
   - ✅ Unit test mocks the git subprocess and verifies the command sequence
   - ✅ Integration test performs a real sparse clone against a small public GitHub monorepo fixture
   - ✅ Fallback ladder is exercised by mocking `--filter` unsupported

5. **Plugin runtime activation works end-to-end**:
   - ✅ Install a fixture plugin via DorkOS's marketplace pipeline
   - ✅ Enable the plugin
   - ✅ Start an agent session
   - ✅ Assert `message.plugins` in the session init contains the fixture plugin
   - ✅ Assert `message.slash_commands` contains at least one namespaced command from the plugin (e.g., `fixture-plugin:quality-review`)

6. **CLI validators enforce reserved names and run CC compatibility check**:
   - ✅ `dorkos package validate-marketplace <path>` rejects all 8 CC reserved names
   - ✅ `dorkos package validate-marketplace <path>` runs CC schema pass and reports pass/fail with exit code 0 or 2

7. **Telemetry tracks source type**:
   - ✅ `marketplace_install_events` has a `source_type` column populated for every install
   - ✅ Drizzle migration applied to dev Neon DB

### Quality gates

- ✅ `pnpm typecheck` at workspace root: 21/21 successful (no new errors)
- ✅ `pnpm lint` at workspace root: 0 new errors; pre-existing warnings unchanged
- ✅ `pnpm test --filter @dorkos/marketplace`: all tests pass including 14 new fixture tests
- ✅ `pnpm test --filter @dorkos/server`: all marketplace tests pass including source-type dispatch
- ✅ `pnpm test --filter @dorkos/site`: all tests pass including fetch + UI updates
- ✅ `pnpm test --filter @dorkos/cli`: all tests pass including validator updates
- ✅ `pnpm build --filter @dorkos/site`: succeeds

### Documentation and process

- ✅ 6 contributing/docs files updated
- ✅ Forward-pointer added to `specs/marketplace-04-web-and-registry/04-implementation.md`
- ✅ 4 new ADRs drafted (0236, 0237, 0238, 0239) and ready for `/adr:curate`
- ✅ CLAUDE.md updated with new marketplace org/repo/format
- ✅ CHANGELOG.md has an entry under Unreleased

### Manual verification (cannot be automated)

- ✅ A locally-installed Claude Code binary can add `dork-labs/marketplace` and install a plugin from it
- ✅ A DorkOS user can install a plugin via the marketplace UI and use its skills in an agent session
- ✅ #28 is no longer blocked (the seed repo can be created with the new layout)
- ✅ `claude plugin validate` pre-merge gate: run manually against the rewritten seed before merging

---

## Testing Strategy

### Unit tests

| Module                              | Test file                                          | Coverage                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `marketplace-json-schema.ts`        | `__tests__/marketplace-json-schema.test.ts`        | 5 source forms × valid/invalid, `owner`/`metadata`/`author` shapes, reserved names, `additionalProperties: false` behavior on cc-validator |
| `dorkos-sidecar-schema.ts`          | `__tests__/dorkos-sidecar-schema.test.ts`          | All DorkOS fields, pricing shape, drift handling                                                                                           |
| `source-resolver.ts`                | `__tests__/source-resolver.test.ts`                | Every source type, `metadata.pluginRoot` semantics, `..` rejection, absolute path rejection                                                |
| `mergeMarketplace`                  | `__tests__/merge-marketplace.test.ts`              | Both-present, sidecar missing, orphan plugin warning, empty states                                                                         |
| `cc-validator.ts`                   | `__tests__/cc-validator.test.ts`                   | Strict mode rejects inline DorkOS fields, accepts all CC-native shapes                                                                     |
| `package-fetcher.ts`                | `__tests__/package-fetcher.test.ts`                | Dispatch by source type, URL resolution, error paths                                                                                       |
| `source-resolvers/relative-path.ts` | `__tests__/source-resolvers/relative-path.test.ts` | Path resolution, missing directory                                                                                                         |
| `source-resolvers/github.ts`        | `__tests__/source-resolvers/github.test.ts`        | URL construction, ref/sha pinning                                                                                                          |
| `source-resolvers/url.ts`           | `__tests__/source-resolvers/url.test.ts`           | URL variants (https, git@, .git-optional)                                                                                                  |
| `source-resolvers/git-subdir.ts`    | `__tests__/source-resolvers/git-subdir.test.ts`    | Command sequence, fallback ladder, SHA pinning                                                                                             |
| `source-resolvers/npm.ts`           | `__tests__/source-resolvers/npm.test.ts`           | Structured error shape                                                                                                                     |
| `plugin-activation.ts`              | `__tests__/plugin-activation.test.ts`              | Build plugins array, filter missing dirs, log warnings                                                                                     |

### Integration tests

| Scenario                                                    | Test file                                             | Mechanism                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| Direction A: minimal DorkOS marketplace passes CC validator | `__tests__/cc-compat.test.ts`                         | Zod parse against `cc-validator.ts`                                      |
| Direction A: full CC fields pass                            | Same                                                  | Same                                                                     |
| Direction A: sidecar isolation                              | Same                                                  | AST/key enumeration — verify no DorkOS keys appear in `marketplace.json` |
| Direction A: all 4 supported source types pass              | Same                                                  | Per-type fixture                                                         |
| Direction A: round-trip parse → serialize → validate        | Same                                                  | Integration                                                              |
| Direction A: empirical `claude plugin validate` pass        | Manual (Phase 1.1)                                    | Run against rewritten seed                                               |
| Direction B: `claude-plugins-official` snapshot parses      | `__tests__/cc-real.test.ts`                           | Committed JSON fixture                                                   |
| Direction B: all 5 source types dispatch correctly          | Same                                                  | Mocked resolvers                                                         |
| Direction B: git-subdir live integration                    | `__tests__/integration/git-subdir-live.test.ts`       | Real sparse clone against small public monorepo                          |
| Direction B: relative path resolves to subdir               | Same                                                  | Mocked marketplace root                                                  |
| Direction B: npm source produces structured deferred-error  | Same                                                  | Error shape assertion                                                    |
| Direction B: unknown CC fields gracefully tolerated         | Same                                                  | Future-field fixture                                                     |
| Plugin runtime activation end-to-end                        | `__tests__/integration/plugin-activation.test.ts`     | Install fixture → start session → assert init.plugins + slash_commands   |
| Telemetry source_type column roundtrip                      | `__tests__/integration/telemetry-source-type.test.ts` | Install + Drizzle insert + assert column                                 |

**Test matrix total**: 6 Direction A + 8 Direction B = 14 fixture tests, plus per-module unit tests (~40 tests), plus 2 major integration tests.

### Manual tests (required before merge)

1. Install Claude Code locally (`npm i -g @anthropic-ai/claude-code` or current install method)
2. Run `claude plugin validate fixtures/dorkos-seed/.claude-plugin/marketplace.json` → expect PASS
3. Run `claude plugin validate` against a fixture with inline `x-dorkos` field → expect FAIL with `additionalProperties` error (empirical confirmation of the sidecar strategy)
4. Create `github.com/dork-labs/marketplace` (after approval)
5. Run `claude plugin marketplace add dork-labs/marketplace` → expect success, see `dorkos` in marketplace list
6. Run `claude plugin install code-reviewer@dorkos` → expect success
7. In DorkOS: install `code-reviewer` via the marketplace UI, enable it, start an agent session, verify its skills are available

---

## Risks and Mitigations

### Risk 1: CC schema drift (HIGH)

**What**: Anthropic has changed the CC validator at least 4 times in 6 months (Issues #15198, #20423, #26555, #33739). Any change to CC's schema can silently break DorkOS's outbound compatibility.

**Mitigation**:

- Weekly CI cron (`.github/workflows/cc-schema-sync.yml`) diffs against `hesreallyhim/claude-code-json-schema`
- PR opened automatically on drift (label `cc-schema-drift`, assigned to marketplace maintainers)
- `cc-validator.ts` has a sync direction invariant: MUST NOT be stricter than CC's actual CLI behavior
- Manual `claude plugin validate` smoke test before every marketplace-related release
- ADR-0238 documents the maintenance commitment

### Risk 2: `additionalProperties: false` regression (MEDIUM)

**What**: If CC ever loosens its plugin entry validation, DorkOS's Zod schema must track that change. If it doesn't, DorkOS becomes accidentally stricter than CC and starts rejecting packages CC accepts — a false positive in the outbound direction.

**Mitigation**:

- Sync direction invariant (Risk 1 mitigation)
- Explicit unit test: "cc-validator rejects inline x-dorkos fields" — if this test starts passing (CC loosens), it's a signal to update the schema
- Weekly sync cron catches shape changes

### Risk 3: `git-subdir` host compatibility (MEDIUM)

**What**: Sparse partial clone is supported by all major hosts as of August 2024, but self-hosted git servers running older versions may not support `--filter=blob:none`. DorkOS installs could fail on enterprise or self-hosted configurations.

**Mitigation**:

- Documented fallback ladder in `git-subdir.ts` (partial clone → shallow clone → full clone with cleanup)
- `isFilterUnsupportedError()` detection function with clear error categorization
- CI integration test matrix for GitHub + at least one other host (GitLab or Gitea)
- User-facing error messages identify the host and recommend a manual fallback

### Risk 4: Claude Agent SDK plugin API changes (LOW)

**What**: The `options.plugins: [{ type: "local", path }]` API is documented but relatively new. If Anthropic renames or refactors it, `plugin-activation.ts` breaks.

**Mitigation**:

- `plugin-activation.ts` is a small file (~50 lines), easy to update
- Claude Agent SDK version is pinned in `package.json`
- Breaking changes to the SDK are generally in major versions and clearly noted in changelogs
- The SDK's `@anthropic-ai/claude-agent-sdk` package has its own CHANGELOG we can monitor

### Risk 5: Seed package stubs don't demonstrate real value (LOW)

**What**: The 8 seed packages ship with stub content (manifest + README + empty skills) per the original marketplace-04 scope. Users who install them get a marketplace experience but no real functionality.

**Mitigation**:

- This is explicitly out-of-scope per marketplace-04 and remains so in marketplace-05
- Seed stubs are enough to prove the end-to-end install + runtime activation pipeline works
- Real package content is a separate engineering effort tracked outside the spec sequence
- Documentation explicitly frames the seed as "reference implementation + install fixture," not a production-ready catalog

### Risk 6: Manual pre-merge step creates friction (LOW)

**What**: Phase 1.1 (empirical CC validator check) and Phase 8 (manual end-to-end smoke tests) both require a human to install Claude Code locally. This is friction that could cause shortcuts.

**Mitigation**:

- Phase 1.1 is a one-time check per spec, not per PR
- Phase 8 is done at the end of the spec before considering it complete
- Both are documented in `04-implementation.md` when done
- Neither blocks individual task-level PRs during execution

---

## Migration and Backward Compatibility

**No migration required.** No live `marketplace.json` files exist in production yet — #28 (the manual GitHub org bootstrap from spec 04) has not been completed. This is "fix before first deploy."

**Backward compatibility requirements:**

1. **`.dork/manifest.json` format** (spec 01) is UNCHANGED. This spec only touches `marketplace.json` and its sidecar.
2. **`@dorkos/marketplace` public exports** keep backward-compatible aliases where reasonable. Old imports of `MarketplaceJsonSchema` continue to work but reference the new schema.
3. **Existing DorkOS marketplace-02 install pipeline** continues to work through the refactor. The `fetchFromGit` method is deprecated but maintained as a thin wrapper around the new `fetchPackage` dispatch for one release.
4. **Existing `dorkos package validate-marketplace` CLI command** remains at the same path but gains the CC compatibility second-pass. Exit code 0 still means "valid DorkOS marketplace"; new exit code 2 means "valid DorkOS but fails CC compatibility."
5. **Existing telemetry events** (spec 04) remain compatible. Adding a column is a non-breaking Drizzle migration.
6. **Existing `fetchMarketplaceJson()` in apps/site** keeps the same signature but fetches from the new path. Callers don't need updates beyond changing the new fetch path in one place.

**What IS a breaking change (intentionally):**

- The seed fixture file path changes from `packages/marketplace/fixtures/dorkos-community-marketplace.json` to `packages/marketplace/fixtures/dorkos-seed/.claude-plugin/marketplace.json`. Legacy file is retained for one release in `fixtures/legacy/` as a reference.
- The `source` field type changes from `string` to a discriminated union. Any code that constructs `MarketplaceJsonEntry` directly and passes a bare string will stop type-checking. The only such caller is the test fixtures, which are updated.
- The `author` field type changes from `string` to an object. Same exposure surface.
- The public marketplace name changes from `dorkos-community` to `dorkos`. This is a rename, not a data migration (nothing is deployed).

---

## References

- Claude Code plugin marketplace docs: <https://code.claude.com/docs/en/plugin-marketplaces>
- Claude Agent SDK plugins API: <https://platform.claude.com/docs/en/agent-sdk/plugins>
- Unofficial CC JSON Schema (reference for Zod port): <https://github.com/hesreallyhim/claude-code-json-schema>
- Canonical CC marketplace (Direction B test fixture): <https://github.com/anthropics/claude-plugins-official>
- GitHub blog on sparse-checkout: <https://github.blog/open-source/git/bring-your-monorepo-down-to-size-with-sparse-checkout/>
- Git sparse-checkout docs: <https://git-scm.com/docs/git-sparse-checkout>
- IETF RFC 6648 ("Deprecating the X- Prefix"): <https://www.rfc-editor.org/rfc/rfc6648>
- Bitbucket Cloud partial clone support (closed Aug 2024): <https://jira.atlassian.com/browse/BCLOUD-19847>
- MCP (Model Context Protocol) official registry: <https://registry.modelcontextprotocol.io>
- Agent Skills (SKILL.md) specification: <https://agentskills.io/specification>
- Prior research:
  - `research/20260323_claude_code_plugin_marketplace_schema.md`
  - `research/20260329_claude_code_plugin_marketplace_extensibility.md`
  - `research/20260329_ai_coding_agent_plugin_marketplaces.md`
  - `research/20260329_skills_sh_marketplace_format_specification.md`
- Related specs:
  - `specs/marketplace-01-foundation/02-specification.md`
  - `specs/marketplace-02-install/02-specification.md`
  - `specs/marketplace-03-browse/02-specification.md`
  - `specs/marketplace-04-web-and-registry/02-specification.md`
- Related ADRs (existing):
  - `decisions/0228-marketplace-manifest-filename.md`
  - `decisions/0230-marketplace-package-type-agent-naming.md`
  - `decisions/0231-atomic-transaction-engine-for-marketplace-installs.md`
  - `decisions/0232-content-addressable-marketplace-cache-with-ttl.md`
  - `decisions/0233-marketplace-update-is-advisory-by-default.md`
  - `decisions/0234-neon-drizzle-single-source-of-truth-for-marketplace-telemetry.md`
  - `decisions/0235-site-local-drizzle-schema-for-marketplace-telemetry.md`
- New ADRs (to be drafted in this spec):
  - ADR-0236: Sidecar `dorkos.json` for DorkOS marketplace extensions
  - ADR-0237: Same-repo monorepo for the dork-labs/marketplace seed
  - ADR-0238: Port-to-Zod CC validator with weekly sync cron
  - ADR-0239: Plugin runtime activation via Claude Agent SDK `options.plugins`

---

## Changelog

### 2026-04-07 — Specification created

Initial version. All 17 decisions from the ideation locked. Key architectural decisions:

- **Strict superset framing** is the load-bearing constraint: outbound invariant + inbound invariant, empirically testable via `claude plugin validate`
- **Sidecar `dorkos.json`** is the only extension strategy that survives CC's `additionalProperties: false`
- **Same-repo monorepo** for the Dork Labs seed (`dork-labs/marketplace` holds both registry AND packages)
- **Claude Agent SDK `options.plugins`** is the architectural unlock for plugin runtime activation — zero CC runtime reimplementation
- **npm source type deferred** to `marketplace-06-npm-sources`
- **`pricing` field included** in the sidecar schema for future-proofing commerce optionality
- **Port-to-Zod CC validator** with weekly sync cron as the CC compatibility oracle
- **Public marketplace renamed** from `dorkos-community` to `dorkos`

### Open questions

None. All 17 decisions from `01-ideation.md` Section 6 are locked. The empirical sidecar verification (Phase 1.1) is a task, not a decision — the default is sidecar, and the verification only exists to catch a future CC loosening that would open up a less-invasive inline alternative.

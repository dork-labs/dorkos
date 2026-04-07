---
slug: marketplace-05-claude-code-format-superset
number: 229
created: 2026-04-07
status: ideation
---

# Marketplace 05: Claude Code Marketplace Format Superset

**Slug:** marketplace-05-claude-code-format-superset
**Author:** Claude Code
**Date:** 2026-04-07
**Branch:** preflight/marketplace-05-claude-code-format-superset

---

## 1) Intent & Assumptions

### Task brief

Make DorkOS's marketplace format a **strict superset** of Claude Code's marketplace format. The current `packages/marketplace/src/marketplace-json-schema.ts` is _labeled_ "Claude Code-compatible" but verification against the live CC docs (fetched 2026-04-07 from `code.claude.com/docs/en/plugin-marketplaces`) found six critical structural incompatibilities. Neither direction works today: Claude Code cannot consume our `marketplace.json`, and DorkOS cannot consume a Claude Code marketplace. This spec fixes that before #28 (the manual GitHub org bootstrap) deploys.

The "strict superset" framing is the load-bearing constraint and is stronger than "compatible." It manifests as two testable invariants:

1. **Outbound:** Any `marketplace.json` produced by DorkOS, using only the standard CC fields, must pass `claude plugin validate`. DorkOS-specific extensions live in a sidecar file (`dorkos.json`) that CC ignores entirely.
2. **Inbound:** Any `marketplace.json` that passes `claude plugin validate` must install successfully via DorkOS's pipeline. No manual conversion. No "import" step. Native consumption.

The CC validator is the reference oracle — DorkOS does not get to subjectively decide what compatible means. CI must run validation as a gate.

A practical consequence: this is a **maintenance commitment**, not a one-time fix. CC's validator has changed at least 4 times in 6 months (Issues #15198, #20423, #26555, #33739). DorkOS must track CC schema changes via a recurring sync process.

### Assumptions

- Spec 04's marketplace web and registry implementation is complete except for #28. The schema layer needs revision; the UI/site rendering layer needs only minor updates (fetch URL + author shape).
- DorkOS uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) as its primary agent runtime via `apps/server/src/services/runtimes/claude-code/`. The SDK's `options.plugins: [{ type: "local", path }]` API is the runtime activation mechanism we'll use — verified at `platform.claude.com/docs/en/agent-sdk/plugins` (2026-04-07).
- The Dork Labs seed monorepo will live at `github.com/dork-labs/marketplace` (single repo, Option A from this session's research) with public marketplace name `dorkos` (so install strings become `/plugin install code-reviewer@dorkos`).
- No live `marketplace.json` files exist in production yet. #28 has not bootstrapped. There is no migration burden — this is "fix before first deploy."
- Telemetry storage (Neon + Drizzle, spec 04) is unchanged. May add a `source_type` column to `marketplace_install_events`, but the storage backend stays.
- The 8 seed packages are still scaffolded as in spec 04; their content and behavior do not change, only their `source` field shape and where they live (now: `dork-labs/marketplace/plugins/<name>/`).

### Out of scope

The following are **explicitly deferred** to follow-up specs and should NOT be expanded into marketplace-05's scope during execution:

- **npm source type** — `source: { source: "npm", package, version?, registry? }` is part of CC's schema but its install path requires `npm install --ignore-scripts` security review, transactional rollback redesign, and private-registry auth handling. Deferred to `marketplace-06-npm-sources`. Marketplace-05 documents the gap and stubs the parser to surface a clear "npm sources not yet supported" error rather than silently failing.
- **CC plugin runtime reimplementation** — DorkOS will NOT parse or execute CC's `commands`, `agents`, `hooks`, `mcpServers`, or `lspServers` fields itself. The Claude Agent SDK already handles all of these when we pass plugin paths via `options.plugins`. We get the runtime for free.
- **Marketplace ToS and commerce paperwork** — A future-paid-packages legal/commercial track. The schema slot for `pricing` IS in scope (see decision 6); the actual ToS, payment intermediary, author payout flow, and commerce permissions are not.
- **Cross-repo package submission tooling** — A `dork marketplace submit` CLI for community contributors is a future ergonomics feature. v1 supports manual PRs to `dork-labs/marketplace`.
- **Multi-runtime plugin abstraction** — A pluggable `AgentRuntime.activatePlugin(path)` interface for future non-CC runtimes (Codex, OpenAI, etc.) is interesting but premature. v1 wires plugins specifically to the Claude Agent SDK runtime in `services/runtimes/claude-code/`.
- **Lighthouse/E2E re-runs from spec 04** — those follow-ups remain follow-ups.

---

## 2) Source Brief

This ideation was triggered by an interactive session in the `marketplace-init` worktree on 2026-04-07. The brief was assembled in-conversation after:

1. Verifying spec 04's "Claude Code-compatible" claim against live CC docs (fetched fresh from `code.claude.com/docs/en/plugin-marketplaces` during the session).
2. Discovering 6 structural incompatibilities in `packages/marketplace/src/marketplace-json-schema.ts`.
3. Deciding the user's earlier "monorepo support" question is solved natively by CC's existing `git-subdir` source type.
4. Deciding compatibility must be a **strict superset**, not just "compatible" — testable in both directions via the CC validator.

The full brief (preserved verbatim) is the conversation context for the `/ideate` invocation and is referenced from the master conversation log at `/Users/doriancollier/.claude/projects/-Users-doriancollier-Keep-dork-os-core-worktrees-marketplace-init/76cc29d3-6443-424f-ba6d-5510676a0fcc.jsonl`.

Key facts to preserve from the brief that the spec must reflect:

- **The 6 incompatibilities are concrete code-level claims** — `marketplace-json-schema.ts:31-41` accepts `source: z.string().min(1)`, but CC accepts a discriminated union of 5 forms with `additionalProperties: false`.
- **The Claude Agent SDK has plugin runtime support** — `options.plugins: [{ type: "local", path }]` loads skills, commands, agents, hooks, AND MCP servers from a local directory automatically. DorkOS does NOT need to reimplement the runtime.
- **There is no well-maintained TypeScript library for CC plugin install** — `hesreallyhim/claude-code-json-schema` (4 stars) provides reverse-engineered schemas only. DorkOS implementing the install pipeline itself is the only path.
- **Two universal AI agent standards already exist underneath CC's plugin format**: MCP (97M monthly SDK downloads, governed by Linux Foundation AAIF) and Agent Skills / SKILL.md (30+ tools, governed by LF AAIF). Being a CC superset inherits compatibility with both transitively.
- **CC uses `additionalProperties: false` on plugin entries** — this kills any inline `x-dorkos` namespace strategy. The sidecar `dorkos.json` file pattern is the only safe extension mechanism.

---

## 3) Pre-reading Log

### From the codebase exploration agent

- `packages/marketplace/src/marketplace-json-schema.ts:31-41`: Current `ClaudeCodeStandardEntrySchema`. `author` is a string (CC uses object). `source` is `z.string().min(1)` (CC uses discriminated union of 5 forms). No `owner`, `metadata`, or `strict` field. No CC component fields (`commands`, `agents`, `hooks`, `mcpServers`, `lspServers`).
- `packages/marketplace/src/marketplace-json-schema.ts:100-116`: Top-level schema. Uses `.passthrough()`. Missing required `owner` and optional `metadata`.
- `packages/marketplace/src/marketplace-json-parser.ts`: Parser layer. Will need source-type discrimination dispatch.
- `packages/marketplace/src/manifest-schema.ts`: `.dork/manifest.json` schema (DorkOS-only, separate file location from CC's `.claude-plugin/plugin.json`). Parallel concept, not a conflict.
- `packages/marketplace/src/package-validator.ts:23-28`: Validates against the schema. Will inherit schema changes; no internal logic changes needed.
- `packages/marketplace/src/package-types.ts:38-61`: PackageType enum (`agent | plugin | skill-pack | adapter`) and `requiresClaudePlugin()` helper. Stays unchanged.
- `packages/marketplace/fixtures/dorkos-community-marketplace.json`: Seed fixture with 8 entries. All use bare `https://github.com/dorkos-community/<name>` source URLs — none of which are valid CC source forms. Full rewrite required.
- `apps/server/src/services/marketplace/package-fetcher.ts:97-128`: `fetchFromGit()` accepts `gitUrl: string`. Must become source-type dispatch.
- `apps/server/src/services/marketplace/package-fetcher.ts:139-150`: `fetchMarketplaceJson()` → `resolveMarketplaceJsonUrl(source.source)` builds the registry URL. Currently `<repo>/raw/main/marketplace.json`. Must become `<repo>/raw/main/.claude-plugin/marketplace.json`.
- `apps/server/src/services/marketplace/transaction.ts:36-81`: Atomic install transaction model with git rollback. Works for git sources; npm sources are deferred so no immediate redesign needed.
- `apps/server/src/services/marketplace/marketplace-cache.ts`: Content-addressable cache keyed by `packageName + commitSha`. Compatible with all 4 git source types after dispatch.
- `apps/server/src/services/marketplace/permission-preview.ts`: Operates on staged package, not source. Unchanged.
- `apps/server/src/services/marketplace-mcp/`: 8 MCP tools (tool-install, tool-get, tool-search, tool-recommend, tool-list-marketplaces, tool-list-installed, tool-create-package, tool-uninstall). Changes flow through automatically once `package-fetcher.ts` and the schema are updated. Tests need new fixtures for source forms.
- `apps/server/src/services/runtimes/claude-code/`: ESLint-bounded directory where `@anthropic-ai/claude-agent-sdk` imports are allowed. Plugin activation (passing `options.plugins`) MUST live here.
- `apps/server/src/services/builtin-extensions/ensure-marketplace.ts`: Auto-stages the Dork Hub extension. Touches `.dork/manifest.json`, not `marketplace.json`. Unaffected.
- `apps/site/src/layers/features/marketplace/lib/fetch.ts:13-14`: Hardcoded fetch URL `https://raw.githubusercontent.com/dorkos-community/marketplace/main/marketplace.json`. Must become `https://raw.githubusercontent.com/dork-labs/marketplace/main/.claude-plugin/marketplace.json`.
- `apps/site/src/layers/features/marketplace/lib/fetch.ts:49-74`: `fetchPackageReadme()` and `githubSourceToRawReadme()`. Currently assumes `source: "https://github.com/owner/repo"`. Must handle 4 (later 5) source forms and degrade gracefully when README is missing.
- `apps/site/src/layers/features/marketplace/ui/PackageHeader.tsx`: Displays `pkg.author`. Must render `author.name` (object) instead of `author` (string).
- `apps/site/src/layers/features/marketplace/ui/InstallInstructions.tsx`: Generates CLI command examples. Must adapt per source type.
- `apps/site/src/layers/features/marketplace/ui/PermissionPreviewServer.tsx`: Server component that calls preview endpoint. Inherits schema changes; no logic change.
- `apps/site/src/app/(marketing)/marketplace/[slug]/page.tsx`: Detail page. Inherits fetch + schema changes.
- `packages/cli/src/commands/package-validate-marketplace.ts:72`: Calls `parseMarketplaceJson()`. Must additionally run a CC-validator second pass and enforce CC's reserved-name list.
- `packages/cli/src/commands/package-validate-remote.ts`: Validates a remote marketplace by URL. Same updates as above.
- `apps/client/src/layers/features/marketplace/`: Client UI does NOT directly import `@dorkos/marketplace` types — consumes via API. No client changes expected (verified by exploration agent).

### From the research agent (CC marketplace patterns + standards landscape)

- `code.claude.com/docs/en/plugin-marketplaces` (fetched 2026-04-07): Authoritative current CC marketplace spec. File location, schema, source forms, reserved names.
- `platform.claude.com/docs/en/agent-sdk/plugins` (fetched 2026-04-07): Confirmed `options.plugins: [{ type: "local", path }]` API. Verified the SDK loads skills, commands, agents, hooks, AND MCP servers from a local plugin directory automatically.
- `github.com/hesreallyhim/claude-code-json-schema` (commit Feb 2026, 4 stars): Reverse-engineered JSON Schema for `marketplace.json` and `plugin.json`. Confirms `additionalProperties: false` on plugin entries. Will be DorkOS's reference for porting CC's schema to Zod.
- `github.com/jeremylongshore/claude-code-plugins-plus-skills` (CCPI CLI, ~1,900 stars): End-user CLI for CC plugins. Confirms the install pipeline pattern but is not usable as a library dependency.
- `github.com/anthropics/claude-plugins-official`: The canonical CC marketplace. 200+ entries including all 5 source types. Will be used as a real-world test fixture for the inbound compatibility direction.
- `research/20260323_claude_code_plugin_marketplace_schema.md`: Full prior schema reference. Includes the validator bug history (git-subdir crashes in v2.1.77, field bleed Issue #26555) — informs DorkOS's CC schema sync risk register.
- `research/20260329_claude_code_plugin_marketplace_extensibility.md`: Confirms `plugin.json` validator rejects unrecognized keys.
- `research/20260329_ai_coding_agent_plugin_marketplaces.md`: Confirms three universal AI agent standards: MCP, SKILL.md, AGENTS.md. Confirms CC superset inherits MCP + SKILL.md compatibility transitively.
- `research/20260331_marketplace_project_brief.md`: DorkOS's prior architectural decision — DorkOS marketplace IS a CC marketplace.
- IETF RFC 6648 ("Deprecating the X- Prefix"): Formally discourages `X-` prefix conventions. Combined with CC's `additionalProperties: false`, rules out the `x-dorkos` namespace strategy. Sidecar file is the only viable approach.
- GitHub blog on sparse-checkout cone mode: Confirms `git clone --filter=blob:none --no-checkout --depth=1` + `git sparse-checkout init --cone` + `git sparse-checkout set <path>` is the canonical sequence for monorepo subdirectory checkout.

---

## 4) Codebase Map

### Primary components/modules (must change)

| Layer                       | Files (with line refs where critical)                                                                         | Role                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Schema & parser**         | `packages/marketplace/src/marketplace-json-schema.ts` (whole file rewrite of `ClaudeCodeStandardEntrySchema`) | Zod schemas. The 6 incompatibilities live here.                                                                                                                                                 |
|                             | `packages/marketplace/src/marketplace-json-parser.ts`                                                         | Parser entry point. Needs source-type discrimination.                                                                                                                                           |
|                             | `packages/marketplace/src/dorkos-sidecar-schema.ts` (NEW)                                                     | Sidecar `dorkos.json` schema for DorkOS extensions.                                                                                                                                             |
|                             | `packages/marketplace/src/source-resolver.ts` (NEW)                                                           | Pure function: `resolvePluginSource(source) → ResolvedSourceDescriptor`. The single source of truth for source-form interpretation, used by both server install pipeline and site rendering.    |
|                             | `packages/marketplace/src/cc-validator.ts` (NEW)                                                              | Ported Zod implementation of CC's schema (using `hesreallyhim/claude-code-json-schema` as reference). Used by `dorkos package validate-marketplace` for the second-pass CC compatibility check. |
| **Server install pipeline** | `apps/server/src/services/marketplace/package-fetcher.ts:97-150`                                              | Fetch dispatch by source type.                                                                                                                                                                  |
|                             | `apps/server/src/services/marketplace/source-resolvers/relative-path.ts` (NEW)                                | Resolves `./<path>` against the marketplace root checkout.                                                                                                                                      |
|                             | `apps/server/src/services/marketplace/source-resolvers/github.ts` (NEW)                                       | Resolves `{source: "github", repo, ref?, sha?}`.                                                                                                                                                |
|                             | `apps/server/src/services/marketplace/source-resolvers/url.ts` (NEW)                                          | Resolves `{source: "url", url, ref?, sha?}`.                                                                                                                                                    |
|                             | `apps/server/src/services/marketplace/source-resolvers/git-subdir.ts` (NEW)                                   | Sparse-clone + cone-mode resolver for `{source: "git-subdir", url, path, ref?, sha?}`.                                                                                                          |
|                             | `apps/server/src/services/marketplace/source-resolvers/npm.ts` (NEW, STUB)                                    | Stub that throws "npm sources not yet supported in this DorkOS version — see marketplace-06" with a structured error code.                                                                      |
| **Plugin activation**       | `apps/server/src/services/runtimes/claude-code/plugin-activation.ts` (NEW, ESLint-bounded)                    | Builds `options.plugins` array for `query()` invocations from the user's enabled installed plugins.                                                                                             |
|                             | `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`                                        | Wires `plugin-activation.ts` output into every session start.                                                                                                                                   |
| **Site fetch & UI**         | `apps/site/src/layers/features/marketplace/lib/fetch.ts:13-74`                                                | Update fetch URL and `fetchPackageReadme` to use source-resolver.                                                                                                                               |
|                             | `apps/site/src/layers/features/marketplace/lib/dorkos-sidecar-fetch.ts` (NEW)                                 | Fetch + merge `dorkos.json` sidecar.                                                                                                                                                            |
|                             | `apps/site/src/layers/features/marketplace/ui/PackageHeader.tsx`                                              | Render `author.name`.                                                                                                                                                                           |
|                             | `apps/site/src/layers/features/marketplace/ui/InstallInstructions.tsx`                                        | Per-source-type install command examples.                                                                                                                                                       |
| **CLI**                     | `packages/cli/src/commands/package-validate-marketplace.ts`                                                   | Add CC validator second-pass + reserved-name check.                                                                                                                                             |
|                             | `packages/cli/src/commands/package-validate-remote.ts`                                                        | Same.                                                                                                                                                                                           |

### Shared dependencies (read-only consumers, may need minor updates)

- `apps/site/src/layers/features/marketplace/ui/PackageCard.tsx`, `MarketplaceGrid.tsx`, `FeaturedAgentsRail.tsx`, `MarketplaceHeader.tsx`, `RelatedPackages.tsx` — pass entries through; no logic changes.
- `apps/site/src/layers/features/marketplace/lib/ranking.ts`, `format-permissions.ts` — read fields from entries; check whether they read `description` (now optional at top level — should not be relied on; use `metadata.description`).
- `apps/server/src/services/marketplace-mcp/tool-install.ts`, `tool-get.ts`, `tool-search.ts`, `tool-recommend.ts`, `tool-create-package.ts` — inherit changes from `package-fetcher.ts` and the schema.
- `apps/server/src/services/marketplace/marketplace-installer.ts` — orchestrator. Inherits dispatch from fetcher.
- `apps/server/src/services/marketplace/permission-preview.ts` — operates on staged package, no source-field interaction. Unchanged.
- `apps/server/src/services/marketplace/marketplace-cache.ts` — content-addressable cache. Compatible with git source types after dispatch (npm key strategy deferred with npm itself).

### Data flow

```
┌─────────────────────────────────────────┐
│  registry repo (dork-labs/marketplace)  │
│  ├── .claude-plugin/marketplace.json    │  ← CC-compatible only
│  ├── .claude-plugin/dorkos.json         │  ← DorkOS sidecar (extensions)
│  └── plugins/                           │
│      ├── code-reviewer/                 │  ← package source lives here
│      ├── security-auditor/
│      └── ...
└─────────────────────────────────────────┘
              │
              │ HTTPS GET (apps/site ISR or apps/server fetch)
              ▼
┌─────────────────────────────────────────┐
│  fetchMarketplaceJson()                 │
│  fetchDorkosSidecar()                   │
│  → MarketplaceJson, DorkosSidecar       │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  mergeMarketplace(cc, sidecar)          │
│  → MergedMarketplaceEntry[] keyed by    │
│    plugin.name                          │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  resolvePluginSource(entry.source)      │
│  → { type: 'github' | 'git-subdir' |    │
│      'url' | 'relative-path', ... }     │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  source-resolvers/<type>.ts             │
│  → fetched-package on disk              │
│  (relative-path: cd; github/url: clone; │
│   git-subdir: sparse clone; npm: STUB)  │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  marketplace-installer.ts (existing)    │
│  → atomic install transaction           │
│  → ~/.dork/marketplace/packages/<name>/ │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  services/runtimes/claude-code/         │
│  plugin-activation.ts                   │
│  → options.plugins: [{type:'local',     │
│       path: '<install_dir>'}, ...]      │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  Claude Agent SDK query()               │
│  loads skills, commands, agents,        │
│  hooks, mcpServers from each path       │
└─────────────────────────────────────────┘
```

### Feature flags / config

- No feature flags needed. The schema migration is "fix before first deploy" — there are no live `marketplace.json` files in production (#28 has not bootstrapped).
- The Claude Agent SDK plugin activation is conditional on `services/runtimes/claude-code/` being the active runtime. If a future runtime is added, plugin activation will fail closed (no error, just no auto-load) until that runtime implements its own activation.

### Potential blast radius

| Category                              | Count             | Scope                                                                                                                                                                       |
| ------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Direct files (must change)**        | 29                | Schema, parser, fetcher, source resolvers, plugin activation, site fetch, UI, CLI                                                                                           |
| **Indirect files (likely cascading)** | 12                | UI components, MCP tools, install flows, telemetry, builtin extensions                                                                                                      |
| **Test files needing updates**        | 27                | Schema tests, parser tests, fetcher tests, install flow tests, MCP tool tests, site tests, CLI tests                                                                        |
| **Documentation files**               | 6                 | `marketplace-packages.md`, `marketplace-registry.md`, `marketplace-installs.md`, `marketplace-telemetry.md`, `external-agent-marketplace-access.md`, `docs/marketplace.mdx` |
| **NEW files**                         | ~10               | Sidecar schema, source resolver module (in @dorkos/marketplace), 4 source-resolver implementations, CC validator port, plugin activation, sidecar fetcher, ADRs             |
| **Total surface**                     | ~74 files touched |                                                                                                                                                                             |

---

## 5) Research

### Topic 1 — Vendor extension strategy: sidecar `dorkos.json` is the only safe option

**Research finding (decisive):** CC's `marketplace.json` schema uses **`additionalProperties: false`** on plugin entries. Issue #26555 documents exactly this: when CC's own internal code wrote a `category` field into a cached `plugin.json`, the validator rejected the result with `Unrecognized keys: "category"`. **Any approach that adds DorkOS extension fields directly to plugin entries will fail CC's validator.**

This rules out the three "inline" strategies:

| Strategy                                                             | Why it fails                              |
| -------------------------------------------------------------------- | ----------------------------------------- |
| `x-dorkos-type`, `x-dorkos-layers`, etc. (RFC 6648 deprecated style) | Rejected by `additionalProperties: false` |
| Single `x-dorkos: {...}` namespace per entry                         | Rejected by `additionalProperties: false` |
| Top-level passthrough                                                | Rejected by `additionalProperties: false` |

**Decision: sidecar `dorkos.json` file** at the same path level as `marketplace.json`.

```
.claude-plugin/
├── marketplace.json   ← CC-compatible, zero DorkOS fields
└── dorkos.json        ← DorkOS extensions, indexed by plugin name
```

`dorkos.json` shape:

```json
{
  "$schema": "https://dorkos.ai/schemas/dorkos-marketplace.schema.json",
  "schemaVersion": 1,
  "plugins": {
    "code-reviewer": {
      "type": "agent",
      "layers": ["agents", "tasks"],
      "requires": ["adapter:slack@^1.0.0"],
      "featured": true,
      "icon": "🔍",
      "dorkosMinVersion": "0.5.0",
      "pricing": { "model": "free" }
    },
    "security-auditor": { "type": "agent", "...": "..." }
  }
}
```

DorkOS reads both files in parallel and merges by plugin name. CC reads only `marketplace.json` and is unaffected. The two files can drift (a plugin in `marketplace.json` not in `dorkos.json` is allowed and treated as having default extensions; a plugin in `dorkos.json` not in `marketplace.json` is a warning but not an error).

**Empirical validation step (load-bearing):** Before implementing the schema, install Claude Code locally and run `claude plugin validate` against a fixture containing only the new `marketplace.json` (no inline DorkOS fields). Confirm pass. Then add inline `x-dorkos` to a copy of the fixture and confirm rejection. This empirical check protects against future CC validator changes that might tolerate `x-` fields — if such tolerance ever appears, the spec can revisit the inline approach in a follow-up. For v1, the sidecar is the only safe path.

### Topic 2 — `git-subdir` install: sparse clone with cone mode

**Recommended command sequence** (per research, verified against GitHub blog and git docs):

```bash
# Step 1: Partial + sparse clone (no checkout yet)
git clone \
  --filter=blob:none \
  --no-checkout \
  --depth=1 \
  "$GIT_URL" \
  "$TARGET_DIR"

# Step 2: Initialize cone-mode sparse-checkout
cd "$TARGET_DIR"
git sparse-checkout init --cone

# Step 3: Restrict to the target subdirectory
git sparse-checkout set "$PLUGIN_PATH"

# Step 4: Materialize the checkout
git checkout "$REF"   # or "$SHA" if specified
```

**Why this combination:**

- `--filter=blob:none` (blobless) downloads commits + trees on demand, blobs only for checked-out files. ~1-5 MB for a typical plugin subdirectory in a 500 MB monorepo.
- `--depth=1` further reduces to the latest commit. DorkOS does not need history for a plugin install.
- `--no-checkout` prevents materializing the full tree before sparse-checkout takes effect.
- `init --cone` enables cone mode (O(n log n) hashset matching, vs quadratic pattern matching). Required for large monorepos.
- `set "$PLUGIN_PATH"` restricts to the target subdirectory.
- `checkout "$REF"` finalizes.

**Compatibility:**

- GitHub: supported since 2020.
- GitLab: supported since ~2021.
- Bitbucket Cloud: **fully rolled out August 2024** (closed BCLOUD-19847).
- Bitbucket Server (self-hosted): version 8.0+.
- Gitea/Forgejo: recent versions support `--filter`.

**Fallback ladder** (when partial clone is unsupported):

1. Try the recommended sequence above.
2. On `--filter` failure, fall back to `git clone --depth=1` (full shallow clone) and `rm -rf` non-target directories. Log a warning.
3. On `--no-checkout` + `sparse-checkout` failure (git < 2.25), full shallow clone + manual cleanup. Log a warning.
4. On any other failure: hard error with actionable message.

Minimum git version for cone sparse-checkout is **2.25 (January 2020)**. CI environments and DorkOS Docker base images are 2.43+.

### Topic 3 — Validator integration: port to Zod, use unofficial schema as reference

**Finding:** Claude Code itself is closed-source (the binary is proprietary). The canonical schema URL referenced in CC's docs (`https://anthropic.com/claude-code/marketplace.schema.json`) does not serve a public schema. Anthropic publishes no version-stability commitment.

**The community reference is `hesreallyhim/claude-code-json-schema`:**

- 4 stars (one-developer artifact, not a community standard)
- Last commit Feb 2026
- Reverse-engineered from CLI behavior, error messages, and the official `claude-plugins-official` marketplace
- Self-described as "intentionally lagging the actual CLI validator in some places"
- Has synthetic test fixtures that can be ported directly into Vitest
- Confirms `additionalProperties: false` on plugin entries

**Rejected approaches:**

- **Shell out to `claude plugin validate` in CI**: requires Anthropic auth, ~200 MB binary, no version lock. CI reliability would be ~70%. Rejected.
- **Vendor CC's validator code**: impossible — CC is proprietary and obfuscated. Rejected.
- **Implement a port from scratch**: too much surface area to maintain without a reference. Rejected.

**Recommended approach: port to Zod with unofficial schema as reference, weekly diff sync.**

1. Port `marketplace.schema.json` from `hesreallyhim/claude-code-json-schema` to a Zod schema in `packages/marketplace/src/cc-validator.ts`.
2. Translate the `fixtures/synthetic/` test cases from the reference repo into Vitest cases under `packages/marketplace/src/__tests__/cc-validator.test.ts`.
3. Add `scripts/sync-cc-schema.ts` that fetches the latest reference schema and diffs against DorkOS's port. Surface the diff as a pull request.
4. Run the sync script as a weekly cron CI job (not on every PR).
5. **Sync direction invariant:** DorkOS's schema MUST NOT be stricter than CC's actual CLI behavior for any field CC currently accepts. Looser-than-CC is acceptable; stricter-than-CC is a regression.

This is the same model `mpalmer/action-validator` uses for GitHub Actions schema compatibility.

### Topic 4 — Bidirectional compatibility test matrix

**Direction A: DorkOS → CC ("DorkOS marketplace passes CC validator")**

| ID  | Test                                                                 | Mechanism                                    | Fixture                                                                                                  |
| --- | -------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A1  | Minimal marketplace.json passes                                      | Zod parse against `cc-validator.ts`          | `cc-compat/minimal.json`                                                                                 |
| A2  | Full standard CC fields pass                                         | Zod parse                                    | `cc-compat/full-cc-fields.json`                                                                          |
| A3  | DorkOS sidecar fields not in marketplace.json                        | AST/key enumeration test                     | `cc-compat/sidecar-isolation.json` + `dorkos.json`                                                       |
| A4  | All 4 supported source types pass (npm deferred)                     | Per-type fixture                             | `cc-compat/source-relative-path.json`, `source-github.json`, `source-url.json`, `source-git-subdir.json` |
| A5  | Round-trip: parse DorkOS format → serialize → validate CC            | Integration test                             | Round-trip on the seed                                                                                   |
| A6  | Empirical: install Claude Code locally, run `claude plugin validate` | Manual one-time validation step before merge | All fixtures above                                                                                       |

**Direction B: CC → DorkOS ("CC marketplace installs via DorkOS")**

| ID  | Test                                                         | Mechanism                                                    | Fixture                                         |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| B1  | `claude-plugins-official` marketplace.json parses in DorkOS  | Vendored snapshot (committed JSON, not fetched at test time) | `cc-real/claude-plugins-official-snapshot.json` |
| B2  | CC fixture with `git-subdir` source installs                 | Mock git subprocess; verify sparse-checkout commands         | `cc-real/git-subdir-source.json`                |
| B3  | CC fixture with relative path source installs                | Mock filesystem; verify subdirectory traversal               | `cc-real/relative-path-source.json`             |
| B4  | CC fixture with `github` source installs                     | Mock git clone; verify ref/sha pinning                       | `cc-real/github-source.json`                    |
| B5  | CC fixture with `url` source installs                        | Mock git clone of arbitrary URL                              | `cc-real/url-source.json`                       |
| B6  | CC fixture with `npm` source produces clear "deferred" error | Verify error message and exit code                           | `cc-real/npm-source.json`                       |
| B7  | Unknown CC fields DorkOS ignores gracefully                  | Add hypothetical future CC field; verify no error            | `cc-compat/future-field.json`                   |
| B8  | Reserved marketplace name rejection                          | Unit test of name validator                                  | n/a                                             |

**Total: 14 fixture-based tests across 5 source types.** npm coverage is 1 test (the deferred-error case) instead of full install coverage.

**Vendored snapshot discipline:** `cc-real/claude-plugins-official-snapshot.json` is a committed JSON file, not fetched at test time. Update quarterly or when CC schema sync detects a change. Prevents flaky tests from network dependency.

### Topic 5 — Same-repo monorepo for the seed

**Decision: Architecture A (same-repo).** The registry IS the package monorepo:

```
github.com/dork-labs/marketplace/        ← single git repo
├── .claude-plugin/
│   ├── marketplace.json                 ← CC catalog, source: "code-reviewer"
│   └── dorkos.json                      ← DorkOS extensions sidecar
├── plugins/                             ← 8 seed packages live here
│   ├── code-reviewer/
│   │   ├── .claude-plugin/plugin.json
│   │   ├── README.md
│   │   └── skills/...
│   ├── security-auditor/
│   ├── docs-keeper/
│   ├── linear-integration/
│   ├── posthog-monitor/
│   ├── security-audit-pack/
│   ├── release-pack/
│   └── discord-adapter/
├── CONTRIBUTING.md
├── README.md
└── .github/workflows/validate-submission.yml
```

`marketplace.json` uses `metadata.pluginRoot: "./plugins"` so each entry can use the short form:

```json
{
  "name": "dorkos",
  "owner": { "name": "Dork Labs", "email": "hello@dorkos.ai" },
  "metadata": {
    "description": "Official marketplace for DorkOS — agents, plugins, skill packs, and adapters",
    "version": "0.1.0",
    "pluginRoot": "./plugins"
  },
  "plugins": [
    { "name": "code-reviewer", "source": "code-reviewer", "category": "code-quality" },
    { "name": "security-auditor", "source": "security-auditor", "category": "security" },
    ...
  ]
}
```

**Why same-repo (research-backed):**

- Atomic changes — registry catalog entry and plugin code change in a single PR. Cross-repo requires coordinated PRs in 2 repos.
- `git-subdir` is purpose-built for this — DorkOS users install `plugins/code-reviewer` from the marketplace repo without getting the rest. Registry and packages live together but install separately.
- Zero tooling overhead — no private npm registry, no publishing workflow. The packages ARE the code.
- Lowest contributor friction — new package contributors submit a single PR to `dork-labs/marketplace`. No "create new repo + PR to registry + sync manifest" 3-step that the Obsidian model requires.
- This is the canonical CC walkthrough pattern (the docs explicitly demonstrate this layout).
- `metadata.pluginRoot: "./plugins"` exists for exactly this use case.

**Third-party packages:** still supported via cross-repo `github` or `git-subdir` source. The seed monorepo is the _default_ Dork Labs pattern, not an exclusive one. Community authors who want their own repo simply submit a PR adding an entry with `source: { source: "github", repo: "their-org/their-plugin" }` to `marketplace.json`. Best of both worlds.

**Promotion path:** A Dork Labs package graduates to its own repo when it has its own release cadence, contributors, and CI. The monorepo serves as incubator; cross-repo is the graduation step. v1 doesn't need to design the graduation tooling — it's a future maintenance task.

### Topic 6 — Risks (the spec MUST address all three)

**Risk 1: CC schema drift.** Anthropic has changed the validator at least 4 times in 6 months (Issues #15198, #20423, #26555, #33739). Mitigation: weekly CI sync against `hesreallyhim/claude-code-json-schema`, blocking PR when fields are added or removed. Schema sync is a maintenance commitment, not optional.

**Risk 2: `additionalProperties: false` regression.** If CC ever loosens its plugin entry validation, DorkOS's Zod schema must track that change (not become accidentally stricter). Mitigation: the sync direction invariant — DorkOS schema MUST NOT be stricter than CC's actual CLI behavior. Loose-direction-only updates.

**Risk 3: Git host compatibility for `git-subdir`.** Bitbucket Cloud added `--filter` support in August 2024. Self-hosted Bitbucket Server may not. Mitigation: fallback ladder (partial clone → shallow clone → full clone with cleanup). Compatibility matrix testing in CI for at least GitHub, GitLab, Gitea.

### Topic 7 — Deferrable items (NOT in v1 scope)

1. **Validator parity with the actual CC binary.** Running `claude plugin validate` as a CI step is not feasible (auth, 200 MB binary, no version lock). Defer to a future ADR if we ever decide to invest in it. The Zod port is sufficient for v1.
2. **Private npm registry support.** `.npmrc` auth flow for private registries is a valid future feature. The `DORK_NPM_TOKEN` / `DORK_NPM_REGISTRY` env var extension points are documented in the deferred npm spec but not implemented in v1.
3. **Community submission tooling.** A `dork marketplace submit` CLI for community contributors. Manual PRs to `marketplace.json` are sufficient for the seed period.

### Standards landscape (informational, drives the strategic positioning)

The DorkOS marketplace's value proposition gets a free strategic boost from compatibility:

- **MCP (Model Context Protocol)** — universal tool integration layer, 97M monthly SDK downloads, governed by Linux Foundation Agentic AI Foundation. CC's plugin format includes `mcpServers`, so DorkOS being CC-compatible inherits MCP compatibility transitively. **Settled and dominant.**
- **Agent Skills / SKILL.md** — universal skill packaging, 30+ tools (CC, Codex, Cursor, Copilot, Windsurf, Gemini CLI, JetBrains Junie, Spring AI, Databricks, Snowflake, etc.), governed by LF AAIF. CC plugins use `skills/`, so DorkOS being CC-compatible inherits SKILL.md compatibility transitively. **Settled.**
- **AGENTS.md** — universal context file standard, 20K+ GitHub repos, 25+ tools. Not relevant to plugin distribution but worth knowing.
- **Plugin bundle wrapper layer** — fragmented. CC, Codex, Cursor, and Copilot each have their own `marketplace.json` + `plugin.json` shape. None has been standardized. CC has the largest plugin ecosystem by volume (200+ official + 400+ community).

The pitch this enables: **"Install any Claude Code plugin in DorkOS. Any DorkOS package that includes skills works in CC, Cursor, Copilot, Codex, and 25+ other tools too."** The bundle wrapper is CC-specific, but the inner artifacts are portable across the entire AI agent ecosystem.

### Claude Agent SDK plugin support (the architectural unlock)

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) has `options.plugins: [{ type: "local", path }]` that loads a plugin directory's skills, commands, agents, hooks, and MCP servers automatically. Confirmed at `platform.claude.com/docs/en/agent-sdk/plugins` (fetched 2026-04-07).

**What it does:**

- Loads `.claude-plugin/plugin.json` from the path
- Auto-namespaces skills as `plugin-name:skill-name`
- Wires hooks, MCP servers, agents, and commands into the session
- All of this happens automatically when `options.plugins` is provided

**What it does NOT do:**

- No marketplace.json parsing (only loads from local paths)
- No remote install (no github/npm/git-subdir source resolution)
- No `installPlugin()` API
- No version pinning, no update lifecycle, no caching

**This is the architectural unlock for marketplace-05.** DorkOS owns the install pipeline (no library exists, no shortcut). The Claude Agent SDK owns the runtime activation. They compose cleanly: DorkOS downloads + materializes plugins to disk, then passes the resulting paths to the SDK at session start. **Zero CC runtime reimplementation required.**

The implementation lives in `apps/server/src/services/runtimes/claude-code/plugin-activation.ts` (NEW), inside the existing ESLint boundary that allows `@anthropic-ai/claude-agent-sdk` imports. Every session start in `claude-code-runtime.ts` builds the `options.plugins` array from the user's enabled installed plugins and passes it to `query()`.

---

## 6) Decisions

This section captures decisions resolved during the ideation. Items marked **(empirical)** require a one-time verification step during execution; everything else is locked.

| #   | Decision                                                                            | Choice                                                                                                                                                                                                                                                                                                                                                                                                                                    | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Public marketplace name and registry repo**                                       | `dork-labs/marketplace` + public name `dorkos`. Install string: `/plugin install <pkg>@dorkos`                                                                                                                                                                                                                                                                                                                                            | User decision in interactive clarification. Cleanest, shortest, leaves room for future sub-marketplaces (`dorkos-experimental`, `dorkos-paid`). Aligns with how Vercel/Astro/Drizzle name their orgs vs marketplaces. The name `dorkos-community` was retired because it implies community-only and doesn't match a future mixed registry.                                                                                                                                      |
| 2   | **Plugin runtime activation in DorkOS sessions**                                    | Auto-load enabled plugins via Claude Agent SDK `options.plugins: [{ type: "local", path }]` at session start. Implementation in `services/runtimes/claude-code/plugin-activation.ts`.                                                                                                                                                                                                                                                     | User decision in interactive clarification. Confirmed from the SDK docs that this API exists and handles all 5 CC component types. Zero CC runtime reimplementation. The user installs once via the marketplace UI; the plugin appears in every session afterward. Works only when the runtime IS the Claude Agent SDK — future non-CC runtimes would need their own activation.                                                                                                |
| 3   | **npm source type scope**                                                           | Defer to follow-up spec (`marketplace-06-npm-sources`). v1 implements a stub source resolver that throws a structured "npm sources not yet supported" error with a link to the deferred spec.                                                                                                                                                                                                                                             | User decision in interactive clarification. npm sources need a separate security review for `--ignore-scripts`, transactional rollback redesign, and private-registry auth. Deferring keeps v1 scope manageable. v1 is a "near-superset" — a CC marketplace using only git-based sources installs natively; one using npm sources fails with a clear error. The strict-superset claim becomes complete in v2.                                                                   |
| 4   | **Pricing field bundling**                                                          | Bundle into v1. Schema lives in `dorkos.json` sidecar (NOT in `marketplace.json` since CC has `additionalProperties: false`). Shape: `pricing: { model: 'free' \| 'paid' \| 'freemium' \| 'byo-license', priceUsd?: number, billingPeriod?: 'one-time' \| 'monthly' \| 'yearly', trialDays?: number }`. All seed packages get `pricing: { model: "free" }`.                                                                               | User decision in interactive clarification. Marginal cost (~30 min schema work + tests) and locks in commerce optionality forever. Avoids a future migration when DorkOS or package authors want to charge.                                                                                                                                                                                                                                                                     |
| 5   | **DorkOS extension strategy**                                                       | **Sidecar `dorkos.json`** at `.claude-plugin/dorkos.json`, alongside `marketplace.json`. Indexed by plugin name. DorkOS reads both files and merges; CC reads only `marketplace.json`.                                                                                                                                                                                                                                                    | Research finding: CC uses `additionalProperties: false` on plugin entries, ruling out inline approaches (`x-dorkos-*`, top-level passthrough, single `x-dorkos: {}` namespace). The sidecar is the only approach that survives `claude plugin validate` today and in future CC versions. **(empirical)** — verify before implementing schema by installing CC locally and validating both an inline-extensions fixture (expected: fail) and a sidecar fixture (expected: pass). |
| 6   | **Same-repo vs cross-repo monorepo for seed**                                       | Same-repo. `dork-labs/marketplace` holds `.claude-plugin/marketplace.json`, `.claude-plugin/dorkos.json`, AND `plugins/code-reviewer/`, `plugins/security-auditor/`, etc. as subdirectories. `metadata.pluginRoot: "./plugins"` makes entries terse.                                                                                                                                                                                      | Research finding: this is the canonical CC walkthrough pattern, what `claude-plugins-official` uses, supports atomic catalog+code PRs, uses `git-subdir` for cross-repo packages too, drops #28 from "9 repos" to "1 repo". Community authors with their own repo continue to use the cross-repo pattern via `github`/`git-subdir` source.                                                                                                                                      |
| 7   | **CC schema validator strategy**                                                    | Port to Zod, using `hesreallyhim/claude-code-json-schema` as reference. Implement in `packages/marketplace/src/cc-validator.ts`. Add `scripts/sync-cc-schema.ts` weekly CI cron that diffs against the unofficial schema and surfaces a PR when CC adds or changes fields.                                                                                                                                                                | Research finding: Anthropic does not publish a public schema URL or version stability guarantee. CC binary is closed source. Shelling out to `claude plugin validate` in CI is infeasible (200 MB binary, auth required, ~70% reliability). Vendoring is impossible (proprietary). Port-to-Zod with reference sync is the only viable path. **Sync direction invariant**: DorkOS Zod schema MUST NOT be stricter than CC CLI behavior for fields CC accepts; looser is fine.    |
| 8   | **`git-subdir` install command sequence**                                           | `git clone --filter=blob:none --no-checkout --depth=1 <url> <dir>` → `cd <dir>` → `git sparse-checkout init --cone` → `git sparse-checkout set <path>` → `git checkout <ref>`. Fallback ladder on partial-clone failure: shallow clone → full clone with manual cleanup.                                                                                                                                                                  | Research finding: this is the canonical sparse-checkout sequence per GitHub docs. Bandwidth ~1-5 MB for typical plugin subdir vs hundreds of MB for full monorepo. Cone mode is required for performance on large monorepos (O(n log n) vs quadratic). Bitbucket Cloud added support August 2024; self-hosted servers need version checks.                                                                                                                                      |
| 9   | **CC component fields (`commands`, `agents`, `hooks`, `mcpServers`, `lspServers`)** | DorkOS does NOT parse or interpret these fields itself. They are stored as opaque metadata in the schema (passed through unchanged) and consumed by the Claude Agent SDK at session start via `options.plugins`.                                                                                                                                                                                                                          | Direct consequence of Decision 2. The SDK already does this work; reimplementing it would be wasteful and introduce divergence. v1 of marketplace-05 specifically does NOT touch CC's runtime semantics.                                                                                                                                                                                                                                                                        |
| 10  | **`${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` env vars**                    | Not handled in v1. CC plugins that reference these env vars in hooks/MCP configs will work correctly inside the Claude Agent SDK runtime (which sets them) but not inside any future non-SDK runtime.                                                                                                                                                                                                                                     | Same reasoning as Decision 9 — the SDK handles env var injection. Documenting the limitation: any plugin that depends on these vars only works when DorkOS uses the Claude Agent SDK runtime, which is the v1 default.                                                                                                                                                                                                                                                          |
| 11  | **Source-form telemetry**                                                           | Add a `source_type` column to `marketplace_install_events` (Drizzle schema in `apps/site/src/db/schema.ts`). Values: `relative-path` \| `github` \| `url` \| `git-subdir` \| `npm`. Drizzle migration in v1.                                                                                                                                                                                                                              | Cheap migration. Useful for future product decisions about which source types to invest in (e.g., is anyone actually using `url` sources, or only `github`?). Keeps the privacy contract from spec 04 intact (no PII added).                                                                                                                                                                                                                                                    |
| 12  | **`metadata.pluginRoot` resolution semantics**                                      | When set: `pluginRoot` is prepended to all relative-path string sources in the same `marketplace.json`. Trailing slashes normalized. Absolute paths in `pluginRoot` are an error. Object-form sources (`github`, `git-subdir`, etc.) ignore `pluginRoot` entirely. Spec the algorithm explicitly with edge case tests.                                                                                                                    | From CC docs. Documented explicitly to prevent ambiguity.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 13  | **Reserved name enforcement**                                                       | `dorkos package validate-marketplace` rejects marketplaces named: `claude-code-marketplace`, `claude-code-plugins`, `claude-plugins-official`, `anthropic-marketplace`, `anthropic-plugins`, `agent-skills`, `knowledge-work-plugins`, `life-sciences`. Also rejects names matching the impersonation patterns (anything starting with `official-claude-*` or `anthropic-*` or containing `claude-code` substring with non-author owner). | From CC docs. Prevents users from accidentally creating a marketplace they can't publish.                                                                                                                                                                                                                                                                                                                                                                                       |
| 14  | **Marketplace ToS**                                                                 | Out of strict scope. Acknowledged as a parallel artifact for the future paid-packages track. The `pricing` schema slot (Decision 4) makes this a future-only concern.                                                                                                                                                                                                                                                                     | User decision: bundle the schema slot, defer the legal/commerce paperwork.                                                                                                                                                                                                                                                                                                                                                                                                      |
| 15  | **Migration story**                                                                 | None. No `marketplace.json` files exist in production yet (#28 has not bootstrapped). marketplace-05 is "fix before first deploy." Spec 04's `04-implementation.md` gets a forward-pointer noting marketplace-05 supersedes the schema portion.                                                                                                                                                                                           | Already explicit in the brief.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 16  | **CC `extraKnownMarketplaces` and `enabledPlugins` settings interop**               | Not in v1 scope. DorkOS has its own settings system. Reading CC's project-level `.claude/settings.json` is a valuable "drop into existing CC teams" story but is deferred.                                                                                                                                                                                                                                                                | User did not explicitly decide; defaulting to "defer" because it touches a separate settings system (`.claude/settings.json` vs DorkOS settings) that needs its own design work. Surface as a future enhancement item.                                                                                                                                                                                                                                                          |
| 17  | **`strict` field interaction with `.dork/manifest.json`**                           | DorkOS treats CC's `strict` field as opaque metadata in v1. DorkOS continues to use `.dork/manifest.json` as its package authority. If a plugin has both `.claude-plugin/plugin.json` and `.dork/manifest.json`, DorkOS prefers `.dork/manifest.json` and ignores CC's `strict` semantics (which only affect CC's component parsing, not DorkOS's package metadata).                                                                      | Defaulting to "preserve existing DorkOS behavior" — `.dork/manifest.json` was the source of truth in spec 02 and stays so in marketplace-05. CC's `strict` mode is about how CC parses its OWN component fields, which we delegate to the SDK anyway.                                                                                                                                                                                                                           |

---

## 7) Success Criteria

A spec is successful if, after implementation:

1. **`claude plugin validate` passes** against `dork-labs/marketplace/.claude-plugin/marketplace.json` (the rewritten seed). Manual pre-merge step using a locally-installed Claude Code binary.
2. **`pnpm test` passes** the new test matrix:
   - 14 fixture-based tests across 5 source types (Direction A: 6 tests; Direction B: 8 tests)
   - All existing marketplace tests in `packages/marketplace/`, `apps/server/src/services/marketplace/`, `apps/server/src/services/marketplace-mcp/`, `apps/site/src/layers/features/marketplace/`, `packages/cli/src/commands/`
3. **`pnpm typecheck` and `pnpm lint`** pass workspace-wide (21/21 successful, no new errors).
4. **A real Claude Code marketplace installs via DorkOS.** Vendored snapshot of `anthropics/claude-plugins-official` parses, dispatches sources correctly, and (mocked) install pipeline succeeds for all 4 supported source types.
5. **A DorkOS seed plugin runs in stock Claude Code.** Manual smoke test: `claude plugin marketplace add dork-labs/marketplace` then `claude plugin install code-reviewer@dorkos` then verify the plugin loads. Document the result in `04-implementation.md`.
6. **Plugin runtime activation works end-to-end via DorkOS.** Install a CC plugin via DorkOS marketplace UI, start an agent session, verify the plugin's skills appear in `slash_commands` and a plugin skill executes.
7. **Spec 04 forward-pointer added** to `specs/marketplace-04-web-and-registry/04-implementation.md` noting that marketplace-05 supersedes the schema portion.
8. **#28 unblocked**. The new same-repo monorepo seed at `dork-labs/marketplace` can be deployed (1 repo total instead of 9).
9. **Documentation updated**: 6 contributing/docs files reflect the new format, the sidecar pattern, and the install dispatch model.
10. **ADRs published**:
    - **ADR-0236**: Sidecar `dorkos.json` for DorkOS marketplace extensions (rationale: CC's `additionalProperties: false`)
    - **ADR-0237**: Same-repo monorepo for the dork-labs/marketplace seed
    - **ADR-0238**: Port-to-Zod CC validator with weekly sync cron (rationale: CC binary closed-source, no public schema URL)
    - **ADR-0239**: Plugin runtime activation via Claude Agent SDK `options.plugins` (rationale: SDK handles all CC component types automatically; no reimplementation)
11. **Schema sync cron CI job** is configured and produces a sample diff PR against `hesreallyhim/claude-code-json-schema` to prove the maintenance loop works.
12. **Source-form telemetry** column added to `marketplace_install_events` Drizzle schema with migration applied to dev Neon DB.

---

## 8) Sequencing & Dependencies

The work has a natural critical path. Decomposition into tasks should respect this ordering so tests can be written against the new schema before the install pipeline changes land:

1. **Phase 1 — Foundations (parallel-safe)**
   - Empirical sidecar verification (install CC locally, validate fixtures both ways)
   - Port CC schema to Zod in `cc-validator.ts`
   - Define new `MarketplaceJsonSchema` (with `owner`, `metadata`, source discriminated union, object-shape `author`, `strict` field, CC component fields as opaque)
   - Define new `dorkos.json` sidecar schema with `pricing`, `type`, `layers`, `requires`, `featured`, `icon`, `dorkosMinVersion`
   - Schema tests for both files, including all 5 source forms (npm as deferred-stub case)
   - ADR-0236 (sidecar) and ADR-0238 (port-to-Zod) drafted
2. **Phase 2 — Source resolution (depends on Phase 1)**
   - `source-resolver.ts` pure function in `@dorkos/marketplace`
   - 4 source resolver implementations in `apps/server/src/services/marketplace/source-resolvers/` (relative-path, github, url, git-subdir)
   - npm stub resolver with structured error
   - Tests for each resolver (mocked git/network)
   - Update `package-fetcher.ts` to dispatch by source type
   - Update `marketplace-installer.ts` integration tests
3. **Phase 3 — Site fetch and runtime activation (depends on Phase 1)**
   - Update `apps/site/src/layers/features/marketplace/lib/fetch.ts` for new path and source dispatch
   - New `dorkos-sidecar-fetch.ts`
   - Update site UI components (PackageHeader, InstallInstructions)
   - **Plugin activation in `services/runtimes/claude-code/plugin-activation.ts`** — the architectural unlock (depends on schema in Phase 1)
   - Wire `plugin-activation.ts` into `claude-code-runtime.ts` session start
   - ADR-0239 (SDK plugin activation) drafted
4. **Phase 4 — Seed rewrite + telemetry (depends on Phases 1-3)**
   - Rewrite `packages/marketplace/fixtures/dorkos-community-marketplace.json` as new same-repo monorepo layout with sidecar
   - Move file location to `.claude-plugin/marketplace.json` in fixture
   - Add Drizzle migration for `source_type` column in `marketplace_install_events`
   - ADR-0237 (same-repo monorepo) drafted
5. **Phase 5 — CLI validator integration**
   - Update `package-validate-marketplace` and `package-validate-remote` to run CC validator second pass and reserved-name enforcement
   - Add `scripts/sync-cc-schema.ts` weekly cron CI job
6. **Phase 6 — Documentation, E2E, manual validation**
   - Update 6 contributing/docs files
   - Update spec 04 implementation forward-pointer
   - Add E2E tests for both compatibility directions
   - Manual: install CC locally, validate seed, run "install plugin from DorkOS in CC" smoke test
   - Manual: install seed plugin via DorkOS, verify SDK plugin activation in agent session
7. **Phase 7 — Unblock #28**
   - Bootstrap `dork-labs/marketplace` repo with the new same-repo monorepo layout
   - Push 1 repo (registry + 8 plugins) instead of 9

**Approximate task count after decomposition: ~22-28 tasks across 7 phases.** Should use holistic batch-level verification gates per stored feedback (`feedback_holistic_batch_gates.md`).

---

## 9) Open follow-ups (NOT in v1, tracked here)

These are intentionally deferred but need to be visible somewhere so they don't get lost:

1. **marketplace-06-npm-sources** — full npm source type support with `--ignore-scripts`, transactional rollback redesign, and private-registry auth via `DORK_NPM_TOKEN` / `DORK_NPM_REGISTRY` env vars.
2. **marketplace-07-paid-packages** — implementation of the `pricing` schema slot. Requires marketplace ToS, payment intermediary integration (Stripe?), author payout flow, commerce permissions.
3. **CC `extraKnownMarketplaces` and `enabledPlugins` interop** — DorkOS reads `.claude/settings.json` from project workspaces and offers to install marketplaces a CC team has already configured. Strong "drop into existing CC teams" story.
4. **Multi-runtime plugin abstraction** — `AgentRuntime.activatePlugin(path)` interface for future non-CC runtimes (Codex, OpenAI). Premature for v1; the Claude Agent SDK runtime is the only one that has plugin support today.
5. **Community submission tooling** — `dork marketplace submit` CLI for community contributors instead of manual PRs.
6. **Validator parity with the actual CC binary** — if Anthropic ever publishes a stable schema URL or open-sources the validator, port over.
7. **CC schema sync weekly cron** — set up and verified in v1, but the maintenance loop continues forever.
8. **Lighthouse + accessibility audit** — deferred from spec 04, gated on #28 deploying.

---

## 10) Notes for `/ideate-to-spec`

When this ideation is converted to a full spec via `/ideate-to-spec`:

- **The 17 decisions are all locked.** Do not re-litigate them. The user resolved 4 explicitly via `AskUserQuestion`; the remaining 13 are research-backed and follow logically from the 4.
- **The empirical sidecar verification (Decision 5) is a Phase 1 task, not a decision.** It validates whether the sidecar approach is needed or whether CC has loosened its validator. If CC turns out to tolerate inline `x-dorkos` fields, the spec can revisit — but the default is sidecar.
- **Honor the strict-superset framing in every section.** When a design choice is borderline, the question to ask is "does this preserve the bidirectional invariants?" If yes, keep. If no, redesign.
- **The Claude Agent SDK plugin activation is the largest architectural unlock and the lowest-risk implementation.** Don't expand the spec to reimplement what the SDK already does. Plugin activation is one new file (`plugin-activation.ts`) plus a wire-up in `claude-code-runtime.ts`.
- **Test matrix is non-negotiable.** All 14 fixture tests (6 outbound + 8 inbound) must exist before declaring the spec complete. Don't reduce coverage to fit a deadline.
- **Vendored snapshot of `claude-plugins-official` is the inbound integration test fixture.** Commit it. Don't fetch at test time. Update quarterly.
- **The CC schema sync cron job is a maintenance commitment.** It must be set up and verified before the spec is considered complete. Without it, DorkOS's Zod schema will silently drift behind CC.
- **Holistic batch-level verification gates** apply per stored feedback. Don't run per-task two-stage review on every task.
- **Out-of-scope items in section 1 stay out of scope.** If execution surfaces a new "shouldn't we also..." question, the answer is "marketplace-06" (or later), not "let's expand v1."

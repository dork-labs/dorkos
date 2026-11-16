---
slug: marketplace-05-agent-installer
number: 228
created: 2026-04-06
status: ideation
parent-spec: dorkos-marketplace
project: dorkos-marketplace
sequence: 5
depends-on: [marketplace-01-foundation, marketplace-02-install]
linear-issue: null
tags: [marketplace, mcp, agent, ai-native, personal-marketplace]
---

# Marketplace 05: Agent Installer (MCP Server)

**Slug:** marketplace-05-agent-installer
**Author:** Claude Code
**Date:** 2026-04-06
**Project:** DorkOS Marketplace (5 specs total)
**Sequence:** 5 of 5 — final spec

---

## Source Material

- **Parent ideation:** [`specs/dorkos-marketplace/01-ideation.md`](../dorkos-marketplace/01-ideation.md)
- **Foundation spec:** [`specs/marketplace-01-foundation/02-specification.md`](../marketplace-01-foundation/02-specification.md)
- **Install spec:** [`specs/marketplace-02-install/02-specification.md`](../marketplace-02-install/02-specification.md)

This is the **capstone spec** that delivers Vision 2 (AI-Native Discovery via MCP Server) and lays the foundation for Vision 3 (Build-to-Install Pipeline). It can ship in parallel with spec 04 since both depend on 02 but not on each other.

---

## Scope of This Spec

This spec exposes the marketplace as an **MCP server** so any AI agent — Claude Code, Cursor, Codex, Cline, ChatGPT, Gemini — can search and install DorkOS packages programmatically. It also introduces the **Personal Marketplace** concept (Vision 3 foundation): every user has their own local marketplace where agents can scaffold and publish packages on demand.

After this spec ships, DorkOS becomes **the default agent package registry** — not just for DorkOS users, but for any AI tool that speaks MCP.

### In Scope

1. **Marketplace MCP server endpoints** — Wired into the existing `/mcp` MCP server at `apps/server/src/services/core/mcp-server.ts`
2. **MCP tools:**
   - `marketplace_search` — Search packages by query, type, category, tags
   - `marketplace_get` — Get package details by name
   - `marketplace_list_marketplaces` — List configured marketplace sources
   - `marketplace_list_installed` — List installed packages
   - `marketplace_install` — Install a package (gated by user confirmation if interactive)
   - `marketplace_uninstall` — Uninstall a package
   - `marketplace_recommend` — Recommend packages based on a context description
3. **Personal marketplace** — `~/.dork/personal-marketplace/` directory treated as a marketplace source
   - Local-only by default
   - Includes a `marketplace.json` and `packages/` subdirectory
   - DorkOS treats it like any other marketplace source
4. **`marketplace_create_package` MCP tool** — Lets agents scaffold a new package (Build-to-Install foundation)
5. **MCP authentication** — Reuse existing `MCP_API_KEY` pattern + anonymous read-only mode
6. **Agent install confirmation flow** — When an agent calls `marketplace_install`, the user sees a confirmation prompt (via existing AskUserQuestion-style interaction patterns)
7. **External MCP server discovery** — Document how third-party agents connect to DorkOS marketplace MCP

### Out of Scope

- Foundation, install machinery, browse UI (Specs 01–03)
- Web marketplace, registry repo, seed packages (Spec 04)
- Public personal marketplace publishing / sharing (deferred)
- Full Build-to-Install loop (the AI-builds-then-publishes flow — deferred to v2)
- Live preview / sandbox (deferred)
- Sigstore signing (deferred)

---

## Resolved Decisions

| #   | Decision                           | Choice                                                                                 | Rationale                                                                        |
| --- | ---------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | MCP server location                | Extend existing `/mcp` server (`apps/server/src/services/core/mcp-server.ts`)          | DorkOS already has a Streamable HTTP MCP server. Don't create a parallel one.    |
| 2   | Authentication                     | Reuse existing `MCP_API_KEY` env var + anonymous read-only mode for search/list        | Consistent with existing MCP server. Don't broaden auth surface.                 |
| 3   | Install confirmation               | Required for `marketplace_install` and `marketplace_uninstall`. Skipped for read-only. | Trust by design. Agents can search freely; mutations require human confirmation. |
| 4   | Personal marketplace location      | `~/.dork/personal-marketplace/`                                                        | Mirrors `~/.dork/agents/`, `~/.dork/extensions/` patterns                        |
| 5   | Personal marketplace structure     | Same `marketplace.json` + package directories layout as `dorkos-community`             | Consistent with the public marketplace. Trivially upgradeable to public.         |
| 6   | Recommendation engine              | Simple keyword + tag matching for v1. ML-based recommendations deferred.               | Solve the easy 80% with no infra.                                                |
| 7   | `marketplace_create_package` scope | Scaffolds package + manifest. Does NOT auto-publish.                                   | Conservative. Full Build-to-Install loop is v2.                                  |
| 8   | External agent discovery           | Document the MCP endpoint URL pattern; users add it to their AI tool's MCP config      | Standard MCP discovery — no special infra needed.                                |

---

## Acceptance Criteria

- [ ] All 7 marketplace MCP tools registered with the existing `/mcp` server
- [ ] Tools are discoverable via standard MCP `tools/list`
- [ ] Tool schemas validate inputs strictly
- [ ] `marketplace_search` returns filtered results from all configured marketplaces
- [ ] `marketplace_install` requires user confirmation
- [ ] `marketplace_create_package` scaffolds a working package
- [ ] Personal marketplace directory is auto-created on first run
- [ ] Personal marketplace appears alongside `dorkos-community` in source list
- [ ] Anonymous read-only mode works for search/list/get
- [ ] `MCP_API_KEY` required for install/uninstall/create
- [ ] Documentation explains how Claude Code / Cursor / Codex users add the DorkOS marketplace MCP
- [ ] Tests cover all tools including failure paths
- [ ] Recommendation function returns relevant matches

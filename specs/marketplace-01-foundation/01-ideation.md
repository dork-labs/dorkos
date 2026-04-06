---
slug: marketplace-01-foundation
number: 224
created: 2026-04-06
status: ideation
parent-spec: dorkos-marketplace
project: dorkos-marketplace
sequence: 1
linear-issue: null
tags: [marketplace, foundation, schemas, parser, validator]
---

# Marketplace 01: Foundation

**Slug:** marketplace-01-foundation
**Author:** Claude Code
**Date:** 2026-04-06
**Branch:** preflight/marketplace-01-foundation
**Project:** DorkOS Marketplace (5 specs total)
**Sequence:** 1 of 5 — must ship before specs 02-05

---

## Source Material

This is the FIRST of 5 sequential specs that together implement the DorkOS Marketplace. The full project context, vision, design decisions, and architectural rationale live in the parent ideation document:

- **Parent ideation:** [`specs/dorkos-marketplace/01-ideation.md`](../dorkos-marketplace/01-ideation.md)
- **Source brief:** [`research/20260331_marketplace_project_brief.md`](../../research/20260331_marketplace_project_brief.md)

**Read the parent ideation first.** It contains the complete industry landscape, the bidirectional Claude Code compatibility model, the 10x vision (Agent App Store, MCP server, Build-to-Install), the 15 design decisions, the 13 open questions, and the V1 build list. This sub-spec inherits all of that context.

---

## Scope of This Spec (Foundation)

**This spec produces a `@dorkos/marketplace` package and supporting tooling.** It does NOT include any install logic, UI, registry, or MCP server — those are subsequent specs.

### In Scope

1. **`@dorkos/marketplace` package** — New shared package at `packages/marketplace/`
   - Browser-safe + Node.js subpath exports (mirrors `@dorkos/skills` pattern)
   - Zod schemas for `.dork/manifest.json`
   - `marketplace.json` parser (Claude Code-compatible + DorkOS extensions)
   - Package validator (structural + semantic checks)
   - Type definitions and constants
2. **`.dork/manifest.json` schema** — The DorkOS package manifest format
   - Required fields: `name`, `version`, `type`, `description`
   - Type-specific fields: extensions, tasks, adapters, requires, layers, etc.
   - Validation, normalization, type-specific schemas for each `type` value
3. **`marketplace.json` parser** — Read Claude Code marketplace registries
   - Tolerant of unknown fields (DorkOS extension fields)
   - Validates against Claude Code's standard schema as a base
   - Normalizes DorkOS extension fields with sensible defaults
4. **Package validator** — `validatePackage(packagePath)` programmatic API
   - Checks for required files: `.claude-plugin/plugin.json` (plugins) or template files (agents)
   - Validates `.dork/manifest.json` against schema
   - Validates SKILL.md files via existing `@dorkos/skills` validator
   - Checks for ID/directory mismatches, duplicate names, conflicting declarations
5. **Authoring CLI commands** (extend `packages/cli`):
   - `dorkos package init <name>` — Scaffold a new package directory
   - `dorkos package validate [path]` — Lint a package locally
6. **Update ADR-0220** with addendum: optional `kind` field on SkillFrontmatterSchema with smart inference
7. **Tests** — Comprehensive Vitest coverage for schemas, parser, validator

### Out of Scope (Future Specs)

- `dorkos install` CLI command (Spec 02)
- File placement, atomic transactions, rollback (Spec 02)
- Three install flows: plugin / agent / personal package (Spec 02)
- Permission preview UI (Spec 02)
- Uninstall + update flows (Spec 02)
- Local cache (Spec 02)
- Marketplace Extension (built-in UI) (Spec 03)
- TemplatePicker integration (Spec 03)
- `/marketplace` web page on dorkos.dev (Spec 04)
- `dorkos-community` registry repo (Spec 04)
- Seed packages (Spec 04)
- Telemetry (Spec 04)
- Marketplace MCP server (Spec 05)
- `marketplace_search` / `marketplace_install` MCP tools (Spec 05)
- Personal marketplace (Spec 05)

---

## 1) Intent & Assumptions

- **Task brief:** Build the foundational `@dorkos/marketplace` package that provides the schemas, parser, validator, and authoring CLIs needed by all subsequent marketplace specs. Make this package useful by itself — a developer can scaffold and validate a marketplace package without any install machinery existing.
- **Assumptions:**
  - `@dorkos/skills` is stable and provides the SkillFrontmatterSchema base
  - ADR-0220 can accept a small addendum for the `kind` field
  - The CLI package (`packages/cli`) can accept new subcommands
  - Zod is the schema validation library (consistent with existing packages)
  - Vitest is the test framework
- **Out of scope:**
  - Anything that requires running an installed package (install flows, runtime)
  - Anything that requires a registry to exist (browsing, searching)
  - Anything that requires DorkOS server runtime (the package is shared)

---

## 2) Resolved Decisions (from /ideate-to-spec)

| #   | Decision                               | Choice                                                  | Rationale                                                                             |
| --- | -------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Manifest filename                      | `.dork/manifest.json`                                   | Consistent with other `.dork/` files (agent.json, adapters.json). No npm confusion.   |
| 2   | `kind` discriminator field on SKILL.md | Add optional `kind` field with smart inference fallback | Marketplace packages benefit from explicit `kind`; user files keep current ergonomics |
| 3   | Registry `type` value for agents       | `agent`                                                 | Aligns with Agent App Store framing. Distinguished from mesh agents by context.       |

---

## 3) Codebase Map (foundation-relevant)

**Existing packages to mirror or extend:**

- `packages/skills/` — `@dorkos/skills`. Mirror its structure: browser-safe + Node.js subpath exports, Zod schemas, parser, writer, scanner, validator. The marketplace package extends the SKILL.md ecosystem.
- `packages/shared/` — `@dorkos/shared`. Some types may need to live here if they're consumed by both client and server (e.g., `MarketplacePackage` type).
- `packages/cli/` — `dorkos` CLI. New subcommands `package init` and `package validate` go here.

**Existing schemas to integrate with:**

- `packages/skills/src/schema.ts` — `SkillFrontmatterSchema` (base agentskills.io spec)
- `packages/skills/src/task-schema.ts` — `TaskFrontmatterSchema`
- `packages/skills/src/command-schema.ts` — `CommandFrontmatterSchema`
- `packages/shared/src/template-catalog.ts` — Existing `TemplateCatalog` and `TemplateEntry` types (will eventually be subsumed by marketplace)
- `packages/shared/src/relay-adapter-schemas.ts` — `AdapterManifest` type (for adapter packages)

**Existing manifest patterns to learn from:**

- `packages/shared/src/manifest.ts` — Read/write `.dork/agent.json`, file-first I/O patterns
- `apps/server/src/services/extensions/extension-manifest-schema.ts` — Extension manifest

---

## 4) Decisions Required During Specification

The specification phase will need to resolve these implementation-detail questions. They are NOT user-facing decisions — they're for the spec author:

- Exact subpath export structure (mirror @dorkos/skills exactly?)
- Whether `MarketplacePackage` type lives in `@dorkos/marketplace` or `@dorkos/shared`
- Where the `kind` field addendum to ADR-0220 lives (new ADR? Update existing?)
- Whether `dorkos package init` should support templates (e.g., `--template plugin` vs `--template agent`)
- Validator error message format and error codes

---

## 5) Acceptance Criteria

After this spec is implemented:

- [ ] `packages/marketplace/` exists with browser-safe + Node.js subpath exports
- [ ] `MarketplacePackageSchema` validates a complete package manifest
- [ ] `parseMarketplaceJson(content)` reads a Claude Code marketplace.json with optional DorkOS extension fields
- [ ] `validatePackage(packagePath)` returns structured validation results for any package on disk
- [ ] `dorkos package init my-package --type plugin` scaffolds a working starter package
- [ ] `dorkos package validate ./my-package` lints a package and reports errors clearly
- [ ] All schemas, parsers, and validators have Vitest test coverage
- [ ] ADR-0220 has an addendum documenting the optional `kind` field
- [ ] `@dorkos/skills` `SkillFrontmatterSchema` accepts an optional `kind` field
- [ ] Type-checks pass across the workspace
- [ ] Zero changes to runtime behavior of existing extensions, tasks, or templates (foundation is purely additive)

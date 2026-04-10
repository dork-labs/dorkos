---
slug: marketplace-01-foundation
number: 224
created: 2026-04-06
status: specified
parent-spec: dorkos-marketplace
project: dorkos-marketplace
sequence: 1
linear-issue: null
depends-on: []
depended-on-by:
  [
    marketplace-02-install,
    marketplace-03-extension,
    marketplace-04-web-and-registry,
    marketplace-05-agent-installer,
  ]
---

# Marketplace 01: Foundation — Technical Specification

**Slug:** marketplace-01-foundation
**Author:** Claude Code
**Date:** 2026-04-06
**Project:** DorkOS Marketplace (5 specs total)
**Sequence:** 1 of 5

---

## Overview

This specification defines the foundational `@dorkos/marketplace` package — the schemas, parser, validator, and authoring CLI commands that all subsequent marketplace specs depend on. It introduces the `.dork/manifest.json` file format, a Claude Code-compatible `marketplace.json` parser with optional DorkOS extension fields, structural and semantic package validation, and `dorkos package init` / `dorkos package validate` commands. It also adds an optional `kind` field to the existing `SkillFrontmatterSchema` (ADR-0220 addendum).

This spec produces **no install logic, no UI, no registry, no MCP server.** Those land in specs 02–05. After this spec ships, a developer can scaffold a marketplace package locally, validate it, and have confidence it will be installable when the install machinery arrives.

### Why

The DorkOS Marketplace project is broken into 5 sequential specs (see parent ideation). Every later spec depends on the schemas and validation defined here:

- **Spec 02 (install)** needs the manifest schema to know what to install and where.
- **Spec 03 (extension UI)** needs the parser to read marketplaces and the validator to display package metadata.
- **Spec 04 (web + registry)** needs the schema to validate submissions to the `dorkos-community` repo.
- **Spec 05 (MCP server)** needs the parser and validator to expose programmatic search/install.

Building these foundations as a standalone, well-tested package — rather than scattered across the install code — gives every later spec a stable, type-safe interface to work against.

### Source Documents

- `specs/marketplace-01-foundation/01-ideation.md` — This spec's ideation document
- `specs/dorkos-marketplace/01-ideation.md` — Parent project ideation (full vision and context)
- `research/20260331_marketplace_project_brief.md` — Source brief (preserved verbatim in parent ideation)
- `research/20260329_claude_code_plugin_marketplace_extensibility.md` — Claude Code plugin format reference
- `research/20260329_skills_sh_marketplace_format_specification.md` — Agent Skills standard reference
- `decisions/0220-adopt-skill-md-open-standard.md` — ADR establishing SKILL.md as the universal file format
- `packages/skills/` — Reference implementation for the package structure pattern

---

## Goals

- Create `packages/marketplace/` (`@dorkos/marketplace`) with the same structure pattern as `@dorkos/skills`
- Define `MarketplacePackageManifestSchema` for `.dork/manifest.json` files
- Define `MarketplaceJsonSchema` for parsing Claude Code-compatible registry files with optional DorkOS extension fields
- Provide a `parseMarketplaceJson(content)` function that handles both standard CC and extended DorkOS variants
- Provide a `validatePackage(packagePath)` function that performs structural + semantic checks
- Add `dorkos package init <name>` CLI subcommand for scaffolding new packages
- Add `dorkos package validate [path]` CLI subcommand for local linting
- Add an optional `kind` field to `SkillFrontmatterSchema` in `@dorkos/skills`
- Write a small ADR addendum to ADR-0220 documenting the `kind` field decision
- Achieve full Vitest test coverage for schemas, parser, validator, and CLI commands
- Zero changes to runtime behavior of existing extensions, tasks, templates, or skills (purely additive)

## Non-Goals

- **`dorkos install` CLI command** — Spec 02
- **Install flows (plugin / agent / personal)** — Spec 02
- **Atomic transactions, rollback, file placement** — Spec 02
- **Permission preview UI** — Spec 02
- **Uninstall + update flows** — Spec 02
- **Local cache** — Spec 02
- **Marketplace Extension UI** — Spec 03
- **`/marketplace` web page** — Spec 04
- **`dorkos-community` registry repo** — Spec 04
- **Seed packages** — Spec 04
- **MCP server** — Spec 05
- **Agent-as-installer flow** — Spec 05
- **Personal marketplace** — Spec 05
- **Telemetry** — Spec 04
- **Server-side runtime** — This package is shared (browser-safe + Node.js subpaths). Server integration happens in spec 02.

---

## Technical Dependencies

| Dependency                  | Version       | Purpose                                        |
| --------------------------- | ------------- | ---------------------------------------------- |
| `zod`                       | `^3.25.76`    | Schema validation                              |
| `gray-matter`               | `^4.0.3`      | YAML frontmatter parsing (via @dorkos/skills)  |
| `@dorkos/skills`            | `workspace:*` | SKILL.md schemas, parser, validator (existing) |
| `@dorkos/typescript-config` | `workspace:*` | Shared TypeScript configuration                |
| `@dorkos/eslint-config`     | `workspace:*` | Shared ESLint configuration                    |

No new external dependencies are introduced. The CLI commands extend the existing `packages/cli` package.

---

## Detailed Design

### Package Structure

The `@dorkos/marketplace` package mirrors `@dorkos/skills` exactly. Both browser-safe and Node.js-only modules are exposed via subpath exports. The barrel `index.ts` only re-exports browser-safe modules.

```
packages/marketplace/
├── package.json
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
├── src/
│   ├── index.ts                       # Browser-safe barrel
│   ├── manifest-schema.ts             # MarketplacePackageManifestSchema (Zod)
│   ├── manifest-types.ts              # TypeScript types derived from schema
│   ├── package-types.ts               # PackageType union, type-specific helpers
│   ├── marketplace-json-schema.ts     # MarketplaceJsonSchema (Zod, CC + DorkOS)
│   ├── marketplace-json-parser.ts     # parseMarketplaceJson(content) [Node.js+browser]
│   ├── constants.ts                   # Filenames, paths, default values
│   ├── slug.ts                        # Re-exports from @dorkos/skills/slug
│   ├── package-validator.ts           # validatePackage(path) [Node.js only]
│   ├── package-scanner.ts             # scanPackageDirectory(path) [Node.js only]
│   ├── scaffolder.ts                  # createPackage(opts) for `dorkos package init`
│   └── __tests__/
│       ├── manifest-schema.test.ts
│       ├── marketplace-json-schema.test.ts
│       ├── marketplace-json-parser.test.ts
│       ├── package-validator.test.ts
│       ├── package-scanner.test.ts
│       ├── scaffolder.test.ts
│       └── fixtures/
│           ├── valid-plugin/
│           ├── valid-agent/
│           ├── valid-skill-pack/
│           ├── valid-adapter/
│           ├── invalid-no-manifest/
│           ├── invalid-manifest-shape/
│           └── claude-code-plugin/
```

### Subpath Export Categories

| Export                      | Browser-safe? | Dependencies            | Purpose                        |
| --------------------------- | :-----------: | ----------------------- | ------------------------------ |
| `.` (default)               |      Yes      | re-exports browser-safe | Barrel for app code            |
| `./manifest-schema`         |      Yes      | zod                     | `.dork/manifest.json` schema   |
| `./manifest-types`          |      Yes      | none                    | TypeScript types               |
| `./package-types`           |      Yes      | none                    | `PackageType` union, helpers   |
| `./marketplace-json-schema` |      Yes      | zod                     | `marketplace.json` schema      |
| `./marketplace-json-parser` |      Yes      | zod                     | Parse marketplace.json content |
| `./constants`               |      Yes      | none                    | Filenames, paths               |
| `./slug`                    |      Yes      | @dorkos/skills/slug     | Re-export of slug utilities    |
| `./package-validator`       |    **No**     | fs, path, gray-matter   | Filesystem package validation  |
| `./package-scanner`         |    **No**     | fs, path                | Directory scanning             |
| `./scaffolder`              |    **No**     | fs, path                | New package scaffolding        |

The client (`apps/client/`) imports only browser-safe subpaths. The server (`apps/server/`), CLI (`packages/cli`), and test code can import any subpath.

### Package Configuration

**`packages/marketplace/package.json`:**

```json
{
  "name": "@dorkos/marketplace",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest",
    "lint": "eslint src/"
  },
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    },
    "./manifest-schema": {
      "types": "./src/manifest-schema.ts",
      "default": "./dist/manifest-schema.js"
    },
    "./manifest-types": {
      "types": "./src/manifest-types.ts",
      "default": "./dist/manifest-types.js"
    },
    "./package-types": {
      "types": "./src/package-types.ts",
      "default": "./dist/package-types.js"
    },
    "./marketplace-json-schema": {
      "types": "./src/marketplace-json-schema.ts",
      "default": "./dist/marketplace-json-schema.js"
    },
    "./marketplace-json-parser": {
      "types": "./src/marketplace-json-parser.ts",
      "default": "./dist/marketplace-json-parser.js"
    },
    "./constants": {
      "types": "./src/constants.ts",
      "default": "./dist/constants.js"
    },
    "./slug": {
      "types": "./src/slug.ts",
      "default": "./dist/slug.js"
    },
    "./package-validator": {
      "types": "./src/package-validator.ts",
      "default": "./dist/package-validator.js"
    },
    "./package-scanner": {
      "types": "./src/package-scanner.ts",
      "default": "./dist/package-scanner.js"
    },
    "./scaffolder": {
      "types": "./src/scaffolder.ts",
      "default": "./dist/scaffolder.js"
    }
  },
  "dependencies": {
    "@dorkos/skills": "workspace:*",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@dorkos/eslint-config": "workspace:*",
    "@dorkos/typescript-config": "workspace:*",
    "@types/node": "^25.5.0",
    "vitest": "^3.2.4"
  }
}
```

**`packages/marketplace/tsconfig.json`:**

```json
{
  "extends": "@dorkos/typescript-config/node.json",
  "compilerOptions": {
    "outDir": "./dist"
  },
  "include": ["src/**/*"],
  "exclude": ["src/__tests__/**"]
}
```

---

### Schema Design

#### Constants

**`packages/marketplace/src/constants.ts`:**

```typescript
/**
 * The DorkOS package manifest filename, located inside the `.dork/` directory
 * at the root of every marketplace package.
 */
export const PACKAGE_MANIFEST_FILENAME = 'manifest.json';

/**
 * The DorkOS package manifest path relative to the package root.
 */
export const PACKAGE_MANIFEST_PATH = '.dork/manifest.json';

/**
 * The Claude Code plugin manifest path. Required for all packages of type
 * `plugin`, `skill-pack`, and `adapter`. Optional for `agent` packages.
 */
export const CLAUDE_PLUGIN_MANIFEST_PATH = '.claude-plugin/plugin.json';

/**
 * The marketplace registry filename.
 */
export const MARKETPLACE_JSON_FILENAME = 'marketplace.json';

/**
 * The DorkOS package manifest schema version this code understands.
 * Increment when introducing breaking changes to the schema.
 */
export const PACKAGE_MANIFEST_VERSION = 1;
```

#### Package Type Union

**`packages/marketplace/src/package-types.ts`:**

```typescript
import { z } from 'zod';

/**
 * The four kinds of installable packages in the DorkOS marketplace.
 *
 * - `agent`: A complete agent — installed via the agent creation flow,
 *   produces a new agent workspace. Aligns with the Agent App Store framing.
 * - `plugin`: A general-purpose package containing extensions, skills,
 *   commands, hooks, MCP servers, etc. Installed into existing agents/global.
 * - `skill-pack`: A lightweight package containing only SKILL.md files
 *   (skills, tasks, commands). No code, no extensions.
 * - `adapter`: A relay channel adapter (e.g., Discord, Slack). Installed
 *   into the relay subsystem.
 */
export const PackageTypeSchema = z.enum(['agent', 'plugin', 'skill-pack', 'adapter']);

export type PackageType = z.infer<typeof PackageTypeSchema>;

/**
 * Returns true if a package of this type requires a `.claude-plugin/plugin.json`
 * manifest. All types except `agent` require it (agents are project scaffolds,
 * not Claude Code plugins).
 */
export function requiresClaudePlugin(type: PackageType): boolean {
  return type !== 'agent';
}
```

#### Package Manifest Schema

**`packages/marketplace/src/manifest-schema.ts`:**

```typescript
import { z } from 'zod';
import { SkillNameSchema } from '@dorkos/skills/schema';
import { PackageTypeSchema } from './package-types.js';

/**
 * Semver version string. Loose validation — full semver parsing is the
 * installer's responsibility.
 */
const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/, 'Must be a valid semver string');

/**
 * A dependency declaration. Format: `<type>:<name>` or `<type>:<name>@<version>`.
 *
 * @example
 *   "adapter:slack"
 *   "adapter:slack@^1.0.0"
 *   "plugin:linear-integration"
 */
const DependencyDeclarationSchema = z
  .string()
  .regex(
    /^(adapter|plugin|skill-pack|agent):[a-z][a-z0-9-]*([@][\w.~^>=<!*-]+)?$/,
    'Must be of the form <type>:<name> or <type>:<name>@<version>'
  );

/**
 * Layer declarations describe what kinds of content a package contains.
 * Used by the marketplace UI to filter and display package capabilities.
 */
const PackageLayerSchema = z.enum([
  'skills',
  'tasks',
  'commands',
  'hooks',
  'extensions',
  'adapters',
  'mcp-servers',
  'lsp-servers',
  'agents',
]);

/**
 * Common fields shared by all package types.
 */
const BasePackageManifestSchema = z.object({
  /** Schema version. Currently 1. */
  schemaVersion: z.literal(1).default(1),

  /** Package identifier. Kebab-case, must match the directory name. */
  name: SkillNameSchema,

  /** Semver version string. */
  version: SemverSchema,

  /** Package type — determines install flow and validation rules. */
  type: PackageTypeSchema,

  /** Short description shown in marketplace browse UI. 1-1024 chars. */
  description: z.string().min(1).max(1024),

  /** Optional human-readable display name. Falls back to humanized `name`. */
  displayName: z.string().max(128).optional(),

  /** Author name or organization. */
  author: z.string().max(256).optional(),

  /** SPDX license identifier or "UNLICENSED". */
  license: z.string().max(64).optional(),

  /** Repository URL (typically a git URL). */
  repository: z.string().url().optional(),

  /** Homepage URL. */
  homepage: z.string().url().optional(),

  /** Searchable tags. */
  tags: z.array(z.string().max(32)).max(20).default([]),

  /** Primary category for browse UI. */
  category: z.string().max(64).optional(),

  /** Icon emoji or icon identifier (e.g., "🔍" or "package"). */
  icon: z.string().max(64).optional(),

  /** Minimum DorkOS version required (semver). */
  minDorkosVersion: SemverSchema.optional(),

  /** Layers (content categories) this package contributes. Informational. */
  layers: z.array(PackageLayerSchema).default([]),

  /** Other packages this one depends on. */
  requires: z.array(DependencyDeclarationSchema).default([]),

  /** Whether to highlight in marketplace browse UI (registry sets this, not the package). */
  featured: z.boolean().optional(),
});

/**
 * Plugin-specific manifest fields.
 */
const PluginManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('plugin'),
  /** Optional list of extension IDs bundled in this package. */
  extensions: z.array(z.string()).default([]),
});

/**
 * Agent (template) -specific manifest fields.
 */
const AgentManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('agent'),
  /** Default agent identity values applied during creation. */
  agentDefaults: z
    .object({
      persona: z.string().max(4000).optional(),
      capabilities: z.array(z.string()).default([]),
      traits: z
        .object({
          tone: z.number().int().min(1).max(5).optional(),
          autonomy: z.number().int().min(1).max(5).optional(),
          caution: z.number().int().min(1).max(5).optional(),
          communication: z.number().int().min(1).max(5).optional(),
          creativity: z.number().int().min(1).max(5).optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * Skill-pack-specific manifest fields. (Currently no extra fields beyond base.)
 */
const SkillPackManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('skill-pack'),
});

/**
 * Adapter-specific manifest fields.
 */
const AdapterManifestSchema = BasePackageManifestSchema.extend({
  type: z.literal('adapter'),
  /** Adapter type identifier (e.g., "discord", "slack"). */
  adapterType: z.string().min(1).max(64),
});

/**
 * Discriminated union over package type. Validates type-specific fields
 * based on the `type` discriminator.
 */
export const MarketplacePackageManifestSchema = z.discriminatedUnion('type', [
  PluginManifestSchema,
  AgentManifestSchema,
  SkillPackManifestSchema,
  AdapterManifestSchema,
]);

export type MarketplacePackageManifest = z.infer<typeof MarketplacePackageManifestSchema>;
export type PluginPackageManifest = z.infer<typeof PluginManifestSchema>;
export type AgentPackageManifest = z.infer<typeof AgentManifestSchema>;
export type SkillPackPackageManifest = z.infer<typeof SkillPackManifestSchema>;
export type AdapterPackageManifest = z.infer<typeof AdapterManifestSchema>;
```

#### Marketplace JSON Schema

The `marketplace.json` schema extends Claude Code's standard format with optional DorkOS fields. The hypothesis (per Open Question #7 in the parent ideation) is that Claude Code's parser ignores unknown fields. This must be **tested before v1 ships**, but the schema is designed to fall back gracefully either way.

**`packages/marketplace/src/marketplace-json-schema.ts`:**

```typescript
import { z } from 'zod';
import { PackageTypeSchema } from './package-types.js';

/**
 * Standard Claude Code marketplace.json plugin entry fields.
 * These are the only fields Claude Code's parser is guaranteed to understand.
 */
const ClaudeCodeStandardEntrySchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  description: z.string().optional(),
  version: z.string().optional(),
  author: z.string().optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

/**
 * Optional DorkOS extension fields. Added to marketplace.json plugin entries
 * to enable browse/filter without cloning every package.
 *
 * If Claude Code's parser is strict and rejects unknown fields, these will
 * be moved to a companion `dorkos-catalog.json` file (Open Question #7).
 */
const DorkosExtensionFieldsSchema = z.object({
  /** Package type — determines install flow. Defaults to `plugin` if absent. */
  type: PackageTypeSchema.optional(),

  /** Browsing category (e.g., "frontend", "code-quality"). */
  category: z.string().max(64).optional(),

  /** Searchable tags. */
  tags: z.array(z.string().max(32)).max(20).optional(),

  /** Icon emoji or identifier. */
  icon: z.string().max(64).optional(),

  /** Layer/content categories. */
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

  /** Dependency declarations. */
  requires: z.array(z.string()).optional(),

  /** Whether to highlight in browse UI. */
  featured: z.boolean().optional(),

  /** Minimum DorkOS version. */
  dorkosMinVersion: z.string().optional(),
});

/**
 * A marketplace.json plugin entry. Combines standard CC fields with optional
 * DorkOS extension fields. Uses `passthrough()` so unknown fields are
 * preserved (defensive against future CC schema additions).
 */
export const MarketplaceJsonEntrySchema = ClaudeCodeStandardEntrySchema.merge(
  DorkosExtensionFieldsSchema
).passthrough();

/**
 * The full marketplace.json schema. Mirrors Claude Code's structure exactly:
 * `{ name: string, plugins: [...] }`.
 *
 * Uses `passthrough()` at the top level so additional CC marketplace metadata
 * (e.g., publisher info, version) is preserved.
 */
export const MarketplaceJsonSchema = z
  .object({
    name: z.string().min(1),
    plugins: z.array(MarketplaceJsonEntrySchema),
  })
  .passthrough();

export type MarketplaceJsonEntry = z.infer<typeof MarketplaceJsonEntrySchema>;
export type MarketplaceJson = z.infer<typeof MarketplaceJsonSchema>;
```

#### Marketplace JSON Parser

**`packages/marketplace/src/marketplace-json-parser.ts`:**

```typescript
import { MarketplaceJsonSchema, type MarketplaceJson } from './marketplace-json-schema.js';

export type ParseMarketplaceResult =
  | { ok: true; marketplace: MarketplaceJson }
  | { ok: false; error: string };

/**
 * Parse a marketplace.json string into a typed MarketplaceJson object.
 *
 * The parser is tolerant of:
 * - Standard Claude Code marketplaces (no DorkOS fields) — entries default to type=plugin
 * - DorkOS-extended marketplaces with type/category/tags/etc.
 * - Unknown fields at any level (preserved via passthrough)
 *
 * @param content - Raw JSON string from marketplace.json
 * @returns Parsed marketplace or error message
 */
export function parseMarketplaceJson(content: string): ParseMarketplaceResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const result = MarketplaceJsonSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `marketplace.json validation failed: ${issues}` };
  }

  return { ok: true, marketplace: result.data };
}
```

---

### Package Validator

**`packages/marketplace/src/package-validator.ts`** (Node.js only):

```typescript
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { scanSkillDirectory } from '@dorkos/skills/scanner';
import { validateSkillStructure } from '@dorkos/skills/validator';
import { MarketplacePackageManifestSchema } from './manifest-schema.js';
import { requiresClaudePlugin } from './package-types.js';
import { PACKAGE_MANIFEST_PATH, CLAUDE_PLUGIN_MANIFEST_PATH } from './constants.js';

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
}

export interface ValidatePackageResult {
  ok: boolean;
  issues: ValidationIssue[];
  manifest?: import('./manifest-schema.js').MarketplacePackageManifest;
}

/**
 * Validate a marketplace package on disk.
 *
 * Performs:
 * 1. Existence checks for required files (.dork/manifest.json, optional .claude-plugin/plugin.json)
 * 2. Schema validation of .dork/manifest.json
 * 3. SKILL.md validation for any *.md files under skills/, tasks/, commands/
 * 4. Type-specific structural checks (e.g., agent templates need agent.json.template OR scaffolding hooks)
 * 5. Cross-reference checks (declared extensions exist on disk, etc.)
 *
 * @param packagePath - Absolute path to the package root directory
 */
export async function validatePackage(packagePath: string): Promise<ValidatePackageResult> {
  const issues: ValidationIssue[] = [];

  // 1. Existence: .dork/manifest.json must exist
  const manifestPath = path.join(packagePath, PACKAGE_MANIFEST_PATH);
  let manifestContent: string;
  try {
    manifestContent = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    issues.push({
      level: 'error',
      code: 'MANIFEST_MISSING',
      message: `Required file missing: ${PACKAGE_MANIFEST_PATH}`,
      path: PACKAGE_MANIFEST_PATH,
    });
    return { ok: false, issues };
  }

  // 2. Parse + validate schema
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestContent);
  } catch (err) {
    issues.push({
      level: 'error',
      code: 'MANIFEST_INVALID_JSON',
      message: `Invalid JSON in manifest: ${err instanceof Error ? err.message : String(err)}`,
      path: PACKAGE_MANIFEST_PATH,
    });
    return { ok: false, issues };
  }

  const parseResult = MarketplacePackageManifestSchema.safeParse(manifestRaw);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      issues.push({
        level: 'error',
        code: 'MANIFEST_SCHEMA_INVALID',
        message: `${issue.path.join('.') || '<root>'}: ${issue.message}`,
        path: PACKAGE_MANIFEST_PATH,
      });
    }
    return { ok: false, issues };
  }

  const manifest = parseResult.data;

  // 3. Plugin-type packages need .claude-plugin/plugin.json
  if (requiresClaudePlugin(manifest.type)) {
    const ccPath = path.join(packagePath, CLAUDE_PLUGIN_MANIFEST_PATH);
    try {
      await fs.access(ccPath);
    } catch {
      issues.push({
        level: 'error',
        code: 'CLAUDE_PLUGIN_MISSING',
        message: `Packages of type '${manifest.type}' must include ${CLAUDE_PLUGIN_MANIFEST_PATH}`,
        path: CLAUDE_PLUGIN_MANIFEST_PATH,
      });
    }
  }

  // 4. Validate SKILL.md files in conventional directories
  for (const dir of ['skills', 'tasks', '.claude/skills', '.claude/commands', '.dork/tasks']) {
    const fullDir = path.join(packagePath, dir);
    try {
      await fs.access(fullDir);
    } catch {
      continue; // Directory doesn't exist — fine
    }
    const skills = await scanSkillDirectory(fullDir);
    for (const skill of skills) {
      const structureResult = await validateSkillStructure(skill.dirPath);
      if (!structureResult.valid) {
        for (const err of structureResult.errors) {
          issues.push({
            level: 'error',
            code: 'SKILL_INVALID',
            message: err,
            path: path.relative(packagePath, skill.filePath),
          });
        }
      }
    }
  }

  // 5. Directory name must match manifest.name (matches @dorkos/skills convention)
  const dirName = path.basename(packagePath);
  if (dirName !== manifest.name) {
    issues.push({
      level: 'warning',
      code: 'NAME_DIRECTORY_MISMATCH',
      message: `Package directory '${dirName}' does not match manifest name '${manifest.name}'`,
    });
  }

  const hasErrors = issues.some((i) => i.level === 'error');
  return { ok: !hasErrors, issues, manifest };
}
```

**`packages/marketplace/src/package-scanner.ts`** (Node.js only):

A minimal scanner used by validators and the eventual install flow. Returns a flat list of package directories under a root directory.

```typescript
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PACKAGE_MANIFEST_PATH } from './constants.js';

export interface ScannedPackage {
  /** Absolute path to the package root */
  packagePath: string;
  /** Package name (directory basename) */
  name: string;
}

/**
 * Scan a directory for marketplace packages.
 *
 * A package is identified by the presence of .dork/manifest.json.
 * Scans only the immediate children — does not recurse.
 */
export async function scanPackageDirectory(rootPath: string): Promise<ScannedPackage[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const packages: ScannedPackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packagePath = path.join(rootPath, entry.name);
    const manifestPath = path.join(packagePath, PACKAGE_MANIFEST_PATH);
    try {
      await fs.access(manifestPath);
      packages.push({ packagePath, name: entry.name });
    } catch {
      // Not a package directory — skip
    }
  }
  return packages;
}
```

---

### Scaffolder

**`packages/marketplace/src/scaffolder.ts`** (Node.js only):

```typescript
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PackageType } from './package-types.js';
import { PACKAGE_MANIFEST_PATH, CLAUDE_PLUGIN_MANIFEST_PATH } from './constants.js';
import { requiresClaudePlugin } from './package-types.js';

export interface CreatePackageOptions {
  /** Where to create the package directory */
  parentDir: string;
  /** Package name (kebab-case). Becomes directory name and manifest.name */
  name: string;
  /** Package type — determines starter file layout */
  type: PackageType;
  /** Optional description for the manifest */
  description?: string;
  /** Optional author for the manifest */
  author?: string;
}

export interface CreatePackageResult {
  /** Absolute path to the created package directory */
  packagePath: string;
  /** Files written, relative to package root */
  filesWritten: string[];
}

/**
 * Scaffold a new marketplace package on disk.
 *
 * Creates a directory at `<parentDir>/<name>/` and writes:
 * - .dork/manifest.json (always)
 * - .claude-plugin/plugin.json (for plugin/skill-pack/adapter types)
 * - README.md (always)
 * - Type-specific starter files (e.g., empty skills/, tasks/ directories)
 */
export async function createPackage(opts: CreatePackageOptions): Promise<CreatePackageResult> {
  const packagePath = path.join(opts.parentDir, opts.name);

  // Refuse to overwrite existing directories
  try {
    await fs.access(packagePath);
    throw new Error(`Directory already exists: ${packagePath}`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  await fs.mkdir(packagePath, { recursive: true });
  await fs.mkdir(path.join(packagePath, '.dork'), { recursive: true });

  const filesWritten: string[] = [];

  // .dork/manifest.json
  const manifest = {
    schemaVersion: 1,
    name: opts.name,
    version: '0.0.1',
    type: opts.type,
    description: opts.description ?? `${opts.name} — a DorkOS ${opts.type}`,
    author: opts.author,
    license: 'MIT',
    tags: [],
    layers: defaultLayersForType(opts.type),
  };
  await fs.writeFile(
    path.join(packagePath, PACKAGE_MANIFEST_PATH),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8'
  );
  filesWritten.push(PACKAGE_MANIFEST_PATH);

  // .claude-plugin/plugin.json (if required)
  if (requiresClaudePlugin(opts.type)) {
    await fs.mkdir(path.join(packagePath, '.claude-plugin'), { recursive: true });
    const pluginManifest = {
      name: opts.name,
      version: '0.0.1',
      description: manifest.description,
    };
    await fs.writeFile(
      path.join(packagePath, CLAUDE_PLUGIN_MANIFEST_PATH),
      JSON.stringify(pluginManifest, null, 2) + '\n',
      'utf-8'
    );
    filesWritten.push(CLAUDE_PLUGIN_MANIFEST_PATH);
  }

  // README.md
  const readme = `# ${opts.name}\n\n${manifest.description}\n\nCreated with \`dorkos package init\`.\n`;
  await fs.writeFile(path.join(packagePath, 'README.md'), readme, 'utf-8');
  filesWritten.push('README.md');

  // Type-specific starter directories
  for (const dir of starterDirsForType(opts.type)) {
    await fs.mkdir(path.join(packagePath, dir), { recursive: true });
  }

  return { packagePath, filesWritten };
}

function defaultLayersForType(type: PackageType): string[] {
  switch (type) {
    case 'plugin':
      return ['skills', 'extensions'];
    case 'skill-pack':
      return ['skills'];
    case 'adapter':
      return ['adapters'];
    case 'agent':
      return ['skills', 'tasks', 'agents'];
  }
}

function starterDirsForType(type: PackageType): string[] {
  switch (type) {
    case 'plugin':
      return ['skills', 'hooks', 'commands'];
    case 'skill-pack':
      return ['skills'];
    case 'adapter':
      return ['.dork/adapters'];
    case 'agent':
      return ['.claude/skills', '.dork/tasks'];
  }
}
```

---

### CLI Commands

The CLI commands extend `packages/cli`. They are thin wrappers over the `@dorkos/marketplace` package.

**`packages/cli/src/commands/package-init.ts`:**

```typescript
import { createPackage } from '@dorkos/marketplace/scaffolder';
import type { PackageType } from '@dorkos/marketplace/package-types';

export interface PackageInitArgs {
  name: string;
  type?: PackageType;
  parentDir?: string;
  description?: string;
  author?: string;
}

/**
 * Implements `dorkos package init <name>`.
 *
 * Creates a new marketplace package in the current directory (or --parent-dir).
 * Defaults type to 'plugin' if not specified.
 */
export async function runPackageInit(args: PackageInitArgs): Promise<void> {
  const result = await createPackage({
    parentDir: args.parentDir ?? process.cwd(),
    name: args.name,
    type: args.type ?? 'plugin',
    description: args.description,
    author: args.author,
  });

  console.log(`Created package at: ${result.packagePath}`);
  console.log('Files written:');
  for (const file of result.filesWritten) {
    console.log(`  - ${file}`);
  }
}
```

**`packages/cli/src/commands/package-validate.ts`:**

```typescript
import path from 'node:path';
import { validatePackage } from '@dorkos/marketplace/package-validator';

export interface PackageValidateArgs {
  packagePath?: string;
}

/**
 * Implements `dorkos package validate [path]`.
 *
 * Validates a marketplace package and prints a structured report.
 * Exits with code 1 if errors are found.
 */
export async function runPackageValidate(args: PackageValidateArgs): Promise<number> {
  const packagePath = path.resolve(args.packagePath ?? process.cwd());
  const result = await validatePackage(packagePath);

  if (result.manifest) {
    console.log(
      `Package: ${result.manifest.name}@${result.manifest.version} (${result.manifest.type})`
    );
  }

  if (result.issues.length === 0) {
    console.log('✓ Package is valid');
    return 0;
  }

  for (const issue of result.issues) {
    const prefix = issue.level === 'error' ? '✗' : '⚠';
    const location = issue.path ? ` (${issue.path})` : '';
    console.log(`${prefix} [${issue.code}] ${issue.message}${location}`);
  }

  if (result.ok) {
    console.log('✓ Package is valid (with warnings)');
    return 0;
  } else {
    console.log('✗ Package validation failed');
    return 1;
  }
}
```

The existing `packages/cli/src/cli.ts` (or equivalent entry point) registers the new subcommands. The exact commander/yargs/clipanion plumbing follows the existing CLI conventions — see `packages/cli/src/` for the established pattern.

---

### ADR-0220 Addendum: Optional `kind` Field

A small change to `@dorkos/skills` and ADR-0220:

**Change to `packages/skills/src/schema.ts`:**

```typescript
/**
 * Optional discriminator for SKILL.md kind. When absent, kind is inferred
 * from frontmatter shape (cron → task) and directory location.
 *
 * Marketplace packages SHOULD specify this explicitly to make the file's
 * intent unambiguous when distributed across installation contexts.
 *
 * Added 2026-04-06 as part of marketplace-01-foundation spec.
 * See ADR-0220 addendum.
 */
export const SkillKindSchema = z.enum(['skill', 'task', 'command']);

export const SkillFrontmatterSchema = z.object({
  // ...existing fields...
  kind: SkillKindSchema.optional(),
});
```

**ADR-0220 addendum** (appended to `decisions/0220-adopt-skill-md-open-standard.md`):

```markdown
## Addendum (2026-04-06): Optional `kind` Field

The marketplace foundation spec (`marketplace-01-foundation`) introduced an
optional `kind` field on `SkillFrontmatterSchema` with values `skill`, `task`,
or `command`. The field is OPTIONAL and existing files continue to work
unchanged.

**Rationale**: When SKILL.md files are distributed in marketplace packages, the
installer needs to know each file's purpose (skill vs task vs command) to
place it in the correct destination directory. Location-based inference works
inside a single installation but breaks at the marketplace boundary, where the
package author chooses arbitrary directory layouts.

**Inference rules** when `kind` is absent:

1. If `cron` field present → `task`
2. If file is under `commands/` or `.claude/commands/` → `command`
3. Otherwise → `skill`

Marketplace package authors SHOULD include `kind` explicitly. User-created
files (not destined for marketplace distribution) MAY omit it.
```

A new ADR is NOT created — this is a small addendum to an existing accepted ADR.

---

### Index Barrel

**`packages/marketplace/src/index.ts`:**

```typescript
/**
 * @dorkos/marketplace — Browser-safe barrel export.
 *
 * Re-exports schemas, types, constants, and the marketplace.json parser
 * (which has no Node.js dependencies). Node.js-only modules must be
 * imported via subpath:
 *
 *   import { validatePackage } from '@dorkos/marketplace/package-validator';
 *   import { createPackage } from '@dorkos/marketplace/scaffolder';
 *   import { scanPackageDirectory } from '@dorkos/marketplace/package-scanner';
 *
 * @module @dorkos/marketplace
 */

// Schemas
export {
  MarketplacePackageManifestSchema,
  type MarketplacePackageManifest,
  type PluginPackageManifest,
  type AgentPackageManifest,
  type SkillPackPackageManifest,
  type AdapterPackageManifest,
} from './manifest-schema.js';

export {
  MarketplaceJsonSchema,
  MarketplaceJsonEntrySchema,
  type MarketplaceJson,
  type MarketplaceJsonEntry,
} from './marketplace-json-schema.js';

// Parser (browser-safe — no fs)
export { parseMarketplaceJson, type ParseMarketplaceResult } from './marketplace-json-parser.js';

// Types & helpers
export { PackageTypeSchema, type PackageType, requiresClaudePlugin } from './package-types.js';

// Constants
export {
  PACKAGE_MANIFEST_FILENAME,
  PACKAGE_MANIFEST_PATH,
  CLAUDE_PLUGIN_MANIFEST_PATH,
  MARKETPLACE_JSON_FILENAME,
  PACKAGE_MANIFEST_VERSION,
} from './constants.js';
```

---

## Implementation Phases

The work is small enough to ship in a single PR, but breaking it into phases helps with parallel work and code review.

### Phase 1 — Package Scaffolding & Schemas

**Goal:** New `@dorkos/marketplace` package compiles, exports schemas, has basic tests.

Tasks:

- Create `packages/marketplace/` directory
- Add `package.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`
- Add to root `pnpm-workspace.yaml` (if not auto-discovered)
- Implement `constants.ts`, `package-types.ts`, `manifest-schema.ts`, `manifest-types.ts`
- Implement `marketplace-json-schema.ts`, `marketplace-json-parser.ts`
- Write `index.ts` barrel
- Write Vitest tests for all schemas (valid + invalid fixtures)
- `pnpm typecheck` and `pnpm test --filter=@dorkos/marketplace` pass

### Phase 2 — `kind` Field Addendum

**Goal:** `@dorkos/skills` accepts optional `kind` field. ADR-0220 documented.

Tasks:

- Add `SkillKindSchema` to `packages/skills/src/schema.ts`
- Add optional `kind` field to `SkillFrontmatterSchema`
- Update tests in `packages/skills/src/__tests__/schema.test.ts` to cover the new field
- Append addendum section to `decisions/0220-adopt-skill-md-open-standard.md`
- All existing tests still pass (the field is purely additive)

### Phase 3 — Validator & Scanner

**Goal:** `validatePackage(path)` and `scanPackageDirectory(path)` work end-to-end against fixtures.

Tasks:

- Implement `package-validator.ts` and `package-scanner.ts`
- Create test fixtures under `packages/marketplace/src/__tests__/fixtures/` for each package type (valid + invalid variants)
- Write Vitest tests covering all error codes
- Verify fixtures match the schema by manually `dorkos package validate`-ing them at the end

### Phase 4 — Scaffolder

**Goal:** `createPackage(opts)` generates a valid package that passes its own validator.

Tasks:

- Implement `scaffolder.ts`
- Write tests that scaffold a package and immediately validate it (round-trip)
- Verify scaffolded packages of every type pass `validatePackage`

### Phase 5 — CLI Subcommands

**Goal:** `dorkos package init` and `dorkos package validate` work from the terminal.

Tasks:

- Add `@dorkos/marketplace` as a dependency of `packages/cli`
- Implement `packages/cli/src/commands/package-init.ts`
- Implement `packages/cli/src/commands/package-validate.ts`
- Wire commands into the existing CLI entry point
- Add CLI tests (use existing CLI test patterns)
- Manual smoke test: `dorkos package init test-plugin --type plugin && dorkos package validate ./test-plugin`

### Phase 6 — Documentation & Polish

Tasks:

- Add a brief `README.md` in `packages/marketplace/` (purpose, exports, usage examples)
- Add JSDoc on all exported functions and types
- Add `contributing/marketplace-packages.md` developer guide stub (full guide lands with spec 02)
- Update root `AGENTS.md` if needed (add `packages/marketplace` to the package list)
- Add a CHANGELOG entry under "Unreleased"

---

## Testing Strategy

### Unit Tests (Vitest)

Each module has its own `*.test.ts` file in `packages/marketplace/src/__tests__/`.

- `manifest-schema.test.ts` — Valid manifests for each `type`. Invalid manifests trigger expected Zod errors. Discriminated union validation. Default value application. Each `requires` declaration format.
- `marketplace-json-schema.test.ts` — Valid Claude Code marketplace.json (no DorkOS fields). Valid DorkOS-extended marketplace.json. Unknown fields preserved by passthrough. Invalid structures rejected.
- `marketplace-json-parser.test.ts` — Round-trip parsing. Malformed JSON. Schema violations. Returns structured error.
- `package-validator.test.ts` — Each error code (`MANIFEST_MISSING`, `MANIFEST_INVALID_JSON`, `MANIFEST_SCHEMA_INVALID`, `CLAUDE_PLUGIN_MISSING`, `SKILL_INVALID`, `NAME_DIRECTORY_MISMATCH`). Valid packages of each type pass. Plugin without `.claude-plugin/` fails. Agent without `.claude-plugin/` passes. Bundled SKILL.md files validated via `@dorkos/skills`.
- `package-scanner.test.ts` — Empty directory. Mixed directory (some packages, some non-packages). Symlinks. Permission errors.
- `scaffolder.test.ts` — Each `type` produces a valid package. Refuses to overwrite. Round-trip: `createPackage` → `validatePackage` succeeds.

### Test Fixtures

Located at `packages/marketplace/src/__tests__/fixtures/`:

- `valid-plugin/` — Complete plugin package with `.claude-plugin/`, skills, hooks
- `valid-agent/` — Complete agent template (no `.claude-plugin/`)
- `valid-skill-pack/` — Skills + tasks only
- `valid-adapter/` — Adapter with `adapterType` field
- `invalid-no-manifest/` — Missing `.dork/manifest.json`
- `invalid-manifest-shape/` — Manifest with wrong field types
- `claude-code-plugin/` — A pure Claude Code plugin (no `.dork/`) — should be marked unsupported by validator (but parser-readable)

### CLI Tests

Located in `packages/cli/__tests__/`:

- `package-init.test.ts` — Creates each package type, verifies file layout, verifies the result passes `validatePackage`
- `package-validate.test.ts` — Runs against fixtures, asserts exit codes and output

### Integration with Existing Test Infrastructure

Add `packages/marketplace` to:

- Root `turbo.json` test pipeline (auto-discovered if pnpm-workspace.yaml is updated)
- ESLint config (extends `@dorkos/eslint-config`)
- TypeScript project references in root `tsconfig.json` (if used)

---

## File Structure / Code Layout

### New files

```
packages/marketplace/
├── package.json
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
├── README.md
├── src/
│   ├── index.ts
│   ├── manifest-schema.ts
│   ├── manifest-types.ts
│   ├── package-types.ts
│   ├── marketplace-json-schema.ts
│   ├── marketplace-json-parser.ts
│   ├── constants.ts
│   ├── slug.ts
│   ├── package-validator.ts
│   ├── package-scanner.ts
│   ├── scaffolder.ts
│   └── __tests__/
│       ├── manifest-schema.test.ts
│       ├── marketplace-json-schema.test.ts
│       ├── marketplace-json-parser.test.ts
│       ├── package-validator.test.ts
│       ├── package-scanner.test.ts
│       ├── scaffolder.test.ts
│       └── fixtures/...

packages/cli/src/commands/
├── package-init.ts
└── package-validate.ts

contributing/
└── marketplace-packages.md            # Stub — full guide in spec 02
```

### Modified files

```
packages/skills/src/schema.ts          # Add optional kind field
packages/skills/src/__tests__/schema.test.ts  # Test kind field

decisions/0220-adopt-skill-md-open-standard.md  # Append addendum

packages/cli/package.json              # Add @dorkos/marketplace dependency
packages/cli/src/cli.ts (or entry)     # Register new subcommands

AGENTS.md                              # Add packages/marketplace to package list
CHANGELOG.md                           # Add unreleased entry
```

### Unchanged

- All existing extensions, tasks, templates, mesh, relay, server, client code
- All other ADRs
- All other specs
- Database schemas, migrations, runtime behavior

---

## Open Questions

All foundational questions were resolved during `/ideate-to-spec` (see ideation document, Section 2). The following are intentionally deferred to later specs and do NOT block this spec:

- Manifest filename → **Resolved:** `.dork/manifest.json`
- `kind` discriminator field → **Resolved:** Optional, with smart inference
- Type field for agent templates → **Resolved:** `agent`
- Marketplace name (Dork Hub vs Dork Index vs ...) → Spec 03 (UI)
- Registry hosting (static vs API) → Spec 04 (registry)
- CC marketplace.json extension tolerance → Spec 02 will test before relying on it
- MCP server authentication → Spec 05
- Telemetry consent → Spec 04
- Personal marketplace privacy → Spec 05

---

## Out of Scope (Intentionally Deferred)

The following are explicitly NOT part of this spec but are tracked for later specs:

| Item                                      | Spec |
| ----------------------------------------- | ---- |
| `dorkos install` CLI                      | 02   |
| Plugin install flow                       | 02   |
| Agent install flow                        | 02   |
| Personal package install flow             | 02   |
| Atomic transactions / rollback            | 02   |
| Permission preview                        | 02   |
| Uninstall + update                        | 02   |
| Local cache                               | 02   |
| Built-in Marketplace Extension UI         | 03   |
| TemplatePicker integration                | 03   |
| `/marketplace` web page                   | 04   |
| `dorkos-community` registry repo          | 04   |
| Seed packages                             | 04   |
| Telemetry                                 | 04   |
| MCP server (`marketplace_search/install`) | 05   |
| `marketplace_create_package` MCP tool     | 05+  |
| Personal marketplace publishing           | 05+  |

---

## Acceptance Criteria

This spec is complete when:

- [ ] `packages/marketplace/` exists with the structure described above
- [ ] `pnpm typecheck` passes across the workspace
- [ ] `pnpm test --filter=@dorkos/marketplace` passes with full coverage of schemas, parser, validator, scanner, and scaffolder
- [ ] `pnpm lint --filter=@dorkos/marketplace` passes
- [ ] `pnpm build --filter=@dorkos/marketplace` produces the `dist/` output
- [ ] `dorkos package init test-plugin --type plugin` creates a valid package directory
- [ ] `dorkos package validate ./test-plugin` reports the package as valid
- [ ] `dorkos package init test-agent --type agent` creates a valid agent template
- [ ] `dorkos package validate ./test-agent` reports the agent as valid (no `.claude-plugin/` warning)
- [ ] `@dorkos/skills` `SkillFrontmatterSchema` accepts an optional `kind` field; existing tests still pass
- [ ] ADR-0220 has the addendum documenting the `kind` field
- [ ] `packages/marketplace/README.md` describes purpose, exports, and basic usage
- [ ] `AGENTS.md` lists `packages/marketplace`
- [ ] `CHANGELOG.md` has an entry under "Unreleased"
- [ ] No changes to runtime behavior of existing extensions, tasks, templates, mesh, relay, server, or client
- [ ] No new external runtime dependencies

---

## Risks & Mitigations

| Risk                                                                | Severity | Mitigation                                                                                                                                     |
| ------------------------------------------------------------------- | :------: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema design too restrictive — blocks valid use cases later        |  Medium  | Use `passthrough()` on marketplace.json. Use discriminated union for manifest. Schemas can be extended additively in later specs.              |
| `kind` field addition breaks existing SKILL.md files                |   Low    | Field is optional, all existing files validate unchanged. Tests verify backward compatibility.                                                 |
| Validator over-strict, refuses real-world packages                  |  Medium  | Distinguish errors from warnings. Most checks should warn, only structural breakage errors.                                                    |
| `@dorkos/marketplace` dependency cycle with `@dorkos/skills`        |   Low    | Marketplace depends on skills, never vice versa. Verify with `pnpm ls --filter=@dorkos/skills` after adding the dep.                           |
| Scaffolder overwrites user files                                    |   High   | Refuses to write into existing directories. Tested explicitly.                                                                                 |
| Marketplace.json parser too lenient, accepts garbage                |   Low    | Standard CC fields are strictly typed. DorkOS extension fields are optional but typed when present. Tests cover malformed inputs.              |
| Hypothesis about CC ignoring unknown fields turns out false         |  Medium  | Spec 02 will test before relying on it. If false, fall back to companion `dorkos-catalog.json` (parser already supports both via passthrough). |
| ADR-0220 addendum is too small to warrant changing the existing ADR |   Low    | The change is genuinely small (one optional field). An addendum is the right call. If reviewers disagree, promote to ADR-0221.                 |

---

## Success Metrics

Quantitative:

- 100% test coverage on `packages/marketplace/src/` (excluding type-only files)
- 0 new external runtime dependencies introduced
- 0 breaking changes to existing schemas or APIs
- `pnpm test` runs in < 10 seconds (the package is small)

Qualitative:

- A new contributor can run `dorkos package init my-thing` and have a valid starter
- A new contributor can read `packages/marketplace/src/manifest-schema.ts` and understand the package format in < 5 minutes
- Spec 02 author can begin work immediately without waiting on schema clarifications
- The package is "boring" — no surprises, follows existing patterns

---

## Changelog

### 2026-04-06 — Initial specification

Created from `/ideate-to-spec specs/dorkos-marketplace/01-ideation.md`.

Foundational decisions resolved:

1. Manifest filename: `.dork/manifest.json`
2. `kind` field: Optional, with smart inference (ADR-0220 addendum)
3. Agent type value: `agent`

This is spec 1 of 5 for the DorkOS Marketplace project. Subsequent specs:

- `marketplace-02-install` — Install CLI and flows
- `marketplace-03-extension` — Built-in Marketplace Extension UI
- `marketplace-04-web-and-registry` — Web page + dorkos-community registry
- `marketplace-05-agent-installer` — MCP server and agent-driven install

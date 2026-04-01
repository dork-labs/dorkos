---
slug: skills-package
number: 212
created: 2026-03-31
status: specified
---

# Skills Package — Technical Specification

**Slug:** skills-package
**Author:** Claude Code
**Date:** 2026-03-31
**Linear issue:** —
**Depends on:** —
**Depended on by:** tasks-system-redesign (#211)

---

## Overview

This specification defines `packages/skills/` (`@dorkos/skills`) — a shared package that implements the [Agent Skills open standard](https://agentskills.io/specification) (SKILL.md format) as the foundation for DorkOS task definitions, slash command definitions, and skill definitions.

The package provides:

- **Zod schemas** for the SKILL.md base format and DorkOS supersets (tasks, commands)
- **File I/O** — generic parser, atomic writer, directory scanner
- **Utilities** — slug validation/generation, duration parsing, humanization
- **Type definitions** — `SkillDefinition`, `TaskDefinition`, `CommandDefinition`
- **Constants** — directory conventions, file naming

Tasks, commands, and skills share the same underlying file format (markdown with YAML frontmatter in a named directory). This package is the single implementation of that format. Domain-specific behavior (scheduling, invocation, activation) remains in their respective services.

### Why

Three systems in DorkOS parse markdown+frontmatter files independently:

| System   | Parser                                                     | Schema                  | Validated? |
| -------- | ---------------------------------------------------------- | ----------------------- | ---------- |
| Tasks    | `task-file-parser.ts` (Zod + gray-matter)                  | `TaskFrontmatterSchema` | Yes        |
| Commands | `command-registry.ts` (gray-matter + hand-rolled fallback) | Ad-hoc field extraction | No         |
| Skills   | (none)                                                     | —                       | —          |

The industry is converging on the SKILL.md format (adopted by 30+ tools: Claude Code, Cursor, GitHub Copilot, Gemini CLI, etc.). By building on this standard, DorkOS task and command files become portable across tools and shareable across installations.

### Source Documents

- `research/20260329_skills_sh_marketplace_format_specification.md` — SKILL.md format and skills.sh ecosystem
- `research/20260328_claude_code_skills_deep_dive.md` — Claude Code's SKILL.md implementation
- `research/20260315_slash_command_storage_formats_competitive.md` — Competitive analysis of command formats
- `decisions/0043-file-canonical-source-of-truth-for-mesh-registry.md` — File-first architecture precedent
- `specs/tasks-system-redesign/02-specification.md` — Task system context (this spec is a dependency)

---

## Background / Problem Statement

DorkOS manages three types of agent instruction files:

1. **Tasks** — scheduled or on-demand work for agents (`.dork/tasks/`)
2. **Slash commands** — user-invoked agent actions (`.claude/commands/`)
3. **Skills** — reusable agent capabilities (`.claude/skills/`)

All three share the same fundamental shape: a markdown file with YAML frontmatter containing metadata, plus a body containing instructions. Yet each has its own parser, its own schema, and its own validation approach. The command parser even has a hand-rolled YAML fallback for when gray-matter fails.

The Agent Skills open standard (`agentskills.io`) defines a universal format for these files. Claude Code already implements it. By adopting this standard as our base and extending it for tasks and commands, we:

- Eliminate three separate parsers in favor of one
- Get portability — a task file created in DorkOS works as a skill in Claude Code
- Get the directory structure (`scripts/`, `references/`, `assets/`) for free
- Align with 30+ tools in the ecosystem

---

## Goals

- Implement a `packages/skills/` package conforming to the agentskills.io SKILL.md specification
- Define `SkillFrontmatterSchema` as the base schema with all required and optional fields from the spec
- Define `TaskFrontmatterSchema` and `CommandFrontmatterSchema` as supersets of the base
- Provide a generic, schema-parameterized parser that works with any extending schema
- Provide an atomic file writer using the temp+rename pattern
- Provide a directory scanner for batch discovery
- Provide slug utilities (validate, slugify, humanize) and duration utilities (parse, format)
- Enforce the directory format: `{name}/SKILL.md` (not flat `.md` files)
- Ensure task files are portable — no installation-specific fields (agent ID, CWD) in the file
- Match Claude Code's level of SKILL.md compliance

---

## Non-Goals

- **Domain-specific behavior** — scheduling, dispatch, run history, command invocation, skill activation logic. These stay in their respective services.
- **File watching** — chokidar-based watchers remain in the server (heavy dependency, lifecycle management). The skills package provides the parser they call.
- **Reconciliation** — DB sync logic remains in the server. The skills package provides the scanner the reconciler uses.
- **Template seeding** — first-run template creation remains in the server. The skills package provides the writer it calls.
- **UI components** — no React code in this package.
- **Marketplace/distribution** — installing skills from remote sources is future work.
- **`kind` discriminator field** — deferred. Location-based type inference is sufficient for now.

---

## Technical Dependencies

| Dependency                  | Version                            | Purpose                         |
| --------------------------- | ---------------------------------- | ------------------------------- |
| `zod`                       | `^3.24` (workspace)                | Schema validation               |
| `gray-matter`               | `^4.0.3` (already in server + CLI) | YAML frontmatter parsing        |
| `@dorkos/typescript-config` | `workspace:*`                      | Shared TypeScript configuration |

No new external dependencies are introduced. Both `zod` and `gray-matter` are already in the dependency tree.

---

## Detailed Design

### Package Structure

```
packages/skills/
├── package.json
├── tsconfig.json
├── src/
│   ├── schema.ts            # Base SkillFrontmatterSchema (SKILL.md spec)
│   ├── task-schema.ts       # TaskFrontmatterSchema extends base
│   ├── command-schema.ts    # CommandFrontmatterSchema extends base
│   ├── types.ts             # SkillDefinition, TaskDefinition, CommandDefinition, ParseResult
│   ├── constants.ts         # SKILL_FILENAME, SKILL_SUBDIRS, path helpers
│   ├── slug.ts              # validateSlug, slugify, humanize
│   ├── duration.ts          # DurationSchema, parseDuration, formatDuration
│   ├── parser.ts            # parseSkillFile<T> (Node.js, gray-matter + Zod)
│   ├── writer.ts            # writeSkillFile, deleteSkillDir (Node.js, atomic)
│   ├── scanner.ts           # scanSkillDirectory<T> (Node.js, fs)
│   ├── validator.ts         # validateSkillStructure (Node.js, structural checks)
│   ├── index.ts             # Barrel re-export of browser-safe modules
│   └── __tests__/
│       ├── schema.test.ts
│       ├── task-schema.test.ts
│       ├── command-schema.test.ts
│       ├── slug.test.ts
│       ├── duration.test.ts
│       ├── parser.test.ts
│       ├── writer.test.ts
│       ├── scanner.test.ts
│       └── validator.test.ts
```

### Package Configuration

**`package.json`:**

```json
{
  "name": "@dorkos/skills",
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
    "./schema": {
      "types": "./src/schema.ts",
      "default": "./dist/schema.js"
    },
    "./task-schema": {
      "types": "./src/task-schema.ts",
      "default": "./dist/task-schema.js"
    },
    "./command-schema": {
      "types": "./src/command-schema.ts",
      "default": "./dist/command-schema.js"
    },
    "./types": {
      "types": "./src/types.ts",
      "default": "./dist/types.js"
    },
    "./constants": {
      "types": "./src/constants.ts",
      "default": "./dist/constants.js"
    },
    "./slug": {
      "types": "./src/slug.ts",
      "default": "./dist/slug.js"
    },
    "./duration": {
      "types": "./src/duration.ts",
      "default": "./dist/duration.js"
    },
    "./parser": {
      "types": "./src/parser.ts",
      "default": "./dist/parser.js"
    },
    "./writer": {
      "types": "./src/writer.ts",
      "default": "./dist/writer.js"
    },
    "./scanner": {
      "types": "./src/scanner.ts",
      "default": "./dist/scanner.js"
    },
    "./validator": {
      "types": "./src/validator.ts",
      "default": "./dist/validator.js"
    }
  },
  "dependencies": {
    "gray-matter": "^4.0.3",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@dorkos/eslint-config": "workspace:*",
    "@dorkos/typescript-config": "workspace:*",
    "vitest": "^3.1.1"
  }
}
```

**`tsconfig.json`:**

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

### Subpath Export Categories

| Export             | Browser-safe?    | Dependencies           | Purpose                         |
| ------------------ | ---------------- | ---------------------- | ------------------------------- |
| `./schema`         | Yes              | zod                    | Base + extension Zod schemas    |
| `./task-schema`    | Yes              | zod, ./schema          | Task frontmatter schema         |
| `./command-schema` | Yes              | zod, ./schema          | Command frontmatter schema      |
| `./types`          | Yes              | zod                    | TypeScript types and interfaces |
| `./constants`      | Yes              | none                   | File naming conventions         |
| `./slug`           | Yes              | none                   | Slug validation and generation  |
| `./duration`       | Yes              | zod                    | Duration string parsing         |
| `./parser`         | **No** (Node.js) | gray-matter, zod, path | File parsing                    |
| `./writer`         | **No** (Node.js) | fs, path, crypto       | Atomic file writing             |
| `./scanner`        | **No** (Node.js) | fs, path, ./parser     | Directory scanning              |
| `./validator`      | **No** (Node.js) | fs, path               | Structural validation           |

The client (`apps/client/`) imports only browser-safe subpaths. The server, CLI, and Obsidian plugin can import any subpath.

---

### Schema Design

#### Base Schema: `schema.ts`

Conforms exactly to the [agentskills.io specification](https://agentskills.io/specification):

```typescript
import { z } from 'zod';

/**
 * SKILL.md name field validation.
 *
 * Per the agentskills.io spec:
 * - 1-64 characters
 * - Lowercase alphanumeric and hyphens only
 * - Must not start or end with a hyphen
 * - Must not contain consecutive hyphens
 * - Must match the parent directory name (enforced at parse time, not in schema)
 */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'Must be lowercase alphanumeric with hyphens, not starting/ending with hyphen'
  )
  .refine((s) => !s.includes('--'), 'Must not contain consecutive hyphens');

/**
 * Base SKILL.md frontmatter schema.
 *
 * Conforms to the agentskills.io open standard. All DorkOS-specific
 * schemas (tasks, commands) extend this base.
 *
 * @see https://agentskills.io/specification#skill-md-format
 */
export const SkillFrontmatterSchema = z.object({
  /** Kebab-case identifier. Must match the parent directory name. */
  name: SkillNameSchema,

  /** What the skill does and when to use it. 1-1024 characters. */
  description: z.string().min(1).max(1024),

  /** License name or reference to a bundled license file. */
  license: z.string().optional(),

  /** Environment requirements (intended product, system packages, network access). */
  compatibility: z.string().max(500).optional(),

  /** Arbitrary key-value metadata for client-specific extensions. */
  metadata: z.record(z.string(), z.string()).optional(),

  /** Space-delimited list of pre-approved tools. */
  'allowed-tools': z.string().optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;
```

#### Task Schema: `task-schema.ts`

Extends the base with scheduling and execution fields:

```typescript
import { z } from 'zod';
import { SkillFrontmatterSchema } from './schema.js';
import { DurationSchema } from './duration.js';

/**
 * Task frontmatter schema — a superset of the SKILL.md base.
 *
 * Adds scheduling, execution constraints, and display customization.
 * Fields that depend on installation context (agentId, cwd) are
 * intentionally excluded — they are derived from the file's location
 * on disk and stored in the DB only.
 */
export const TaskFrontmatterSchema = SkillFrontmatterSchema.extend({
  /** Human-readable display name. Falls back to humanized `name` if absent. */
  'display-name': z.string().optional(),

  /** Cron expression for scheduling. Absent means on-demand only. */
  cron: z.string().optional(),

  /** IANA timezone for cron evaluation. */
  timezone: z.string().default('UTC'),

  /** Whether the task is active. Disabled tasks are not scheduled. */
  enabled: z.boolean().default(true),

  /** Maximum execution time. Duration string: "5m", "1h", "30s", "2h30m". */
  'max-runtime': DurationSchema.optional(),

  /**
   * Agent permission mode during task execution.
   * - `acceptEdits`: agent can edit files with approval
   * - `bypassPermissions`: agent runs without approval gates
   */
  permissions: z.enum(['acceptEdits', 'bypassPermissions']).default('acceptEdits'),
});

export type TaskFrontmatter = z.infer<typeof TaskFrontmatterSchema>;
```

**Fields explicitly excluded from the file** (derived from location, stored in DB):

| Field     | Derivation                                                         | Rationale                                                                |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `agentId` | Which `.dork/tasks/` directory the file lives in → MeshCore lookup | Portability — file can be copied between projects                        |
| `cwd`     | The project root containing the `.dork/tasks/` directory           | Portability — no absolute paths in the file                              |
| `status`  | Runtime state (`active`, `paused`, `pending_approval`)             | Not a definition property                                                |
| `tags`    | Removed entirely                                                   | SKILL.md doesn't have tags; filtering by agent/status/type is sufficient |

#### Command Schema: `command-schema.ts`

Extends the base with Claude Code's slash command fields:

```typescript
import { z } from 'zod';
import { SkillFrontmatterSchema } from './schema.js';

/**
 * Command frontmatter schema — a superset of the SKILL.md base.
 *
 * Aligns with Claude Code's slash command extensions on top of the
 * agentskills.io base spec.
 */
export const CommandFrontmatterSchema = SkillFrontmatterSchema.extend({
  /** Parameter hint shown in autocomplete (e.g., "[issue-number]"). */
  'argument-hint': z.string().optional(),

  /** Prevent automatic loading by the model. Use for explicit-only commands. */
  'disable-model-invocation': z.boolean().optional(),

  /** Whether this command appears in the `/` menu. Default: true. */
  'user-invocable': z.boolean().default(true),

  /** Execution context. "fork" runs in an isolated subagent. */
  context: z.enum(['fork']).optional(),

  /** Subagent type when context is "fork". */
  agent: z.string().optional(),

  /** Model override for this command's execution. */
  model: z.string().optional(),

  /** Effort level override. */
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
});

export type CommandFrontmatter = z.infer<typeof CommandFrontmatterSchema>;
```

---

### Types: `types.ts`

```typescript
import type { SkillFrontmatter } from './schema.js';
import type { TaskFrontmatter } from './task-schema.js';
import type { CommandFrontmatter } from './command-schema.js';

/** Discriminated parse result. */
export type ParseResult<T> =
  | { ok: true; definition: T }
  | { ok: false; error: string; filePath: string };

/** Base parsed skill definition. */
export interface SkillDefinition {
  /** Kebab-case identifier (matches directory name). */
  name: string;
  /** Validated frontmatter. */
  meta: SkillFrontmatter;
  /** Markdown body — the agent instructions. */
  body: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** Absolute path to the skill directory (parent of SKILL.md). */
  dirPath: string;
}

/** Parsed task definition with location-derived context. */
export interface TaskDefinition extends Omit<SkillDefinition, 'meta'> {
  meta: TaskFrontmatter;
  /** Whether the task comes from a project or global tasks directory. */
  scope: 'project' | 'global';
  /** Absolute path to the project root (present for project-scoped tasks). */
  projectPath?: string;
}

/** Parsed command definition with invocation metadata. */
export interface CommandDefinition extends Omit<SkillDefinition, 'meta'> {
  meta: CommandFrontmatter;
  /** Namespace prefix (from subdirectory name, if any). */
  namespace?: string;
  /** Full invocation string (e.g., "/frontend:deploy" or "/commit"). */
  fullCommand: string;
}
```

---

### Constants: `constants.ts`

```typescript
/** Required filename inside every skill directory. */
export const SKILL_FILENAME = 'SKILL.md' as const;

/** Standard subdirectory names per the agentskills.io spec. */
export const SKILL_SUBDIRS = ['scripts', 'references', 'assets'] as const;

/**
 * Build the path to a SKILL.md file inside a parent directory.
 *
 * @param parentDir - The directory containing skill subdirectories
 * @param name - The skill's kebab-case name (directory name)
 * @returns Absolute path like `{parentDir}/{name}/SKILL.md`
 */
export function skillFilePath(parentDir: string, name: string): string {
  return `${parentDir}/${name}/${SKILL_FILENAME}`;
}

/**
 * Build the path to a skill's directory.
 *
 * @param parentDir - The directory containing skill subdirectories
 * @param name - The skill's kebab-case name
 * @returns Absolute path like `{parentDir}/{name}/`
 */
export function skillDirPath(parentDir: string, name: string): string {
  return `${parentDir}/${name}`;
}
```

---

### Slug Utilities: `slug.ts`

```typescript
/**
 * Validate a string against SKILL.md naming rules.
 *
 * Rules: 1-64 chars, lowercase alphanumeric + hyphens, no leading/trailing
 * hyphens, no consecutive hyphens.
 *
 * @param s - The string to validate
 * @returns True if valid as a SKILL.md name
 */
export function validateSlug(s: string): boolean {
  if (s.length < 1 || s.length > 64) return false;
  if (s.includes('--')) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s);
}

/**
 * Convert a display name to a valid SKILL.md slug.
 *
 * @param displayName - Human-readable name (e.g., "Daily Health Check")
 * @returns Kebab-case slug (e.g., "daily-health-check")
 */
export function slugify(displayName: string): string {
  return displayName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}

/**
 * Convert a kebab-case slug to a human-readable title.
 *
 * @param slug - Kebab-case identifier (e.g., "daily-health-check")
 * @returns Title-cased string (e.g., "Daily Health Check")
 */
export function humanize(slug: string): string {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
```

---

### Duration Utilities: `duration.ts`

```typescript
import { z } from 'zod';

/** Duration string pattern: "5m", "1h", "30s", "2h30m", "1h15m30s". */
export const DurationSchema = z
  .string()
  .regex(/^(\d+h)?(\d+m)?(\d+s)?$/, 'Duration must be like "5m", "1h", "30s", or "2h30m"')
  .refine((v) => v.length > 0, 'Duration must not be empty');

/**
 * Parse a duration string to milliseconds.
 *
 * @param duration - Duration string matching DurationSchema (e.g., "2h30m")
 * @returns Duration in milliseconds
 */
export function parseDuration(duration: string): number {
  let ms = 0;
  const hours = duration.match(/(\d+)h/);
  const minutes = duration.match(/(\d+)m/);
  const seconds = duration.match(/(\d+)s/);
  if (hours) ms += parseInt(hours[1], 10) * 3_600_000;
  if (minutes) ms += parseInt(minutes[1], 10) * 60_000;
  if (seconds) ms += parseInt(seconds[1], 10) * 1_000;
  return ms;
}

/**
 * Format milliseconds as a human-readable duration string.
 *
 * @param ms - Duration in milliseconds
 * @returns Duration string (e.g., "2h30m")
 */
export function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join('') || '0s';
}
```

---

### Parser: `parser.ts`

Generic, schema-parameterized parser using gray-matter:

```typescript
import matter from 'gray-matter';
import path from 'node:path';
import type { z } from 'zod';
import { SKILL_FILENAME } from './constants.js';
import type { ParseResult } from './types.js';

/** The parsed output from a SKILL.md file. */
interface ParsedSkill<T> {
  /** Kebab-case name (from directory name). */
  name: string;
  /** Validated frontmatter. */
  meta: T;
  /** Markdown body content. */
  body: string;
  /** Absolute path to the SKILL.md file. */
  filePath: string;
  /** Absolute path to the skill directory. */
  dirPath: string;
}

/**
 * Parse a SKILL.md file and validate its frontmatter against a Zod schema.
 *
 * Validates that:
 * 1. The file is named SKILL.md
 * 2. Frontmatter passes the provided schema
 * 3. The `name` field in frontmatter matches the parent directory name
 *
 * @param filePath - Absolute path to the SKILL.md file
 * @param content - Raw file content (UTF-8)
 * @param schema - Zod schema to validate frontmatter against
 * @returns ParseResult with the validated definition or an error
 */
export function parseSkillFile<T>(
  filePath: string,
  content: string,
  schema: z.ZodSchema<T>
): ParseResult<ParsedSkill<T>> {
  // Validate filename
  const filename = path.basename(filePath);
  if (filename !== SKILL_FILENAME) {
    return {
      ok: false,
      error: `Expected filename "${SKILL_FILENAME}", got "${filename}"`,
      filePath,
    };
  }

  // Parse frontmatter
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(content);
    data = parsed.data;
    body = parsed.content.trim();
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse frontmatter: ${(err as Error).message}`,
      filePath,
    };
  }

  // Validate with schema
  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      ok: false,
      error: `Invalid frontmatter: ${result.error.message}`,
      filePath,
    };
  }

  // Derive name from parent directory
  const dirPath = path.dirname(filePath);
  const dirName = path.basename(dirPath);

  // Validate name matches directory
  const meta = result.data as T & { name?: string };
  if (meta.name && meta.name !== dirName) {
    return {
      ok: false,
      error: `Frontmatter name "${meta.name}" does not match directory name "${dirName}"`,
      filePath,
    };
  }

  return {
    ok: true,
    definition: {
      name: dirName,
      meta: result.data,
      body,
      filePath,
      dirPath,
    },
  };
}
```

---

### Writer: `writer.ts`

Atomic file writer using the temp+rename pattern:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';
import { SKILL_FILENAME } from './constants.js';

/**
 * Write a SKILL.md file atomically inside a named directory.
 *
 * Creates the directory structure `{parentDir}/{name}/SKILL.md`.
 * Uses temp file + rename to prevent corruption on crash.
 *
 * @param parentDir - The directory containing skill subdirectories
 * @param name - Kebab-case skill name (becomes the directory name)
 * @param frontmatter - YAML frontmatter fields
 * @param body - Markdown body content (agent instructions / prompt)
 * @returns Absolute path to the written SKILL.md file
 */
export async function writeSkillFile(
  parentDir: string,
  name: string,
  frontmatter: Record<string, unknown>,
  body: string
): Promise<string> {
  const skillDir = path.join(parentDir, name);
  await fs.mkdir(skillDir, { recursive: true });

  const content = matter.stringify(body, frontmatter);
  const targetPath = path.join(skillDir, SKILL_FILENAME);
  const tempPath = path.join(skillDir, `.skill-${randomUUID()}.tmp`);

  await fs.writeFile(tempPath, content, 'utf-8');
  await fs.rename(tempPath, targetPath);

  return targetPath;
}

/**
 * Delete a skill directory and all its contents.
 *
 * @param parentDir - The directory containing skill subdirectories
 * @param name - Kebab-case skill name (the directory to remove)
 */
export async function deleteSkillDir(parentDir: string, name: string): Promise<void> {
  const skillDir = path.join(parentDir, name);
  await fs.rm(skillDir, { recursive: true, force: true });
}
```

---

### Scanner: `scanner.ts`

Scans a parent directory for all valid skill subdirectories:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import type { z } from 'zod';
import { SKILL_FILENAME } from './constants.js';
import { parseSkillFile } from './parser.js';
import type { ParseResult } from './types.js';

/** The parsed output shape from parseSkillFile. */
interface ParsedSkill<T> {
  name: string;
  meta: T;
  body: string;
  filePath: string;
  dirPath: string;
}

/**
 * Scan a directory for skill subdirectories and parse each SKILL.md.
 *
 * Looks for subdirectories containing a SKILL.md file. Ignores
 * non-directory entries, dotfiles, and directories without SKILL.md.
 *
 * @param dir - Parent directory to scan (e.g., `.dork/tasks/`)
 * @param schema - Zod schema to validate frontmatter
 * @returns Array of parse results (both successes and failures)
 */
export async function scanSkillDirectory<T>(
  dir: string,
  schema: z.ZodSchema<T>
): Promise<ParseResult<ParsedSkill<T>>[]> {
  const results: ParseResult<ParsedSkill<T>>[] = [];

  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist — return empty, not an error
    return results;
  }

  for (const entry of entries) {
    // Skip non-directories and dotfiles
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const skillPath = path.join(dir, entry.name, SKILL_FILENAME);

    let content: string;
    try {
      content = await fs.readFile(skillPath, 'utf-8');
    } catch {
      // No SKILL.md in this directory — skip silently
      continue;
    }

    results.push(parseSkillFile(filePath, content, schema));
  }

  return results;
}
```

Note: The `filePath` variable in the for loop should be `skillPath`. This will be corrected during implementation.

---

### Validator: `validator.ts`

Structural validation beyond schema:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { SKILL_FILENAME } from './constants.js';
import { validateSlug } from './slug.js';

/** Validation result with categorized issues. */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate the structural integrity of a skill directory.
 *
 * Checks:
 * 1. Directory name is a valid slug
 * 2. SKILL.md file exists
 * 3. No unexpected files at the root level (warning only)
 *
 * @param dirPath - Absolute path to the skill directory
 * @returns Validation result with errors and warnings
 */
export async function validateSkillStructure(dirPath: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check directory name is a valid slug
  const dirName = path.basename(dirPath);
  if (!validateSlug(dirName)) {
    errors.push(
      `Directory name "${dirName}" is not a valid SKILL.md name (must be kebab-case, 1-64 chars)`
    );
  }

  // Check SKILL.md exists
  const skillPath = path.join(dirPath, SKILL_FILENAME);
  try {
    await fs.access(skillPath);
  } catch {
    errors.push(`Missing ${SKILL_FILENAME} file`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
```

---

## Data Flow

### Task creation (after this package + task system migration):

```
User fills CreateTaskDialog form
  → Client generates slug via slugify() from @dorkos/skills/slug
  → Client sends POST /api/tasks with { name, displayName, description, prompt, target, ... }
    → Server resolves target to directory path:
        target="global" → {dorkHome}/tasks/
        target=agentId  → {projectPath}/.dork/tasks/
    → Server calls writeSkillFile(targetDir, name, frontmatter, prompt) from @dorkos/skills/writer
        → Creates {targetDir}/{name}/SKILL.md atomically
    → Server calls store.upsertFromFile() for immediate DB consistency
        → Derives agentId + cwd from directory location
    → Server registers with scheduler if cron present
    → Returns 201 with created task
```

### File edit detected (watcher path):

```
User edits {projectPath}/.dork/tasks/daily-check/SKILL.md
  → Chokidar detects change (50ms stability)
  → Watcher reads file content
  → Calls parseSkillFile(path, content, TaskFrontmatterSchema) from @dorkos/skills/parser
  → On success: calls store.upsertFromFile(definition, derivedAgentId, derivedCwd)
  → Scheduler re-registers cron if changed
```

### Reconciliation (5-minute sweep):

```
Reconciler timer fires
  → Calls scanSkillDirectory(globalTasksDir, TaskFrontmatterSchema) from @dorkos/skills/scanner
  → For each registered agent: scanSkillDirectory(projectTasksDir, TaskFrontmatterSchema)
  → Compares scan results to DB state
  → Upserts new/changed definitions
  → Marks missing definitions as paused (24h grace)
```

---

## Testing Strategy

### Unit Tests

Every module gets its own test file. Tests use Vitest.

**`schema.test.ts`** — Schema validation:

- Valid base frontmatter (minimal: name + description)
- Valid base frontmatter (all optional fields)
- Rejects missing `name`
- Rejects missing `description`
- Rejects `name` with uppercase
- Rejects `name` with consecutive hyphens
- Rejects `name` starting/ending with hyphen
- Rejects `name` longer than 64 chars
- Rejects `description` longer than 1024 chars
- Accepts valid `metadata` map
- Rejects non-string `metadata` values

**`task-schema.test.ts`** — Task extension:

- Accepts all base fields plus task fields
- Applies defaults (timezone=UTC, enabled=true, permissions=acceptEdits)
- Accepts `display-name` field
- Accepts valid `cron` expression
- Accepts `max-runtime` duration string
- Rejects invalid `permissions` value
- Verifies base schema fields are still validated

**`command-schema.test.ts`** — Command extension:

- Accepts all base fields plus command fields
- Applies defaults (user-invocable=true)
- Accepts `argument-hint`
- Accepts `disable-model-invocation`
- Accepts `context: "fork"` with `agent`
- Accepts `effort` values
- Rejects invalid `effort` value

**`slug.test.ts`** — Slug utilities:

- `validateSlug`: valid slugs, empty string, too long, uppercase, leading hyphen, trailing hyphen, consecutive hyphens, special characters
- `slugify`: basic conversion, special characters stripped, whitespace handling, max length truncation, leading/trailing cleanup
- `humanize`: basic conversion, single word, multiple hyphens, round-trip with slugify

**`duration.test.ts`** — Duration utilities:

- `parseDuration`: minutes only, hours only, seconds only, combined, zero values
- `formatDuration`: round-trip with parseDuration, zero ms, large values
- `DurationSchema`: valid strings, invalid strings, empty string

**`parser.test.ts`** — File parsing:

- Parses valid SKILL.md with base schema
- Parses valid SKILL.md with task schema
- Returns error for wrong filename (not SKILL.md)
- Returns error for invalid frontmatter
- Returns error for name/directory mismatch
- Handles empty body gracefully
- Handles malformed YAML

**`writer.test.ts`** — File writing:

- Creates directory structure
- Writes valid SKILL.md content
- Overwrites existing file
- Atomic write (no partial files on crash simulation)
- `deleteSkillDir` removes directory and contents

**`scanner.test.ts`** — Directory scanning:

- Scans directory with multiple valid skills
- Skips dotfile directories
- Skips directories without SKILL.md
- Returns empty array for non-existent directory
- Includes both successes and failures in results
- Handles mixed valid/invalid entries

**`validator.test.ts`** — Structural validation:

- Valid structure passes
- Missing SKILL.md fails
- Invalid directory name fails

### Test Fixtures

Create a `src/__tests__/fixtures/` directory with sample SKILL.md files for different test scenarios:

```
src/__tests__/fixtures/
├── valid-skill/
│   └── SKILL.md          # Minimal valid skill
├── valid-task/
│   └── SKILL.md          # Valid task with all fields
├── invalid-name/
│   └── SKILL.md          # Name doesn't match directory
├── missing-description/
│   └── SKILL.md          # Missing required description
└── malformed-yaml/
    └── SKILL.md          # Broken YAML frontmatter
```

Alternatively, create content strings inline in tests for simplicity and co-location. Use fixtures only if the content is shared across multiple test files.

---

## Performance Considerations

- **Schema compilation**: Zod schemas are compiled once at import time. No per-parse overhead.
- **Scanner parallelism**: The scanner reads files sequentially within a directory. For directories with many skills (50+), consider adding a concurrency parameter. Not needed for MVP.
- **Writer atomicity**: The temp+rename pattern adds one extra filesystem operation per write. This is negligible and prevents data corruption.
- **gray-matter parsing**: Adds ~1ms per file. Acceptable for our scale (dozens of tasks, not thousands).

---

## Security Considerations

- **Path traversal**: The parser derives the name from `path.basename()`, never from user-provided frontmatter for filesystem operations. The `name` field is validated against the directory name, not used to construct paths.
- **YAML injection**: gray-matter parses YAML safely. No `eval()` or dynamic code execution.
- **File permissions**: The writer creates files with the process's default umask. Task files may contain sensitive agent prompts — the `.dork/` directory should have appropriate permissions (addressed at the directory level, not per-file).
- **Symlink attacks**: The scanner follows symlinks by default (via `fs.readdir`). This is acceptable — `.dork/tasks/` is a trusted directory. If future security hardening is needed, add a `followSymlinks: false` option.

---

## Documentation

- **CLAUDE.md** — add `packages/skills/` to the monorepo structure section with description
- **ADR** — create "Adopt SKILL.md Open Standard for Task and Command Definitions" (deferred to the follow-up implementation prompt)
- **TSDoc** — all exported functions and types include TSDoc comments (enforced by existing `eslint-plugin-jsdoc`)

---

## Implementation Phases

### Phase 1: Core schemas and utilities (no I/O)

Create the package scaffolding and implement all browser-safe modules:

1. Create `packages/skills/` directory with `package.json`, `tsconfig.json`
2. Implement `schema.ts` — `SkillFrontmatterSchema`, `SkillNameSchema`
3. Implement `task-schema.ts` — `TaskFrontmatterSchema`
4. Implement `command-schema.ts` — `CommandFrontmatterSchema`
5. Implement `types.ts` — `SkillDefinition`, `TaskDefinition`, `CommandDefinition`, `ParseResult`
6. Implement `constants.ts` — `SKILL_FILENAME`, `SKILL_SUBDIRS`, path helpers
7. Implement `slug.ts` — `validateSlug`, `slugify`, `humanize`
8. Implement `duration.ts` — `DurationSchema`, `parseDuration`, `formatDuration`
9. Implement `index.ts` — barrel re-export of browser-safe modules
10. Write tests for all above modules
11. Wire into turbo.json, add as dependency to consuming packages
12. **Gate:** `pnpm typecheck && pnpm build && pnpm test -- --run`

### Phase 2: File I/O modules

Implement all Node.js-only modules:

1. Implement `parser.ts` — `parseSkillFile<T>`
2. Implement `writer.ts` — `writeSkillFile`, `deleteSkillDir`
3. Implement `scanner.ts` — `scanSkillDirectory<T>`
4. Implement `validator.ts` — `validateSkillStructure`
5. Write tests for all above modules (using temp directories)
6. **Gate:** `pnpm typecheck && pnpm build && pnpm test -- --run`

---

## Acceptance Criteria

1. **Package exists** at `packages/skills/` with `@dorkos/skills` name
2. **`SkillFrontmatterSchema` conforms to agentskills.io spec** — validates all required and optional fields per the specification
3. **`TaskFrontmatterSchema` extends the base** with `display-name`, `cron`, `timezone`, `enabled`, `max-runtime`, `permissions`. Does NOT include `agentId`, `cwd`, or `tags`.
4. **`CommandFrontmatterSchema` extends the base** with `argument-hint`, `disable-model-invocation`, `user-invocable`, `context`, `agent`, `model`, `effort`
5. **Parser is generic** — `parseSkillFile<T>` accepts any Zod schema extending the base
6. **Parser validates name/directory match** — frontmatter `name` must equal the parent directory name
7. **Writer creates directory format** — `{parentDir}/{name}/SKILL.md`, not flat files
8. **Writer is atomic** — uses temp file + rename
9. **Scanner discovers all valid skill directories** — returns both successes and failures
10. **Slug utilities are correct** — `slugify` produces valid SKILL.md names, `humanize` is the inverse, `validateSlug` enforces all naming rules
11. **Duration utilities round-trip** — `formatDuration(parseDuration("2h30m")) === "2h30m"`
12. **All subpath exports work** — browser-safe modules importable without Node.js APIs
13. **All tests pass** — `pnpm typecheck && pnpm build && pnpm test -- --run`

---

## Open Questions

None — all design decisions were resolved during ideation.

---

## Related ADRs

- **ADR-0043**: Use Filesystem as Canonical Source of Truth for Mesh Agent Registry — establishes the file-first pattern this package supports
- **ADR-0193**: Generic Background Task System — context on the task system (different scope, but related domain)

A new ADR ("Adopt SKILL.md Open Standard") should be created during the follow-up implementation work that migrates the task system to use this package.

---

## References

- [agentskills.io specification](https://agentskills.io/specification) — The SKILL.md open standard
- [skills.sh](https://skills.sh) — Agent skills directory and leaderboard
- `research/20260329_skills_sh_marketplace_format_specification.md` — SKILL.md format research
- `research/20260328_claude_code_skills_deep_dive.md` — Claude Code's implementation
- `research/20260315_slash_command_storage_formats_competitive.md` — Competitive command format analysis
- `specs/tasks-system-redesign/02-specification.md` — Dependent spec that will use this package

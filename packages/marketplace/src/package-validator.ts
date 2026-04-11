/**
 * @dorkos/marketplace — Package validator.
 *
 * Performs all structural and semantic checks on a marketplace package on
 * disk. The validator is the canonical gate that every package must pass
 * before it can be published, installed, or surfaced in marketplace browse
 * UIs. It is intentionally strict on errors and forgiving on warnings —
 * a package can have warnings (e.g. directory/name mismatch) and still be
 * considered `ok: true`.
 *
 * This module is Node.js-only (it imports `node:fs` and `node:path`) and is
 * not re-exported from the package barrel. Consumers must import it via the
 * `@dorkos/marketplace/package-validator` subpath.
 *
 * @module @dorkos/marketplace/package-validator
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { scanSkillDirectory } from '@dorkos/skills/scanner';
import { validateSkillStructure } from '@dorkos/skills/validator';
import { CLAUDE_PLUGIN_MANIFEST_PATH, PACKAGE_MANIFEST_PATH } from './constants.js';
import {
  MarketplacePackageManifestSchema,
  type MarketplacePackageManifest,
} from './manifest-schema.js';
import { requiresClaudePlugin } from './package-types.js';
import { parseMarketplaceJson, parseDorkosSidecar } from './marketplace-json-parser.js';
import { validateAgainstCcSchema } from './cc-validator.js';

/**
 * A single validation finding produced by {@link validatePackage}. Errors
 * fail the validation; warnings are surfaced to the user but do not block.
 */
export interface ValidationIssue {
  /** Severity — `error` fails validation, `warning` is informational. */
  level: 'error' | 'warning';
  /**
   * Stable machine-readable identifier. Tests, CLI output, and downstream
   * tooling assert on this string, so it must remain stable across releases.
   */
  code: string;
  /** Human-readable description of the issue. */
  message: string;
  /**
   * Optional path (relative to the package root) where the issue was found.
   * Omitted for issues that are not tied to a specific file.
   */
  path?: string;
}

/**
 * Result of validating a marketplace package on disk.
 */
export interface ValidatePackageResult {
  /**
   * `true` when no `error`-level issues were produced. Warnings do not
   * affect this flag.
   */
  ok: boolean;
  /** All issues found during validation, in the order they were detected. */
  issues: ValidationIssue[];
  /**
   * The parsed and schema-validated manifest. Only present when manifest
   * parsing and schema validation succeeded.
   */
  manifest?: MarketplacePackageManifest;
}

/**
 * Conventional directories inside a marketplace package that may contain
 * SKILL.md files. Each directory is scanned recursively for skill
 * subdirectories; missing directories are silently skipped.
 *
 * The `commands/` entry mirrors the plugin scaffolder's starter layout so
 * that SKILL.md files dropped into a freshly scaffolded plugin's `commands/`
 * directory are validated alongside `skills/` and `tasks/`.
 */
const SKILL_SOURCE_DIRS = [
  'skills',
  'tasks',
  'commands',
  '.claude/skills',
  '.claude/commands',
  '.dork/tasks',
] as const;

/**
 * Permissive frontmatter schema used when scanning bundled SKILL.md files.
 *
 * The package validator only cares about structural integrity — it should
 * surface issues like missing `SKILL.md` files or invalid directory names,
 * but it must not fail because a task or command frontmatter shape differs
 * from the base skill shape. Per-shape frontmatter validation is the job
 * of the runtime that consumes the file, not the package validator.
 */
const PermissiveSkillFrontmatterSchema = z.unknown();

/**
 * Validate a marketplace package on disk.
 *
 * Performs, in order:
 *
 * 1. Existence check for `.dork/manifest.json`. Returns early on miss.
 * 2. JSON parsing of the manifest. Returns early on parse failure.
 * 3. Zod schema validation of the manifest. Returns early on schema
 *    violation (one issue per Zod error).
 * 4. Existence check for `.claude-plugin/plugin.json` when the package type
 *    requires a Claude Code plugin manifest (everything except `agent`).
 * 5. Recursive SKILL.md validation across all conventional skill source
 *    directories. Missing directories are silently skipped.
 * 6. Directory-name vs `manifest.name` check. Mismatches are warnings.
 *
 * @param packagePath - Absolute path to the package root directory.
 * @returns A {@link ValidatePackageResult} describing all issues found.
 */
export async function validatePackage(packagePath: string): Promise<ValidatePackageResult> {
  const issues: ValidationIssue[] = [];

  // 1. Manifest existence — prefer .dork/manifest.json, fall back to
  //    synthesizing from .claude-plugin/plugin.json for CC-only packages.
  let manifestRaw: unknown;
  let manifestSource: string;

  const dorkManifestPath = path.join(packagePath, PACKAGE_MANIFEST_PATH);
  let dorkManifestContent: string | null = null;
  try {
    dorkManifestContent = await fs.readFile(dorkManifestPath, 'utf-8');
  } catch {
    // File not found — will attempt CC fallback below.
  }

  if (dorkManifestContent !== null) {
    // .dork/manifest.json exists — parse it.
    try {
      manifestRaw = JSON.parse(dorkManifestContent);
    } catch (err) {
      issues.push({
        level: 'error',
        code: 'MANIFEST_INVALID_JSON',
        message: `Invalid JSON in manifest: ${err instanceof Error ? err.message : String(err)}`,
        path: PACKAGE_MANIFEST_PATH,
      });
      return { ok: false, issues };
    }
    manifestSource = PACKAGE_MANIFEST_PATH;
  } else {
    // No .dork/manifest.json — try deriving from CC plugin manifest.
    const synthesized = await synthesizeFromCcManifest(packagePath);
    if (!synthesized) {
      issues.push({
        level: 'error',
        code: 'MANIFEST_MISSING',
        message: `Required file missing: ${PACKAGE_MANIFEST_PATH} (no ${CLAUDE_PLUGIN_MANIFEST_PATH} fallback found either)`,
        path: PACKAGE_MANIFEST_PATH,
      });
      return { ok: false, issues };
    }
    manifestRaw = synthesized;
    manifestSource = CLAUDE_PLUGIN_MANIFEST_PATH;
  }

  // 2. Manifest passes schema validation
  const parseResult = MarketplacePackageManifestSchema.safeParse(manifestRaw);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      issues.push({
        level: 'error',
        code: 'MANIFEST_SCHEMA_INVALID',
        message: `${issue.path.join('.') || '<root>'}: ${issue.message}`,
        path: manifestSource,
      });
    }
    return { ok: false, issues };
  }

  const manifest = parseResult.data;

  // 4. Claude Code plugin manifest required for plugin/skill-pack/adapter
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

  // 5. Validate any bundled SKILL.md files
  for (const dir of SKILL_SOURCE_DIRS) {
    const fullDir = path.join(packagePath, dir);
    try {
      await fs.access(fullDir);
    } catch {
      continue; // Directory doesn't exist — skip silently
    }
    await validateSkillsInDirectory(fullDir, packagePath, issues);
  }

  // 6. Directory basename should match manifest.name (warning only)
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

/**
 * Scan one conventional skill source directory and append any SKILL.md
 * issues found to the shared `issues` array.
 *
 * Both scanner-level failures (missing SKILL.md, frontmatter parse errors)
 * and structural failures from {@link validateSkillStructure} are surfaced
 * as `SKILL_INVALID` errors.
 *
 * @param fullDir - Absolute path to the directory to scan.
 * @param packagePath - Absolute path to the package root, used to compute
 *   relative paths for issue reporting.
 * @param issues - Mutable issue list to append findings to.
 */
async function validateSkillsInDirectory(
  fullDir: string,
  packagePath: string,
  issues: ValidationIssue[]
): Promise<void> {
  const scanResults = await scanSkillDirectory(fullDir, PermissiveSkillFrontmatterSchema, {
    includeMissing: false,
  });

  for (const result of scanResults) {
    if (!result.ok) {
      issues.push({
        level: 'error',
        code: 'SKILL_INVALID',
        message: result.error,
        path: path.relative(packagePath, result.filePath),
      });
      continue;
    }

    const { dirPath, filePath } = result.definition;
    const structureResult = await validateSkillStructure(dirPath);
    if (!structureResult.valid) {
      for (const err of structureResult.errors) {
        issues.push({
          level: 'error',
          code: 'SKILL_INVALID',
          message: err,
          path: path.relative(packagePath, filePath),
        });
      }
    }
  }
}

/**
 * A structured marketplace validation finding. Unlike {@link ValidationIssue}
 * (which applies to a package on disk), these apply to a `marketplace.json`
 * or sidecar document and are used by the CLI validators
 * (`validate-marketplace`, `validate-remote`) to report DorkOS + CC schema
 * compliance.
 */
export interface MarketplaceValidationIssue {
  /** Severity — `error` fails validation, `warning` is informational. */
  level: 'error' | 'warning';
  /** Human-readable description of the issue. */
  message: string;
  /** Path into the JSON document where the issue was found. */
  path?: string[];
}

/**
 * Validate a `marketplace.json` document string against the DorkOS
 * (passthrough) schema. Returns an empty array when valid; returns one
 * error entry per Zod issue when invalid.
 *
 * @param raw - Raw JSON string from `marketplace.json`.
 * @returns Array of validation issues (empty when valid).
 */
export function validateMarketplaceJson(raw: string): MarketplaceValidationIssue[] {
  const result = parseMarketplaceJson(raw);
  if (result.ok) {
    return [];
  }
  return [{ level: 'error', message: result.error }];
}

/**
 * Validate a `marketplace.json` document string against the strict CC
 * schema (`cc-validator.ts`). Returns an empty array when valid; returns
 * one error entry per Zod issue when invalid. This is the *outbound
 * compatibility check*: if this function returns errors, the document
 * will fail `claude plugin validate`.
 *
 * @param raw - Raw JSON string from `marketplace.json`.
 * @returns Array of validation issues (empty when valid).
 */
export function validateMarketplaceJsonWithCcSchema(raw: string): MarketplaceValidationIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return [
      {
        level: 'error',
        message: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      },
    ];
  }

  const result = validateAgainstCcSchema(parsed);
  if (result.ok) {
    return [];
  }
  return result.errors.map((issue) => ({
    level: 'error' as const,
    message: issue.message,
    path: issue.path.map(String),
  }));
}

/**
 * Validate a `dorkos.json` sidecar document string. Returns an empty array
 * when valid; returns one error entry when invalid.
 *
 * @param raw - Raw JSON string from `.claude-plugin/dorkos.json`.
 * @returns Array of validation issues (empty when valid).
 */
export function validateDorkosSidecar(raw: string): MarketplaceValidationIssue[] {
  const result = parseDorkosSidecar(raw);
  if (result.ok) {
    return [];
  }
  return [{ level: 'error', message: result.error }];
}

/**
 * Attempt to synthesize a DorkOS manifest from a Claude Code plugin manifest.
 * Returns a plain object suitable for `MarketplacePackageManifestSchema.safeParse`,
 * or `null` when no CC manifest exists or cannot be parsed.
 *
 * CC plugins are mapped to the `plugin` package type with sensible defaults
 * for optional fields. This allows vanilla CC marketplace packages to be
 * installed without requiring a `.dork/manifest.json`.
 *
 * @internal
 */
async function synthesizeFromCcManifest(
  packagePath: string
): Promise<Record<string, unknown> | null> {
  const ccPath = path.join(packagePath, CLAUDE_PLUGIN_MANIFEST_PATH);
  let content: string;
  try {
    content = await fs.readFile(ccPath, 'utf-8');
  } catch {
    return null;
  }

  let cc: Record<string, unknown>;
  try {
    cc = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }

  return {
    schemaVersion: 1,
    name: cc.name,
    version: cc.version ?? '0.0.0',
    type: 'plugin',
    description: cc.description ?? String(cc.name ?? 'CC plugin'),
    tags: [],
    layers: [],
    requires: [],
    extensions: [],
  };
}

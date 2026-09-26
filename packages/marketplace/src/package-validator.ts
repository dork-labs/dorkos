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

import { promises as fs, type Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { scanSkillDirectory } from '@dorkos/skills/scanner';
import { validateSkillStructure } from '@dorkos/skills/validator';
import {
  AGENT_MANIFEST_PATH,
  CLAUDE_PLUGIN_MANIFEST_PATH,
  PACKAGE_MANIFEST_PATH,
} from './constants.js';
import {
  MarketplacePackageManifestSchema,
  type MarketplacePackageManifest,
} from './manifest-schema.js';
import {
  PACKAGE_TEXT_MAX_BYTES,
  TooLargeError,
  UnsafeFileError,
  readPackageFileWithin,
} from '@dorkos/shared/bounded-read';
import { describePackageLink, findPackageLinks } from './package-links.js';
import { PackageTooLargeError, measurePackageTree } from './package-size.js';
import { requiresClaudePlugin } from './package-types.js';
import { parseMarketplaceJson, parseDorkosSidecar } from './marketplace-json-parser.js';
import { validateAgainstCcSchema } from './cc-validator.js';
import {
  declaredEffectPaths,
  isReservedPackagePath,
  userEditableReaches,
} from './user-editable.js';
import { findAgentWorkspaceConfig } from './agent-workspace-config.js';

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
 * Options for {@link validatePackage}.
 */
export interface ValidatePackageOptions {
  /**
   * What kind of tree is being validated. `'package'` (the default) is a
   * package as its author ships it: publishing, `dorkos marketplace validate`,
   * and the install pipeline's staged tree. `'installed'` is an install root on
   * disk, which legitimately holds the installer's own records and the
   * person's data, so the reserved-path check is skipped there.
   */
  tree?: 'package' | 'installed';
  /**
   * The package is a folder on this machine that the person pointed at. A
   * `.git` FILE at its root is then its own worktree's link, not a package
   * steering git elsewhere, and the install drops every `.git` as it copies,
   * so that one refusal is skipped. A root shaped like a git repository is
   * still refused.
   */
  localSource?: boolean;
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
  /**
   * The version the package declares about itself, from {@link readDeclaredVersion}:
   * plugin.json's `version`, else the manifest's. Present on every result,
   * `ok` or not. `undefined` when neither file declares one — a Claude-Code-only
   * package with no `version` is NOT reported as `'0.0.0'`, even though the
   * synthesized manifest still carries `'0.0.0'` because the schema requires one.
   */
  declaredVersion?: string;
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
 * Where a `schedules[].skillRef` may resolve to a shipped skill.
 *
 * A deliberate SUBSET of {@link SKILL_SOURCE_DIRS}: the two task directories are
 * excluded, because a task directory is the legacy home for scheduled tasks and
 * a schedule pointing INTO one is the arrangement this whole slot replaces.
 *
 * The list must stay identical to the installer's resolver
 * (`SKILL_SEARCH_DIRS` in
 * `apps/server/src/services/marketplace/lib/validate-package-schedules.ts`),
 * which is why it is its own constant rather than a reuse of the broader list.
 * Reusing that one made publish-time accept a `tasks/`-only skill the installer
 * would then fail to find — a package that validated clean and produced a
 * schedule that never materialized, with the failure surfacing to the installing
 * person rather than to the author who could fix it.
 */
const SCHEDULE_SKILL_SOURCE_DIRS = [
  'skills',
  '.claude/skills',
  'commands',
  '.claude/commands',
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
 * Thrown by {@link readPackageFile} for a package file DorkOS refuses to read:
 * larger than it reads, reached through a symbolic link, or not a regular
 * file. It carries the file's package-relative path so the validator can
 * report it by name, and it passes through the "missing or unreadable reads
 * as absent" catches below, so a refused manifest is never mistaken for a
 * missing one (DOR-2319).
 */
class RefusedPackageFileError extends Error {
  /** The issue code: `FILE_TOO_LARGE` or `FILE_REFUSED`. */
  readonly code: 'FILE_TOO_LARGE' | 'FILE_REFUSED';

  /**
   * Wrap one refused read.
   *
   * @param relPath - The file's path, relative to the package root.
   * @param cause - The refusal.
   */
  constructor(
    readonly relPath: string,
    cause: TooLargeError | UnsafeFileError
  ) {
    super(cause.message, { cause });
    this.name = 'RefusedPackageFileError';
    this.code = cause instanceof TooLargeError ? 'FILE_TOO_LARGE' : 'FILE_REFUSED';
  }
}

/**
 * Read one package file as text, within {@link PACKAGE_TEXT_MAX_BYTES} and
 * never through a symbolic link.
 *
 * @param packagePath - Absolute path to the package root.
 * @param relPath - The file's path, relative to the package root.
 * @returns The file's text.
 * @throws {RefusedPackageFileError} When the file is too large, reached
 *   through a symbolic link, or not a regular file.
 * @throws The read error, unchanged, otherwise (for example `ENOENT`).
 */
async function readPackageFile(packagePath: string, relPath: string): Promise<string> {
  try {
    return await readPackageFileWithin(
      packagePath,
      relPath,
      PACKAGE_TEXT_MAX_BYTES,
      `The package's ${relPath}`
    );
  } catch (err) {
    if (err instanceof TooLargeError || err instanceof UnsafeFileError) {
      throw new RefusedPackageFileError(relPath, err);
    }
    throw err;
  }
}

/**
 * Whether any directory from `packagePath` down to `relDir` is a symbolic link.
 *
 * @param packagePath - Absolute path to the package root.
 * @param relDir - A directory, relative to the package root.
 * @returns `true` when one of them is a link.
 */
async function reachedThroughLink(packagePath: string, relDir: string): Promise<boolean> {
  let current = packagePath;
  for (const part of path.normalize(relDir).split(path.sep)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) return true;
  }
  return false;
}

/**
 * The version a package tree states about itself: `plugin.json`'s `version`
 * when that file declares one, else `.dork/manifest.json`'s. Reads the two
 * files directly and NEVER gates on validity, so an install whose files
 * disagree (or that fails validation for any other reason) still has a
 * readable version. `undefined` when neither file declares one. Never throws.
 *
 * `plugin.json` comes first because Claude Code loads the plugin by it. For a
 * package that validates the order is moot (`VERSION_MISMATCH` holds the two
 * equal); for an install that predates that rule it makes DorkOS report what
 * Claude Code actually runs.
 *
 * @param packagePath - Absolute path to the package root directory.
 * @returns The declared version, or `undefined` when neither file states one.
 */
export async function readDeclaredVersion(packagePath: string): Promise<string | undefined> {
  return (
    (await readVersionField(packagePath, CLAUDE_PLUGIN_MANIFEST_PATH)) ??
    (await readVersionField(packagePath, PACKAGE_MANIFEST_PATH))
  );
}

/**
 * Read a JSON file's non-empty string `version` field. A missing or
 * unreadable file, invalid JSON, a non-object, or a missing, empty or
 * non-string `version` all read as "declares none". Never throws.
 *
 * @param packagePath - Absolute path to the package root.
 * @param relPath - The JSON file, relative to the package root.
 * @internal
 */
async function readVersionField(packagePath: string, relPath: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readPackageFileWithin(packagePath, relPath, PACKAGE_TEXT_MAX_BYTES, 'The file')
    );
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const version = (parsed as Record<string, unknown>).version;
    return typeof version === 'string' && version !== '' ? version : undefined;
  } catch {
    return undefined;
  }
}

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
 *    When both `.dork/manifest.json` and `plugin.json` exist, their versions
 *    must agree (`VERSION_MISMATCH`, {@link checkVersionAgreement}).
 * 5. Recursive SKILL.md validation across all conventional skill source
 *    directories. Missing directories are silently skipped.
 * 6. Directory-name vs `manifest.name` check. Mismatches are warnings.
 *
 * @param packagePath - Absolute path to the package root directory.
 * @param options - What kind of tree this is; see {@link ValidatePackageOptions}.
 * @returns A {@link ValidatePackageResult} describing all issues found.
 */
export async function validatePackage(
  packagePath: string,
  options: ValidatePackageOptions = {}
): Promise<ValidatePackageResult> {
  try {
    return await validatePackageFiles(packagePath, options);
  } catch (err) {
    if (!(err instanceof RefusedPackageFileError)) throw err;
    return {
      ok: false,
      issues: [{ level: 'error', code: err.code, message: err.message, path: err.relPath }],
      declaredVersion: await readDeclaredVersion(packagePath),
    };
  }
}

/**
 * The body of {@link validatePackage}. A refused package file anywhere in it
 * throws {@link RefusedPackageFileError}, which the caller turns into one
 * issue naming the file.
 *
 * @param packagePath - Absolute path to the package root directory.
 * @param options - What kind of tree this is.
 * @returns The validation result.
 */
async function validatePackageFiles(
  packagePath: string,
  options: ValidatePackageOptions
): Promise<ValidatePackageResult> {
  const issues: ValidationIssue[] = [];
  // Read before any gate, so every result — failed ones included — says what
  // version the tree states. The update check relies on that for trees that
  // do not validate.
  const declaredVersion = await readDeclaredVersion(packagePath);

  // 0. The package is not larger than DorkOS installs (DOR-2321). First, so
  //    an enormous tree is refused before anything else walks it.
  try {
    await measurePackageTree(packagePath);
  } catch (err) {
    if (!(err instanceof PackageTooLargeError)) throw err;
    issues.push({
      level: 'error',
      code: 'PACKAGE_TOO_LARGE',
      message: err.message,
      ...(err.path !== undefined && { path: err.path }),
    });
    return { ok: false, issues, declaredVersion };
  }

  // 1. Manifest existence — prefer .dork/manifest.json, fall back to
  //    synthesizing from .claude-plugin/plugin.json for CC-only packages.
  let manifestRaw: unknown;
  let manifestSource: string;

  let dorkManifestContent: string | null = null;
  try {
    dorkManifestContent = await readPackageFile(packagePath, PACKAGE_MANIFEST_PATH);
  } catch (err) {
    if (err instanceof RefusedPackageFileError) throw err;
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
      return { ok: false, issues, declaredVersion };
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
      return { ok: false, issues, declaredVersion };
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
    return { ok: false, issues, declaredVersion };
  }

  const manifest = parseResult.data;

  // 3a. Advisory: a package with no category at all browses as "Uncategorized".
  //     Off-list categories[] and incoherent category/categories[0] pairs
  //     already failed the schema parse above (MANIFEST_SCHEMA_INVALID); a
  //     legacy free-string singular category deliberately still parses. This
  //     warning covers only the soft "no category declared" case.
  if (!manifest.category && !manifest.categories?.length) {
    issues.push({
      level: 'warning',
      code: 'CATEGORY_MISSING',
      message: 'Package declares no category — it will browse as "Uncategorized".',
    });
  }

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

  // 4a. The two version files agree. Only a real manifest can disagree with
  //     plugin.json — a synthesized one copies plugin.json's version.
  if (manifestSource === PACKAGE_MANIFEST_PATH) {
    await checkVersionAgreement(packagePath, manifest.version, issues);
  }

  // 4b. Every shortcut (symbolic link) in the package: staging drops them, so
  //     each is said out loud rather than silently missing once installed.
  for (const link of await findPackageLinks(packagePath)) {
    issues.push({
      level: 'warning',
      code: 'LINK_SKIPPED',
      message: describePackageLink(link),
      path: link.path,
    });
  }

  // 5. Validate any bundled SKILL.md files
  for (const dir of SKILL_SOURCE_DIRS) {
    const fullDir = path.join(packagePath, dir);
    try {
      await fs.access(fullDir);
    } catch {
      continue; // Directory doesn't exist — skip silently
    }
    // A skill directory reached through a symbolic link is not the package's
    // own: staging drops the link, and following it could read files outside
    // the package. It is never read; the LINK_SKIPPED warning below says it
    // will not be installed (DOR-2319).
    if (await reachedThroughLink(packagePath, dir)) continue;
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

  // 7. A packaged agent may not ship auto-injectable MCP servers. A shipped
  //    `.dork/agent.json` that declares a non-empty `mcpServers` would connect
  //    an arbitrary command the moment the agent runs a session, bypassing the
  //    gated `mcp.add` approval that governs every legitimate managed server
  //    (ADR 260803-233420, guarantee 3). Servers are added post-install through
  //    that gate, never carried by the package.
  await checkPackagedMcpServers(packagePath, issues);

  // 7b. A root git would read as a repository (DOR-2326): its `config` can
  //     name a program git runs whenever it runs there. Only before install:
  //     a person may make their installed agent's folder a repository of
  //     their own, and that must not hide the agent.
  if ((options.tree ?? 'package') === 'package') {
    await checkGitShapedRoot(packagePath, manifest.type, options.localSource === true, issues);
  }

  // 8. Declared schedules that point at nothing.
  await checkScheduleSkillRefs(packagePath, manifest, issues);

  // 9. Paths that belong to the person or the installer (DOR-2245). Skipped on
  //    an installed tree, which holds exactly those files by design.
  if ((options.tree ?? 'package') === 'package') {
    await checkReservedPaths(packagePath, issues);
  }

  // 10. userEditable entries that reach a path plugin.json declares hooks,
  //     servers, monitors, skills or commands at (DOR-2245). The defaults are
  //     refused by the manifest schema; these locations only plugin.json knows.
  await checkUserEditableDeclaredPaths(packagePath, manifest.userEditable ?? [], issues);

  // 11. An agent package's folder is its working directory, so harness
  //     configuration there would run in every session unseen (DOR-2314).
  //     Skipped on an installed tree, where DorkOS writes some of it itself.
  if (manifest.type === 'agent' && (options.tree ?? 'package') === 'package') {
    for (const finding of await findAgentWorkspaceConfig(packagePath)) {
      issues.push({
        level: 'error',
        code: 'AGENT_WORKSPACE_CONFIG_FORBIDDEN',
        message: finding.message,
        path: finding.path,
      });
    }
  }

  const hasErrors = issues.some((i) => i.level === 'error');
  return { ok: !hasErrors, issues, manifest, declaredVersion };
}

/**
 * Fail for every `userEditable` entry that reaches a location plugin.json
 * declares something runnable at. A person approves the new version's copy of
 * those files on update, so an edited copy must never be kept over it
 * (DOR-2245, DOR-2195). The manifest schema already refuses the default
 * locations (`EFFECT_BEARING_PATHS`).
 *
 * @param packagePath - Absolute path to the package root directory.
 * @param userEditable - The manifest's `userEditable` list.
 * @param issues - Mutable issue list to append findings to.
 * @internal
 */
async function checkUserEditableDeclaredPaths(
  packagePath: string,
  userEditable: readonly string[],
  issues: ValidationIssue[]
): Promise<void> {
  if (userEditable.length === 0) return;
  let pluginJson: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(
      await readPackageFile(packagePath, CLAUDE_PLUGIN_MANIFEST_PATH)
    );
    if (typeof parsed !== 'object' || parsed === null) return;
    pluginJson = parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof RefusedPackageFileError) throw err;
    return;
  }
  const declared = declaredEffectPaths(pluginJson);
  for (const pattern of userEditable) {
    const reached = declared.find((p) => userEditableReaches(pattern, p));
    if (reached === undefined) continue;
    issues.push({
      level: 'error',
      code: 'USER_EDITABLE_EFFECT_PATH',
      message:
        `userEditable entry "${pattern}" reaches ${reached}, which plugin.json names as something ` +
        "the package runs. A person approves the new version's copy on update, so it can't be user-editable.",
      path: PACKAGE_MANIFEST_PATH,
    });
  }
}

/** Directories the reserved-path walk never enters: vendored code and git's own store. */
const RESERVED_WALK_SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * Fail for every shipped file under a path DorkOS keeps for the person or the
 * installer (`isReservedPackagePath`): the package's data directory, its
 * secrets file, the installer's records, and `.dork-old` / `.dork-new` copies.
 * A package that shipped one would, on the next update, own a file that is
 * really a person's (ADR 260923-163513). The install copy step strips these
 * too; this check is the one an author sees.
 *
 * @param packagePath - Absolute path to the package root directory.
 * @param issues - Mutable issue list to append findings to.
 * @internal
 */
async function checkReservedPaths(packagePath: string, issues: ValidationIssue[]): Promise<void> {
  const walk = async (relDir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path.join(packagePath, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (RESERVED_WALK_SKIP_DIRS.has(entry.name)) continue;
        await walk(rel);
      } else if (isReservedPackagePath(rel)) {
        issues.push({
          level: 'error',
          code: 'RESERVED_PATH_SHIPPED',
          message:
            `${rel} is a path DorkOS keeps for the person or the installer ` +
            '(.dork/data/, .dork/secrets.json, .dork/install-metadata.json, ' +
            '.dork/installed-files.json, .dork/uninstalled-agent.json, *.dork-old, ' +
            '*.dork-new). Remove it from the package.',
          path: rel,
        });
      }
    }
  };
  await walk('');
}

/**
 * Fail when `.dork/manifest.json` and `.claude-plugin/plugin.json` state
 * different versions, or when plugin.json states none beside a manifest.
 *
 * Either way DorkOS and Claude Code would disagree about which version is
 * installed for the package's whole life: DorkOS reads the manifest, Claude
 * Code loads plugin.json (and, with no version there, falls back to the
 * marketplace entry or the commit). Any tie-break would only choose which of
 * the two programs is wrong (ADR 260923-122616).
 *
 * Runs wherever validation gates something — authoring, install, and staging
 * a new version for the update check — and never on an installed tree, whose
 * readers go through {@link readDeclaredVersion} instead. A missing
 * plugin.json is step 4's concern and an unparseable one keeps its existing
 * handling; neither is reported here. `package.json` is not compared: DorkOS
 * does not interpret it.
 *
 * @param packagePath - Absolute path to the package root directory.
 * @param manifestVersion - The schema-validated manifest's `version`.
 * @param issues - Mutable issue list to append a finding to.
 * @internal
 */
async function checkVersionAgreement(
  packagePath: string,
  manifestVersion: string,
  issues: ValidationIssue[]
): Promise<void> {
  let plugin: unknown;
  try {
    plugin = JSON.parse(await readPackageFile(packagePath, CLAUDE_PLUGIN_MANIFEST_PATH));
  } catch (err) {
    if (err instanceof RefusedPackageFileError) throw err;
    return;
  }
  if (plugin === null || typeof plugin !== 'object') return;

  const pluginVersion = (plugin as Record<string, unknown>).version;
  if (typeof pluginVersion === 'string' && pluginVersion !== '') {
    if (pluginVersion === manifestVersion) return;
    issues.push({
      level: 'error',
      code: 'VERSION_MISMATCH',
      message:
        `${PACKAGE_MANIFEST_PATH} says version ${manifestVersion} but ${CLAUDE_PLUGIN_MANIFEST_PATH} says ${pluginVersion}. ` +
        `Set both to the same version: Claude Code loads ${pluginVersion}, DorkOS would report ${manifestVersion}.`,
      path: CLAUDE_PLUGIN_MANIFEST_PATH,
    });
    return;
  }
  issues.push({
    level: 'error',
    code: 'VERSION_MISMATCH',
    message:
      `${PACKAGE_MANIFEST_PATH} says version ${manifestVersion} but ${CLAUDE_PLUGIN_MANIFEST_PATH} has no version. ` +
      `Add "version": "${manifestVersion}" to plugin.json so Claude Code and DorkOS agree.`,
    path: CLAUDE_PLUGIN_MANIFEST_PATH,
  });
}

/**
 * Reject a `schedules[].skillRef` that names a skill the package does not ship.
 *
 * This is the publish-time half of the schedule gate, and it is here rather than
 * only on the server so an author hears it while they still have the manifest
 * open — `dorkos package validate` runs this, and a broken reference caught then
 * never reaches anybody's install. The server repeats the check at install
 * (`services/marketplace/lib/validate-package-schedules.ts`) because a package
 * can arrive from a source that never ran the validator.
 *
 * Deliberately NOT extended to cron validity, which is the other half. Deciding
 * whether a cron expression means anything is croner's question, and croner is a
 * server dependency this package will not take on: it is browser-safe (both
 * `apps/client` and `apps/site` import its manifest schema) and holds its
 * dependency list to zod plus `@dorkos/skills`. A hand-rolled cron grammar here
 * would be worse than the gap — a second acceptance set that agrees with croner
 * today and drifts the first time either widens, producing a package this
 * validator passed and the installer then refuses. The structural half is
 * checkable here, so it is checked here; the semantic half is checked at the one
 * seam that can ask the real question.
 *
 * @param packagePath - Absolute path to the package root directory.
 * @param manifest - The parsed manifest.
 * @param issues - Mutable issue list to append findings to.
 * @internal
 */
async function checkScheduleSkillRefs(
  packagePath: string,
  manifest: MarketplacePackageManifest,
  issues: ValidationIssue[]
): Promise<void> {
  // `adapter` has no schedules slot; anything else may arrive without the key
  // when it was not produced by a parse.
  if (manifest.type === 'adapter') return;
  const schedules = manifest.schedules;
  if (!Array.isArray(schedules)) return;

  for (const schedule of schedules) {
    const skillRef = schedule.skillRef;
    if (typeof skillRef !== 'string' || skillRef === '') continue;

    const found = await packageShipsSkill(packagePath, skillRef);
    if (!found) {
      issues.push({
        level: 'error',
        code: 'SCHEDULE_SKILL_MISSING',
        message:
          `Schedule references the skill '${skillRef}', which this package does not ship. ` +
          `Add skills/${skillRef}/SKILL.md, or describe the work inline with name, ` +
          `description and prompt.`,
        path: PACKAGE_MANIFEST_PATH,
      });
    }
  }
}

/**
 * Whether the package ships a skill directory of this name, anywhere in its
 * conventional skill source directories.
 *
 * Matches on DIRECTORY name, which is what every harness keys a skill by — the
 * same reason a frontmatter/directory mismatch is only a warning above (DOR-263).
 *
 * The search descends, because skills nest (`skills/group/my-skill/`) and the
 * installer's own resolver descends too. The two accept the same set — same
 * four directories ({@link SCHEDULE_SKILL_SOURCE_DIRS}), same depth, same
 * `node_modules` exclusion — because disagreeing in either direction is a bug
 * with a person on the end of it: stricter here rejects a package that would
 * install perfectly well, and looser here passes a package whose schedule then
 * fails to materialize after install, which is the report the author never gets.
 *
 * @param packagePath - Absolute path to the package root.
 * @param skillName - The directory name to find.
 * @internal
 */
async function packageShipsSkill(packagePath: string, skillName: string): Promise<boolean> {
  for (const dir of SCHEDULE_SKILL_SOURCE_DIRS) {
    if (await searchForSkill(path.join(packagePath, dir), skillName, 0)) return true;
  }
  return false;
}

/** How deep to descend below a skill source directory. Mirrors the installer's resolver. */
const MAX_SKILL_SEARCH_DEPTH = 3;

/**
 * Depth-bounded search for a skill directory containing a `SKILL.md`.
 *
 * @param root - Directory to search.
 * @param skillName - Directory name to find.
 * @param depth - Current recursion depth.
 * @internal
 */
async function searchForSkill(root: string, skillName: string, depth: number): Promise<boolean> {
  if (depth > MAX_SKILL_SEARCH_DEPTH) return false;

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return false; // Missing or unreadable — not here.
  }

  for (const entry of entries) {
    // A vendored dependency's same-named skill is not this package's skill.
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const child = path.join(root, entry.name);
    if (entry.name === skillName) {
      try {
        await fs.access(path.join(child, 'SKILL.md'));
        return true;
      } catch {
        // A directory of the right name with no SKILL.md is not a skill.
      }
    }
    if (await searchForSkill(child, skillName, depth + 1)) return true;
  }
  return false;
}

/**
 * Refuse a package whose root git would read as a repository (DOR-2326).
 *
 * Git treats a folder holding `HEAD` with `objects/`, `refs/` or `packed-refs`
 * as a repository in its own right, and a `.git` file saying `gitdir:` makes
 * the folder part of another one. Either way git reads a `config` the package
 * wrote, and settings such as `core.fsmonitor` name a program git runs, so
 * `git status` in the installed folder ran the package's code. That holds for
 * any package type.
 *
 * An agent's folder is also where its sessions run git, so an agent may not
 * carry the other pieces of a repository at its root either: no `config`
 * file, `worktrees/` or `packed-refs`. (A plugin's `config` file or folder is
 * an ordinary name, and nothing runs git inside a plugin's folder.) A `.git`
 * FOLDER is not refused: a local agent that is someone's own repository is
 * ordinary, and the install drops every `.git` as it copies the package
 * (`stage-package.ts`). DorkOS's own git calls and every agent session's git
 * are hardened as well (`@dorkos/shared/git-hardening`); this refusal keeps
 * such a package from being installed at all.
 *
 * @param packagePath - Absolute path to the package root directory.
 * @param type - The package's type.
 * @param localSource - A folder on this machine; see {@link ValidatePackageOptions}.
 * @param issues - Mutable issue list to append a finding to.
 * @internal
 */
async function checkGitShapedRoot(
  packagePath: string,
  type: string,
  localSource: boolean,
  issues: ValidationIssue[]
): Promise<void> {
  const kindOf = async (name: string): Promise<'file' | 'dir' | null> => {
    try {
      const stats = await fs.lstat(path.join(packagePath, name));
      return stats.isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  };
  const [head, objects, refs, packedRefs, dotGit, config, worktrees] = await Promise.all(
    ['HEAD', 'objects', 'refs', 'packed-refs', '.git', 'config', 'worktrees'].map(kindOf)
  );
  const found: string[] = [];
  if (head === 'file' && (objects === 'dir' || refs === 'dir' || packedRefs === 'file')) {
    found.push('HEAD with objects/, refs/ or packed-refs');
  }
  if (dotGit === 'file' && !localSource) {
    let text: string;
    try {
      text = await readPackageFileWithin(packagePath, '.git', 4096, "The package's .git");
    } catch {
      // A link, too large, or unreadable: treated like one that points elsewhere.
      text = 'gitdir:';
    }
    if (/^\s*gitdir:/m.test(text.slice(0, 4096))) found.push('a .git file that points elsewhere');
  }
  if (type === 'agent') {
    if (config === 'file') found.push('a config file');
    if (worktrees === 'dir') found.push('a worktrees folder');
    if (packedRefs === 'file') found.push('packed-refs');
  }
  if (found.length === 0) return;
  issues.push({
    level: 'error',
    code: 'GIT_REPOSITORY_SHAPED',
    message: `The package's folder looks like a git repository (${[...new Set(found)].join(', ')}), and git would read settings from it that can run a program. Remove those files from the package.`,
  });
}

/**
 * Reject a package that ships an agent identity manifest (`.dork/agent.json`)
 * declaring one or more managed MCP servers.
 *
 * This is the marketplace half of the managed-MCP trust model (ADR
 * 260803-233420, guarantee 3): a person adds servers post-install through the
 * gated `mcp.add` capability, so a package must never carry them. The check is
 * structural rather than schema-typed on purpose — `@dorkos/shared` is a
 * dev-only dependency of this package (keeping the validator browser-safe), and
 * the guard only needs to know whether `mcpServers` is a present, non-empty
 * array, not to fully parse the agent manifest. A missing or unreadable
 * `.dork/agent.json` is not this check's concern (the normal case is that the
 * installer scaffolds it), so it is skipped silently.
 *
 * This structural check is a fast, friendly rejection at publish/install time,
 * not the whole defense: a differently-shaped smuggle (e.g. `mcpServers` as an
 * object) slips this guard but is then rejected by `AgentManifestSchema` at
 * load — the agent fails to parse, is hidden from the registry, and injects
 * nothing. `injectableServersForCwd` is the final backstop.
 *
 * @param packagePath - Absolute path to the package root directory.
 * @param issues - Mutable issue list to append a finding to.
 * @internal
 */
async function checkPackagedMcpServers(
  packagePath: string,
  issues: ValidationIssue[]
): Promise<void> {
  let content: string;
  try {
    content = await readPackageFile(packagePath, AGENT_MANIFEST_PATH);
  } catch (err) {
    if (err instanceof RefusedPackageFileError) throw err;
    return; // No shipped agent.json — nothing to guard.
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Malformed JSON is a divergent state, but not this guard's job — the
    // install pipeline scaffolds a fresh manifest anyway. Say nothing.
    return;
  }

  if (parsed === null || typeof parsed !== 'object') return;
  const mcpServers = (parsed as Record<string, unknown>).mcpServers;
  if (Array.isArray(mcpServers) && mcpServers.length > 0) {
    issues.push({
      level: 'error',
      code: 'PACKAGED_MCP_SERVERS_FORBIDDEN',
      message:
        'A packaged agent may not ship MCP servers in .dork/agent.json — add them ' +
        'after install through the gated mcp.add capability (ADR 260803-233420).',
      path: AGENT_MANIFEST_PATH,
    });
  }
}

/**
 * Scan one conventional skill source directory and append any SKILL.md
 * issues found to the shared `issues` array.
 *
 * Both scanner-level failures (missing SKILL.md, frontmatter parse errors)
 * and structural failures from {@link validateSkillStructure} are surfaced
 * as `SKILL_INVALID` errors — including a directory that exists but cannot be
 * listed, which {@link scanSkillDirectory} throws for. Nothing here escapes as
 * an exception: a validator's job is to return findings, and callers up the
 * chain treat a throw as "the whole package list is broken".
 *
 * A frontmatter `name` that differs from the skill's directory name is a
 * WARNING (`SKILL_NAME_MISMATCH`), not an error: Claude Code keys skills by
 * directory name and tolerates the divergence — Anthropic's own `hookify`
 * plugin ships one — so a validator claiming CC-superset compatibility must
 * not reject what CC itself accepts (DOR-263).
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
  let scanResults;
  try {
    scanResults = await scanSkillDirectory(fullDir, PermissiveSkillFrontmatterSchema, {
      packageTree: true,
      includeMissing: false,
      requireNameMatch: false,
    });
  } catch (err) {
    // `scanSkillDirectory` throws when a directory is there but cannot be
    // listed — EACCES, or EMFILE under transient file-descriptor pressure.
    // That is a finding about ONE directory, so it is reported as one.
    // Letting it propagate would turn an unreadable subdirectory of one
    // package into a failed installed-package listing for every package.
    issues.push({
      level: 'error',
      code: 'SKILL_INVALID',
      message: `Could not read skills directory: ${(err as Error).message}`,
      path: path.relative(packagePath, fullDir),
    });
    return;
  }

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

    const { name, meta, dirPath, filePath } = result.definition;
    const frontmatterName =
      meta !== null && typeof meta === 'object' && 'name' in meta
        ? (meta as { name: unknown }).name
        : undefined;
    if (typeof frontmatterName === 'string' && frontmatterName !== name) {
      issues.push({
        level: 'warning',
        code: 'SKILL_NAME_MISMATCH',
        message: `Frontmatter name "${frontmatterName}" does not match directory name "${name}" — harnesses that key skills by directory name will use "${name}"`,
        path: path.relative(packagePath, filePath),
      });
    }

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
  let content: string;
  try {
    content = await readPackageFile(packagePath, CLAUDE_PLUGIN_MANIFEST_PATH);
  } catch (err) {
    if (err instanceof RefusedPackageFileError) throw err;
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

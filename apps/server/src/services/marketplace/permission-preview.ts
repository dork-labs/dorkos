/**
 * Permission preview builder — walks a downloaded marketplace package and
 * produces a `PermissionPreview` describing every effect the install will
 * have on disk and on the running system.
 *
 * The builder is constructor-injected with `dorkHome` (the resolved data
 * directory — never derived from `os.homedir()`) and a `ConflictDetectorLike`
 * dependency. The interface is forward-declared in this file so the builder
 * can be constructed against either the real `ConflictDetector` (sibling
 * `conflict-detector.ts`) or a test double without a circular import.
 *
 * @module services/marketplace/permission-preview
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { MarketplacePackageManifest } from '@dorkos/marketplace';
import { parseSkillFile } from '@dorkos/skills/parser';
import { TaskFrontmatterSchema } from '@dorkos/skills';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import type { ConflictReport, PermissionPreview } from './types.js';

/** Directory names ignored when walking the package contents. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist']);

/**
 * Forward-declared interface for the conflict detector. The real
 * `ConflictDetector` class (sibling task 2.2) implements this structurally;
 * declaring it here avoids a circular import on a not-yet-existing module.
 */
export interface ConflictDetectorLike {
  /**
   * Inspect the staged package against the currently-installed state and
   * return any collisions found.
   */
  detect(ctx: {
    packagePath: string;
    manifest: MarketplacePackageManifest;
    dorkHome: string;
    projectPath?: string;
  }): Promise<ConflictReport[]>;
}

/** Options for {@link PermissionPreviewBuilder.build}. */
export interface BuildPreviewOptions {
  /** Project path for project-local installs (defaults to global). */
  projectPath?: string;
}

/**
 * Computes the on-disk install root for a package given its type and name.
 * Plugins, skill-packs, and adapters all live under `plugins/`; agents live
 * under `agents/`.
 */
function computeInstallRoot(dorkHome: string, manifest: MarketplacePackageManifest): string {
  if (manifest.type === 'agent') {
    return join(dorkHome, 'agents', manifest.name);
  }
  return join(dorkHome, 'plugins', manifest.name);
}

/**
 * Recursively yield every file path under `root`, skipping
 * `IGNORED_DIRECTORIES`. Returns paths relative to `root`.
 */
async function walkPackageFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        await visit(join(dir, entry.name));
        continue;
      }
      if (entry.isFile()) {
        results.push(relative(root, join(dir, entry.name)));
      }
    }
  }

  await visit(root);
  return results;
}

/** Returns true if `path` exists on disk (file or directory). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read every `extension.json` under `<packagePath>/.dork/extensions/<id>/` and
 * return the parsed manifests. Invalid manifests are silently skipped — the
 * package validator (separate concern) is responsible for surfacing schema
 * errors before the preview ever runs.
 */
async function readExtensionManifests(
  packagePath: string
): Promise<Array<{ id: string; manifest: ReturnType<typeof ExtensionManifestSchema.parse> }>> {
  const extRoot = join(packagePath, '.dork', 'extensions');
  if (!(await pathExists(extRoot))) return [];

  const entries = await readdir(extRoot, { withFileTypes: true });
  const results: Array<{
    id: string;
    manifest: ReturnType<typeof ExtensionManifestSchema.parse>;
  }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(extRoot, entry.name, 'extension.json');
    if (!(await pathExists(manifestPath))) continue;
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      const parsed = ExtensionManifestSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        results.push({ id: entry.name, manifest: parsed.data });
      }
    } catch {
      // Malformed JSON or unreadable file — surfaced elsewhere; skip here.
    }
  }

  return results;
}

/**
 * Read every `SKILL.md` under `<packagePath>/.dork/tasks/<name>/` via the
 * shared `@dorkos/skills` parser. Invalid SKILL files are skipped.
 */
async function readTaskSkills(
  packagePath: string
): Promise<Array<{ name: string; cron: string | null }>> {
  const tasksRoot = join(packagePath, '.dork', 'tasks');
  if (!(await pathExists(tasksRoot))) return [];

  const entries = await readdir(tasksRoot, { withFileTypes: true });
  const results: Array<{ name: string; cron: string | null }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(tasksRoot, entry.name, 'SKILL.md');
    if (!(await pathExists(skillPath))) continue;
    try {
      const content = await readFile(skillPath, 'utf-8');
      const parsed = parseSkillFile(skillPath, content, TaskFrontmatterSchema);
      if (parsed.ok) {
        results.push({
          name: parsed.definition.meta.name,
          cron: parsed.definition.meta.cron ?? null,
        });
      }
    } catch {
      // Unreadable SKILL.md — skip; validator surfaces these errors.
    }
  }

  return results;
}

/**
 * Extract slot IDs from an extension manifest's `contributions` map.
 * Slots are the keys whose value is `true`.
 */
function extractSlots(contributions: Record<string, boolean> | undefined): string[] {
  if (!contributions) return [];
  return Object.entries(contributions)
    .filter(([, enabled]) => enabled === true)
    .map(([slot]) => slot);
}

/**
 * Parse a single requires declaration of the form `<type>:<name>` or
 * `<type>:<name>@<version>`.
 */
function parseRequiresDeclaration(decl: string): { type: string; name: string; version?: string } {
  const colonIdx = decl.indexOf(':');
  const type = decl.slice(0, colonIdx);
  const rest = decl.slice(colonIdx + 1);
  const atIdx = rest.indexOf('@');
  if (atIdx === -1) {
    return { type, name: rest };
  }
  return { type, name: rest.slice(0, atIdx), version: rest.slice(atIdx + 1) };
}

/**
 * Resolve a single dependency declaration against the installed state on
 * disk. Plugin/skill-pack/adapter requirements are satisfied by a directory
 * under `<dorkHome>/plugins/<name>`; agent requirements by `<dorkHome>/agents/
 * <name>`.
 */
async function resolveRequirement(
  dorkHome: string,
  decl: string
): Promise<{ type: string; name: string; version?: string; satisfied: boolean }> {
  const parsed = parseRequiresDeclaration(decl);
  const root = parsed.type === 'agent' ? 'agents' : 'plugins';
  const candidate = join(dorkHome, root, parsed.name);
  const satisfied = await pathExists(candidate);
  return { ...parsed, satisfied };
}

/**
 * Builds {@link PermissionPreview} reports for marketplace package installs.
 *
 * Each `build()` call walks the staged package directory, reads the bundled
 * extension/task/adapter metadata, and resolves declared requirements against
 * the running system — without mutating any state.
 */
export class PermissionPreviewBuilder {
  /**
   * Construct a builder bound to a specific data directory and conflict
   * detector. Both dependencies are injected so the builder is fully
   * testable in isolation.
   *
   * @param dorkHome - Resolved DorkOS data directory (see `.claude/rules/dork-home.md`).
   * @param conflictDetector - Conflict detector consulted by every `build()`
   *   call to populate `preview.conflicts`.
   */
  constructor(
    private readonly dorkHome: string,
    private readonly conflictDetector: ConflictDetectorLike
  ) {}

  /**
   * Build a {@link PermissionPreview} for an already-fetched package staged at
   * `packagePath`. The preview enumerates:
   *
   * - `fileChanges` — every file the install will create or modify, with the
   *   destination resolved against `dorkHome` (or the project-local install
   *   root) per package type.
   * - `extensions` — every `.dork/extensions/<id>/extension.json` discovered
   *   in the package, expanded into `{ id, slots }` where `slots` are the
   *   extension's enabled `contributions` keys.
   * - `tasks` — every `.dork/tasks/<name>/SKILL.md` parsed via
   *   `@dorkos/skills`, captured as `{ name, cron }`.
   * - `secrets` — secret declarations sourced from each extension manifest's
   *   `serverCapabilities.secrets` array (deduplicated by `key`).
   * - `externalHosts` — hosts sourced from each extension manifest's
   *   `serverCapabilities.externalHosts` array (deduplicated). The
   *   marketplace manifest schema does not currently expose a top-level
   *   `externalHosts` field, so package-level hosts are not surfaced here.
   * - `requires` — `manifest.requires` declarations resolved against the
   *   installed packages under `<dorkHome>/plugins/` and `<dorkHome>/agents/`,
   *   tagged with `satisfied: boolean`.
   * - `conflicts` — every collision returned by the injected
   *   {@link ConflictDetectorLike} for the staged package against the active
   *   scope.
   *
   * @param packagePath - Absolute path to the staged package directory.
   * @param manifest - Parsed marketplace package manifest.
   * @param opts - Optional build options (e.g., project-local install path).
   */
  async build(
    packagePath: string,
    manifest: MarketplacePackageManifest,
    opts: BuildPreviewOptions = {}
  ): Promise<PermissionPreview> {
    const installRoot = opts.projectPath
      ? join(
          opts.projectPath,
          '.dork',
          manifest.type === 'agent' ? 'agents' : 'plugins',
          manifest.name
        )
      : computeInstallRoot(this.dorkHome, manifest);

    const preview: PermissionPreview = {
      fileChanges: [],
      extensions: [],
      tasks: [],
      secrets: [],
      externalHosts: [],
      requires: [],
      conflicts: [],
    };

    preview.fileChanges = await this.computeFileChanges(packagePath, installRoot);

    const extensionManifests = await readExtensionManifests(packagePath);
    preview.extensions = extensionManifests.map(({ id, manifest: extManifest }) => ({
      id,
      slots: extractSlots(extManifest.contributions),
    }));

    preview.tasks = await readTaskSkills(packagePath);
    preview.secrets = collectSecrets(extensionManifests);
    preview.externalHosts = collectExternalHosts(extensionManifests);
    preview.requires = await Promise.all(
      manifest.requires.map((decl) => resolveRequirement(this.dorkHome, decl))
    );

    preview.conflicts = await this.conflictDetector.detect({
      packagePath,
      manifest,
      dorkHome: this.dorkHome,
      projectPath: opts.projectPath,
    });

    return preview;
  }

  /**
   * Walk the staged package and emit a `fileChanges` entry for every file,
   * tagged `modify` if the destination already exists or `create` otherwise.
   */
  private async computeFileChanges(
    packagePath: string,
    installRoot: string
  ): Promise<PermissionPreview['fileChanges']> {
    const relativePaths = await walkPackageFiles(packagePath);
    const changes: PermissionPreview['fileChanges'] = [];
    for (const rel of relativePaths) {
      const destPath = join(installRoot, rel);
      const exists = await pathExists(destPath);
      changes.push({ path: destPath, action: exists ? 'modify' : 'create' });
    }
    return changes;
  }
}

/**
 * Collapse all extension secrets into a single deduplicated list keyed by
 * `secret.key`. The first occurrence wins.
 */
function collectSecrets(
  extensions: Array<{ manifest: ReturnType<typeof ExtensionManifestSchema.parse> }>
): PermissionPreview['secrets'] {
  const seen = new Map<string, PermissionPreview['secrets'][number]>();
  for (const { manifest } of extensions) {
    const declared = manifest.serverCapabilities?.secrets ?? [];
    for (const secret of declared) {
      if (seen.has(secret.key)) continue;
      seen.set(secret.key, {
        key: secret.key,
        required: secret.required,
        description: secret.description,
      });
    }
  }
  return Array.from(seen.values());
}

/**
 * Collapse all extension `externalHosts` into a single deduplicated list,
 * preserving first-seen order.
 */
function collectExternalHosts(
  extensions: Array<{ manifest: ReturnType<typeof ExtensionManifestSchema.parse> }>
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const { manifest } of extensions) {
    const hosts = manifest.serverCapabilities?.externalHosts ?? [];
    for (const host of hosts) {
      if (seen.has(host)) continue;
      seen.add(host);
      ordered.push(host);
    }
  }
  return ordered;
}

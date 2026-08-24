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
import { PackageTypeSchema } from '@dorkos/marketplace';
import { parseSkillFile } from '@dorkos/skills/parser';
import { TaskFrontmatterSchema } from '@dorkos/skills';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import { clampSchedulePermissionMode } from '../tasks/schedule-permission-clamp.js';
import { installRootDirForType } from './lib/install-roots.js';
import { readNpmDependencies } from './lib/npm-dependencies.js';
import { packageSchedules, scheduleDisplayName } from './lib/package-schedules.js';
import type {
  ConflictReport,
  PermissionPreview,
  PreviewHook,
  PreviewSchedule,
  UnreadablePreviewHook,
} from './types.js';

/** Directory names ignored when walking the package contents. */
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'dist']);

/** Package-relative path of a Claude-plugin hooks declaration. */
const HOOKS_FILE = 'hooks/hooks.json';

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
 * Computes the on-disk install root the preview's `fileChanges` paths resolve
 * against, via the shared type → install-root mapping (`lib/install-roots.ts`)
 * so the preview always shows the same destination the install flow writes to
 * — plugins/skill-packs/adapters under `plugins/`, agents under `agents/`,
 * Shapes under `shapes/`.
 *
 * Shapes are global-only (`install-shape.ts` accepts `projectPath` for
 * signature symmetry but ignores it), so a Shape preview always resolves
 * against `dorkHome` — showing a project-local destination the install would
 * never write to would be a lie.
 */
function computeInstallRoot(
  dorkHome: string,
  manifest: MarketplacePackageManifest,
  projectPath: string | undefined
): string {
  const rootDir = installRootDirForType(manifest.type);
  if (projectPath && manifest.type !== 'shape') {
    return join(projectPath, '.dork', rootDir, manifest.name);
  }
  return join(dorkHome, rootDir, manifest.name);
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
 *
 * A task SKILL.md declares its own permission mode (`permissions`, default
 * `acceptEdits`) and whether it is active on arrival (`enabled`, default
 * `true`), so a scheduled job from this source is disclosed with exactly the
 * same detail as a Shape's `schedules[]` entry — including the clamp. A file on
 * disk cannot arm an unattended bypass any more than a manifest can
 * (`services/tasks/schedule-permission-clamp.ts`), so reporting the raw
 * declaration would warn a person about a job the install would never create.
 * See {@link readManifestSchedules} for the whole of that reasoning.
 *
 * ## The one case this under-reports, said rather than papered over
 *
 * `upsertFromFile` lets a file KEEP a `bypassPermissions` the schedule row
 * already holds, when the row is active and its prompt and cron still match the
 * file. So re-installing a package over a task whose bypass a person raised
 * themselves, with byte-identical content, keeps that bypass while this preview
 * says `acceptEdits`.
 *
 * Reporting it truthfully means resolving each staged SKILL.md to its install
 * destination, reading the row there, and re-running the keep rule — a second
 * copy of the decision in the one place a drifting copy does most harm, plus a
 * `TaskStore` dependency on a builder that is otherwise pure. It is not worth
 * that: the case is narrow (an unchanged reinstall over a mode the person set),
 * and the direction of the error is under-claiming a permission the person
 * granted on that exact task and can see on it. Every case where the install
 * would GRANT more than the preview shows is already impossible — a changed
 * file, or a task that is not already raised, clamps.
 */
async function readTaskSkills(packagePath: string): Promise<PreviewSchedule[]> {
  const tasksRoot = join(packagePath, '.dork', 'tasks');
  if (!(await pathExists(tasksRoot))) return [];

  const entries = await readdir(tasksRoot, { withFileTypes: true });
  const results: PreviewSchedule[] = [];

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
          permissionMode: clampSchedulePermissionMode(parsed.definition.meta.permissions).mode,
          startsEnabled: parsed.definition.meta.enabled,
        });
      }
    } catch {
      // Unreadable SKILL.md — skip; validator surfaces these errors.
    }
  }

  return results;
}

/**
 * Read a Shape manifest's declared `schedules[]`. Non-Shape manifests carry no
 * such field and yield nothing.
 *
 * Both fields report what the install will ACTUALLY do, not what the package
 * asked for, because two apply-time rules override the manifest and a preview
 * that echoed the raw declaration would be wrong in the alarming direction:
 *
 * - `permissionMode` is run through the same clamp `apply-shape.ts` applies, so
 *   a Shape that requests `bypassPermissions` is disclosed as the mode it
 *   actually gets. Echoing the request would warn a person that an unattended
 *   job can run any command when the installer would never allow it. The same
 *   clamp covers `.dork/tasks/<name>/SKILL.md` (see {@link readTaskSkills}),
 *   because both sources end at the same schedule row — with one narrow
 *   under-report on the file path, named there.
 * - `startsEnabled` reads `startEnabled`, the field that decides this since
 *   DOR-607. The retired `startDisabled` is deliberately NOT consulted: it is
 *   declared in the schema only so apply-time can tell an author it is stale,
 *   and nothing reads its value. Inverting it here would report every schedule
 *   in a modern manifest as starting switched on, since the key is absent.
 *
 * `apply-shape.ts` may still force a schedule off when its bound agent is
 * missing at apply time, which cannot be known before the install runs, so a
 * `true` here remains the more permissive of the two possible outcomes.
 */
function readManifestSchedules(manifest: MarketplacePackageManifest): PreviewSchedule[] {
  // Every type that can declare a schedule is disclosed, not just Shapes
  // (DOR-1487). The gate here used to be `type !== 'shape'` because the slot was
  // Shape-only; leaving it would have made a plugin's cron the one kind of
  // unattended work a person approves an install without being shown.
  // `packageSchedules` also answers for `adapter`, which has no slot at all.
  return packageSchedules(manifest).map((schedule, index) => ({
    // A by-reference schedule is named by the skill it runs; an inline one
    // carries its own name.
    name: scheduleDisplayName(schedule, index),
    cron: schedule.cron,
    permissionMode: clampSchedulePermissionMode(schedule.permissionMode).mode,
    startsEnabled: schedule.startEnabled,
  }));
}

/**
 * Read a package's Claude-plugin hooks (`hooks/hooks.json`) into flat
 * `{ event, matcher?, command }` rows, plus the declarations that could not be
 * read.
 *
 * Parsing mirrors `readPluginHooks` in `packages/harness/src/sources/installed.ts`,
 * the reader that feeds Harness Sync, including its tolerance for both the
 * settings-style `{ hooks: {…} }` wrapper and a bare `{ Event: […] }` object.
 * It is reimplemented rather than imported because the harness copy is module
 * private, and because the two want different things from a bad declaration:
 * the projector only needs what it can use, while the preview has to say out
 * loud what it could not read. Every discarded declaration therefore comes back
 * in `unreadable`.
 *
 * Facts this function deliberately does NOT encode, because the preview's job
 * is to disclose what the package declares, not to predict every downstream
 * filter:
 *
 * - Those hooks only reach a harness settings file for a PROJECT-scoped install
 *   of a `plugin` or `skill-pack` (`installed.ts` records global installs as
 *   identity-only; `projector.ts` filters to `PROJECTABLE_PLUGIN_TYPES`), and
 *   only after a person approves that exact command set for that project
 *   (`services/harness/hook-approval.ts`, DOR-522). An agent or Shape ships its
 *   `hooks/hooks.json` to disk and nothing ever reads it. The UI therefore says
 *   the package "declares" these commands rather than that it "will run" them —
 *   this preview is read BEFORE installing, the approval card BEFORE running.
 * - `readPluginHooks` validates only that an event's value is an array; the
 *   group interior is unchecked, and malformed groups make the PROJECTOR throw
 *   rather than skip (tracked separately). This reader validates the interior
 *   too, which is why it can report a partially-bad file instead of dying on it.
 */
async function readPackageHooks(
  packagePath: string
): Promise<{ hooks: PreviewHook[]; unreadable: UnreadablePreviewHook[] }> {
  const hooksPath = join(packagePath, 'hooks', 'hooks.json');
  if (!(await pathExists(hooksPath))) return { hooks: [], unreadable: [] };

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(hooksPath, 'utf-8'));
  } catch {
    return { hooks: [], unreadable: [{ path: HOOKS_FILE }] };
  }

  // Accept both `{ hooks: {…} }` (settings-style) and a bare `{ Event: […] }` object.
  const hooksObj =
    raw && typeof raw === 'object' && 'hooks' in raw ? (raw as { hooks: unknown }).hooks : raw;
  if (!hooksObj || typeof hooksObj !== 'object') {
    return { hooks: [], unreadable: [{ path: HOOKS_FILE }] };
  }

  const hooks: PreviewHook[] = [];
  const unreadable: UnreadablePreviewHook[] = [];

  for (const [event, groups] of Object.entries(hooksObj as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      unreadable.push({ path: HOOKS_FILE, event });
      continue;
    }
    let salvaged = 0;
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      const { matcher, hooks: commands } = group as { matcher?: unknown; hooks?: unknown };
      if (!Array.isArray(commands)) continue;
      for (const command of commands) {
        if (!command || typeof command !== 'object') continue;
        const { command: text } = command as { command?: unknown };
        if (typeof text !== 'string' || text.length === 0) continue;
        hooks.push({
          event,
          ...(typeof matcher === 'string' && matcher.length > 0 ? { matcher } : {}),
          command: text,
        });
        salvaged += 1;
      }
    }
    // An event that declares matcher groups but yields no command string is a
    // declaration we failed to read, not an empty one.
    if (salvaged === 0 && groups.length > 0) unreadable.push({ path: HOOKS_FILE, event });
  }

  return { hooks, unreadable };
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
 * disk, probing the declared type's install root via the shared mapping
 * (`lib/install-roots.ts`): plugin/skill-pack/adapter requirements under
 * `<dorkHome>/plugins/<name>`, agents under `<dorkHome>/agents/<name>`,
 * Shapes under `<dorkHome>/shapes/<name>`. A declaration whose type is not a
 * known package type falls back to the `plugins/` root (the pre-mapping
 * behavior for unrecognized types).
 */
async function resolveRequirement(
  dorkHome: string,
  decl: string
): Promise<{ type: string; name: string; version?: string; satisfied: boolean }> {
  const parsed = parseRequiresDeclaration(decl);
  const parsedType = PackageTypeSchema.safeParse(parsed.type);
  const root = parsedType.success ? installRootDirForType(parsedType.data) : 'plugins';
  const candidate = join(dorkHome, root, parsed.name);
  const satisfied = await pathExists(candidate);
  return { ...parsed, satisfied };
}

/**
 * Builds {@link PermissionPreview} reports for marketplace package installs.
 *
 * Each `build()` call walks the staged package directory, reads the bundled
 * extension/task/hook/adapter metadata, and resolves declared requirements
 * against the running system — without mutating any state.
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
   * - `hooks` — every shell command declared in the package's
   *   `hooks/hooks.json`, flattened to `{ event, matcher?, command }` with the
   *   command string kept verbatim.
   * - `unreadableHooks` — every hook declaration the package ships that could
   *   not be parsed. Reported separately so "declares hooks we could not read"
   *   never renders as "declares no hooks".
   * - `schedules` — every scheduled job the install creates, from both
   *   `.dork/tasks/<name>/SKILL.md` (parsed via `@dorkos/skills`) and a Shape
   *   manifest's `schedules[]`, captured as
   *   `{ name, cron, permissionMode, startsEnabled }`.
   * - `secrets` — secret declarations sourced from each extension manifest's
   *   `serverCapabilities.secrets` array (deduplicated by `key`).
   * - `npmDependencies` — the `dependencies` map of the package's own
   *   `package.json`, so the dialog can say which libraries the install will
   *   fetch from the npm registry before the person approves that network call
   *   (DOR-1341). Only the package root is read; nested workspaces are not
   *   chased. `node_modules` stays out of `fileChanges` as it always has —
   *   listing thousands of vendored files would bury the package's own.
   * - `externalHosts` — hosts sourced from each extension manifest's
   *   `serverCapabilities.externalHosts` array (deduplicated). The
   *   marketplace manifest schema does not currently expose a top-level
   *   `externalHosts` field, so package-level hosts are not surfaced here.
   * - `requires` — `manifest.requires` declarations resolved against the
   *   installed packages under every global install root (`plugins/`,
   *   `agents/`, `shapes/`), tagged with `satisfied: boolean`.
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
    const installRoot = computeInstallRoot(this.dorkHome, manifest, opts.projectPath);

    const preview: PermissionPreview = {
      fileChanges: [],
      extensions: [],
      hooks: [],
      unreadableHooks: [],
      schedules: [],
      secrets: [],
      npmDependencies: [],
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

    const hookDeclarations = await readPackageHooks(packagePath);
    preview.hooks = hookDeclarations.hooks;
    preview.unreadableHooks = hookDeclarations.unreadable;

    preview.schedules = [
      ...(await readTaskSkills(packagePath)),
      ...readManifestSchedules(manifest),
    ];
    preview.secrets = collectSecrets(extensionManifests);
    preview.npmDependencies = await readNpmDependencies(packagePath);
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

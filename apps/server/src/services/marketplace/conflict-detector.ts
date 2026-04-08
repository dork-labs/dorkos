/**
 * Conflict detector for marketplace package installs.
 *
 * Scans the current installed state under `${dorkHome}/plugins/` and the
 * staged package directory for the six collision classes the install spec
 * defines. Severity errors block install (unless `--force`); warnings
 * surface in the permission preview but allow the user to proceed.
 *
 * @module services/marketplace/conflict-detector
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import matter from 'gray-matter';
import type { MarketplacePackageManifest } from '@dorkos/marketplace';
import type { AdapterManager } from '../relay/adapter-manager.js';
import type { ConflictReport } from './types.js';

/**
 * Input to {@link ConflictDetector.detect}. Captures everything the
 * detector needs to compare a staged package against the active scope.
 *
 * The `dorkHome` field mirrors the spec's API surface for cross-call
 * traceability, but the detector reads its own constructor-supplied
 * `dorkHome` (per `.claude/rules/dork-home.md` — no fallback chains).
 * If both are set they must agree; the constructor value wins.
 */
export interface ConflictDetectionContext {
  /** Path to the staged package directory being installed. */
  packagePath: string;
  /** Parsed package manifest. */
  manifest: MarketplacePackageManifest;
  /** Active dorkHome — informational; constructor value is authoritative. */
  dorkHome: string;
  /** Optional project path (for project-local scope checks). */
  projectPath?: string;
}

/** A slot binding contributed by an extension manifest (`extension.json`). */
interface SlotBinding {
  slot: string;
  priority: number;
}

/** A scanned extension record from disk: id + every slot it binds. */
interface ExtensionRecord {
  packageName: string;
  extensionId: string;
  bindings: SlotBinding[];
}

/** A scanned SKILL.md record: name + cron field (if any) + owning package. */
interface SkillRecord {
  packageName: string;
  skillName: string;
  cron: string | null;
}

/**
 * Detect collisions between an incoming marketplace package and the
 * currently-installed set. Run before any disk mutation; the result is
 * surfaced in the permission preview.
 */
export class ConflictDetector {
  readonly #dorkHome: string;
  readonly #adapterManager: AdapterManager;

  /**
   * Construct a detector bound to a specific dorkHome and adapter manager.
   *
   * @param dorkHome - Resolved DorkOS data directory (no fallback chain).
   * @param adapterManager - Adapter manager — used to read current adapters.
   */
  constructor(dorkHome: string, adapterManager: AdapterManager) {
    this.#dorkHome = dorkHome;
    this.#adapterManager = adapterManager;
  }

  /**
   * Detect every collision between the staged package and the active
   * scope. Returns an empty array on a clean state.
   *
   * The six rules:
   *
   * 1. Package name — installed plugin/agent directory with the same name.
   * 2. Slot — staged extension binds same `slot` + `priority` as installed.
   * 3. Skill name — staged SKILL.md `name` matches an installed one.
   *    (Tasks share this rule because foundation only ships SKILL.md; a
   *    separate task manifest does not exist yet.)
   * 4. Cron — staged task SKILL.md shares the same minute field as
   *    an installed one (string compare; no cron parsing in v1).
   * 5. Adapter id — adapter package whose `adapterType` matches an
   *    installed adapter `id` from {@link AdapterManager.listAdapters}.
   * 6. (Task name collapses into rule 3 — see above.)
   *
   * @param ctx - Detection context (staged path, manifest, scope roots).
   * @returns A list of {@link ConflictReport}s, possibly empty.
   */
  async detect(ctx: ConflictDetectionContext): Promise<ConflictReport[]> {
    const reports: ConflictReport[] = [];
    const scopeRoot = ctx.projectPath ?? this.#dorkHome;

    const installedExtensions = await this.#readInstalledExtensions(scopeRoot);
    const installedSkills = await this.#readInstalledSkills(scopeRoot);
    const stagedExtensions = await this.#readPackageExtensions(ctx.packagePath, ctx.manifest.name);
    const stagedSkills = await this.#readPackageSkills(ctx.packagePath, ctx.manifest.name);

    reports.push(...(await this.#detectPackageNameConflict(ctx, scopeRoot)));
    reports.push(...this.#detectSlotConflicts(stagedExtensions, installedExtensions));
    reports.push(...this.#detectSkillNameConflicts(stagedSkills, installedSkills));
    reports.push(...this.#detectCronConflicts(stagedSkills, installedSkills));
    reports.push(...this.#detectAdapterIdConflict(ctx));

    return reports;
  }

  /**
   * Rule 1 — package name collision. Errors if `${scope}/plugins/<name>`
   * or `${scope}/agents/<name>` already exists.
   */
  async #detectPackageNameConflict(
    ctx: ConflictDetectionContext,
    scopeRoot: string
  ): Promise<ConflictReport[]> {
    const candidates = [
      join(scopeRoot, 'plugins', ctx.manifest.name),
      join(scopeRoot, 'agents', ctx.manifest.name),
    ];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        return [
          {
            level: 'error',
            type: 'package-name',
            description: `A package named "${ctx.manifest.name}" is already installed at this scope.`,
            conflictingPackage: ctx.manifest.name,
          },
        ];
      }
    }
    return [];
  }

  /**
   * Rule 2 — UI slot collisions at identical `slot` + `priority`.
   * Warning, because last-installed wins (ideation decision #6).
   */
  #detectSlotConflicts(staged: ExtensionRecord[], installed: ExtensionRecord[]): ConflictReport[] {
    const reports: ConflictReport[] = [];
    for (const stagedExt of staged) {
      for (const stagedBinding of stagedExt.bindings) {
        reports.push(...findSlotCollisions(stagedBinding, installed));
      }
    }
    return reports;
  }

  /**
   * Rule 3 — skill (and task) name collisions. Errors because two
   * SKILL.md files with the same `name` cannot coexist at the same scope.
   */
  #detectSkillNameConflicts(staged: SkillRecord[], installed: SkillRecord[]): ConflictReport[] {
    const reports: ConflictReport[] = [];
    for (const stagedSkill of staged) {
      const collision = installed.find((s) => s.skillName === stagedSkill.skillName);
      if (collision) {
        reports.push({
          level: 'error',
          type: 'skill-name',
          description: `A skill named "${stagedSkill.skillName}" is already installed by package "${collision.packageName}".`,
          conflictingPackage: collision.packageName,
        });
      }
    }
    return reports;
  }

  /**
   * Rule 4 — cron collisions. Heuristic: two tasks whose cron expressions
   * share the same minute field (first whitespace-delimited token) are
   * flagged. No cron AST parsing in v1.
   */
  #detectCronConflicts(staged: SkillRecord[], installed: SkillRecord[]): ConflictReport[] {
    const reports: ConflictReport[] = [];
    for (const stagedSkill of staged) {
      const stagedMinute = extractMinuteField(stagedSkill.cron);
      if (stagedMinute === null) continue;
      for (const installedSkill of installed) {
        const installedMinute = extractMinuteField(installedSkill.cron);
        if (installedMinute === null) continue;
        if (stagedMinute === installedMinute) {
          reports.push({
            level: 'warning',
            type: 'cron-collision',
            description: `Task "${stagedSkill.skillName}" shares its cron minute field "${stagedMinute}" with task "${installedSkill.skillName}" from package "${installedSkill.packageName}".`,
            conflictingPackage: installedSkill.packageName,
          });
        }
      }
    }
    return reports;
  }

  /**
   * Rule 5 — adapter type collisions. Only runs for adapter packages; the
   * staged `adapterType` is compared against the `type` field of every
   * adapter currently registered with {@link AdapterManager.listAdapters}.
   *
   * The install flow registers adapters via `addAdapter(adapterType, name, ...)`,
   * which stores the package name on `config.id` and the adapter family on
   * `config.type`. So the collision check has to compare against
   * `entry.config.type` — comparing against `entry.config.id` would only
   * fire when a package happened to be named after its adapter family,
   * which is the exception, not the rule.
   */
  #detectAdapterIdConflict(ctx: ConflictDetectionContext): ConflictReport[] {
    if (ctx.manifest.type !== 'adapter') return [];
    const stagedType = ctx.manifest.adapterType;
    const installed = this.#adapterManager.listAdapters();
    const collision = installed.find((entry) => entry.config.type === stagedType);
    if (!collision) return [];
    return [
      {
        level: 'error',
        type: 'adapter-id',
        description: `An adapter of type "${stagedType}" is already configured (installed package: "${collision.config.id}").`,
        conflictingPackage: collision.config.id,
      },
    ];
  }

  /**
   * Walk every installed plugin under `${scopeRoot}/plugins/*` and read
   * each `.dork/extensions/*\/extension.json`. Malformed JSON is silently
   * skipped — the detector is best-effort, not a validator.
   */
  async #readInstalledExtensions(scopeRoot: string): Promise<ExtensionRecord[]> {
    const pluginsRoot = join(scopeRoot, 'plugins');
    const packageNames = await listSubdirectories(pluginsRoot);
    const records: ExtensionRecord[] = [];
    for (const packageName of packageNames) {
      const packageRoot = join(pluginsRoot, packageName);
      records.push(...(await this.#readPackageExtensions(packageRoot, packageName)));
    }
    return records;
  }

  /**
   * Walk every installed plugin under `${scopeRoot}/plugins/*` and read
   * `.dork/tasks/**\/SKILL.md` for each. Returns one record per SKILL.md.
   */
  async #readInstalledSkills(scopeRoot: string): Promise<SkillRecord[]> {
    const pluginsRoot = join(scopeRoot, 'plugins');
    const packageNames = await listSubdirectories(pluginsRoot);
    const records: SkillRecord[] = [];
    for (const packageName of packageNames) {
      const packageRoot = join(pluginsRoot, packageName);
      records.push(...(await this.#readPackageSkills(packageRoot, packageName)));
    }
    return records;
  }

  /**
   * Read every `extension.json` under `${packageRoot}/.dork/extensions/*`.
   * Slot bindings without numeric `priority` are coerced to `0`.
   */
  async #readPackageExtensions(
    packageRoot: string,
    packageName: string
  ): Promise<ExtensionRecord[]> {
    const extensionsDir = join(packageRoot, '.dork', 'extensions');
    const extensionIds = await listSubdirectories(extensionsDir);
    const records: ExtensionRecord[] = [];
    for (const extensionId of extensionIds) {
      const manifestPath = join(extensionsDir, extensionId, 'extension.json');
      const bindings = await readSlotBindings(manifestPath);
      records.push({ packageName, extensionId, bindings });
    }
    return records;
  }

  /**
   * Read every `SKILL.md` under `${packageRoot}/.dork/tasks/*`. Returns
   * one record per skill, with the cron field (if any) extracted from
   * the gray-matter frontmatter.
   */
  async #readPackageSkills(packageRoot: string, packageName: string): Promise<SkillRecord[]> {
    const tasksDir = join(packageRoot, '.dork', 'tasks');
    const skillNames = await listSubdirectories(tasksDir);
    const records: SkillRecord[] = [];
    for (const skillName of skillNames) {
      const skillPath = join(tasksDir, skillName, 'SKILL.md');
      const cron = await readSkillCron(skillPath);
      if (cron === undefined) continue;
      records.push({ packageName, skillName, cron });
    }
    return records;
  }
}

/**
 * Best-effort directory listing. Returns `[]` when the path is missing
 * or unreadable so the detector keeps running on partial filesystems.
 */
async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Best-effort `stat` to test for path existence without throwing. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read an `extension.json` and pull `.slots[]` entries. Coerces non-numeric
 * priority to `0` and silently drops malformed entries.
 */
async function readSlotBindings(manifestPath: string): Promise<SlotBinding[]> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const slots = (parsed as { slots?: unknown }).slots;
  if (!Array.isArray(slots)) return [];
  const bindings: SlotBinding[] = [];
  for (const entry of slots) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as { slot?: unknown; priority?: unknown };
    if (typeof candidate.slot !== 'string') continue;
    const priority = typeof candidate.priority === 'number' ? candidate.priority : 0;
    bindings.push({ slot: candidate.slot, priority });
  }
  return bindings;
}

/**
 * Read a SKILL.md file and return its `cron` frontmatter field. Returns
 * `null` when the file exists but has no cron, and `undefined` when the
 * file is missing or unreadable (so callers can skip the record entirely).
 */
async function readSkillCron(skillPath: string): Promise<string | null | undefined> {
  let raw: string;
  try {
    raw = await readFile(skillPath, 'utf-8');
  } catch {
    return undefined;
  }
  let data: Record<string, unknown>;
  try {
    data = matter(raw).data;
  } catch {
    return null;
  }
  const cron = data.cron;
  return typeof cron === 'string' && cron.length > 0 ? cron : null;
}

/**
 * Extract the minute field (first whitespace-delimited token) from a cron
 * expression. Returns `null` for empty/missing input.
 */
function extractMinuteField(cron: string | null): string | null {
  if (!cron) return null;
  const trimmed = cron.trim();
  if (!trimmed) return null;
  const minute = trimmed.split(/\s+/)[0];
  return minute ?? null;
}

/**
 * Find every installed extension that binds the same slot at the same
 * priority as `stagedBinding`. Extracted to keep
 * {@link ConflictDetector.detectSlotConflicts} below the nesting budget.
 */
function findSlotCollisions(
  stagedBinding: SlotBinding,
  installed: ExtensionRecord[]
): ConflictReport[] {
  const reports: ConflictReport[] = [];
  for (const installedExt of installed) {
    const collides = installedExt.bindings.some(
      (b) => b.slot === stagedBinding.slot && b.priority === stagedBinding.priority
    );
    if (!collides) continue;
    reports.push({
      level: 'warning',
      type: 'slot',
      description: `Slot "${stagedBinding.slot}" at priority ${stagedBinding.priority} is already bound by package "${installedExt.packageName}". Last-installed wins.`,
      conflictingPackage: installedExt.packageName,
    });
  }
  return reports;
}

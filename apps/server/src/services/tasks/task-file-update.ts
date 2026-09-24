/**
 * Editing a scheduled task's SKILL.md without damaging it.
 *
 * `PATCH /api/tasks/:id` writes the file first and the row second, which is
 * right — the file is the source of truth. What it used to write was not. Three
 * separate ways it could destroy a file, all found in the DOR-1485 review:
 *
 * 1. **It rewrote the file on every PATCH, including ones that changed nothing
 *    in it.** Approving a schedule sends `status` alone, which lives in the row
 *    and nowhere else; there was still a full read-merge-write of the file
 *    behind it. Every hazard below was therefore reachable by clicking Approve.
 * 2. **It merged the PARSED frontmatter back to disk.** Since schedulability
 *    became a frontmatter property, an unreadable `schedule:` block parses to a
 *    complaint object — so the rewrite replaced the author's `cron` with
 *    `{invalid, problem}`, and the next read saw an empty, valid block: the
 *    schedule silently became on-demand and the complaint disappeared.
 * 3. **It wrote scheduling fields at the TOP level.** On a block-backed file a
 *    cron edit landed as top-level `cron:` while `schedule.cron` kept the old
 *    value — the row and the file then disagreed forever, and each sync reverted
 *    the row and re-parked it.
 *
 * The rules that replace them:
 *
 * - A request that touches nothing in the file does not open the file.
 * - A rewrite is built from the RAW frontmatter (`readRawFrontmatter`), so
 *   nothing the schema invented, dropped, or reshaped is ever persisted.
 * - Scheduling fields go into the `schedule:` block through
 *   `scheduleToFrontmatter`, always. Until DOR-1486 there was a second branch
 *   here that wrote them at the top level for a legacy file; there are no legacy
 *   files any more, and a file that arrives without a block gets one rather than
 *   growing the old shape back.
 * - A file DorkOS cannot fully read is not edited at all, and a file an
 *   installed package owns is never written by us.
 *
 * @module services/tasks/task-file-update
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import {
  hasSchedule,
  scheduleProblem,
  scheduleToFrontmatter,
  ScheduleBlockSchema,
  type ScheduleBlock,
} from '@dorkos/skills';
import { parseSkillFile, readRawFrontmatter } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { PACKAGE_MANIFEST_PATH } from '@dorkos/marketplace/constants';
import { matchesUserEditable } from '@dorkos/marketplace';
import { installRootsUnder, projectScopeRoot } from '../marketplace/lib/install-roots.js';
import { INSTALL_METADATA_PATH } from '../marketplace/installed-metadata.js';
import { readInstalledFiles, type InstalledFiles } from '../marketplace/lib/installed-files.js';
import { mergeTaskFrontmatter, type TaskFrontmatterWrite } from './task-frontmatter-merge.js';
import type { TaskRoot } from './skills-roots.js';
import { describeScheduleProblem } from './cron-validation.js';

/**
 * Request field → the row column holding the same value, for the fields that
 * live in the SKILL.md.
 *
 * `maxRuntime` is deliberately absent: the request carries a duration string
 * (`30m`) and the row holds milliseconds, so the two cannot be compared without
 * parsing. It is handled as always-touching below — the conservative direction.
 */
const FILE_BACKED_COLUMN = {
  name: 'name',
  displayName: 'displayName',
  description: 'description',
  cron: 'cron',
  timezone: 'timezone',
  enabled: 'enabled',
  sticky: 'sticky',
  permissionMode: 'permissionMode',
  prompt: 'prompt',
  // The execution trio (DOR-1615/DOR-1347). Comparable against the row directly:
  // the request spells "no override" as `null` and so does the column, so a
  // re-sent current value is correctly read as no change and opens no file.
  runtime: 'runtime',
  model: 'model',
  effort: 'effort',
} as const satisfies Record<string, string>;

/** The row columns {@link touchesFile} compares a request against. */
export interface FileBackedRow {
  name: string;
  displayName?: string | null;
  description?: string | null;
  cron?: string | null;
  timezone?: string | null;
  enabled: boolean;
  sticky: boolean;
  permissionMode: string;
  prompt: string;
  /** Which runtime the task's runs execute on; `null` = follow the agent. */
  runtime?: string | null;
  /** The model its runs execute on; `null` = follow the agent and the server default. */
  model?: string | null;
  /** The reasoning-effort rung its runs execute at; `null` = follow the agent. */
  effort?: string | null;
}

/**
 * Whether this request CHANGES anything that lives in the SKILL.md.
 *
 * Not "mentions" — changes. That distinction is the whole fix for B1: the
 * cockpit's Approve button sends `{status, enabled: true}` together, always,
 * because a schedule approved but left switched off would never run. `enabled`
 * does live in the file, so a request that merely mentions it looks
 * file-worthy — and every Approve would then drag the person's own SKILL.md
 * through a read-merge-write that had nothing to write.
 *
 * Comparing against the row is what makes Approve free of the file entirely:
 * `enabled: true` on a row that is already enabled is not a change, so nothing
 * is opened, nothing is merged, and nothing can be lost.
 *
 * A field the row cannot be compared on (`maxRuntime`, which the request sends
 * as a duration string and the row holds in milliseconds) counts as a change
 * whenever it is present. That errs toward writing a file that did not need it,
 * never toward skipping one that did.
 *
 * @param data - The validated update request body.
 * @param existing - The row as it stands, or undefined to skip comparison.
 * @returns True when the file has to be rewritten.
 */
export function touchesFile(data: Record<string, unknown>, existing?: FileBackedRow): boolean {
  return fileBackedChanges(data, existing).length > 0;
}

/**
 * WHICH file-backed fields this request changes, by request-field name.
 *
 * The same comparison {@link touchesFile} makes, kept rather than reduced to a
 * boolean, because one caller needs to know what changed and not merely that
 * something did: a schedule an installed package owns may still be switched on
 * and off, and telling that request apart from a cron edit is exactly the
 * difference between the two (FB-26). See {@link landsOnRowAlone}.
 *
 * `maxRuntime` reports as changed whenever it is present, for the reason
 * {@link FILE_BACKED_COLUMN} gives: the request spells it as a duration string
 * and the row holds milliseconds, so the two cannot be compared here.
 *
 * @param data - The validated update request body.
 * @param existing - The row as it stands, or undefined to skip comparison.
 * @returns The changed fields, in {@link FILE_BACKED_COLUMN} order.
 */
export function fileBackedChanges(
  data: Record<string, unknown>,
  existing?: FileBackedRow
): string[] {
  const changed = Object.entries(FILE_BACKED_COLUMN)
    .filter(([field, column]) => {
      const value = data[field];
      if (value === undefined) return false;
      if (!existing) return true;
      const current = existing[column as keyof FileBackedRow];
      // `null` in a request means "clear it"; the row spells an absent optional
      // as `null` too, so the two compare directly.
      return value !== current;
    })
    .map(([field]) => field);
  return data.maxRuntime !== undefined ? [...changed, 'maxRuntime'] : changed;
}

/**
 * The file-backed fields a PACKAGE-OWNED schedule may still change, because
 * they can be applied to the row alone.
 *
 * The reasoning is the refusal's own promise: "you can switch this schedule on
 * or off, or change when it runs, here; to change what it does, edit the
 * package". Those are the person's decisions about a schedule they did not
 * write, and they have nowhere to live but the row — DorkOS never writes a
 * file inside somebody else's checkout.
 *
 * - `enabled` is the switch (FB-26), kept on the row by the sync
 *   (`file-sync-gates.ts`, `keepsRowEnabled`).
 * - `cron` and `timezone` become the row's timing OVERRIDE (DOR-2302): the
 *   file's timing stays the default the sync keeps writing, and the person's
 *   wins (`timing/effective-timing.ts`). A change to either is still a change
 *   to when the approved work runs, which the caller settles
 *   (`TaskStore.settleTimingChange`).
 *
 * Everything else in {@link FILE_BACKED_COLUMN} describes what the schedule
 * DOES, which is the package's to say and stays refused.
 *
 * `status` is absent because it was never here: it lives in the row and nowhere
 * else, so approving and parking never touched the file in the first place.
 */
const ROW_ONLY_WHEN_PACKAGE_OWNED: ReadonlySet<string> = new Set(['enabled', 'cron', 'timezone']);

/**
 * Whether a package-owned schedule can take this change without its file being
 * written (FB-26).
 *
 * Asked only of a file an installed package owns. Every field has to qualify:
 * a request that switches a schedule off AND re-writes its cron is still a
 * request to edit the package, and letting the row-only half through would
 * apply half of what the caller asked for.
 *
 * @param changed - The changed file-backed fields, from {@link fileBackedChanges}.
 * @returns True when the row can absorb all of them.
 */
export function landsOnRowAlone(changed: readonly string[]): boolean {
  return changed.every((field) => ROW_ONLY_WHEN_PACKAGE_OWNED.has(field));
}

/**
 * Everything {@link packageOwnershipOf} needs to find the install roots a task's
 * file might sit in.
 *
 * Three ways to reach an install root, because a package reaches a schedule
 * three ways and no one of them subsumes the others. Each only NAMES a
 * candidate install root; the root's own installed-files record then decides
 * (DOR-2272). A way that cannot answer (no mesh, no such root on disk) names
 * nothing, rather than exempting anything.
 */
export interface PackageOwnershipContext {
  /**
   * Directories holding only installs — the `plugins/` and `shapes/` install
   * roots of every scope in view. For an install here with no record, being
   * inside it is the whole legacy answer.
   */
  packageOnlyRoots: string[];
  /**
   * The `agents/` install roots — shared with the agents a person makes, so an
   * install here with no record is only a package when it carries a marker.
   */
  sharedInstallRoots: string[];
  /**
   * The owning agent's own directory, when mesh could name one. Not a root to
   * search: the candidate package checkout ITSELF.
   */
  agentDir?: string;
}

/**
 * Build the ownership context for a task, from the data directory and the
 * owning agent's directory.
 *
 * **`agentDir` is the agent's own directory, not a project to search under.**
 * That is what `meshCore.getProjectPath(agentId)` returns — `registry.projectPath`,
 * the directory holding the agent's `.dork/agent.json`. For an agent that came
 * from a package, that directory IS the install: `<dorkHome>/agents/<name>` for a
 * global install, `<repo>/.dork/agents/<name>` for a project-scoped one.
 *
 * ## Why all three, and why neither alone
 *
 * The FIRST version of this fix asked only whether the file sat under an
 * `agents/` root. That misses a project-scoped agent package entirely: the scope
 * root derived from `agentDir` is `<agentDir>/.dork`, whose roots are
 * `<agentDir>/.dork/{plugins,agents,shapes}` — never `<repo>/.dork/agents`, the
 * one root that would have caught it. That ancestor is not derivable from
 * anything the route holds (DOR-1789 review).
 *
 * The SECOND version replaced the `agents/` walk with the `agentDir` probe,
 * which fixed that — and made mesh load-bearing for the whole answer. Three
 * production-reachable states then answered `false` where the first version had
 * answered `true`: mesh failing to initialize (`meshCore` undefined, so every
 * package file becomes writable), an agent no longer in the registry (its rows
 * survive and stay patchable), and a file reached through a symlink from a
 * skills root belonging to some OTHER agent, whose `agentDir` does not contain
 * it. A protection that evaporates when a dependency is missing is worse than a
 * narrower one that does not (DOR-1789 re-review).
 *
 * So the `agents/` walk stays BESIDE the probe rather than instead of it.
 *
 * @param dorkHome - The resolved data directory.
 * @param agentDir - The owning agent's own directory, when mesh named one.
 * @returns The roots to search and the directory to probe.
 */
export function packageOwnershipContext(
  dorkHome: string,
  agentDir?: string
): PackageOwnershipContext {
  const scopeRoots = [dorkHome, ...(agentDir ? [projectScopeRoot(agentDir)] : [])];
  const roots = scopeRoots.flatMap((scopeRoot) => installRootsUnder(scopeRoot));
  return {
    packageOnlyRoots: roots.filter((r) => r.packagesOnly).map((r) => r.dir),
    sharedInstallRoots: roots.filter((r) => !r.packagesOnly).map((r) => r.dir),
    ...(agentDir ? { agentDir } : {}),
  };
}

/**
 * The ownership context for a file found in a SKILLS ROOT, derived from the
 * root itself.
 *
 * Discovery has no `dorkHome` and no mesh — it has the root it is walking — so
 * it cannot build {@link packageOwnershipContext} the way a route does. It does
 * not need to: a skills root is fed by the installs of its OWN scope, which is
 * the pairing `pluginsRootFor` already writes down for the reconciler's
 * retirement gate (DOR-1934). The global root `<dorkHome>/skills` is fed by
 * `<dorkHome>/…`, and a project's `.agents/skills` by that project's `.dork/…`.
 *
 * The agent probe rides along for a project root, where the project path IS the
 * agent's own directory — the same value `meshCore.getProjectPath` hands the
 * route — so a schedule shipped inside an installed agent package is recognised
 * here too.
 *
 * @param root - The skills root the file was discovered in.
 * @returns The roots to search and the directory to probe.
 */
export function rootPackageOwnershipContext(root: TaskRoot): PackageOwnershipContext {
  if (root.scope === 'global') return packageOwnershipContext(path.dirname(root.dir));
  // A project root that does not say which project it belongs to can answer
  // nothing, and `packageOwnershipContext` with no scope of its own would
  // search the filesystem root. An empty context answers `false`, which is the
  // conservative direction for a read: the file is treated as ordinary.
  if (root.projectPath === undefined) {
    return { packageOnlyRoots: [], sharedInstallRoots: [] };
  }
  const roots = installRootsUnder(projectScopeRoot(root.projectPath));
  return {
    packageOnlyRoots: roots.filter((r) => r.packagesOnly).map((r) => r.dir),
    sharedInstallRoots: roots.filter((r) => !r.packagesOnly).map((r) => r.dir),
    agentDir: root.projectPath,
  };
}

/**
 * Whether a file discovered in a skills root belongs to an installed package —
 * {@link isPackageOwned}, asked the way discovery can ask it.
 *
 * Discovery asks because ownership decides more than whether DorkOS may WRITE
 * the file: a file DorkOS refuses to write can never record a person's decision
 * to switch its schedule on, so that decision lives on the row and the sync must
 * not overwrite it (FB-26, `file-sync-gates.ts`).
 *
 * @param filePath - The schedule's file, already resolved by discovery.
 * @param root - The skills root it was discovered in.
 * @returns True when an installed package owns it.
 */
export async function isPackageOwnedInRoot(filePath: string, root: TaskRoot): Promise<boolean> {
  return isPackageOwned(filePath, rootPackageOwnershipContext(root));
}

/**
 * The files whose presence in a directory say an install put it there, asked
 * only of an install root that has no installed-files record.
 *
 * `.dork/manifest.json` is the marketplace's own marker for a package on disk —
 * what `scanPackageDirectory` looks for and what the installed scanner reads.
 * `.dork/install-metadata.json` is the install's provenance sidecar, written
 * after every successful install. Either is enough; existence is the test, not
 * readability: a manifest DorkOS cannot parse still means an install lives here.
 */
const PACKAGE_MARKERS = [PACKAGE_MANIFEST_PATH, INSTALL_METADATA_PATH];

/**
 * Who a schedule's file belongs to, and how DorkOS knows.
 *
 * `record`: the install root's installed-files record lists it. `legacy`: the
 * install predates records and the location-and-marker answer claimed it.
 */
export type PackageOwnership = { owned: false } | { owned: true; by: 'record' | 'legacy' };

/** An install root a file sits in, and how to answer for it without a record. */
interface CandidateInstall {
  /** The install root, resolved. */
  installRoot: string;
  /** With no record: `location` claims the file outright; `marker` needs a marker. */
  legacy: 'location' | 'marker';
}

/**
 * Whether this file belongs to an installed marketplace package, and how that
 * is known.
 *
 * A file DorkOS writes inside a package's install root is kept or undone by the
 * package's next update, and the installed-files record says which (DOR-2245):
 * a file the record lists is replaced by the package's own copy unless the
 * package marked it `userEditable`, and every file it does not list survives.
 * So a file is the package's exactly when its install's record lists it (in
 * `files` or under `ownedPaths`) and it does not match `userEditable`.
 *
 * **The bytes are deliberately not compared.** `isProvenPackageFile` also
 * requires them to match, which answers "may DorkOS delete this?" — a different
 * question. An edited shipped file fails that test and is still replaced by the
 * next update, so writing it would lose the edit to a `.dork-old` copy. The same
 * holds for a `skillRef` schedule rewritten after its record was taken.
 *
 * A record left by an uninstall (`uninstalledAt`) lists only the edited files
 * it kept, with no package left to put anything back: it claims nothing.
 *
 * **An install with no record** (made before DOR-2245, not yet updated) keeps
 * the DOR-1789 answer, asked per install: a plugin or Shape install claims every
 * file in it by location, and an `agents/` install or the owning agent's own
 * directory claims every file in it when it carries a {@link PACKAGE_MARKERS}
 * file. That fallback shrinks to nothing as installs are updated, because an
 * update writes a record.
 *
 * Candidates come from the three ways in {@link PackageOwnershipContext}, and any
 * one claiming the file is enough: a plugin installed at project scope inside an
 * agent package's directory is claimed by the plugin's record even though the
 * agent's record does not list it.
 *
 * Paths are resolved before comparing — the file because a link from a skills
 * root into a package is the ordinary case, and the roots because a data
 * directory under a symlinked parent is ordinary too (every macOS temp
 * directory is one). A file that does not exist yet (the create door asks
 * before writing) is resolved through its deepest existing ancestor.
 *
 * @param filePath - The file the caller is about to write.
 * @param ctx - Roots and agent directory, from {@link packageOwnershipContext}.
 * @returns Whether a package owns it, and whether a record or the legacy
 *   answer said so.
 */
export async function packageOwnershipOf(
  filePath: string,
  ctx: PackageOwnershipContext
): Promise<PackageOwnership> {
  const resolvedFile = await resolveThroughExisting(filePath);
  for (const candidate of await candidateInstalls(resolvedFile, ctx)) {
    const record = await readInstalledFiles(candidate.installRoot);
    if (record) {
      if (recordClaims(record, toPosix(path.relative(candidate.installRoot, resolvedFile)))) {
        return { owned: true, by: 'record' };
      }
      continue;
    }
    if (candidate.legacy === 'location' || (await hasPackageMarker(candidate.installRoot))) {
      return { owned: true, by: 'legacy' };
    }
  }
  return { owned: false };
}

/**
 * Whether this file belongs to an installed marketplace package and must not be
 * written by DorkOS — {@link packageOwnershipOf}, as a yes or no.
 *
 * @param filePath - The file the caller is about to write.
 * @param ctx - Roots and agent directory, from {@link packageOwnershipContext}.
 * @returns True when the file is package-owned and must not be written.
 */
export async function isPackageOwned(
  filePath: string,
  ctx: PackageOwnershipContext
): Promise<boolean> {
  return (await packageOwnershipOf(filePath, ctx)).owned;
}

/** Whether a record says its package's next install puts its own copy of `rel` back. */
function recordClaims(record: InstalledFiles, rel: string): boolean {
  if (record.uninstalledAt !== undefined) return false;
  const listed =
    Object.hasOwn(record.files, rel) ||
    record.ownedPaths.some((owned) => rel === owned || rel.startsWith(`${owned}/`));
  return listed && !matchesUserEditable(rel, record.userEditable);
}

/**
 * The install roots an already-resolved file sits in, de-duplicated, in the
 * order the context names them.
 */
async function candidateInstalls(
  resolvedFile: string,
  ctx: PackageOwnershipContext
): Promise<CandidateInstall[]> {
  const found = new Map<string, CandidateInstall>();
  const add = (installRoot: string, legacy: CandidateInstall['legacy']) => {
    if (!found.has(installRoot)) found.set(installRoot, { installRoot, legacy });
  };
  for (const [roots, legacy] of [
    [ctx.packageOnlyRoots, 'location'],
    [ctx.sharedInstallRoots, 'marker'],
  ] as const) {
    for (const root of roots) {
      const resolvedRoot = await resolveOrSelf(root);
      if (!resolvedFile.startsWith(resolvedRoot + path.sep)) continue;
      // The install's own directory is the first segment below the root;
      // anything deeper is that install's contents. `path.relative` cannot
      // escape here — the prefix test above already proved containment.
      const [installDir, ...inside] = path.relative(resolvedRoot, resolvedFile).split(path.sep);
      // A file standing directly in the root is in no install at all.
      if (inside.length > 0) add(path.join(resolvedRoot, installDir), legacy);
    }
  }
  if (ctx.agentDir !== undefined) {
    const resolvedAgent = await resolveOrSelf(ctx.agentDir);
    if (resolvedFile.startsWith(resolvedAgent + path.sep)) add(resolvedAgent, 'marker');
  }
  return [...found.values()];
}

/** A native relative path in the record's POSIX spelling. */
function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

/** Whether a directory carries one of the {@link PACKAGE_MARKERS}. */
async function hasPackageMarker(dir: string): Promise<boolean> {
  for (const marker of PACKAGE_MARKERS) {
    try {
      await fs.access(path.join(dir, marker));
      return true;
    } catch {
      // Not this marker; the next one may still be there.
    }
  }
  return false;
}

/**
 * `fs.realpath` of a path that may not exist yet: the deepest ancestor that
 * does exist is resolved, and the rest is joined back on. A bare unresolved
 * path would never match a resolved root under a symlinked parent.
 */
async function resolveThroughExisting(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(await resolveThroughExisting(parent), path.basename(target));
  }
}

/** `fs.realpath`, falling back to the path itself when it cannot be resolved. */
async function resolveOrSelf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

/**
 * What stops this file's schedule being armed, or `null` when nothing does.
 *
 * Asked when a person APPROVES a parked schedule. Arming something DorkOS
 * cannot read would be theatre: an unreadable block has no cron to run on, so
 * the row would go `active` and never fire, and the complaint that said why
 * would be gone from the card. Better to refuse the approval and name the
 * problem, so the answer is "go fix line 4" rather than silence.
 *
 * One shape is asked, because there is one: the `schedule:` block. A file with
 * no block is not a schedule and has nothing to block arming — the row it is
 * attached to is on its way to being retired by discovery, and refusing the
 * approval of a row nobody can fix is not an improvement.
 *
 * @param filePath - The task's SKILL.md.
 * @param content - Its bytes.
 * @returns The problem, or `null` when the file's schedule reads.
 */
export function describeArmBlocker(filePath: string, content: string): string | null {
  const skill = parseSkillFile(filePath, content, SkillFrontmatterSchema);
  if (!skill.ok) return null; // Not a readable skill at all; the route's parse gate answers.

  const blockProblem = scheduleProblem(skill.definition.meta);
  if (blockProblem !== null) return blockProblem;

  if (!hasSchedule(skill.definition.meta)) return null;
  const block = skill.definition.meta.schedule;
  return describeScheduleProblem(block.cron ?? null, block.timezone);
}

/** What {@link planTaskFileUpdate} decided to do with the file. */
export type TaskFileUpdatePlan =
  /** Write these bytes. */
  | { kind: 'write'; frontmatter: Record<string, unknown>; body: string }
  /** Do not write, and tell the caller why. */
  | { kind: 'refuse'; message: string };

/**
 * Which request fields belong inside a `schedule:` block rather than at the top
 * level of the frontmatter.
 *
 * The mapping is the inverse of `readScheduleFromSkill`'s. `name`,
 * `display-name` and `description` are absent on purpose: they describe the
 * SKILL, not its schedule, and stay where every other skill keeps them.
 */
const SCHEDULE_FIELD: Record<string, keyof ScheduleBlock> = {
  cron: 'cron',
  timezone: 'timezone',
  enabled: 'enabled',
  sticky: 'sticky',
  maxRuntime: 'max-runtime',
  permissionMode: 'permissions',
  // The execution trio (DOR-1615/DOR-1347). Inside the block, never at the top
  // level: a top-level `model:` is the Claude Code dialect a person's own
  // invocation of the skill reads, so a codex model id written there would be
  // handed to Claude Code. The block is where the SCHEDULED fire's answer lives.
  runtime: 'runtime',
  model: 'model',
  effort: 'effort',
};

/**
 * Apply a task update to a block-backed file's raw frontmatter.
 *
 * The block is re-read from RAW yaml and re-validated, then written back through
 * `scheduleToFrontmatter` so it keeps the shape a person would have typed: an
 * omitted default stays omitted rather than being materialized on every edit.
 */
function planBlockUpdate(
  raw: Record<string, unknown>,
  write: TaskFrontmatterWrite
): TaskFileUpdatePlan {
  // An absent block reads as an empty one. That is what makes this the single
  // write path: a create starts from nothing, and a file that somehow lost its
  // block gets one back rather than having its scheduling fields written at the
  // top level, which is the shape DOR-1486 retired.
  const parsed = ScheduleBlockSchema.safeParse(raw.schedule ?? {});
  if (!parsed.success) {
    // Unreachable through the route, which checks `describeArmBlocker` and the
    // parse gate first. Stated anyway: this function's whole job is to not
    // damage a block, and silently writing one it could not read would be the
    // exact bug it exists to prevent.
    return {
      kind: 'refuse',
      message:
        'DorkOS could not read the schedule settings in this file, so nothing was changed. ' +
        'Open the file and fix the `schedule:` block, then try again.',
    };
  }

  const block: Record<string, unknown> = { ...parsed.data };
  for (const [field, key] of Object.entries(SCHEDULE_FIELD)) {
    const value = write[field as keyof TaskFrontmatterWrite];
    if (value === undefined) continue;
    // `null` clears — and for `cron` that is meaningful: a schedule with no cron
    // is on-demand, which is a state a person can choose.
    if (value === null) delete block[key];
    else block[key] = value;
  }

  const reparsed = ScheduleBlockSchema.safeParse(block);
  if (!reparsed.success) {
    return {
      kind: 'refuse',
      message:
        'Those settings would leave the schedule in a state DorkOS cannot read, ' +
        'so nothing was changed.',
    };
  }

  // Only the skill-level fields go through the top-level merge. Passing the
  // scheduling ones here too is exactly defect 3: they would land at the top
  // level and shadow nothing, while the block kept the old values.
  const top = mergeTaskFrontmatter(raw, {
    name: write.name,
    displayName: write.displayName,
    description: write.description,
  });

  return {
    kind: 'write',
    frontmatter: { ...top, schedule: scheduleToFrontmatter(reparsed.data) },
    body: '',
  };
}

/**
 * Work out the new contents of a task's SKILL.md, or refuse to touch it.
 *
 * @param filePath - The file being edited.
 * @param content - Its current bytes.
 * @param write - The fields the request carries.
 * @param prompt - The new body, when the request set one.
 * @returns The bytes to write, or a refusal to report to the caller.
 */
export function planTaskFileUpdate(
  filePath: string,
  content: string,
  write: TaskFrontmatterWrite,
  prompt?: string
): TaskFileUpdatePlan {
  const raw = readRawFrontmatter(content);
  if (raw === null) {
    return {
      kind: 'refuse',
      message:
        'DorkOS could not make sense of the settings block at the top of this file, ' +
        'so nothing was changed.',
    };
  }

  const plan = planBlockUpdate(raw.data, write);
  if (plan.kind === 'refuse') return plan;
  return { kind: 'write', frontmatter: plan.frontmatter, body: prompt ?? raw.body };
}

/**
 * Work out the contents of a schedule's SKILL.md as it is first written.
 *
 * The create path used to build its frontmatter with a bare
 * `mergeTaskFrontmatter` over `{name, description}`, which put `cron:` and
 * friends at the TOP level — the legacy shape, written fresh, by the newest
 * code in the system, on a file the reconciler then had to keep re-reading in a
 * format nothing else produced. Converging it here means create and update
 * cannot disagree about what a schedule file looks like, which is the same
 * reason `mergeTaskFrontmatter` exists one level down.
 *
 * @param base - The identity fields a create knows before anything else.
 * @param write - The schedule fields the request carries.
 * @returns The frontmatter to write, or a refusal (unreachable for a create,
 *   whose starting block is empty by construction).
 */
export function planTaskFileCreate(
  base: { name: string; description: string },
  write: TaskFrontmatterWrite
): TaskFileUpdatePlan {
  return planBlockUpdate({ ...base, schedule: {} }, write);
}

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
import { installRootsUnder, projectScopeRoot } from '../marketplace/lib/install-roots.js';
import { INSTALL_METADATA_PATH } from '../marketplace/installed-metadata.js';
import { mergeTaskFrontmatter, type TaskFrontmatterWrite } from './task-frontmatter-merge.js';
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
  if (data.maxRuntime !== undefined) return true;
  return Object.entries(FILE_BACKED_COLUMN).some(([field, column]) => {
    const value = data[field];
    if (value === undefined) return false;
    if (!existing) return true;
    const current = existing[column as keyof FileBackedRow];
    // `null` in a request means "clear it"; the row spells an absent optional
    // as `null` too, so the two compare directly.
    return value !== current;
  });
}

/**
 * Everything {@link isPackageOwned} needs to answer for one task's file.
 *
 * Two questions, because a package reaches a schedule two different ways and
 * only one of them is a question about location.
 */
export interface PackageOwnershipContext {
  /**
   * Directories where being inside one is the whole answer — the `plugins/` and
   * `shapes/` install roots of every scope in view.
   */
  installRoots: string[];
  /**
   * The owning agent's own directory, when the task has an agent. Not a root to
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
 * The first version of this fix walked `installRootsUnder()` for both scopes and
 * asked whether the file sat under an `agents/` root. That works only when the
 * agent happens to live under the data directory: for a project-scoped agent
 * package the scope root derived from `agentDir` is `<agentDir>/.dork`, whose
 * roots are `<agentDir>/.dork/{plugins,agents,shapes}` — never `<repo>/.dork/agents`,
 * the one root that would have caught it. The ancestor was never derivable from
 * what the route has. Asking about `agentDir` directly answers both scopes with
 * no derivation at all (DOR-1789 review).
 *
 * The root walk stays for the case it is genuinely right for: a `skillRef`
 * schedule whose file physically sits inside a plugin's or a Shape's checkout,
 * which no agent directory contains.
 *
 * @param dorkHome - The resolved data directory.
 * @param agentDir - The owning agent's own directory, when the task has one.
 * @returns The roots to search and the directory to probe.
 */
export function packageOwnershipContext(
  dorkHome: string,
  agentDir?: string
): PackageOwnershipContext {
  const scopeRoots = [dorkHome, ...(agentDir ? [projectScopeRoot(agentDir)] : [])];
  const installRoots = scopeRoots.flatMap((scopeRoot) =>
    installRootsUnder(scopeRoot)
      // `agents/` is deliberately dropped: it is the one root shared with the
      // agents a person makes, and the `agentDir` probe below answers for it
      // without needing to find it.
      .filter(({ packagesOnly }) => packagesOnly)
      .map(({ dir }) => dir)
  );
  return { installRoots, ...(agentDir ? { agentDir } : {}) };
}

/**
 * The files whose presence in a directory say an install put it there.
 *
 * `.dork/manifest.json` is the marketplace's own marker for a package on disk —
 * what `scanPackageDirectory` looks for and what the installed scanner reads.
 * `.dork/install-metadata.json` is the install's provenance sidecar, written
 * after every successful install.
 *
 * Belt and braces rather than two necessary limbs: for the `agentDir` probe the
 * manifest alone would almost certainly do, since the one documented way to
 * install without a `.dork/manifest.json` is a Claude-Code-native package, and
 * `synthesizeFromCcManifest` hardcodes `type: 'plugin'`, so such a package lands
 * in `plugins/` and is never an agent. The sidecar costs one `access` and covers
 * whatever that reasoning has not thought of; the manifest covers an install
 * whose best-effort sidecar write failed.
 *
 * Existence is the test, not readability: a manifest DorkOS cannot parse still
 * means an install lives here, and the conservative answer is to leave it alone.
 */
const PACKAGE_MARKERS = [PACKAGE_MANIFEST_PATH, INSTALL_METADATA_PATH];

/**
 * Whether this file belongs to an installed marketplace package.
 *
 * A skill installed from a package lives inside that package's checkout and is
 * reachable from an agent's `.agents/skills/` as a symlink. Editing it through
 * that link writes into the checkout: the change is invisible in the app's
 * provenance, it is shared by every agent that installed the package, and the
 * next package update overwrites it. So DorkOS does not do it. Approving such a
 * schedule is row state, which the caller reaches without a write at all.
 *
 * Two ways a package owns a schedule, so two questions:
 *
 * 1. **The file sits in a plugin's or a Shape's checkout** — a `skillRef`
 *    schedule written into a skill the package ships
 *    (`materialize-schedules.ts`). Those roots hold nothing a person put there,
 *    so location settles it.
 * 2. **The owning AGENT is itself an installed package** — then its whole
 *    directory is the checkout, and every schedule filed under it (shipped,
 *    generated, or created later through DorkOS, which writes to
 *    `agentSkillsRoot(agentDir)`) is inside something the next update replaces.
 *
 * Question 2 is asked of {@link PackageOwnershipContext.agentDir} directly and
 * is why `agents/` is not among the roots walked: that root also holds every
 * agent a person makes, DorkBot included, and claiming their schedules would be
 * this same bug pointed the other way. A hand-made agent has `.dork/agent.json`
 * and no {@link PACKAGE_MARKERS} file; an agent package has `.dork/agent.json`
 * AND a marker, because the install scaffolds the workspace on top of the
 * package it just unpacked. Containment is still required — an agent's row can
 * point at a file outside its own directory, and the agent being a package says
 * nothing about that file.
 *
 * Both sides are resolved before comparing — the file because the link is the
 * whole point, and the roots because a data directory or a checkout under a
 * symlinked parent is ordinary rather than exotic (every macOS temp directory is
 * one). An earlier version tested for a `plugins` path SEGMENT instead, which
 * both missed real installs and would have claimed any file under any directory
 * a person happened to name `plugins` (DOR-1485 review, residual 5).
 *
 * @param filePath - The file the route is about to edit.
 * @param ctx - Roots and agent directory, from {@link packageOwnershipContext}.
 * @returns True when the file is package-owned and must not be written.
 */
export async function isPackageOwned(
  filePath: string,
  ctx: PackageOwnershipContext
): Promise<boolean> {
  const resolvedFile = await resolveOrSelf(filePath);
  for (const root of ctx.installRoots) {
    if (await containsFile(root, resolvedFile)) return true;
  }
  if (ctx.agentDir === undefined) return false;
  return (
    (await containsFile(ctx.agentDir, resolvedFile)) &&
    (await hasPackageMarker(await resolveOrSelf(ctx.agentDir)))
  );
}

/** Whether `dir`, once resolved, is an ancestor of an already-resolved file. */
async function containsFile(dir: string, resolvedFile: string): Promise<boolean> {
  const resolvedDir = await resolveOrSelf(dir);
  return resolvedFile.startsWith(resolvedDir + path.sep);
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
 * Whether an agent's own directory is an installed package's checkout.
 *
 * The CREATE-side half of {@link isPackageOwned}'s question 2, asked before a
 * new schedule is written rather than after. Exported because `create-task.ts`
 * has the agent directory and no file yet, so it cannot ask the other one.
 *
 * @param agentDir - The agent's own directory, from `meshCore.getProjectPath`.
 * @returns True when schedules filed under this agent belong to a package.
 */
export async function isPackageOwnedAgent(agentDir: string): Promise<boolean> {
  return hasPackageMarker(await resolveOrSelf(agentDir));
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

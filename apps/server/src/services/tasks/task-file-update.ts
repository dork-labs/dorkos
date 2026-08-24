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
 * - On a block-backed file, scheduling fields go into the block through
 *   `scheduleToFrontmatter`; on a legacy file they stay at the top level.
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
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
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
  permissionMode: 'permissionMode',
  prompt: 'prompt',
} as const satisfies Record<string, string>;

/** The row columns {@link touchesFile} compares a request against. */
export interface FileBackedRow {
  name: string;
  displayName?: string | null;
  description?: string | null;
  cron?: string | null;
  timezone?: string | null;
  enabled: boolean;
  permissionMode: string;
  prompt: string;
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
 * The directories installed packages live in, for a given scope.
 *
 * Mirrors the marketplace's own layout (`conflict-detector.ts`): the scope root
 * is `<projectPath>/.dork` for a project install and the data directory for a
 * global one, and packages sit under `plugins/` inside it.
 *
 * @param dorkHome - The resolved data directory.
 * @param projectPath - The owning agent's project, when it has one.
 */
export function pluginRoots(dorkHome: string, projectPath?: string): string[] {
  const roots = [path.join(dorkHome, 'plugins')];
  if (projectPath) roots.push(path.join(projectPath, '.dork', 'plugins'));
  return roots;
}

/**
 * Whether this file belongs to an installed marketplace package.
 *
 * A skill installed from a package lives under a `plugins/` root and is reachable
 * from an agent's `.agents/skills/` as a symlink. Editing it through that link
 * writes into the package's own checkout: the change is invisible in the
 * cockpit's provenance, it is shared by every agent that installed the package,
 * and the next package update overwrites it. So DorkOS does not do it. Approving
 * such a schedule is row state, which the caller reaches without a write at all.
 *
 * Both sides are resolved before comparing — the file because the link is the
 * whole point, and the roots because a data directory or a checkout under a
 * symlinked parent is ordinary rather than exotic (every macOS temp directory is
 * one). An earlier version tested for a `plugins` path SEGMENT instead, which
 * both missed real installs and would have claimed any file under any directory
 * a person happened to name `plugins` (DOR-1485 review, residual 5).
 *
 * @param filePath - The file the route is about to edit.
 * @param roots - Candidate plugin roots, from {@link pluginRoots}.
 * @returns True when the file is package-owned and must not be written.
 */
export async function isPackageOwned(filePath: string, roots: string[]): Promise<boolean> {
  const resolvedFile = await resolveOrSelf(filePath);
  for (const root of roots) {
    const resolvedRoot = await resolveOrSelf(root);
    if (resolvedFile.startsWith(resolvedRoot + path.sep)) return true;
  }
  return false;
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
 * Both file shapes are asked, because both are still live: the `schedule:` block
 * first, then legacy top-level fields.
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

  if (hasSchedule(skill.definition.meta)) {
    const block = skill.definition.meta.schedule;
    return describeScheduleProblem(block.cron ?? null, block.timezone);
  }

  const legacy = parseSkillFile(filePath, content, TaskFrontmatterSchema);
  return legacy.ok
    ? describeScheduleProblem(legacy.definition.meta.cron, legacy.definition.meta.timezone)
    : null;
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
  maxRuntime: 'max-runtime',
  permissionMode: 'permissions',
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
  const parsed = ScheduleBlockSchema.safeParse(raw.schedule);
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

  const isBlockBacked = raw.data.schedule !== undefined && raw.data.schedule !== null;
  const plan = isBlockBacked
    ? planBlockUpdate(raw.data, write)
    : ({ kind: 'write', frontmatter: mergeTaskFrontmatter(raw.data, write), body: '' } as const);

  if (plan.kind === 'refuse') return plan;
  return { kind: 'write', frontmatter: plan.frontmatter, body: prompt ?? raw.body };
}

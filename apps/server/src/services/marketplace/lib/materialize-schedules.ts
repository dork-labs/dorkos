/**
 * Turning a package's declared schedules into files on disk.
 *
 * A `schedules[]` entry in a manifest is a statement of intent; this is what
 * makes it real. Every declaration ends as a skill file carrying a `schedule:`
 * block, because being scheduled is a property of a skill file rather than a
 * place on disk (ADR `260823-200724`, spec `universal-scheduled-tasks` §6). The
 * two declaration forms end in two different places:
 *
 * - **`skillRef`** — the package already ships the skill, so the block is
 *   written into the INSTALLED copy of that file and nothing new is generated.
 *   One file: the instructions a person reads and the schedule that fires them
 *   are the same document. Harness Sync projects installed plugin skills as
 *   symlinks (`.claude/skills/<pkg>__<skill>`), so the projections follow the
 *   source copy with no second write and no chance of the two disagreeing.
 * - **inline** — the package described work it does not otherwise ship, so a new
 *   skill directory is generated in the skills root the install is for.
 *
 * ## Nothing here arms anything
 *
 * This module writes files. It never registers a cron job, never touches the
 * task store, and never marks a schedule approved. A file-discovered schedule
 * parks for a person to approve before it can fire — `startEnabled: true` or not
 * — which is the whole point of never-auto-arm (spec §3): a package landing on
 * disk is not consent to run unattended work. `startEnabled` becomes
 * `schedule.enabled` in the file, where it reads as what it is: the author's
 * stated intent, and the thing the person is being asked to approve.
 *
 * ## Failures warn, they do not fail the install
 *
 * By the time this runs the package is installed and working. Refusing the whole
 * install because one schedule file could not be written would roll back a
 * package whose commands, skills and docs are fine — the same trade
 * `lib/npm-dependencies.ts` makes for a failed dependency fetch. The genuinely
 * fatal cases (a cron croner cannot read, a `skillRef` pointing at nothing) are
 * caught by `validate-package-schedules.ts` BEFORE anything touches disk, which
 * is where an install can still be refused cleanly.
 *
 * @module services/marketplace/lib/materialize-schedules
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { MarketplacePackageManifest } from '@dorkos/marketplace';
import type { PackageScheduleDecl } from '@dorkos/marketplace/manifest-schema';
import { AGENTS_SKILLS_DIR } from '@dorkos/harness/scan';
import type { Logger } from '@dorkos/shared/logger';
import { scheduleToFrontmatter, type ScheduleBlock } from '@dorkos/skills/schedule-schema';
import { writeSkillFile } from '@dorkos/skills/writer';
import { slugify } from '@dorkos/skills/slug';
import { clampSchedulePermissionMode } from '../../tasks/schedule-permission-clamp.js';
import { runTransaction } from '../transaction.js';
import { atomicMove } from './atomic-move.js';
import { packageSchedules, scheduleDisplayName } from './package-schedules.js';
import { findShippedSkillDir } from './validate-package-schedules.js';

/** Where a generated schedule file goes when the install is not project-scoped. */
const GLOBAL_SKILLS_DIR = 'skills';

/** What {@link materializePackageSchedules} needs to place a package's schedules. */
export interface MaterializeSchedulesOptions {
  /** The validated manifest whose `schedules[]` are being materialized. */
  manifest: MarketplacePackageManifest;
  /** Absolute path to the package's install root (where its shipped skills now live). */
  installPath: string;
  /** The DorkOS data directory — the global skills root's parent. */
  dorkHome: string;
  /** The project this install is scoped to, when it is scoped to one. */
  projectPath?: string;
  logger: Logger;
}

/** What materializing produced, and what could not be produced. */
export interface MaterializeSchedulesResult {
  /**
   * Absolute paths of the skill DIRECTORIES generated for inline declarations.
   *
   * Recorded in the package's install-metadata sidecar so uninstall can remove
   * them. Only inline entries appear here: a `skillRef` block is written inside
   * the package's own install root, which uninstall removes wholesale, so there
   * is nothing extra to track and nothing of the person's to avoid deleting.
   */
  generatedPaths: string[];
  /** One sentence per schedule that could not be placed, or that needs saying. */
  warnings: string[];
}

/**
 * Write every schedule a package declares as a file.
 *
 * @param opts - The package, where it landed, and where its schedules go.
 * @returns The generated directories (for the uninstall receipt) and warnings.
 */
export async function materializePackageSchedules(
  opts: MaterializeSchedulesOptions
): Promise<MaterializeSchedulesResult> {
  const schedules = packageSchedules(opts.manifest);
  const generatedPaths: string[] = [];
  const warnings: string[] = [];
  if (schedules.length === 0) return { generatedPaths, warnings };

  const skillsRoot = resolveSkillsRoot(opts);
  const packageName = opts.manifest.name;

  for (const [index, schedule] of schedules.entries()) {
    const label = scheduleDisplayName(schedule, index);

    // A manifest written against the pre-DOR-607 schema still parses: zod would
    // simply drop the retired key, leaving the author with a timer that never
    // fires and nothing to explain it. Say so instead.
    if (schedule.startDisabled !== undefined) {
      warnings.push(
        `Schedule '${label}' uses 'startDisabled', which DorkOS no longer reads. ` +
          `It stays off until the package sets 'startEnabled' to true.`
      );
    }

    const { block, clamped } = buildScheduleBlock(schedule, packageName);
    if (clamped) {
      warnings.push(
        `Schedule '${label}' asked to run with every approval prompt turned off. ` +
          `DorkOS wrote it with the normal prompts instead; you can change that on the schedule.`
      );
    }

    try {
      if (schedule.skillRef) {
        await injectScheduleIntoShippedSkill(opts.installPath, schedule.skillRef, block);
        continue;
      }
      const generated = await generateScheduleSkill(skillsRoot, schedule, block, packageName);
      if (generated.written) {
        generatedPaths.push(generated.dirPath);
      } else {
        warnings.push(generated.reason);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      warnings.push(
        `Schedule '${label}' could not be written (${detail}). The package installed; ` +
          `the schedule did not.`
      );
      opts.logger.warn('[marketplace-schedules] failed to materialize a schedule', {
        packageName,
        schedule: label,
        error: detail,
      });
    }
  }

  return { generatedPaths, warnings };
}

/**
 * Which skills root this install's generated schedules belong in.
 *
 * This is where a non-Shape schedule's agent binding is decided, and it is
 * decided by the install rather than by the manifest. A project-scoped install
 * generates into that project's `.agents/skills/`, where the schedule belongs to
 * that project's agent; a global install generates into `<dorkHome>/skills/`,
 * where it is global. The install already knows which one the person asked for,
 * so the package never gets to name an agent nobody agreed to hand it.
 *
 * @param opts - The materialize options.
 * @returns Absolute path to the skills root.
 * @internal
 */
function resolveSkillsRoot(opts: MaterializeSchedulesOptions): string {
  return opts.projectPath
    ? path.join(opts.projectPath, AGENTS_SKILLS_DIR)
    : path.join(opts.dorkHome, GLOBAL_SKILLS_DIR);
}

/**
 * Build the `schedule:` block a declaration becomes, with the permission mode
 * clamped and the package's provenance stamped on.
 *
 * `origin` is `'shape'` or `'plugin'` — the two values the block's schema
 * carries. Every non-Shape package type stamps `'plugin'`: the distinction the
 * marker draws is "a Shape stood this up" versus "a package shipped it", not
 * which of the four package types it was, and the package NAME (in `shape`)
 * identifies the exact origin anyway.
 *
 * @param schedule - The declaration to convert.
 * @param packageName - The package standing the schedule up.
 * @returns The block, and whether the declared permission mode was clamped.
 * @internal
 */
function buildScheduleBlock(
  schedule: PackageScheduleDecl,
  packageName: string
): { block: ScheduleBlock; clamped: boolean } {
  // Every field is coalesced to the value the manifest schema would have
  // supplied, rather than trusted to be there. The schema's `.default()`s only
  // apply to a declaration that went through a parse, and not every one does —
  // a manifest read off disk by an older build reaches here with keys missing.
  // The cost of assuming otherwise is not a wrong default but a THROW:
  // `scheduleToFrontmatter` hands whatever it is given to js-yaml, which refuses
  // an `undefined` with "unacceptable kind of an object to dump" and takes the
  // whole schedule down. Its own TSDoc names that failure; this is the guard.
  const { mode, clamped } = clampSchedulePermissionMode(schedule.permissionMode ?? 'acceptEdits');
  const block: ScheduleBlock = {
    ...(schedule.cron != null && { cron: schedule.cron }),
    timezone: schedule.timezone ?? 'UTC',
    // The author's intent, and nothing more — approval is a separate step that
    // no file can grant itself. See the module note. Absent means the safe
    // answer (off), which is also the schema's default.
    enabled: schedule.startEnabled ?? false,
    permissions: mode,
    origin: 'plugin',
    shape: packageName,
  };
  return { block, clamped };
}

/**
 * Write a `schedule:` block into the installed copy of a skill the package ships.
 *
 * The rest of the frontmatter is preserved VERBATIM, which is why this reads
 * with `gray-matter` rather than through `SkillFrontmatterSchema`: the schema
 * strips keys it does not know, so parsing and re-writing through it would
 * quietly delete a Claude-Code-only key, a `metadata:` map, or anything else the
 * author put there. Only the `schedule` key is added or replaced.
 *
 * @param installPath - The package's install root.
 * @param skillRef - Directory name of the shipped skill.
 * @param block - The schedule block to write.
 * @internal
 */
async function injectScheduleIntoShippedSkill(
  installPath: string,
  skillRef: string,
  block: ScheduleBlock
): Promise<void> {
  const skillDir = await findShippedSkillDir(installPath, skillRef);
  if (!skillDir) {
    // Pre-validated at install time, so reaching here means the tree changed
    // under us between validation and activation.
    throw new Error(`the installed package no longer contains a skill named '${skillRef}'`);
  }

  const filePath = path.join(skillDir, 'SKILL.md');
  const parsed = matter(await readFile(filePath, 'utf-8'));
  await writeSkillFile(
    path.dirname(skillDir),
    path.basename(skillDir),
    { ...parsed.data, schedule: scheduleToFrontmatter(block) },
    parsed.content.trim()
  );
}

/**
 * Generate a new skill directory for an inline declaration.
 *
 * Refuses to overwrite a directory that is already there and is not one of ours.
 * A person's own skill, or another package's, must never be replaced because a
 * manifest picked a colliding name — the same provenance gate the Shape flows
 * apply before they touch anything they did not create. The check reads the
 * existing file's own `schedule.origin`/`schedule.shape` rather than trusting
 * the path, and anything unreadable counts as not-ours (fail closed).
 *
 * The write runs through {@link runTransaction} so a failure mid-write cannot
 * leave a half-built skill directory behind: the file is built in a staging
 * directory and moved into place in one atomic rename, and a failed move
 * restores whatever was there before (ADR-0304).
 *
 * @param skillsRoot - The skills root to generate into.
 * @param schedule - The inline declaration.
 * @param block - The schedule block to write.
 * @param packageName - The package standing the schedule up.
 * @returns Whether the directory was written, and why not when it was not.
 * @internal
 */
async function generateScheduleSkill(
  skillsRoot: string,
  schedule: PackageScheduleDecl,
  block: ScheduleBlock,
  packageName: string
): Promise<{ written: true; dirPath: string } | { written: false; reason: string }> {
  // The inline form guarantees these three; the schema's declaration-form rule
  // is what makes that true, and the install-time validator ran before this.
  const name = schedule.name ?? '';
  const slug = slugify(name);
  const dirPath = path.join(skillsRoot, slug);

  const existing = await readScheduleOwner(path.join(dirPath, 'SKILL.md'));
  // Anything already there that this package did not write is left alone. Note
  // "present with no marker" is a REFUSAL, not a permission: an unmarked skill
  // is a person's own, and it is the case that matters most.
  if (existing.present && existing.owner !== packageName) {
    return {
      written: false,
      reason:
        `Schedule '${name}' was not created: a skill named '${slug}' is already there and ` +
        `DorkOS did not put it there. Rename the schedule in the package, or move the ` +
        `existing skill.`,
    };
  }

  const frontmatter: Record<string, unknown> = {
    name: slug,
    description: schedule.description,
    schedule: scheduleToFrontmatter(block),
  };

  await runTransaction<void>({
    name: `materialize-schedule-${packageName}-${slug}`,
    target: dirPath,
    stage: async (staging) => {
      await writeSkillFile(staging.path, slug, frontmatter, schedule.prompt ?? '');
    },
    activate: async (staging) => {
      // `stage` built `<staging>/<slug>/`; that inner directory is what becomes
      // the skill dir, so it is what moves onto the target.
      await mkdir(path.dirname(dirPath), { recursive: true });
      await atomicMove(path.join(staging.path, slug), dirPath);
    },
  });

  return { written: true, dirPath };
}

/**
 * Whether a skill file is already at this path, and which package generated it.
 *
 * The two facts have to be separate, because collapsing them is a way to delete
 * somebody's work: a file that is present but carries no provenance marker is a
 * person's own skill, and reporting it the same as "nothing here" would let a
 * colliding package name overwrite it. Present-and-unreadable reports the same
 * way, for the same reason — a file DorkOS cannot understand is never a file it
 * may replace.
 *
 * @param filePath - Absolute path to a candidate `SKILL.md`.
 * @returns Whether a file is there, and the package that generated it (`null`
 *   when there is no marker, including when the file could not be read).
 * @internal
 */
async function readScheduleOwner(
  filePath: string
): Promise<{ present: boolean; owner: string | null }> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    // Genuinely absent is the only case that clears the way. Any other read
    // error means something IS there that we could not read.
    const absent = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { present: !absent, owner: null };
  }

  try {
    const parsed = matter(content);
    const schedule = parsed.data.schedule as Record<string, unknown> | undefined;
    if (!schedule || typeof schedule !== 'object') return { present: true, owner: null };
    const shape = schedule.shape;
    return { present: true, owner: typeof shape === 'string' ? shape : null };
  } catch {
    return { present: true, owner: null }; // Unparseable frontmatter — not ours.
  }
}

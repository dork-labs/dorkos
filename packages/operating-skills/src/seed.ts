/**
 * Idempotent, version-stamped seeding of the Operating DorkOS skill pack into a
 * workspace's `.agents/skills/` directory.
 *
 * Each seeded SKILL.md carries a stamp in its frontmatter `metadata`: the pack
 * marker, the pack version, and a content hash of the body we wrote. On re-seed:
 *
 * - Absent file → write it (`created`).
 * - Present but not one of ours (no pack marker, or unparseable) → leave it
 *   (`preserved`). A user's own skill with the same name is never clobbered.
 * - Present and ours but the on-disk body no longer matches the stamped hash →
 *   the user edited it → leave it (`preserved`).
 * - Present, ours, unmodified, older pack version → overwrite (`upgraded`).
 * - Present, ours, unmodified, current version → leave it (`unchanged`).
 *
 * A skill that ships files beside its SKILL.md (`OperatingSkill.files`) also
 * stamps a SHA-256 per file it wrote. One of those files edited or deleted, or
 * a file of the person's at a name the pack would write, makes the whole skill
 * `preserved`: the seeder writes all of a skill's files or none of them.
 *
 * Harness Sync (`@dorkos/harness`) then projects `.agents/skills/` to every
 * harness with no further work here.
 *
 * @module seed
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeSkillFile } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import { OPERATING_SKILLS_PACK, OPERATING_SKILLS_VERSION, type OperatingSkill } from './pack.js';

/** Frontmatter `metadata` marker identifying a file as a seeded pack skill. */
const META_PACK_KEY = 'dorkosPack';
/** Marker value written under {@link META_PACK_KEY}. */
const META_PACK_VALUE = 'operating-dorkos';
/** Frontmatter `metadata` key holding the pack version the file was seeded from. */
const META_VERSION_KEY = 'dorkosPackVersion';
/** Frontmatter `metadata` key holding the content hash of the seeded body. */
const META_HASH_KEY = 'dorkosContentHash';
/**
 * Frontmatter `metadata` key listing the supporting files seeded beside the
 * SKILL.md, as `name=sha256` pairs joined by `,`. A flat string, so every
 * harness that projects the file reads plain metadata.
 */
const META_FILES_KEY = 'dorkosFiles';

/** What the seeder did with one skill. */
export type SeedAction = 'created' | 'upgraded' | 'unchanged' | 'preserved';

/** The outcome for a single skill in a seed run. */
export interface SeedOutcome {
  /** The skill's kebab-case name. */
  name: string;
  /** What happened to it. */
  action: SeedAction;
}

/** The result of seeding the whole pack into one workspace. */
export interface SeedResult {
  /** Absolute path to the `.agents/skills/` directory seeded into. */
  skillsDir: string;
  /** Per-skill outcomes, in pack order. */
  outcomes: SeedOutcome[];
  /**
   * Absolute paths to the directory trees this run created, each named by its
   * topmost new directory (for example `<rootDir>/.agents` in a workspace that
   * had none). Nothing at or below one of these paths existed before the run,
   * which is what lets a caller undo a failed scaffold without guessing at
   * directories that were already the user's.
   */
  createdDirs: string[];
}

/** Hash the canonical (trimmed) body — the parser trims on read, so we match it. */
function hashBody(body: string): string {
  return createHash('sha256').update(body.trim()).digest('hex');
}

/** Hash a supporting file exactly as written: it is seeded verbatim, never trimmed. */
function hashFile(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** The {@link META_FILES_KEY} value for a skill's supporting files. */
function stampFiles(files: Readonly<Record<string, string>>): string {
  return Object.entries(files)
    .map(([name, content]) => `${name}=${hashFile(content)}`)
    .join(',');
}

/** Parse a {@link META_FILES_KEY} value back into file name → stamped hash. */
function parseFilesStamp(value: unknown): Map<string, string> {
  const stamped = new Map<string, string>();
  if (typeof value !== 'string' || value === '') return stamped;
  for (const pair of value.split(',')) {
    const at = pair.lastIndexOf('=');
    if (at > 0) stamped.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return stamped;
}

/** Build the stamped frontmatter written for a seeded skill. */
function buildFrontmatter(skill: OperatingSkill): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description,
    metadata: {
      [META_PACK_KEY]: META_PACK_VALUE,
      [META_VERSION_KEY]: String(OPERATING_SKILLS_VERSION),
      [META_HASH_KEY]: hashBody(skill.body),
      ...(skill.files ? { [META_FILES_KEY]: stampFiles(skill.files) } : {}),
    },
  };
}

/** A file's contents, or `null` when it is not there. */
async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Whether every supporting file on disk may be written over. A file is ours
 * when it still hashes to the stamp it was seeded with, or already holds what
 * this pack would write (a run cut short before its SKILL.md landed). A
 * stamped file that is gone was deleted by the person. A file at a new name
 * that holds anything else is the person's.
 */
async function supportingFilesAreOurs(
  skill: OperatingSkill,
  skillDir: string,
  stamp: unknown
): Promise<boolean> {
  const stamped = parseFilesStamp(stamp);
  for (const [name, content] of Object.entries(skill.files ?? {})) {
    const onDisk = await readIfPresent(path.join(skillDir, name));
    if (onDisk === null) {
      if (stamped.has(name)) return false;
    } else if (onDisk !== content && hashFile(onDisk) !== stamped.get(name)) {
      return false;
    }
  }
  // A file an older pack seeded that this one no longer writes is still checked:
  // the person may have kept it on purpose, so an edit to it preserves the skill.
  for (const [name, hash] of stamped) {
    if (skill.files?.[name] !== undefined) continue;
    const onDisk = await readIfPresent(path.join(skillDir, name));
    if (onDisk !== null && hashFile(onDisk) !== hash) return false;
  }
  return true;
}

/** Decide what to do with the on-disk files (if any) for one skill. */
async function decide(filePath: string, skill: OperatingSkill): Promise<SeedAction> {
  const skillDir = path.dirname(filePath);
  const raw = await readIfPresent(filePath);
  if (raw === null) {
    return (await supportingFilesAreOurs(skill, skillDir, undefined)) ? 'created' : 'preserved';
  }

  const parsed = parseSkillFile(filePath, raw, SkillFrontmatterSchema, { requireNameMatch: false });
  // Unparseable, or a user's own skill sharing the name: never clobber.
  if (!parsed.ok) return 'preserved';

  const meta = parsed.definition.meta.metadata;
  if (!meta || meta[META_PACK_KEY] !== META_PACK_VALUE) return 'preserved';

  // The user edited a copy we seeded: its body no longer matches the stamp.
  if (meta[META_HASH_KEY] !== hashBody(parsed.definition.body)) return 'preserved';
  if (!(await supportingFilesAreOurs(skill, skillDir, meta[META_FILES_KEY]))) return 'preserved';

  const storedVersion = Number(meta[META_VERSION_KEY]);
  if (Number.isFinite(storedVersion) && storedVersion >= OPERATING_SKILLS_VERSION) {
    return 'unchanged';
  }
  return 'upgraded';
}

/**
 * Whether a file is a pack skill this seeder wrote and nobody has edited since:
 * it carries the pack marker, and its body still hashes to the stamp written
 * with it — whichever pack version wrote it. The same test the seeder uses to
 * decide it may overwrite a copy; a caller retiring copies DorkOS left behind
 * uses it to decide it may delete one.
 *
 * @param filePath - Where the file is, for the parser's messages.
 * @param raw - The file's contents.
 */
export function isUnmodifiedSeededSkill(filePath: string, raw: string): boolean {
  const parsed = parseSkillFile(filePath, raw, SkillFrontmatterSchema, { requireNameMatch: false });
  if (!parsed.ok) return false;
  const meta = parsed.definition.meta.metadata;
  if (!meta || meta[META_PACK_KEY] !== META_PACK_VALUE) return false;
  return meta[META_HASH_KEY] === hashBody(parsed.definition.body);
}

/**
 * Seed (or re-seed) the Operating DorkOS skill pack into a workspace.
 *
 * @param rootDir - Absolute path to the workspace root (the agent's home). The
 *   pack is written under `<rootDir>/.agents/skills/<name>/SKILL.md`.
 * @returns The skills directory and per-skill outcomes.
 */
export async function seedOperatingSkills(rootDir: string): Promise<SeedResult> {
  const skillsDir = path.join(rootDir, '.agents', 'skills');
  const outcomes: SeedOutcome[] = [];
  const createdDirs: string[] = [];

  for (const skill of OPERATING_SKILLS_PACK) {
    const filePath = path.join(skillsDir, skill.name, 'SKILL.md');
    const action = await decide(filePath, skill);
    if (action === 'created' || action === 'upgraded') {
      // `writeSkillFile` makes this directory itself, but only a recursive
      // `mkdir` reports the topmost directory it had to create, and that
      // return value is the only proof available that the directory is this
      // run's to undo. Making it here first leaves that call a no-op.
      const firstCreated = await mkdir(path.dirname(filePath), { recursive: true });
      if (firstCreated) createdDirs.push(firstCreated);
      // Supporting files first: SKILL.md carries the stamp, so it lands last.
      for (const [name, content] of Object.entries(skill.files ?? {})) {
        await writeFile(path.join(path.dirname(filePath), name), content, 'utf-8');
      }
      await writeSkillFile(skillsDir, skill.name, buildFrontmatter(skill), skill.body);
    }
    outcomes.push({ name: skill.name, action });
  }

  return { skillsDir, outcomes, createdDirs };
}

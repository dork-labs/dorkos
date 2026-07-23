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
 * Harness Sync (`@dorkos/harness`) then projects `.agents/skills/` to every
 * harness with no further work here.
 *
 * @module seed
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
}

/** Hash the canonical (trimmed) body — the parser trims on read, so we match it. */
function hashBody(body: string): string {
  return createHash('sha256').update(body.trim()).digest('hex');
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
    },
  };
}

/** Decide what to do with the on-disk file (if any) for one skill. */
async function decide(filePath: string): Promise<SeedAction> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'created';
    throw err;
  }

  const parsed = parseSkillFile(filePath, raw, SkillFrontmatterSchema, { requireNameMatch: false });
  // Unparseable, or a user's own skill sharing the name: never clobber.
  if (!parsed.ok) return 'preserved';

  const meta = parsed.definition.meta.metadata;
  if (!meta || meta[META_PACK_KEY] !== META_PACK_VALUE) return 'preserved';

  // The user edited a copy we seeded: its body no longer matches the stamp.
  if (meta[META_HASH_KEY] !== hashBody(parsed.definition.body)) return 'preserved';

  const storedVersion = Number(meta[META_VERSION_KEY]);
  if (Number.isFinite(storedVersion) && storedVersion >= OPERATING_SKILLS_VERSION) {
    return 'unchanged';
  }
  return 'upgraded';
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

  for (const skill of OPERATING_SKILLS_PACK) {
    const filePath = path.join(skillsDir, skill.name, 'SKILL.md');
    const action = await decide(filePath);
    if (action === 'created' || action === 'upgraded') {
      await writeSkillFile(skillsDir, skill.name, buildFrontmatter(skill), skill.body);
    }
    outcomes.push({ name: skill.name, action });
  }

  return { skillsDir, outcomes };
}

/**
 * Reading and forging the Operating DorkOS pack's version stamp.
 *
 * Two helpers, shared by the agent-workspace suite and by J-11, because the
 * version ratchet can only be tested against a file that is stamped exactly as
 * an older seeder would have stamped it — including the content hash, without
 * which `decide()` classifies the file as the person's own and PRESERVES it,
 * making a ratchet test assert the opposite of what it claims.
 *
 * @module __tests__/journeys/pack-stamp
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATING_SKILLS_PACK } from '@dorkos/operating-skills';
import { writeSkillFile } from '@dorkos/skills/writer';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';

/**
 * Write a pack skill stamped as DorkOS's own at an OLDER pack version, exactly
 * as `seed.ts` would have written it back then.
 *
 * `writeSkillFile` is the same writer the seeder uses, so the frontmatter shape
 * cannot drift from it here.
 *
 * @param agentDir - Workspace root to write into.
 * @param name - Pack skill name (must be a real one, or nothing upgrades it).
 * @param body - The older body this stamp claims to describe.
 * @param version - The pack version to stamp, lower than the current one.
 */
export async function writeStalePackSkill(
  agentDir: string,
  name: string,
  body: string,
  version: number
): Promise<void> {
  const skill = OPERATING_SKILLS_PACK.find((s) => s.name === name);
  if (!skill) throw new Error(`${name} is not in the pack; the ratchet test would prove nothing`);
  await writeSkillFile(
    join(agentDir, '.agents', 'skills'),
    name,
    {
      name,
      description: skill.description,
      metadata: {
        dorkosPack: 'operating-dorkos',
        dorkosPackVersion: String(version),
        dorkosContentHash: createHash('sha256').update(body.trim()).digest('hex'),
      },
    },
    body
  );
}

/**
 * Read a seeded `SKILL.md` back through the same parser the seeder decides with.
 *
 * @param agentDir - Workspace root to read from.
 * @param name - The skill's name.
 * @returns its body and the pack version stamped on it, if any.
 */
export function readSeededSkill(
  agentDir: string,
  name: string
): { body: string; version?: string } {
  const filePath = join(agentDir, '.agents', 'skills', name, 'SKILL.md');
  const parsed = parseSkillFile(filePath, readFileSync(filePath, 'utf-8'), SkillFrontmatterSchema, {
    requireNameMatch: false,
  });
  if (!parsed.ok) throw new Error(`Could not parse ${filePath}: ${parsed.error}`);
  const version = parsed.definition.meta.metadata?.dorkosPackVersion;
  return {
    body: parsed.definition.body,
    version: typeof version === 'string' ? version : undefined,
  };
}

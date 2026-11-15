/**
 * The person's own user-level skill names, as a harness that keys skills by
 * name reads them (DOR-4392).
 *
 * OpenCode reads `~/.config/opencode/skills`, `~/.claude/skills` and
 * `~/.agents/skills` in every project, beside the project's own folders, and
 * keeps one of two skills that share a `name`. So a package skill named like a
 * skill in one of those folders can replace it, from a project or from the
 * global plan, exactly as it could replace one in the project (Security's U1,
 * U2 and G1 on #3752, measured on the pinned `opencode 1.19.3`).
 *
 * The engine resolves no home directory: the folders are handed in by the
 * server (`services/harness/agents-user-home.ts`), and this only reads them.
 *
 * DorkOS's own links are left out the way the project inventory leaves them
 * out of `.agents/skills`: an entry that is BOTH a `<pkg>__<name>` folder and a
 * symlink is a projection (`scanSkillDirs`' default view). The global plan
 * writes exactly those into `~/.agents/skills` and `~/.claude/skills`, and a
 * package must not be skipped for a name only its own earlier link holds.
 *
 * @module inventory/user-skills
 */
import { join } from 'node:path';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { scanSkillDirs } from '../scan/scanner.js';
import { readDirEntries, readTextFile } from './read.js';

/** One of the person's user-level skills, by the name a by-name harness keys it on. */
export interface UserSkillName {
  /** The skill's folder, absolute. */
  source: string;
  /** The `name` exactly as the YAML parsed it: untrimmed, and possibly blank. */
  exactFrontmatterName: string;
}

/**
 * Read the exact frontmatter name of every skill in the given user folders.
 *
 * Never throws. A folder that is missing, unreadable or not a folder adds
 * nothing, and so does a skill with no string `name`, which OpenCode does not
 * load. Order follows `dirs`, then the scan.
 *
 * @param dirs - absolute user-level skill folders, in the order to report them.
 * @returns one entry per named skill found.
 */
export function readUserSkillNames(dirs: readonly string[]): UserSkillName[] {
  const found: UserSkillName[] = [];
  for (const dir of dirs) {
    if (readDirEntries(dir, dir, 'skill').unreadable) continue;
    let skills;
    try {
      skills = scanSkillDirs(dir, dir);
    } catch {
      continue;
    }
    for (const skill of skills) {
      const source = join(dir, skill.name);
      const { text } = readTextFile(join(source, SKILL_FILENAME), skill.name, 'skill');
      if (text === undefined) continue;
      const declared = readRawFrontmatter(text)?.data.name;
      if (typeof declared === 'string') found.push({ source, exactFrontmatterName: declared });
    }
  }
  return found;
}

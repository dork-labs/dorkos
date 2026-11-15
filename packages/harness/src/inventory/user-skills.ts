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
 * DorkOS's own links are left out by the global sweep's own rule
 * (`apply/link-owner.ts`): a `<pkg>__<name>` symlink whose text points into
 * `<dorkHome>/plugins` or the extension plugin roots. The global plan writes
 * exactly those into `~/.agents/skills` and `~/.claude/skills`, and a package
 * must not be skipped for a name only its own earlier link holds. A person's
 * own `team__a` linked anywhere else is theirs, and is protected (Security,
 * #3761 Should 1).
 *
 * A name is read leniently when the frontmatter will not parse (over 32 KB,
 * too many aliases): a plain `name:` line still counts, because OpenCode may
 * still load the skill under it, and over-protecting the person's own skill is
 * the safe way to be wrong (#3761 Should 2).
 *
 * @module inventory/user-skills
 */
import { join, resolve } from 'node:path';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { scanSkillDirs } from '../scan/scanner.js';
import { linkOwnerUnder } from '../apply/link-owner.js';
import { extensionSkillPluginsDir } from '../sources/running-extension-skills.js';
import { readDirEntries, readTextFile } from './read.js';

/** The person's user-level skill folders, and the DorkOS data directory whose links in them are DorkOS's own. */
export interface UserSkillFolders {
  /** Absolute folders, in the order to report them. */
  dirs: readonly string[];
  /** The DorkOS data directory, absolute. */
  dorkHome: string;
}

/** One of the person's user-level skills, by the name a by-name harness keys it on. */
export interface UserSkillName {
  /** The skill's folder, absolute. */
  source: string;
  /** The `name` exactly as the YAML parsed it: untrimmed, and possibly blank. */
  exactFrontmatterName: string;
}

/** The `---` block at the top of a `SKILL.md`, unparsed. */
const FRONTMATTER_BLOCK = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** A top-level `name:` line inside that block. */
const NAME_LINE = /^name:[ \t]*(.*?)[ \t]*\r?$/m;

/**
 * The `name` a skill declares: parsed, or, when the frontmatter will not
 * parse, read off its `name:` line with one pair of surrounding quotes removed.
 */
function declaredName(text: string): string | undefined {
  const parsed = readRawFrontmatter(text);
  if (parsed !== null) {
    const name = parsed.data.name;
    return typeof name === 'string' ? name : undefined;
  }
  const block = FRONTMATTER_BLOCK.exec(text)?.[1];
  const line = block === undefined ? undefined : NAME_LINE.exec(block)?.[1];
  if (line === undefined || line === '') return undefined;
  const quoted = /^(['"])(.*)\1$/.exec(line);
  return quoted ? quoted[2] : line;
}

/**
 * Read the exact frontmatter name of every skill in the given user folders.
 *
 * Never throws. A folder that is missing, unreadable or not a folder adds
 * nothing, and so does a skill with no string `name`, which OpenCode does not
 * load. Order follows `dirs`, then the scan.
 *
 * @param dirs - absolute user-level skill folders, in the order to report them.
 * @param dorkHome - the DorkOS data directory, whose links are DorkOS's own.
 * @returns one entry per named skill found.
 */
export function readUserSkillNames(dirs: readonly string[], dorkHome: string): UserSkillName[] {
  const owned = [resolve(dorkHome, 'plugins'), resolve(extensionSkillPluginsDir(dorkHome))];
  const found: UserSkillName[] = [];
  for (const dir of dirs) {
    if (readDirEntries(dir, dir, 'skill').unreadable) continue;
    let skills;
    try {
      skills = scanSkillDirs(dir, dir, { includeManagedProjections: true });
    } catch {
      continue;
    }
    for (const skill of skills) {
      const source = join(dir, skill.name);
      if (owned.some((root) => linkOwnerUnder(resolve(source), root) !== undefined)) continue;
      const { text } = readTextFile(join(source, SKILL_FILENAME), skill.name, 'skill');
      if (text === undefined) continue;
      const declared = declaredName(text);
      if (declared !== undefined) found.push({ source, exactFrontmatterName: declared });
    }
  }
  return found;
}

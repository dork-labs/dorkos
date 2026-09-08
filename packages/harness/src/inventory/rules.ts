/**
 * Rules half of the source inventory — the path-scoped instruction files under
 * `.claude/rules`, the kind the engine had never enumerated (IN-07, XA-02).
 *
 * A rule attaches guidance to a set of file globs, which is the whole reason it
 * is a separate kind: two harnesses have the same idea under different names
 * (Cursor's `.cursor/rules/*.mdc` `globs:`, Copilot's
 * `.github/instructions/*.instructions.md` `applyTo:`), and a projection to
 * either needs the globs. So they are read here once and carried on the entry.
 *
 * The directory is flat — Claude Code documents `.claude/rules/*.md`, and this
 * repository's 13 rules are all at the top level — so the walk does not descend.
 *
 * @module inventory/rules
 */
import { join } from 'node:path';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { listMarkdownFiles, readTextFile } from './read.js';
import type { RuleInventoryEntry, UnreadableSource } from './types.js';

/** The repo-relative directory Claude Code reads path-scoped rules from. */
export const CLAUDE_RULES_DIR = '.claude/rules';

/**
 * Read a rule's `paths:` frontmatter into a glob list.
 *
 * Both spellings people actually use are accepted: one comma-separated string
 * (what all 13 of this repository's rules use) and a YAML list. Anything else —
 * a number, a nested map — yields no globs rather than a guess.
 *
 * @param value - the raw `paths` frontmatter value.
 * @returns the globs, or `undefined` when the rule declares none this reader understands.
 */
function readPathGlobs(value: unknown): readonly string[] | undefined {
  const globs =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
  const trimmed = globs.map((glob) => glob.trim()).filter((glob) => glob.length > 0);
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Inventory every path-scoped rule under `.claude/rules`.
 *
 * A rule whose frontmatter will not parse is still a rule — the file is there
 * and Claude Code reads the directory — so it is inventoried without globs and
 * the parse failure is reported separately. A file that cannot be read at all is
 * only reported.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns the rules and any file or directory that could not be read.
 */
export function inventoryRules(repoRoot: string): {
  rules: RuleInventoryEntry[];
  unreadable: UnreadableSource[];
} {
  const { files, unreadable } = listMarkdownFiles(
    join(repoRoot, CLAUDE_RULES_DIR),
    CLAUDE_RULES_DIR,
    'rule'
  );

  const rules: RuleInventoryEntry[] = [];
  for (const file of files) {
    const read = readTextFile(join(repoRoot, file.source), file.source, 'rule');
    if (read.text === undefined) {
      if (read.unreadable) unreadable.push(read.unreadable);
      continue;
    }
    const frontmatter = readRawFrontmatter(read.text);
    if (frontmatter === null) {
      unreadable.push({
        kind: 'rule',
        source: file.source,
        reason: `${file.source} has frontmatter this reader cannot parse, so its "paths" globs were not read`,
      });
    }
    const paths = frontmatter ? readPathGlobs(frontmatter.data.paths) : undefined;
    rules.push({
      kind: 'rule',
      name: file.name,
      source: file.source,
      provenance: 'authored',
      ...(paths ? { paths } : {}),
    });
  }
  return { rules, unreadable };
}

/**
 * Hook half of the source inventory — every place a person declares a hook at
 * PROJECT scope, which is two more places than the engine has ever read.
 *
 * `loadClaudeHooks` reads `.claude/settings.json` and stops there. Claude Code
 * does not: it reads `.claude/settings.local.json` beside it, and it registers
 * the `hooks:` a `SKILL.md` declares in its own frontmatter for as long as that
 * skill is active. Both were silent — HK-12 and HK-14 — so a person with a
 * shell command in either was told nothing about it by any harness report.
 *
 * **`~/.claude/settings.json` is deliberately NOT read here.** It is the third
 * file Claude Code merges, it is outside the repository, and global scope is
 * DOR-1857's whole ticket. A source inventory of a repository that reached into
 * a home directory would report one machine's private hooks as if they were the
 * project's.
 *
 * Two exclusions keep this to SOURCES. A matcher group in
 * `.claude/settings.local.json` carrying the `_dorkosHarness` sentinel is one the
 * engine merged in from an installed plugin — DorkOS's own output, whose source
 * is the plugin's `hooks/hooks.json`. And an event whose groups are ALL managed
 * is skipped whole, because nobody authored any part of it.
 *
 * @module inventory/hooks
 */
import { join } from 'node:path';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { readRawFrontmatter } from '@dorkos/skills/parser';
import { MANAGED_HOOK_SENTINEL_KEY } from '../plan/installed-projector.js';
import { readJsonFile, readTextFile, relPath } from './read.js';
import type {
  HookInventoryEntry,
  HookOrigin,
  SkillInventoryEntry,
  UnreadableSource,
} from './types.js';

/** The two project-scope settings files Claude Code merges hooks from, in its own order. */
const SETTINGS_SOURCES: readonly { source: string; origin: HookOrigin }[] = [
  { source: '.claude/settings.json', origin: 'claude-settings' },
  { source: '.claude/settings.local.json', origin: 'claude-settings-local' },
];

/** Whether a value is a plain object usable as an event-keyed hooks map. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether every matcher group under one event is one the engine merged in.
 *
 * The sentinel is per GROUP, so an event can hold both a person's group and a
 * plugin's. Only an event that is entirely the engine's is skipped; a mixed one
 * is a person's hook that happens to share an event name.
 *
 * @param groups - the raw value under one event key.
 * @returns `true` when the event holds at least one group and every one is managed.
 */
function isWhollyManaged(groups: unknown): boolean {
  if (!Array.isArray(groups) || groups.length === 0) return false;
  return groups.every(
    (group) => isRecord(group) && typeof group[MANAGED_HOOK_SENTINEL_KEY] === 'string'
  );
}

/**
 * Inventory the hook events one settings file declares.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param source - the repo-relative settings file to read.
 * @param origin - which source this is, carried on every entry.
 * @returns the entries and any reason the file could not be read.
 */
function inventorySettingsHooks(
  repoRoot: string,
  source: string,
  origin: HookOrigin
): { hooks: HookInventoryEntry[]; unreadable: UnreadableSource[] } {
  const { value, unreadable } = readJsonFile(join(repoRoot, source), source, 'hook');
  if (unreadable) return { hooks: [], unreadable: [unreadable] };
  if (value === undefined) return { hooks: [], unreadable: [] };

  const declared = (value as { hooks?: unknown }).hooks;
  if (declared === undefined) return { hooks: [], unreadable: [] };
  if (!isRecord(declared)) {
    return {
      hooks: [],
      unreadable: [
        {
          kind: 'hook',
          source,
          reason: `${source} has a "hooks" key that is not an object, so no hook it declares was inventoried`,
        },
      ],
    };
  }

  return {
    hooks: Object.keys(declared)
      .filter((event) => !isWhollyManaged(declared[event]))
      .sort((a, b) => a.localeCompare(b))
      .map((event) => ({
        kind: 'hook' as const,
        name: event,
        source,
        provenance: 'authored' as const,
        origin,
        event,
      })),
    unreadable: [],
  };
}

/**
 * Inventory the hook events each authored skill declares in its own frontmatter.
 *
 * These are real shell commands with a real lifetime: Claude Code registers
 * them when the skill is invoked and **keeps running them for the rest of the
 * session**, not only during that turn, unless the hook sets `once: true`
 * (https://code.claude.com/docs/en/hooks, fetched 2026-09-07). It is the
 * SUBAGENT frontmatter hooks that are torn down when the subagent finishes —
 * `research/20260328_claude_code_skills_deep_dive.md` §5 says otherwise about
 * skills and is out of date. No other harness has the concept at all, which is
 * why these have to be said out loud rather than assumed portable.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param skills - the skills already inventoried, whose `SKILL.md` to read.
 * @returns the entries and any `SKILL.md` whose frontmatter would not parse.
 */
function inventorySkillFrontmatterHooks(
  repoRoot: string,
  skills: readonly SkillInventoryEntry[]
): { hooks: HookInventoryEntry[]; unreadable: UnreadableSource[] } {
  const hooks: HookInventoryEntry[] = [];
  const unreadable: UnreadableSource[] = [];

  for (const skill of skills) {
    const source = relPath(skill.source, SKILL_FILENAME);
    const read = readTextFile(join(repoRoot, source), source, 'hook');
    if (read.text === undefined) {
      if (read.unreadable) unreadable.push(read.unreadable);
      continue;
    }
    const frontmatter = readRawFrontmatter(read.text);
    if (frontmatter === null) {
      unreadable.push({
        kind: 'hook',
        source,
        reason: `${source} has frontmatter this reader cannot parse, so any hooks it declares were not inventoried`,
      });
      continue;
    }
    const declared = frontmatter.data.hooks;
    if (!isRecord(declared)) continue;
    for (const event of Object.keys(declared).sort((a, b) => a.localeCompare(b))) {
      hooks.push({
        kind: 'hook',
        name: `${skill.name}:${event}`,
        source,
        provenance: 'authored',
        origin: 'skill-frontmatter',
        event,
        skill: skill.name,
      });
    }
  }
  return { hooks, unreadable };
}

/**
 * Inventory every project-scope hook declaration: both Claude settings files and
 * every authored skill's frontmatter.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param skills - the skills already inventoried, whose frontmatter to read.
 * @returns one entry per event per source, and every source that could not be read.
 */
export function inventoryHooks(
  repoRoot: string,
  skills: readonly SkillInventoryEntry[]
): { hooks: HookInventoryEntry[]; unreadable: UnreadableSource[] } {
  const hooks: HookInventoryEntry[] = [];
  const unreadable: UnreadableSource[] = [];

  for (const { source, origin } of SETTINGS_SOURCES) {
    const result = inventorySettingsHooks(repoRoot, source, origin);
    hooks.push(...result.hooks);
    unreadable.push(...result.unreadable);
  }

  const frontmatter = inventorySkillFrontmatterHooks(repoRoot, skills);
  hooks.push(...frontmatter.hooks);
  unreadable.push(...frontmatter.unreadable);

  return { hooks, unreadable };
}

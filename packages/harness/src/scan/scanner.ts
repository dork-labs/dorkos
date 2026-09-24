/**
 * Skill scanner — derives the authored skill set from `.agents/skills/*`.
 *
 * The manifest deliberately does NOT store the per-skill list (it is derivable);
 * this scanner reconstructs it from disk so the projector always operates on the
 * current skill set, not a stale snapshot.
 *
 * @module scan/scanner
 */
import { lstatSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { isInstallSiblingName } from '@dorkos/shared/marketplace-schemas';

/** A single authored skill discovered under `.agents/skills`. */
export interface SkillEntry {
  /** The skill's directory name — its stable identifier. */
  name: string;
  /** Repo-relative source directory, e.g. `.agents/skills/<name>`. */
  sourceDir: string;
  /**
   * True when the entry is a directory the scan could not look INSIDE, so
   * whether it holds a `SKILL.md` is unknown.
   *
   * Such an entry counts as a skill anyway, and that is the whole point: the
   * plan is the sweeps' keep-set, so a folder that lost its permissions — or one
   * an `rm -rf` is halfway through — used to answer "not a skill" and take its
   * live `<pkg>__<name>` links with it, in silence (DOR-1935). Present is the
   * only safe reading of "could not look", exactly as it is for a skills ROOT
   * one level up (`SkillDirListing.unreadable`, DOR-1882).
   *
   * Absent means the entry was read: it has a `SKILL.md`, and everything about
   * it that a reader wants is on disk to be read.
   */
  unreadable?: true;
}

/**
 * The infix that marks a managed installed-plugin skill projection
 * (`<pkg>__<skill>`).
 *
 * It is half of the predicate, never the whole of it: the engine writes every
 * installed projection as a SYMLINK, so "managed projection" means `__` in the
 * name **and** a symlink on disk. A real directory named `my__helper` is
 * something a person authored, and is scanned and projected like any other
 * authored skill (DOR-1844). The orphan sweep asks for the same pair, so nothing
 * hand-authored is mistaken for a projection.
 *
 * ONE STANDING COST, older than any of this: an authored
 * `.agents/skills/my__helper` SYMLINK is indistinguishable from a managed
 * projection by construction, so the scan skips it (correctly, by the rule
 * above) and the sweep then deletes the link itself: `swept:
 * ['.agents/skills/my__helper']`. The real directory behind the link survives;
 * the link does not, and `--check` calls that clean because nothing was ever
 * planned for it. The old name-only rule skipped such an entry too, so this is
 * written down here rather than introduced.
 *
 * See contributing/harness-sync.md §4.
 */
export const INSTALLED_PROJECTION_MARKER = '__';

/**
 * The repo-relative skills directory both authored skills and installed-plugin
 * skill projections live in (Codex reads it directly). The single source of
 * truth for this path — the scanner, the projector's symlink target, and the
 * orphan sweep all agree on it.
 */
export const AGENTS_SKILLS_DIR = '.agents/skills';

/**
 * The substitution token Claude Code expands to a plugin's install directory at
 * runtime. It only resolves inside plugin context (SDK activation), so any file
 * the engine projects OUT of a plugin (a command wrapper, a native hook command)
 * must have it rewritten to an absolute path, and any projected file that still
 * carries it (e.g. an installed skill's `SKILL.md`) is flagged with a warning.
 */
export const CLAUDE_PLUGIN_ROOT_TOKEN = '${CLAUDE_PLUGIN_ROOT}';

/**
 * The substitution token Claude Code expands to a plugin's persistent data
 * directory. DorkOS resolves it to the install's own `.dork/data` (one per
 * install, so a project-scoped plugin keeps per-project state; ADR
 * 260923-163515). Like the root token, it is rewritten in projected commands and
 * hooks, and flagged in a projected skill that still carries it.
 */
export const CLAUDE_PLUGIN_DATA_TOKEN = '${CLAUDE_PLUGIN_DATA}';

/** How much of a skills directory {@link scanSkillDirs} should report. */
export interface ScanSkillDirsOptions {
  /**
   * Include the engine's own managed installed-plugin projections — the entries
   * that are BOTH `<pkg>__<name>` and a symlink. Defaults to `false`.
   *
   * The default is what a PLANNER wants: the authored scan feeds the projector,
   * and re-deriving what the projector already wrote would make the engine
   * project its own output. Set it for a READER that has to mirror what a
   * harness reads off disk — Codex enumerates `.agents/skills` entry by entry
   * and follows symlinks, so a projected plugin skill is a skill to it, and a
   * DorkOS reader that hides one shows a smaller palette than the bare `codex`
   * command in the same repo (DOR-1844, ADR 260706-192819's parity promise).
   */
  includeManagedProjections?: boolean;
  /**
   * Whether an entry that is a symlink may count as a skill. Defaults to `true`,
   * because linking a skill in from elsewhere is exactly what a person does with
   * `.agents/skills` and what every harness reading that directory honors.
   *
   * Pass `false` for a root the ENGINE walks on a package's behalf rather than a
   * person's. A symlink there is a link the scan would follow out of the tree it
   * was pointed at, and the projector turns whatever it finds into a
   * `.agents/skills` and `.claude/skills` link that both the palette and
   * `dorkos://skills` then serve — so `skills/stolen -> /somewhere/private`
   * publishes that directory to every agent in the project. See
   * `collectPortableSkills` for the one root that sets it.
   */
  followSymlinks?: boolean;
}

/**
 * Whether a directory entry is a skill directory: a real directory, or a symlink
 * whose target resolves to one.
 *
 * `Dirent.isDirectory()` is FALSE for a symlink, which is why a linked-in skill
 * source used to vanish from every scan without so much as a drop line. The
 * `stat()` follows the link; a dangling one (or a link loop) throws, and a link
 * pointing at nothing is not a skill, so it is skipped rather than propagated.
 */
function resolvesToDirectory(absPath: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The entries in a directory, and whether something is there that could not be
 * read.
 *
 * `existsSync` + `readdirSync` was here, and it answers only the commonest of
 * the three ways there is nothing to scan: a FILE at `.agents/skills` (ENOTDIR)
 * and one nobody may read (EACCES) both pass the guard and throw on the read —
 * out of `buildPlan`, so `dorkos harness sync` died before it could report
 * anything at all, `--check` included (DOR-1882; the same swap `apply/
 * link-state.ts` made for the sweeps in DOR-1843).
 *
 * **The two answers are not interchangeable, and collapsing them was worse than
 * the crash.** A skills root that cannot be listed holds no skills *as far as
 * this scan can tell*, and the planner's output is the sweep's only evidence of
 * what is installed — so an empty listing from a failed read made every live
 * link that pointed into that folder look orphaned, and one `chmod 000` on
 * `.agents/skills` deleted `.claude/skills/*` outright. ENOENT is the one errno
 * that really means nothing is there; every other one is an entry the caller has
 * to be told about (the same distinction `plan/global-projector.ts` draws with
 * `unreadableRoot`, for exactly the same reason).
 *
 * Written out here rather than imported from `apply/link-state.ts`: the apply
 * stage already reads this module, and pointing it back would make the two
 * directories depend on each other.
 *
 * @param absDir - the absolute directory to list.
 * @returns its entries, and whether the listing failed on something that is there.
 */
function listEntries(absDir: string): { entries: Dirent[]; unreadable: boolean } {
  try {
    return { entries: readdirSync(absDir, { withFileTypes: true }), unreadable: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { entries: [], unreadable: true };
    // ENOENT has two causes and they are opposite answers. Nothing at all is the
    // silent one. A LINK POINTING AT NOTHING is not: somebody put that entry
    // there, the skills it used to reach are still projected, and reading it as
    // an empty folder is how `.agents/skills -> ../vault/skills` with the vault
    // moved away deleted every link into it — which it did before any of this
    // too. `lstat` sees the link where `readdir` cannot follow it.
    return { entries: [], unreadable: entryIsThere(absDir) };
  }
}

/** Whether anything at all occupies a path, a link pointing at nothing included. */
function entryIsThere(absPath: string): boolean {
  return lstatSync(absPath, { throwIfNoEntry: false }) !== undefined;
}

/** What {@link listSkillDirs} found: the skills, and what it could not read. */
export interface SkillDirListing {
  /** The skills found, sorted by name. Empty for an absent root and an unreadable one alike. */
  skills: SkillEntry[];
  /**
   * The skill directories inside this root that could not be looked into, each
   * spelled `<relPrefix>/<name>` — the same paths their entries carry.
   *
   * Each one is ALSO in {@link skills}, flagged: this list exists so a report
   * can name the folder, not so a caller can subtract it. Empty is the ordinary
   * case, and it is a different fact from {@link unreadable}, which is about
   * this root rather than about anything in it.
   */
  unreadableSkills: string[];
  /**
   * True when something occupies the root and it could not be listed — a file
   * where the folder belongs, a folder nobody may read, a link to neither.
   *
   * **A caller that draws a conclusion from an EMPTY listing must read this
   * first.** "No skills here" and "nobody could look" are the same array and
   * opposite facts, and the second one is not evidence that a link pointing into
   * this folder is an orphan (DOR-1882).
   */
  unreadable: boolean;
}

/**
 * Enumerate skill directories directly under `absRoot`, reporting whether the
 * root could be read at all.
 *
 * The full answer {@link scanSkillDirs} narrows: use this wherever an empty
 * result would otherwise be read as "there is nothing here", and
 * {@link scanSkillDirs} where the caller only ever wants the skills it can see.
 *
 * @param absRoot - absolute path to the directory to scan.
 * @param relPrefix - repo-relative prefix prepended to each entry's name.
 * @param options - see {@link ScanSkillDirsOptions}; defaults to the planner's view.
 * @returns the skills found, whether the root was unreadable, and which skill
 *   directories inside it could not be looked into.
 */
export function listSkillDirs(
  absRoot: string,
  relPrefix: string,
  options: ScanSkillDirsOptions = {}
): SkillDirListing {
  const { entries, unreadable } = listEntries(absRoot);
  const skills: SkillEntry[] = [];
  const unreadableSkills: string[] = [];
  for (const entry of entries) {
    const isLink = entry.isSymbolicLink();
    if (isLink && options.followSymlinks === false) continue;
    const isManagedProjection = isLink && entry.name.includes(INSTALLED_PROJECTION_MARKER);
    if (isManagedProjection && !options.includeManagedProjections) continue;
    // A marketplace install's own sibling (a crash-left backup of a schedule
    // skill) is a copy, never a skill to project (DOR-2273).
    if (isInstallSiblingName(entry.name)) continue;
    const absEntry = join(absRoot, entry.name);
    if (!resolvesToDirectory(absEntry, entry)) continue;
    const sourceDir = `${relPrefix}/${entry.name}`;
    const marker = skillMarkerState(absEntry);
    if (marker === 'absent') continue;
    if (marker === 'unreadable') unreadableSkills.push(sourceDir);
    skills.push({
      name: entry.name,
      sourceDir,
      ...(marker === 'unreadable' ? { unreadable: true as const } : {}),
    });
  }
  return {
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    unreadable,
    unreadableSkills: unreadableSkills.sort(),
  };
}

/**
 * Whether a directory holds a `SKILL.md`, told apart from not being able to
 * look.
 *
 * `existsSync` collapses the two — reading `<dir>/SKILL.md` needs `x` on `<dir>`,
 * and a directory at mode 000 answers `false` exactly as an empty one does. The
 * two are opposite facts about a skill and the difference is a measured
 * deletion: the plan is the sweeps' keep-set, so "not a skill" took the folder's
 * live links with it (DOR-1935).
 *
 * `throwIfNoEntry: false` suppresses ENOENT and nothing else, so a missing file
 * is `undefined` and a permission error still throws — which is the whole
 * distinction, made by the call rather than by inspecting an errno.
 *
 * @param absEntry - the absolute skill directory to look in.
 * @returns `present`, `absent`, or `unreadable` when nobody could look.
 */
function skillMarkerState(absEntry: string): 'present' | 'absent' | 'unreadable' {
  try {
    return statSync(join(absEntry, 'SKILL.md'), { throwIfNoEntry: false }) === undefined
      ? 'absent'
      : 'present';
  } catch {
    return 'unreadable';
  }
}

/**
 * Enumerate skill directories directly under `absRoot`, each returned as a
 * {@link SkillEntry} whose `sourceDir` is `<relPrefix>/<name>`.
 *
 * An entry counts as a skill when it is a directory — or a symlink resolving to
 * one, which is how a person links a skill kept outside the repo into
 * `.agents/skills`, and which `followSymlinks: false` turns off for a root the
 * engine walks on a package's behalf — and it directly contains a `SKILL.md`.
 * Stray files, skill-less directories and dangling links are ignored.
 *
 * By default a managed installed projection is ignored too, so the authored scan
 * never re-derives the engine's own output. That is `<pkg>__<name>` **and** a
 * symlink, both halves required: the engine only ever writes a projection as a
 * link, so a real directory carrying `__` is authored and always counts. Pass
 * `includeManagedProjections` to get the projections back — see
 * {@link ScanSkillDirsOptions} for which callers should.
 *
 * Results are sorted by name so the projection plan is deterministic.
 *
 * **An empty result is ambiguous here** — absent and unreadable both answer `[]`
 * — so a caller that would treat "nothing found" as "nothing exists" must use
 * {@link listSkillDirs} instead. The readers that keep this narrower form only
 * ever show what they can see (the Codex palette, `dorkos://skills`, the source
 * inventory behind the adopt list), where the two answers really are the same.
 *
 * That is why a skill DIRECTORY nobody could look inside is dropped here and
 * kept there (DOR-1935). The planner has to keep it, because the plan is the
 * sweeps' keep-set and dropping it deletes its live links; a list somebody
 * READS has to drop it, because there is nothing to show — no frontmatter, no
 * description, and an adopt candidate whose source cannot be opened is an offer
 * that cannot be honoured.
 *
 * @param absRoot - absolute path to the directory to scan.
 * @param relPrefix - repo-relative prefix prepended to each entry's name.
 * @param options - see {@link ScanSkillDirsOptions}; defaults to the planner's view.
 * @returns one {@link SkillEntry} per immediate entry resolving to a directory
 *   that contains a `SKILL.md`.
 */
export function scanSkillDirs(
  absRoot: string,
  relPrefix: string,
  options: ScanSkillDirsOptions = {}
): SkillEntry[] {
  return listSkillDirs(absRoot, relPrefix, options).skills.filter(
    (skill) => skill.unreadable !== true
  );
}

/**
 * Enumerate authored skills under `<repoRoot>/.agents/skills`, and say whether
 * that folder could be read.
 *
 * The authored view: a skill linked in from outside the repo counts, a real
 * directory whose name contains `__` counts, and the engine's own managed
 * `<pkg>__<name>` symlinks do not — see {@link scanSkillDirs}.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns the authored skills, and whether `.agents/skills` was unreadable.
 */
export function listAuthoredSkills(repoRoot: string): SkillDirListing {
  return listSkillDirs(join(repoRoot, AGENTS_SKILLS_DIR), AGENTS_SKILLS_DIR);
}

/**
 * The shared repository generator for the engine's property tests (T0).
 *
 * `arbRepo()` produces a whole small repository — authored skills, plugins,
 * authored hooks, an optional `AGENTS.md`, an optional `.claude/commands`, a
 * random enabled-harness subset — and then stages **hostile occupants** on top
 * of it: a file somebody wrote by hand at a generated hook
 * target, a real directory at a skill link target, a widowed ownership sidecar,
 * a **dead symlink** at one of the three kinds of target the engine writes (a
 * `generate` target, a `scaffold` target, a `symlink` target), a **person's
 * own dead link** under `.claude/skills` pointing at a vendored checkout that
 * moved — the shape the orphan sweep must never take, however dead it is — and a
 * plain **file where a FOLDER on a write path belongs**, at any depth. Each
 * generated repo is materialised into a real temp dir; nothing here is mocked.
 *
 * It lives in its own module because more than one property file reads it:
 * `apply-ownership.property.test.ts` (P3, P4), `orphaned-links.property.test.ts`
 * (P2, P2b), `native-source-exists.property.test.ts` (P9a),
 * `native-reachable.property.test.ts` (P9b) and
 * `plan-completeness.property.test.ts` (P6). Keeping one generator is the point
 * — a hostile shape added for one property immediately hardens the others.
 *
 * P6 is why a generated repo also carries path-scoped rules, subagent
 * definitions (some nested), an authored `.mcp.json`, a person's own hooks in
 * `.claude/settings.local.json` and a skill declaring `hooks:` in its own
 * frontmatter. The engine had no `ArtifactType` for the first three, read only
 * one of the two settings files, and never parsed the fifth — so a generator
 * that staged none of them could not fail a completeness check, exactly as one
 * that always wrote `AGENTS.md` could not fail P9a.
 *
 * The three fields the last two turn on are `agentsMd`, `claudeCommands` and
 * `authoredHooks`: each names a file whose EXISTENCE decides whether a
 * projection may be called `native`, and each was once asserted regardless
 * (DOR-1847). A generator that always wrote all three could not fail P9a.
 *
 * P2b is why `claudeCommands` and `opencodeCommands` can each be a stray FILE or
 * an unreadable directory rather than only a directory. Both paths are scanned
 * by `--check` as well as `--fix` since every sweep gained a `find*` half
 * (DOR-1889), and `existsSync` says yes to both shapes while the `readdirSync`
 * behind it throws — so a generator that only ever staged directories could not
 * fail the property that says `checkPlan` never throws.
 *
 * P3b is why {@link RepoSpec.hostile} exists, and why those two command-directory
 * shapes now reach a plan that WRITES into them. Until DOR-1882 they were
 * downgraded first: a wrapper generated into a hostile command directory raised
 * ENOTDIR, EEXIST or EACCES out of `applyPlan`, which would have redded P2, P3,
 * P4 and P2c for a reason none of them names. A folder in the way is a `blocked`
 * conflict now, so the narrowing is gone and a file may be staged at any depth of
 * any write path.
 *
 * @module __tests__/properties/arb-repo
 */
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HARNESS_IDS, type HarnessId } from '../../manifest/schema.js';
import {
  CODEX_HOOKS_TARGET,
  CURSOR_HOOKS_TARGET,
  COPILOT_HOOKS_TARGET,
} from '../../generate/hooks.js';
import { EPHEMERAL_GITIGNORE_PATTERNS } from '../../sources/resolve-roots.js';
import { writeFileAt, writeJsonAt } from '../journeys/stage.js';

/** The sidecar suffix the engine writes beside a generated hook file. */
export const SIDECAR_SUFFIX = '.dorkos-generated';

/** Which harness owns each generated hook target — the map the sweep must respect. */
export const TARGET_HARNESS: Record<string, HarnessId> = {
  [CODEX_HOOKS_TARGET]: 'codex',
  [CURSOR_HOOKS_TARGET]: 'cursor',
  [COPILOT_HOOKS_TARGET]: 'copilot',
};

/** How a staged occupant's sidecar relates to the file beside it. */
type SidecarState = 'none' | 'matching' | 'stale';

/**
 * What the staged occupant's bytes look like.
 *
 * `vendor` is unmistakably a person's — the documented wrapper shape with a
 * distinctive command. `bare` is the engine's own pre-sidecar output shape, the
 * one case where migration rule 2 may legitimately overwrite a sidecar-less
 * file, so a generated repo has to be able to hold one.
 */
export type OccupantShape = 'vendor' | 'bare';

/**
 * Which kind of target a staged dead symlink sits at.
 *
 * The three are not interchangeable, because the engine answers each one
 * differently: a dead link at a `generate` target is drift the engine replaces,
 * at a `scaffold` target it is an absent pointer, and at a `symlink` target
 * under `.claude/skills` that points into `.agents/skills` it is an ORPHAN — the
 * skill it pointed at is gone, and the engine prunes it.
 */
type DanglingKind = 'generate' | 'scaffold' | 'skill';

/** The repo-relative path each {@link DanglingKind} stages its dead link at. */
const DANGLING_TARGETS: Record<DanglingKind, string> = {
  generate: CODEX_HOOKS_TARGET,
  scaffold: '.claude/CLAUDE.md',
  skill: '.claude/skills/zz-gone',
};

/**
 * The link text each staged dead link carries.
 *
 * The generate/scaffold links point at a sibling path that does not exist, so a
 * write THROUGH the link would land somewhere real and visible rather than
 * throwing — the engine has to remove the link, not follow it. The skill link
 * points into `.agents/skills/` at a name no generated repo ever has, which is
 * exactly the shape a removed authored skill leaves behind.
 */
const DANGLING_LINK_TEXT: Record<DanglingKind, string> = {
  generate: 'nowhere-codex-hooks.json',
  scaffold: 'nowhere-claude.md',
  skill: '../../.agents/skills/zz-gone',
};

/**
 * The state of a slash-command directory — `.claude/commands`, which Claude Code
 * reads and whose EXISTENCE is one of the three facts deciding whether a
 * projection may be called `native` (DOR-1847), and the flat
 * `.opencode/commands` beside it.
 *
 * The last two shapes are not exotic: both directories are enumerated by
 * wildcard, by `--fix` and — since every sweep gained a `find*` half (DOR-1889)
 * — by `--check` too. `existsSync` says yes to a stray FILE at that path and to
 * a directory nobody may read, and the `readdirSync` behind it then throws
 * ENOTDIR or EACCES out of a report whose whole job is to say what is wrong with
 * the tree. A generator that only ever staged directories could not fail P2b.
 */
type CommandDirState = 'absent' | 'empty' | 'populated' | 'file' | 'unreadable';

/**
 * Whether this platform can stage an unreadable directory at all.
 *
 * Not Windows, where POSIX modes do not mean this, and not root, who reads
 * everything regardless. Where it cannot, the shape is simply not generated —
 * a case that stages nothing is a case that asserts nothing.
 */
const CAN_STAGE_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

/** The command-directory shapes this generator stages, platform permitting. */
const COMMAND_DIR_STATES: readonly CommandDirState[] = CAN_STAGE_UNREADABLE
  ? ['absent', 'empty', 'populated', 'file', 'unreadable']
  : ['absent', 'empty', 'populated', 'file'];

/** One generated path-scoped rule: its name, and whether it declares `paths:` globs. */
interface RuleSpec {
  /** The rule's file name below `.claude/rules`, without the `.md`. */
  name: string;
  /** Whether it carries a `paths:` frontmatter glob (the half Cursor and Copilot key on). */
  paths: boolean;
}

/** One generated repository, before it is written to disk. */
export interface RepoSpec {
  /** Authored skill names under `.agents/skills`. */
  skills: string[];
  /**
   * Project-scoped installed plugins.
   *
   * `commands` is not decoration: a plugin command projects as a generated
   * wrapper into `.claude/commands/<pkg>/` and `.opencode/commands/`, the only
   * two directories the engine enumerates BY WILDCARD. Every one of its
   * ownership predicates therefore sees whatever else is in there — including
   * another process's in-flight atomic-write temp file, which it used to delete
   * (DOR-1854, review round 2). A generator that never shipped a command could
   * not reach that code at all.
   */
  plugins: { name: string; skills: string[]; hooks: boolean; commands: number }[];
  /** Whether `.claude/settings.json` carries authored hooks. */
  authoredHooks: boolean;
  /**
   * Whether a canonical `AGENTS.md` exists at the repo root.
   *
   * With `authoredHooks` and `claudeCommands`, this is what lets P9a fail: a
   * plan may only call something `native` when the file behind it is really
   * there, and each of the three used to be asserted regardless (DOR-1847).
   */
  agentsMd: boolean;
  /** What is at `.claude/commands`: nothing, an empty dir, a `.md`, a file, or an unreadable dir. */
  claudeCommands: CommandDirState;
  /**
   * The same five shapes at `.opencode/commands`.
   *
   * A separate field rather than a shared one, because the two directories are
   * scanned by different predicates — the Claude one per package subdirectory,
   * the OpenCode one flat — and a single value could never stage one hostile and
   * the other ordinary.
   */
  opencodeCommands: CommandDirState;
  /**
   * Path-scoped rules under `.claude/rules`, some carrying `paths:` globs.
   *
   * These and the four fields below are the kinds the engine could not name
   * before DOR-1845 — no `ArtifactType` for them, no scanner that looked. A
   * generator that never staged one could not fail the completeness property,
   * which is the same reason `agentsMd` and `claudeCommands` are here.
   */
  rules: RuleSpec[];
  /** Subagent definitions under `.claude/agents`, some in subdirectories. */
  agents: string[];
  /** Server names in an authored `.mcp.json`, or no `.mcp.json` at all. */
  mcpServers: string[] | null;
  /** Whether a person's own hooks sit in `.claude/settings.local.json`. */
  localSettingsHooks: boolean;
  /** Whether the first authored skill declares hooks in its own frontmatter. */
  skillFrontmatterHooks: boolean;
  /**
   * Whether a whole directory of rules is linked in from outside `.claude/rules`
   * — the shape a person uses to share one rule set across their repositories.
   * `Dirent.isDirectory()` is false for it, so the walk saw neither a directory
   * nor an `.md` file and said nothing.
   */
  linkedRulesDir: boolean;
  /**
   * Whether an `.md` entry under `.claude/agents` is a link to a file that moved.
   * It looks exactly like a subagent to a scan that never opens it, which is how
   * a `native` was claimed for a path that resolves to nothing.
   */
  deadAgentLink: boolean;
  /**
   * Whether a person's own skill is linked into `.claude/skills` from elsewhere
   * in the repository. Not every link there is DorkOS's projection, and treating
   * them all as one gave a real skill no line at all.
   */
  personSkillLink: boolean;
  /**
   * Real skill directories in `.claude/skills`, by directory name — see
   * {@link CLAUDE_SKILL_DIRS} for why the alphabet is awkward on purpose.
   */
  claudeSkills: (typeof CLAUDE_SKILL_DIRS)[number][];
  /** The manifest's enabled harnesses (may be empty). */
  harnesses: HarnessId[];
  /** A hand-written file at one generated hook target, or none. */
  occupant: { target: string; sidecar: SidecarState; shape: OccupantShape } | null;
  /** A sidecar with no file beside it, at the Copilot target. */
  widowedSidecar: boolean;
  /** Whether a real directory occupies a Claude skill link target. */
  dirOccupant: boolean;
  /** A dead symlink staged at one kind of engine target, or none. */
  dangling: DanglingKind | null;
  /**
   * A dead link somebody made themselves under `.claude/skills`, pointing OUT of
   * `.agents/skills` at a vendored checkout that has moved. It is dead, it is a
   * symlink, and it sits in a projection dir — every clause of the orphan
   * predicate but the one that matters. It must survive every sweep.
   */
  personLink: boolean;
  /**
   * A plain file staged where a FOLDER on a write path belongs, or none.
   *
   * Staged last and only where nothing else is, so it never contradicts the rest
   * of the spec — {@link MaterialisedRepo.hostile} says which case really got
   * one. Its whole job is to reach the write paths: a projection through that
   * folder must come back as a named `blocked` conflict rather than as an
   * exception out of the middle of the apply (DOR-1882).
   */
  hostile: (typeof HOSTILE_WRITE_PATHS)[number] | null;
  /**
   * The repo's root `.gitignore`, as a subset of the patterns the engine
   * declares — or `null` for a directory that is not a git checkout at all.
   *
   * P7 turns on this field twice over: a random subset is what makes "the lines
   * you are missing" a moving target rather than a fixed list, and the `null`
   * case is the one where the whole `.gitignore` contract is silent on purpose
   * (nothing to say about git in a tree git does not have).
   */
  gitignore: string[] | null;
}

/** What {@link materialise} actually staged for {@link RepoSpec.dangling}. */
interface StagedDangling {
  /** Which kind of target the dead link sits at. */
  kind: DanglingKind;
  /** Its repo-relative path. */
  path: string;
}

/** Where a person's own dead link is staged, and what it points at. */
export const PERSON_LINK_PATH = '.claude/skills/vendored';

/** Its link text: out of `.agents/skills` entirely, at a checkout that moved. */
const PERSON_LINK_TEXT = '../../vendor/skills/vendored';

/** A small name alphabet, so collisions between authored and plugin skills happen. */
const SKILL_NAMES = ['a', 'b', 'c', 'd'] as const;

/**
 * Rule file names, one of them NESTED.
 *
 * Claude Code discovers `.claude/rules` recursively, and this generator staged
 * only flat names — so a walk that stopped at the top level kept P6 green while
 * giving a nested rule zero lines under every harness (DOR-1845 review). Same
 * reasoning as the nested subagent names below.
 */
const RULE_NAMES = ['api', 'ui', 'frontend/style'] as const;

/**
 * Subagent names, two of them nested.
 *
 * This repository keeps two of its seven subagents in subdirectories, and a walk
 * that stopped at the top level would call that five — so a generator that only
 * staged flat names could not tell the two walks apart.
 */
const AGENT_NAMES = ['reviewer', 'react/tanstack', 'deep/nested/helper'] as const;

/** MCP server names for the generated `.mcp.json`. */
const MCP_NAMES = ['linear', 'shadcn'] as const;

/** Where a linked-in directory of rules is staged, and the link that reaches it. */
const LINKED_RULES_SOURCE = 'vendor/rules';
/** The link into `.claude/rules` that points at {@link LINKED_RULES_SOURCE}. */
const LINKED_RULES_LINK = '.claude/rules/shared';
/** The one rule reached THROUGH that link, as the inventory names it. */
export const LINKED_RULES_FILE = `${LINKED_RULES_LINK}/security.md`;

/** A dead subagent link: an `.md` entry that opens as nothing. */
const DEAD_AGENT_LINK = '.claude/agents/dead.md';

/**
 * Real skill directories staged in `.claude/skills`, with the names that decide
 * the placement.
 *
 * Every generated skill used to go to `.agents/skills`, and the single
 * `.claude/skills` entry was a link named `mine` — a name that satisfies every
 * harness's charset rule and matches its own frontmatter. So the whole
 * name-rule half of the placement was unreachable, and a `native` claimed for a
 * directory OpenCode and Cursor would refuse to decide about passed every
 * property green (DOR-1845 review). `.claude/skills` is exactly where an agent
 * drops a directory under whatever name it liked, so the alphabet says so:
 *
 * - `tidy` — lower-case, hyphen-free, frontmatter name matching. Loads everywhere.
 * - `My_Skill` — an upper-case underscore name that breaks Cursor's and
 *   OpenCode's documented charset rule.
 * - `mismatched` — a name that does not match its own frontmatter, which two
 *   harnesses document as required and two more say nothing about.
 * - `nameless` — no frontmatter name at all, which the frontmatter-keyed
 *   harnesses cannot key on.
 */
const CLAUDE_SKILL_DIRS = ['tidy', 'My_Skill', 'mismatched', 'nameless'] as const;

/** What each staged `.claude/skills` directory declares as its frontmatter name. */
const CLAUDE_SKILL_FRONTMATTER: Record<(typeof CLAUDE_SKILL_DIRS)[number], string | null> = {
  tidy: 'tidy',
  My_Skill: 'My_Skill',
  mismatched: 'something-else',
  nameless: null,
};

/**
 * The folders a generated repo may find a plain FILE at, one per generated case.
 *
 * Every one of them is a directory some action's write must pass through, and
 * they are chosen to cover **every depth** of one: the harness's own top folder,
 * the collection inside it, and the per-package folder inside that. Before
 * DOR-1882 a file at any of them raised ENOTDIR, EEXIST or EACCES out of the
 * middle of `applyPlan` — so the three command-directory shapes were deliberately
 * downgraded before they reached a plan that WROTE into them, and this list
 * could not exist at all. It is the same claim from the other side: a folder in
 * the way is a `blocked` conflict, so staging one may cost the projections that
 * go through it and nothing else.
 *
 * A file is the shape, rather than a mode-000 directory, because the command
 * directories already generate the unreadable one ({@link CommandDirState}) and
 * a file is the one every platform can stage.
 */
/** The bytes a staged file-in-the-way holds, so a property can prove it survived. */
export const HOSTILE_FILE_BYTES = 'not a folder\n';

const HOSTILE_WRITE_PATHS = [
  '.claude',
  '.claude/skills',
  '.claude/commands',
  '.claude/commands/acme',
  '.agents/skills',
  '.codex',
  '.cursor',
  '.github/hooks',
  '.gemini',
  '.opencode',
  '.opencode/commands',
] as const;

/** A skill a person keeps outside the canonical layer and links where Claude Code reads. */
const PERSON_SKILL_SOURCE = 'vendor/skills/mine';
/** The link into `.claude/skills` that reaches {@link PERSON_SKILL_SOURCE}. */
export const PERSON_SKILL_LINK = '.claude/skills/mine';

/**
 * The generator: a whole small repo, hostile occupants included.
 *
 * @returns an arbitrary over {@link RepoSpec}.
 */
export function arbRepo(): fc.Arbitrary<RepoSpec> {
  return fc.record({
    skills: fc.uniqueArray(fc.constantFrom(...SKILL_NAMES), { maxLength: 4 }),
    plugins: fc.uniqueArray(
      fc.record({
        name: fc.constantFrom('acme', 'flow'),
        skills: fc.uniqueArray(fc.constantFrom(...SKILL_NAMES), { maxLength: 2 }),
        hooks: fc.boolean(),
        commands: fc.integer({ min: 0, max: 1 }),
      }),
      { maxLength: 2, selector: (p) => p.name }
    ),
    authoredHooks: fc.boolean(),
    agentsMd: fc.boolean(),
    claudeCommands: fc.constantFrom<CommandDirState>(...COMMAND_DIR_STATES),
    opencodeCommands: fc.constantFrom<CommandDirState>(...COMMAND_DIR_STATES),
    rules: fc.uniqueArray(
      fc.record({ name: fc.constantFrom(...RULE_NAMES), paths: fc.boolean() }),
      { maxLength: 3, selector: (r) => r.name }
    ),
    agents: fc.uniqueArray(fc.constantFrom(...AGENT_NAMES), { maxLength: 3 }),
    mcpServers: fc.option(fc.uniqueArray(fc.constantFrom(...MCP_NAMES), { maxLength: 2 }), {
      nil: null,
    }),
    localSettingsHooks: fc.boolean(),
    skillFrontmatterHooks: fc.boolean(),
    linkedRulesDir: fc.boolean(),
    deadAgentLink: fc.boolean(),
    personSkillLink: fc.boolean(),
    claudeSkills: fc.uniqueArray(fc.constantFrom(...CLAUDE_SKILL_DIRS), { maxLength: 3 }),
    harnesses: fc.subarray([...HARNESS_IDS]),
    occupant: fc.option(
      fc.record({
        target: fc.constantFrom(CODEX_HOOKS_TARGET, CURSOR_HOOKS_TARGET, COPILOT_HOOKS_TARGET),
        sidecar: fc.constantFrom<SidecarState>('none', 'matching', 'stale'),
        shape: fc.constantFrom<OccupantShape>('vendor', 'bare'),
      }),
      { nil: null }
    ),
    widowedSidecar: fc.boolean(),
    dirOccupant: fc.boolean(),
    dangling: fc.option(fc.constantFrom<DanglingKind>('generate', 'scaffold', 'skill'), {
      nil: null,
    }),
    personLink: fc.boolean(),
    gitignore: fc.option(fc.subarray([...EPHEMERAL_GITIGNORE_PATTERNS]), { nil: null }),
    hostile: fc.option(fc.constantFrom(...HOSTILE_WRITE_PATHS), { nil: null }),
  });
}

/**
 * The bytes a staged occupant holds.
 *
 * `vendor` is unmistakably somebody's own — the documented wrapper shape with a
 * distinctive command, which the engine may never adopt or rewrite. `bare` is
 * the engine's own pre-sidecar output, which migration rule 2 IS allowed to
 * rewrite when no sidecar has ever been written beside it.
 *
 * @param target - the repo-relative hook target the occupant sits at.
 * @param shape - which of the two shapes to write.
 * @returns the exact bytes to stage.
 */
export function occupantContent(target: string, shape: OccupantShape = 'vendor'): string {
  const body =
    shape === 'bare'
      ? { Stop: [{ hooks: [{ type: 'command', command: `echo LEGACY ${target}` }] }] }
      : {
          version: 1,
          description: `hand-written ${target}`,
          hooks: { stop: [{ type: 'command', command: `echo MINE ${target}` }] },
        };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Whether the engine is entitled to rewrite this occupant: only its own legacy
 * bare map, and only at the Codex path, and only with no sidecar beside it.
 *
 * @param occupant - the staged occupant, or null.
 * @returns `true` when migration rule 2 covers it.
 */
export function isAdoptableLegacy(occupant: RepoSpec['occupant']): boolean {
  return (
    occupant !== null &&
    occupant.shape === 'bare' &&
    occupant.sidecar === 'none' &&
    occupant.target === CODEX_HOOKS_TARGET
  );
}

/** What {@link materialise} returns: the two temp dirs and what it staged in them. */
export interface MaterialisedRepo {
  /** Absolute path of the generated repository. */
  repoRoot: string;
  /** Absolute path of an empty dork home (no global plugins). */
  dorkHome: string;
  /** Absolute path of the staged hand-written occupant, when there is one. */
  occupantAbs?: string;
  /** The dead link that was actually staged, when there is one. */
  dangling?: StagedDangling;
  /**
   * Absolute paths this repo made mode-000.
   *
   * {@link withRepo} puts the mode back before it removes the tree: a directory
   * nobody may read defeats `rmSync -r` as thoroughly as it defeats the scan
   * under test, and a property that leaks temp directories is a property that
   * eventually fails for the wrong reason.
   */
  unreadable: string[];
  /**
   * The repo-relative folder a plain file was really staged at, when one was.
   *
   * `spec.hostile` is what the generator ASKED for; this is what landed. The two
   * differ whenever something else already occupies the path — most of these
   * folders are ones an ordinary generated repo also fills — and a property that
   * read the request would be asserting about a shape that is not there.
   */
  hostile?: string;
}

/**
 * Make a symlink at a repo-relative path, creating its parent directory first.
 *
 * @param repoRoot - absolute path of the staged repository.
 * @param relLink - repo-relative path the link sits at.
 * @param linkText - the literal link text, never resolved here.
 */
function linkInto(repoRoot: string, relLink: string, linkText: string): void {
  const abs = join(repoRoot, relLink);
  mkdirSync(dirname(abs), { recursive: true });
  symlinkSync(linkText, abs);
}

/**
 * Stage one slash-command directory in the shape the spec asked for.
 *
 * @param repoRoot - absolute path of the staged repository.
 * @param relDir - the directory's repo-relative path.
 * @param state - which of the five shapes to stage.
 * @param commandName - the `.md` to write for the `populated` shape.
 * @param unreadable - collects the paths made mode-000, so they can be restored.
 */
function stageCommandDir(
  repoRoot: string,
  relDir: string,
  state: CommandDirState,
  commandName: string,
  unreadable: string[]
): void {
  if (state === 'absent') return;
  const abs = join(repoRoot, relDir);
  if (state === 'file') {
    // A stray note where a directory belongs: `existsSync` says yes, and the
    // `readdirSync` behind it raises ENOTDIR.
    writeFileAt(abs, 'not a directory\n');
    return;
  }
  mkdirSync(abs, { recursive: true });
  if (state === 'populated') writeFileAt(join(abs, commandName), `# ${commandName}\n`);
  if (state === 'unreadable') {
    chmodSync(abs, 0o000);
    unreadable.push(abs);
  }
}

/**
 * Materialise a generated repo spec into a fresh temp dir.
 *
 * @param spec - the generated repository to write.
 * @returns the staged repo, its dork home, and what hostile content landed.
 */
function materialise(spec: RepoSpec): MaterialisedRepo {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-prop-repo-'));
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-prop-home-'));

  writeJsonAt(join(repoRoot, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: spec.harnesses,
  });
  if (spec.agentsMd) writeFileAt(join(repoRoot, 'AGENTS.md'), '# Project\n');
  const unreadable: string[] = [];
  stageCommandDir(repoRoot, '.claude/commands', spec.claudeCommands, 'review.md', unreadable);
  stageCommandDir(repoRoot, '.opencode/commands', spec.opencodeCommands, 'deploy.md', unreadable);
  for (const [index, name] of spec.skills.entries()) {
    // Real frontmatter, not a bare heading: the vendor-facts coverage walk keys
    // three harnesses on the frontmatter `name` and refuses to decide about a
    // SKILL.md that has none, so a generator without it would make every harness
    // `uncertain` about every skill and P9b vacuous.
    //
    // The first skill may also carry its own `hooks:` — a Claude Code feature no
    // other harness has, and one no scanner in the engine had ever parsed (HK-12).
    const hooks =
      spec.skillFrontmatterHooks && index === 0
        ? 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: ./check.sh\n'
        : '';
    writeFileAt(
      join(repoRoot, '.agents', 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: The ${name} skill\n${hooks}---\n\n# ${name}\n`
    );
  }
  if (spec.authoredHooks) {
    writeJsonAt(join(repoRoot, '.claude', 'settings.json'), {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo authored' }] }] },
    });
  }
  if (spec.localSettingsHooks) {
    // A person's own hooks, in the file the engine WRITES managed groups into and
    // has never READ (HK-14).
    writeJsonAt(join(repoRoot, '.claude', 'settings.local.json'), {
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    });
  }
  for (const rule of spec.rules) {
    const frontmatter = rule.paths ? `---\npaths: apps/**/*.ts, packages/**/*.ts\n---\n\n` : '';
    writeFileAt(
      join(repoRoot, '.claude', 'rules', `${rule.name}.md`),
      `${frontmatter}# ${rule.name} rules\n`
    );
  }
  for (const agent of spec.agents) {
    writeFileAt(
      join(repoRoot, '.claude', 'agents', `${agent}.md`),
      `---\nname: ${agent.split('/').join('-')}\ndescription: The ${agent} subagent\n---\n\n# ${agent}\n`
    );
  }
  if (spec.mcpServers) {
    writeJsonAt(join(repoRoot, '.mcp.json'), {
      mcpServers: Object.fromEntries(
        spec.mcpServers.map((name) => [name, { command: 'npx', args: [name] }])
      ),
    });
  }
  if (spec.linkedRulesDir) {
    writeFileAt(
      join(repoRoot, LINKED_RULES_SOURCE, 'security.md'),
      "---\npaths: '**/*.ts'\n---\n\n# security\n"
    );
    linkInto(repoRoot, LINKED_RULES_LINK, `../../${LINKED_RULES_SOURCE}`);
  }
  if (spec.deadAgentLink) {
    linkInto(repoRoot, DEAD_AGENT_LINK, '../../gone/missing.md');
  }
  for (const dir of spec.claudeSkills) {
    const declared = CLAUDE_SKILL_FRONTMATTER[dir];
    const name = declared === null ? '' : `name: ${declared}\n`;
    writeFileAt(
      join(repoRoot, '.claude', 'skills', dir, 'SKILL.md'),
      `---\n${name}description: The ${dir} skill\n---\n\n# ${dir}\n`
    );
  }
  if (spec.personSkillLink) {
    writeFileAt(
      join(repoRoot, PERSON_SKILL_SOURCE, 'SKILL.md'),
      '---\nname: mine\ndescription: A skill kept outside the canonical layer\n---\n\n# mine\n'
    );
    linkInto(repoRoot, PERSON_SKILL_LINK, `../../${PERSON_SKILL_SOURCE}`);
  }
  for (const plugin of spec.plugins) {
    const dir = join(repoRoot, '.dork', 'plugins', plugin.name);
    writeJsonAt(join(dir, '.dork', 'manifest.json'), {
      schemaVersion: 1,
      name: plugin.name,
      version: '1.0.0',
      type: 'plugin',
      description: `${plugin.name} plugin`,
      layers: ['skills', 'hooks', 'commands'],
    });
    for (let i = 0; i < plugin.commands; i++) {
      writeFileAt(
        join(dir, 'commands', `cmd-${i}.md`),
        `---\ndescription: ${plugin.name} command ${i}\n---\n\nRun ${i}.\n`
      );
    }
    for (const skill of plugin.skills) {
      writeFileAt(
        join(dir, 'skills', skill, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: The ${skill} skill\n---\n\n# ${skill}\n`
      );
    }
    if (plugin.hooks) {
      writeJsonAt(join(dir, 'hooks', 'hooks.json'), {
        Stop: [{ hooks: [{ type: 'command', command: `echo ${plugin.name}` }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'echo unmappable' }] }],
      });
    }
  }

  if (spec.widowedSidecar) {
    // A sidecar whose file is gone: the sweep may take it, alone.
    writeFileAt(
      `${join(repoRoot, COPILOT_HOOKS_TARGET)}${SIDECAR_SUFFIX}`,
      `${createHash('sha256').update('a file that is no longer here').digest('hex')}\n`
    );
  }

  let occupantAbs: string | undefined;
  if (spec.occupant) {
    occupantAbs = join(repoRoot, spec.occupant.target);
    const content = occupantContent(spec.occupant.target, spec.occupant.shape);
    writeFileAt(occupantAbs, content);
    if (spec.occupant.sidecar !== 'none') {
      const digested = spec.occupant.sidecar === 'matching' ? content : 'something else';
      writeFileAt(
        `${occupantAbs}${SIDECAR_SUFFIX}`,
        `${createHash('sha256').update(digested).digest('hex')}\n`
      );
    }
  }

  if (spec.dirOccupant && spec.skills.length > 0 && spec.harnesses.includes('claude-code')) {
    writeFileAt(
      join(repoRoot, '.claude', 'skills', spec.skills[0], 'precious.md'),
      '# do not delete\n'
    );
  }

  // A git checkout, and whatever the person's own `.gitignore` happens to cover.
  // `null` is a directory git does not track, where the contract says nothing.
  if (spec.gitignore) {
    mkdirSync(join(repoRoot, '.git'), { recursive: true });
    writeFileAt(
      join(repoRoot, '.gitignore'),
      `${['node_modules/', ...spec.gitignore].join('\n')}\n`
    );
  }

  if (spec.personLink) {
    linkInto(repoRoot, PERSON_LINK_PATH, PERSON_LINK_TEXT);
  }

  // The dead link goes on last, and only where nothing else is: two hostile
  // shapes at one path would make every assertion about that path ambiguous.
  let dangling: StagedDangling | undefined;
  if (spec.dangling && spec.occupant?.target !== DANGLING_TARGETS[spec.dangling]) {
    const rel = DANGLING_TARGETS[spec.dangling];
    const abs = join(repoRoot, rel);
    mkdirSync(dirname(abs), { recursive: true });
    symlinkSync(DANGLING_LINK_TEXT[spec.dangling], abs);
    dangling = { kind: spec.dangling, path: rel };
  }

  // And the file in the way goes last of all, for the same reason and one more:
  // most of these folders are ones an ordinary generated repo fills, so it is
  // staged only where the tree left the path free. What landed is reported, so
  // no property asserts about a shape that is not there.
  let hostile: string | undefined;
  if (spec.hostile !== null && !existsSync(join(repoRoot, spec.hostile))) {
    try {
      writeFileAt(join(repoRoot, spec.hostile), HOSTILE_FILE_BYTES);
      hostile = spec.hostile;
    } catch {
      // Something ABOVE it is already one of the generator's other hostile
      // shapes — a file at `.claude/commands` under a requested
      // `.claude/commands/acme`, or a mode-000 directory. Nothing was staged, so
      // `hostile` stays undefined and no property asserts about it. The floors in
      // P3b are what stop that becoming a green over nothing.
    }
  }

  return { repoRoot, dorkHome, occupantAbs, dangling, unreadable, hostile };
}

/**
 * Run `body` against a materialised repo, always cleaning both temp dirs up.
 *
 * @param spec - the generated repository to stage.
 * @param body - the property body, given the staged paths.
 */
export function withRepo(spec: RepoSpec, body: (dirs: MaterialisedRepo) => void): void {
  const dirs = materialise(spec);
  try {
    body(dirs);
  } finally {
    // Modes first: `rmSync -r` has to read a directory to empty it, so a
    // mode-000 one would survive the cleanup and leak the whole temp tree.
    for (const abs of dirs.unreadable) {
      try {
        chmodSync(abs, 0o755);
      } catch {
        /* already gone */
      }
    }
    for (const d of [dirs.repoRoot, dirs.dorkHome]) rmSync(d, { recursive: true, force: true });
  }
}

/** fast-check settings: modest run count, fixed seed so a failure is reproducible. */
export const RUNS = { numRuns: 40, seed: 20260907 } as const;

/**
 * How long a property driven by this generator gets, in milliseconds.
 *
 * Every one of them materialises a whole repository per generated case — real
 * directories, real symlinks, a real apply — forty times over, and DOR-1854's
 * review added a `commands` layer because the swept command directories are
 * where the concurrency bugs lived. Alone each file still runs in one to two
 * seconds; under the full suite, with workers competing for CPU and the disk,
 * they sat right on vitest's 5s default and timed out about one run in three
 * (measured: 3/3 clean without the commands layer, 2 timeouts in 3 runs with
 * it). The budget is generous on purpose — it is here to say "this is an I/O
 * property", not to hide a hang, and a real hang still fails, just later.
 */
export const PROPERTY_TIMEOUT_MS = 60_000;

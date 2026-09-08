/**
 * `stageRepo` — the journey fixture DSL.
 *
 * A journey stages a whole repository the way a person would actually have one,
 * runs one real projection against it, and asserts the EXACT set of paths that
 * run added, changed or removed (`snapshotTree` + `diffSnapshots` in
 * `./stage.ts`). Before this existed each journey hand-rolled its tree with
 * `mkdirSync`/`writeFileSync`, which made every fixture a hundred lines of
 * plumbing and made two journeys' idea of "a realistic repo" quietly different.
 *
 * The spec is one object per harness plus the canonical layer, so a fixture
 * READS as the repository it describes:
 *
 * ```ts
 * const repo = stageRepo({
 *   claude: { skills: ['a'], commands: ['deploy'], rootClaudeMd: '# Project' },
 *   plugins: [{ name: 'flow', scope: 'project', skills: ['capture'] }],
 *   manifest: { harnesses: ['claude-code', 'codex'] },
 *   git: true,
 * });
 * ```
 *
 * Three rules the DSL keeps, because a journey's exact diff depends on them:
 *
 * 1. **Every body is deterministic.** No timestamps, no temp paths, no random
 *    ids — two stagings of the same spec differ only in their root.
 * 2. **Skills are real skills.** Each `SKILL.md` carries frontmatter with a
 *    `name`, because three harnesses key a skill by that field and a body-only
 *    file would exercise the parser's failure path instead of the journey.
 * 3. **Nothing is projected.** `stageRepo` writes only what a PERSON (or the
 *    marketplace installer) puts there. Everything else in the tree afterwards
 *    is the engine's, which is what makes the diff meaningful.
 *
 * Kept separate from `./stage.ts` on purpose: that module is the snapshot half
 * (hashing, diffing, probes) and is imported by journeys that stage nothing at
 * all, while this one is the staging half and imports it for nothing.
 *
 * @module __tests__/journeys/stage-repo
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HarnessId } from '../../manifest/schema.js';
import type { ClaudeHooksConfig } from '../../generate/hooks.js';
import { writeFileAt, writeJsonAt } from './stage.js';

/**
 * One skill directory to stage, when a plain name is not enough.
 *
 * The three flags each turn on a behaviour a contract row is about, so a journey
 * asks for the row rather than for YAML: a `schedule:` block (SK-02's scheduled
 * task), a `${CLAUDE_PLUGIN_ROOT}` token (SK-07's plugin-context caveat), and a
 * frontmatter `hooks:` declaration (HK-12).
 */
export interface SkillDirSpec {
  /** The skill's directory name, and its frontmatter `name`. */
  name: string;
  /** Declare a `schedule:` block, which is what makes any skill a scheduled task. */
  scheduled?: boolean;
  /** Put a `${CLAUDE_PLUGIN_ROOT}` token in the body, which only resolves in plugin context. */
  pluginRoot?: boolean;
  /**
   * Declare hooks in the skill's own frontmatter (HK-12). `true` uses a stock
   * `PreToolUse` guard; a string is used as the hook command verbatim.
   */
  frontmatterHooks?: boolean | string;
}

/** A skill to stage: just its name, or {@link SkillDirSpec} when a flag is needed. */
export type SkillSpec = string | SkillDirSpec;

/**
 * One path-scoped rule under `.claude/rules`.
 *
 * `paths` is written into the frontmatter VERBATIM and unquoted, because the
 * quoting is the thing under test: a bare `**` opens a YAML scalar with `*`,
 * which the parser reads as an alias, so `paths: **\/*.test.ts` is a rule Claude
 * Code still reads and this repository's own reader cannot parse (IN-07). A
 * plain string names a rule with no frontmatter at all.
 */
export interface RuleFileSpec {
  /** The rule's file name below `.claude/rules`, with or without the `.md`. */
  name: string;
  /** The `paths:` frontmatter value, written exactly as given. */
  paths: string;
}

/** One `manifest.claudeOnlySkills` entry, as a person would write it. */
export interface ClaudeOnlySkillSpec {
  /** The skill's name. */
  name: string;
  /** Repo-relative path the entry claims the skill is kept at. */
  path: string;
  /** Why it is deliberately not in the canonical layer. */
  reason: string;
}

/** What a Claude Code project has in `.claude/` (and the two files beside it). */
export interface ClaudeSpec {
  /** Skills, staged as REAL directories in `.claude/skills/<name>/SKILL.md`. */
  skills?: readonly SkillSpec[];
  /** Slash-command names, staged as `.claude/commands/<name>.md`. */
  commands?: readonly string[];
  /**
   * Path-scoped rules, staged as `.claude/rules/<name>.md`. A plain string is a
   * rule with no frontmatter; a {@link RuleFileSpec} carries `paths:` globs.
   */
  rules?: readonly (string | RuleFileSpec)[];
  /** Subagent names, staged as `.claude/agents/<name>.md` with frontmatter. */
  agents?: readonly string[];
  /** The `hooks` object of `.claude/settings.json` — the one the engine projects from. */
  settingsHooks?: ClaudeHooksConfig;
  /** The `hooks` object of `.claude/settings.local.json` — the person's own, never projected. */
  settingsLocalHooks?: ClaudeHooksConfig;
  /** The whole `.mcp.json` body, written at the repository ROOT where Claude Code reads it. */
  mcpJson?: unknown;
  /** The root `CLAUDE.md`'s content. */
  rootClaudeMd?: string;
}

/** What a Codex project has in `.codex/`. */
export interface CodexSpec {
  /** The whole hand-written `.codex/hooks.json` body — the file HK-11 is about. */
  hooksJson?: unknown;
  /** The literal `.codex/config.toml` text (MCP servers, trust settings). */
  configToml?: string;
}

/** What a Cursor project has in `.cursor/`. */
export interface CursorSpec {
  /** The whole hand-written `.cursor/hooks.json` body. */
  hooksJson?: unknown;
  /** Rule names, staged as `.cursor/rules/<name>.mdc` — the extension Cursor reads. */
  rules?: readonly string[];
}

/** What an OpenCode project has in `.opencode/` (and `opencode.json` beside it). */
export interface OpenCodeSpec {
  /** Skills, staged as real directories in `.opencode/skills/<name>/SKILL.md`. */
  skills?: readonly SkillSpec[];
  /** Command names, staged as AUTHORED `.opencode/commands/<name>.md` — no engine marker. */
  commands?: readonly string[];
  /** The whole `opencode.json` body. */
  opencodeJson?: unknown;
}

/** The canonical, harness-agnostic layer: `.agents/` and `AGENTS.md`. */
export interface AgentsSpec {
  /** Skills, staged as real directories in `.agents/skills/<name>/SKILL.md`. */
  skills?: readonly SkillSpec[];
  /**
   * Skills kept outside the canonical layer and reached through a symlink:
   * `{ e: '../../vendor/e' }` stages the real skill at `vendor/e` and links
   * `.agents/skills/e` at the given RELATIVE text, so a committed fixture
   * resolves in a clone (AP-06).
   */
  symlinkedSkills?: Readonly<Record<string, string>>;
  /** Whether to write a root `AGENTS.md`, or the exact text to write. */
  agentsMd?: boolean | string;
}

/** One marketplace-installed plugin, as the installer leaves it on disk. */
export interface PluginSpec {
  /** Package name — the projection namespace (`<pkg>__<skill>`). */
  name: string;
  /** `project` → `<root>/.dork/plugins/<name>`; `global` → `<dorkHome>/plugins/<name>`. */
  scope: 'project' | 'global';
  /** Skills, staged under `skills/<name>/SKILL.md`. */
  skills?: readonly SkillSpec[];
  /** Skill names that also carry a `schedule:` block — what makes a skill a scheduled task. */
  scheduled?: readonly string[];
  /** Slash-command names, staged under `commands/<name>.md`. */
  commands?: readonly string[];
  /** The whole `hooks/hooks.json` body — the shell commands consent is about. */
  hooks?: unknown;
  /**
   * The manifest's declared `layers`. Defaults to whatever the spec staged, so
   * a fixture only says this when it is testing a non-portable layer.
   */
  layers?: readonly string[];
  /** The manifest's `type`. Defaults to `plugin`. */
  type?: string;
}

/** Everything a journey can stage. Every field is optional; an empty spec is a bare repo. */
export interface StageRepoSpec {
  /** `.claude/` and the two root files Claude Code reads. */
  claude?: ClaudeSpec;
  /** `.codex/`. */
  codex?: CodexSpec;
  /** `.cursor/`. */
  cursor?: CursorSpec;
  /** `.opencode/` and `opencode.json`. */
  opencode?: OpenCodeSpec;
  /** `.agents/` and `AGENTS.md`. */
  agents?: AgentsSpec;
  /** Marketplace-installed plugins, at either scope. */
  plugins?: readonly PluginSpec[];
  /**
   * `.agents/harness.manifest.json`. Omit for the default two-harness manifest;
   * pass `false` to stage NO manifest, which is what a project that has never
   * run `dorkos harness sync` looks like.
   */
  manifest?:
    { harnesses: readonly HarnessId[]; claudeOnlySkills?: readonly ClaudeOnlySkillSpec[] } | false;
  /** Make it a real git repository with one commit, so rename and symlink behaviour is real. */
  git?: boolean;
  /** Lines to write into a root `.gitignore`. */
  gitignore?: readonly string[];
}

/** A staged repository: where it is, its dork home, and how to remove both. */
export interface StagedRepo {
  /** Absolute path to the repository root. */
  root: string;
  /**
   * Absolute path to a per-fixture DorkOS data directory, for the `dorkHome`
   * every projection entry point takes. Global-scope plugins are staged in it.
   */
  dorkHome: string;
  /** Remove both directories. Safe to call twice. */
  cleanup: () => void;
}

/** The manifest a journey gets when it does not ask for a particular one. */
const DEFAULT_HARNESSES: readonly HarnessId[] = ['claude-code', 'codex'];

/**
 * The identity a staged repository commits as, passed as `-c` overrides rather
 * than through the environment.
 *
 * Fixed so `git commit` works on a machine with no git identity configured (CI
 * containers have none) and so nothing in a fixture depends on who ran it. `-c`
 * rather than `GIT_AUTHOR_*` because the alternative is reading `process.env` to
 * rebuild the child's environment, which this repo bans outside an `env.ts`.
 */
const GIT_IDENTITY = [
  '-c',
  'user.name=Journey Fixture',
  '-c',
  'user.email=fixture@dorkos.invalid',
  // A machine with commit signing on globally would otherwise prompt, or fail.
  '-c',
  'commit.gpgsign=false',
] as const;

/**
 * The body of a staged `SKILL.md`: real frontmatter with a `name`, plus a
 * one-line body.
 *
 * @param spec - the skill to write.
 * @returns the file's exact bytes.
 */
export function skillFile(spec: SkillSpec): string {
  const { name, scheduled, pluginRoot, frontmatterHooks } = normalizeSkill(spec);
  const schedule = scheduled ? "schedule:\n  cron: '0 9 * * *'\n" : '';
  const hooks =
    frontmatterHooks === undefined || frontmatterHooks === false
      ? ''
      : 'hooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n' +
        `          command: ${frontmatterHooks === true ? './scripts/guard.sh' : frontmatterHooks}\n`;
  const body = pluginRoot ? 'Run ${CLAUDE_PLUGIN_ROOT}/bin/run.mjs.\n' : `The ${name} skill.\n`;
  return `---\nname: ${name}\ndescription: The ${name} skill\n${schedule}${hooks}---\n\n# ${name}\n\n${body}`;
}

/** Widen a plain name into the full skill spec. */
function normalizeSkill(spec: SkillSpec): SkillDirSpec {
  return typeof spec === 'string' ? { name: spec } : spec;
}

/** Stage one `SKILL.md` directory under `dir`. */
function stageSkill(dir: string, spec: SkillSpec): void {
  writeFileAt(join(dir, normalizeSkill(spec).name, 'SKILL.md'), skillFile(spec));
}

/** Stage the `.claude/` half of a repository. */
function stageClaude(root: string, spec: ClaudeSpec): void {
  for (const name of spec.skills ?? []) stageSkill(join(root, '.claude', 'skills'), name);
  for (const name of spec.commands ?? []) {
    writeFileAt(join(root, '.claude', 'commands', `${name}.md`), `# /${name}\n\nRun ${name}.\n`);
  }
  for (const rule of spec.rules ?? []) {
    const name = typeof rule === 'string' ? rule : rule.name;
    const leaf = name.endsWith('.md') ? name : `${name}.md`;
    const frontmatter = typeof rule === 'string' ? '' : `---\npaths: ${rule.paths}\n---\n\n`;
    writeFileAt(join(root, '.claude', 'rules', leaf), `${frontmatter}# ${name}\n`);
  }
  for (const name of spec.agents ?? []) {
    writeFileAt(
      join(root, '.claude', 'agents', `${name}.md`),
      `---\nname: ${name}\ndescription: The ${name} subagent\n---\n\n# ${name}\n`
    );
  }
  if (spec.settingsHooks) {
    writeJsonAt(join(root, '.claude', 'settings.json'), { hooks: spec.settingsHooks });
  }
  if (spec.settingsLocalHooks) {
    writeJsonAt(join(root, '.claude', 'settings.local.json'), { hooks: spec.settingsLocalHooks });
  }
  if (spec.mcpJson !== undefined) writeJsonAt(join(root, '.mcp.json'), spec.mcpJson);
  if (spec.rootClaudeMd !== undefined) writeFileAt(join(root, 'CLAUDE.md'), spec.rootClaudeMd);
}

/** Stage the canonical `.agents/` layer and the root `AGENTS.md`. */
function stageAgents(root: string, spec: AgentsSpec): void {
  for (const name of spec.skills ?? []) stageSkill(join(root, '.agents', 'skills'), name);
  for (const [name, linkText] of Object.entries(spec.symlinkedSkills ?? {})) {
    // The link text is relative to `.agents/skills/<name>`, so the real skill is
    // staged at the path that text resolves to — which keeps a committed fixture
    // working in a clone.
    const target = join(root, '.agents', 'skills', name);
    mkdirSync(dirname(target), { recursive: true });
    const realDir = join(target, '..', linkText);
    writeFileAt(join(realDir, 'SKILL.md'), skillFile(name));
    symlinkSync(linkText, target, 'dir');
  }
  if (spec.agentsMd !== undefined && spec.agentsMd !== false) {
    const text =
      typeof spec.agentsMd === 'string' ? spec.agentsMd : '# Our project\n\nHouse rules.\n';
    writeFileAt(join(root, 'AGENTS.md'), text);
  }
}

/** Stage one installed plugin into its scope's install root. */
function stagePlugin(root: string, dorkHome: string, spec: PluginSpec): void {
  const dir =
    spec.scope === 'project'
      ? join(root, '.dork', 'plugins', spec.name)
      : join(dorkHome, 'plugins', spec.name);

  const layers =
    spec.layers ??
    [
      (spec.skills?.length ?? 0) + (spec.scheduled?.length ?? 0) > 0 ? 'skills' : undefined,
      spec.commands?.length ? 'commands' : undefined,
      spec.hooks ? 'hooks' : undefined,
    ].filter((layer): layer is string => layer !== undefined);

  writeJsonAt(join(dir, '.dork', 'manifest.json'), {
    schemaVersion: 1,
    name: spec.name,
    version: '1.0.0',
    type: spec.type ?? 'plugin',
    description: `The ${spec.name} package`,
    layers,
  });

  for (const name of spec.skills ?? []) stageSkill(join(dir, 'skills'), name);
  for (const name of spec.scheduled ?? []) {
    stageSkill(join(dir, 'skills'), { name, scheduled: true });
  }
  for (const name of spec.commands ?? []) {
    writeFileAt(
      join(dir, 'commands', `${name}.md`),
      `---\ndescription: The ${name} command\n---\n\nRun ${name}.\n`
    );
  }
  if (spec.hooks !== undefined) writeJsonAt(join(dir, 'hooks', 'hooks.json'), spec.hooks);
}

/**
 * Make `root` a real git repository holding one commit of everything staged.
 *
 * Real rather than faked because two journeys ask git questions of the fixture:
 * J-10 clones it with `core.symlinks=false`, and a rename is only a rename to
 * git if the tree was committed first. Signing is off and the identity is fixed
 * so it works on a machine that has neither.
 *
 * @param root - absolute path of the repository to initialise.
 */
function initGit(root: string): void {
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  };
  run('init', '--initial-branch=main', '--quiet');
  run('add', '--all');
  run(...GIT_IDENTITY, 'commit', '--quiet', '-m', 'Stage the fixture');
}

/**
 * Stage a whole repository from a declarative spec, plus the dork home that goes
 * with it.
 *
 * The order is the order a real repository grew: the person's own files, then
 * the manifest, then whatever the marketplace installed, then `.gitignore`, then
 * the commit — so `git: true` captures everything the spec described.
 *
 * @param spec - what the repository holds. Every field is optional.
 * @returns the staged repository's root, its dork home, and a cleanup function.
 */
export function stageRepo(spec: StageRepoSpec = {}): StagedRepo {
  const root = mkdtempSync(join(tmpdir(), 'harness-journey-repo-'));
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-journey-home-'));

  if (spec.claude) stageClaude(root, spec.claude);
  if (spec.agents) stageAgents(root, spec.agents);

  if (spec.codex?.hooksJson !== undefined) {
    writeJsonAt(join(root, '.codex', 'hooks.json'), spec.codex.hooksJson);
  }
  if (spec.codex?.configToml !== undefined) {
    writeFileAt(join(root, '.codex', 'config.toml'), spec.codex.configToml);
  }

  if (spec.cursor?.hooksJson !== undefined) {
    writeJsonAt(join(root, '.cursor', 'hooks.json'), spec.cursor.hooksJson);
  }
  for (const name of spec.cursor?.rules ?? []) {
    writeFileAt(
      join(root, '.cursor', 'rules', `${name}.mdc`),
      `---\ndescription: The ${name} rule\n---\n\nBe careful.\n`
    );
  }

  for (const name of spec.opencode?.skills ?? []) {
    stageSkill(join(root, '.opencode', 'skills'), name);
  }
  for (const name of spec.opencode?.commands ?? []) {
    writeFileAt(
      join(root, '.opencode', 'commands', `${name}.md`),
      `---\ndescription: The ${name} command\n---\n\nRun ${name}.\n`
    );
  }
  if (spec.opencode?.opencodeJson !== undefined) {
    writeJsonAt(join(root, 'opencode.json'), spec.opencode.opencodeJson);
  }

  if (spec.manifest !== false) {
    writeJsonAt(join(root, '.agents', 'harness.manifest.json'), {
      version: 1,
      harnesses: [...(spec.manifest?.harnesses ?? DEFAULT_HARNESSES)],
      ...(spec.manifest?.claudeOnlySkills
        ? { claudeOnlySkills: [...spec.manifest.claudeOnlySkills] }
        : {}),
    });
  }

  for (const plugin of spec.plugins ?? []) stagePlugin(root, dorkHome, plugin);

  if (spec.gitignore) writeFileAt(join(root, '.gitignore'), `${spec.gitignore.join('\n')}\n`);

  if (spec.git) initGit(root);

  return {
    root,
    dorkHome,
    cleanup: () => {
      for (const dir of [root, dorkHome]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

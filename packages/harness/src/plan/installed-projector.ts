/**
 * Installed-plugin projection — turn a {@link InstalledPlugin} into projection
 * actions for one harness, plus the honest drops for everything that has no
 * harness home.
 *
 * A project-scoped marketplace plugin is delivered to every harness through
 * harness-native files, NOT through a runtime SDK plugin array (ADR
 * 260706-192819): the external `claude` CLI and DorkOS-managed sessions then see
 * exactly the same thing. Per harness:
 *
 * - **skills** project as symlinks into the harness's skill dir, always
 *   namespaced `<pkg>__<name>` so an installed skill can never silently overwrite
 *   an authored one (claude-code → `.claude/skills`, codex → `.agents/skills`).
 *   OpenCode, Cursor, Gemini CLI and Copilot read `.agents/skills` directly, so
 *   they take the same skills `native` rather than a symlink of their own — and
 *   the link they read is planned whatever harnesses are enabled (see
 *   {@link planCanonicalSkillLinks}), which is what makes that `native` true.
 * - **commands** project as generated repo-local wrappers, with every
 *   `${CLAUDE_PLUGIN_ROOT}` rewritten to the absolute install dir and a marker
 *   line marking the file engine-generated (the sweep-ownership predicate):
 *   claude-code → `.claude/commands/<pkg>/<name>.md` (namespaced subdir);
 *   opencode → `.opencode/commands/<pkg>-<name>.md` (flat, hyphen-joined,
 *   frontmatter reduced to `description`, invoked `/<pkg>-<name>` since OpenCode
 *   has no command namespacing). Other harnesses have no repo-local slash-command
 *   format, so their commands drop with a reason.
 * - **hooks** merge (claude-code only) into the user-owned
 *   `.claude/settings.local.json`, touching only the managed entries. They are
 *   also folded into the generated Codex hooks file by the projector (see
 *   {@link mergeHookConfigs}), with `${CLAUDE_PLUGIN_ROOT}` rewritten to absolute
 *   first (see {@link rewritePluginRootInHooks}). OpenCode has no declarative
 *   hook config (only a code-based TS plugin API), so its hooks drop honestly.
 *   What the scanner could not READ out of a plugin's `hooks/hooks.json` is
 *   reported separately, by `plan/unreadable-hooks.ts`.
 *
 * One projection answers to no harness list at all. `.agents/skills` is the one
 * directory five of the six harnesses read AND the only project skills root the
 * DorkOS scheduler watches, so every installed plugin skill is linked there
 * whatever harnesses the project enables (see {@link planCanonicalSkillLinks}).
 * It arrived for schedules — the stock project (harnesses `['claude-code']`)
 * projected the flow plugin's scheduled skills only into `.claude/skills`, which
 * nothing watches, so their schedules were never offered for approval (DOR-1518)
 * — and DOR-1847 widened it to every installed skill, because an OpenCode- or
 * Cursor-only project had the same hole with none of the schedules.
 *
 * A cross-harness caveat the projector also warns on: Claude Code keys a skill by
 * its DIRECTORY name (so `<pkg>__<name>` namespacing protects it), but OpenCode
 * and Codex key a skill by its `SKILL.md` frontmatter `name`, so two skills that
 * share a frontmatter name collide there regardless of the directory namespacing
 * (see {@link planSkillNameCollisions}).
 *
 * Non-portable layers (extensions, adapters, mcp-servers, …) drop with a reason.
 *
 * @module plan/installed-projector
 */
import { join } from 'node:path';
import { HARNESS_LABELS, type HarnessId } from '../manifest/schema.js';
import type { ProjectionAction, ProjectionWarning } from './types.js';
import type { InstalledPlugin, ProjectInstalledPlugin } from '../sources/installed.js';
import { emptyHooksConfig } from '../generate/hooks.js';
import type { ClaudeHooksConfig, HookMatcherGroup } from '../generate/hooks.js';
import { setActionContent } from './content-map.js';
import { commandDropReason } from './command-formats.js';
// Codex reads `.agents/skills/<name>` directly; Claude Code reads `.claude/skills`.
// Installed-plugin skills are symlinked there under their namespaced name
// (shared with the scanner + sweep).
import { AGENTS_SKILLS_DIR, CLAUDE_PLUGIN_ROOT_TOKEN } from '../scan/scanner.js';

/** Repo-relative Claude Code project slash-command dir (holds authored + wrapper commands). */
export const CLAUDE_COMMANDS_DIR = '.claude/commands';

/** Package types whose content projects to harnesses (skills/tasks/hooks live here). */
export const PROJECTABLE_PLUGIN_TYPES: ReadonlySet<string> = new Set(['plugin', 'skill-pack']);

/** Repo-relative Claude Code project skills dir (authored + namespaced installed symlinks). */
export const CLAUDE_SKILLS_DIR = '.claude/skills';

/**
 * Repo-relative OpenCode project command dir. OpenCode reads a FLAT directory of
 * `<name>.md` files and invokes each as `/<name>` — it has no command
 * namespacing, so installed-plugin wrappers land here hyphen-joined
 * (`<pkg>-<name>.md`, invoked `/<pkg>-<name>`), never in a per-plugin subdir.
 * Authored commands may legitimately coexist here, so this dir is NEVER given a
 * `*` gitignore; the engine writes a single self-listing `.gitignore` that names
 * only its own generated wrappers (see {@link OPENCODE_COMMANDS_GITIGNORE_TARGET}).
 *
 * @see https://opencode.ai/docs/commands/
 */
export const OPENCODE_COMMANDS_DIR = '.opencode/commands';

/** Repo-relative path of the engine-owned, self-listing OpenCode commands `.gitignore`. */
export const OPENCODE_COMMANDS_GITIGNORE_TARGET = `${OPENCODE_COMMANDS_DIR}/.gitignore`;

/**
 * The user-owned, machine-local Claude Code settings file the engine merges
 * installed-plugin hooks into. Never wholly generated: it may hold the user's
 * own local settings, so the merge touches only the managed hook entries.
 */
export const CLAUDE_SETTINGS_LOCAL_TARGET = '.claude/settings.local.json';

/**
 * The explicit ownership sentinel on every engine-managed hook matcher group in
 * `.claude/settings.local.json`: its value is the owning plugin's package name.
 * Ownership is never inferred from the command string (a plugin hook need not
 * reference its install path, and a user hook may legitimately mention
 * `.dork/plugins/`), so this key is the SOLE managed/user discriminator for the
 * settings merge, drift check, and uninstall sweep. Claude Code tolerates the
 * unknown key and the tagged hook still fires (validated against CLI 2.1.197).
 */
export const MANAGED_HOOK_SENTINEL_KEY = '_dorkosHarness';

/** An engine-managed hook matcher group: a plain group tagged with its owning plugin. */
export interface ManagedHookGroup extends HookMatcherGroup {
  /** The owning plugin's package name (the {@link MANAGED_HOOK_SENTINEL_KEY} value). */
  [MANAGED_HOOK_SENTINEL_KEY]: string;
}

/**
 * Stable sentinel embedded in every engine-generated command wrapper (and the
 * self-ignoring `.gitignore` beside them). The apply sweep uses it as the sole
 * ownership predicate: only a file under `.claude/commands/<pkg>/` that carries
 * this sentinel is ever pruned, so a hand-authored command is never deleted.
 */
export const GENERATED_COMMAND_MARKER = 'dorkos:generated-command';

/** Per-harness skill projection dir for installed plugins; absent harnesses cannot take skills. */
const INSTALLED_SKILL_TARGET_DIRS: Partial<Record<HarnessId, string>> = {
  'claude-code': CLAUDE_SKILLS_DIR,
  codex: AGENTS_SKILLS_DIR,
};

/**
 * Harnesses whose skill loader keys a skill by its `SKILL.md` frontmatter `name`
 * (verified: OpenCode `skill/index.ts` keys the map on `md.data.name`; Codex uses
 * the frontmatter name as identity), NOT by the directory name. The
 * `<pkg>__<name>` directory namespacing therefore does NOT protect these harnesses
 * from a same-frontmatter-name collision — the projector warns instead (see
 * {@link planSkillNameCollisions}). Claude Code is deliberately absent: it keys by
 * directory name, so the namespacing is sufficient there.
 */
export const FRONTMATTER_KEYED_HARNESSES: readonly HarnessId[] = ['codex', 'opencode'];

/** Manifest layers with no harness home — each dropped with the given reason. */
const NON_PORTABLE_LAYER_REASONS: Record<string, string> = {
  extensions: 'UI extensions run inside DorkOS, not in a harness',
  adapters: 'messaging adapters run inside DorkOS, not in a harness',
  'mcp-servers': 'MCP servers are configured per-harness, not projected as files',
  'lsp-servers': 'LSP servers are configured per-harness, not projected as files',
  agents: 'agent definitions are installed as workspaces, not harness assets',
};

/** The harness a plugin-level (harness-agnostic) drop is attributed to for display. */
const DROP_ATTRIBUTION: HarnessId = 'codex';

/**
 * The harness an unconditional `.agents/skills` link is attributed to.
 *
 * The link exists for the directory, not for one harness, but every
 * {@link ProjectionAction} must name one and `HarnessId` has no "DorkOS" member.
 * Codex is the honest answer available: `.agents/skills` is the directory it
 * reads, so the link genuinely serves Codex whenever Codex is enabled — and when
 * it is not, the reason on the action ({@link SCHEDULE_LINK_REASON} or
 * {@link CANONICAL_LINK_REASON}) says plainly why the link is there anyway.
 */
const SCHEDULE_LINK_ATTRIBUTION: HarnessId = 'codex';

/** The note carried on a scheduler-driven link, so the report never looks arbitrary. */
const SCHEDULE_LINK_REASON = `skill declares a schedule; linked into ${AGENTS_SKILLS_DIR} so the DorkOS scheduler can find it (the only project skills root it watches)`;

/**
 * The note carried on every other unconditional link — the reason a package's
 * skills land in `.agents/skills` even in a project that enables nothing which
 * reads it today.
 */
const CANONICAL_LINK_REASON = `linked into ${AGENTS_SKILLS_DIR}, the one skills directory Codex, OpenCode, Cursor, Gemini CLI and Copilot all read (vendor docs, 2026-09-07)`;

/** The marker comment inserted into a generated command wrapper. */
function generatedCommandMarkerLine(relDir: string): string {
  return `<!-- ${GENERATED_COMMAND_MARKER} from ${relDir} (regenerated by dorkos harness sync; do not edit) -->`;
}

/** The self-ignoring `.gitignore` written beside wrappers so they never commit. */
function generatedWrapperGitignore(relDir: string): string {
  return `# ${GENERATED_COMMAND_MARKER} from ${relDir} (regenerated by dorkos harness sync; do not edit)\n*\n`;
}

/**
 * Insert `markerLine` immediately after a file's closing frontmatter delimiter,
 * so the YAML frontmatter stays the first bytes of the file. Files without
 * frontmatter get the marker prepended (it becomes the first line).
 */
function insertAfterFrontmatter(content: string, markerLine: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === '---') {
        lines.splice(i + 1, 0, markerLine);
        return lines.join('\n');
      }
    }
  }
  return `${markerLine}\n${content}`;
}

/**
 * The absolute install dir as it should read INSIDE generated text.
 *
 * A plugin writes the token with forward slashes around it —
 * `${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs` — while `join()` spells the install root
 * with backslashes on Windows. Substituting one into the other produced half of
 * each: `C:\Users\me\.dork\plugins\flow/hooks/x.mjs`, inside a shell command
 * and inside a JSON string, where every backslash then has to survive JSON
 * escaping and whatever shell the harness hands the command to. Measured on a
 * real `windows-latest` runner (DOR-1855); nothing in this repo had ever
 * generated one of these paths on Windows before.
 *
 * Forward slashes are read the same way by node, PowerShell and bash, so the
 * whole path is spelled the one way that means the same thing everywhere.
 *
 * POSIX is deliberately untouched, and the platform is a PARAMETER rather than a
 * read of `process.platform` inside: a POSIX filename may legitimately contain a
 * backslash, and passing the platform in is what lets the Windows branch be
 * tested from a Mac.
 *
 * @param absInstallDir - the plugin's absolute install directory.
 * @param platform - the running platform, i.e. `process.platform`.
 * @returns the install dir as it should appear in generated text.
 */
export function pluginRootText(absInstallDir: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? absInstallDir.split('\\').join('/') : absInstallDir;
}

/** Build a command wrapper: rewrite the plugin-root token to absolute, mark it generated. */
function buildCommandWrapper(content: string, absInstallDir: string, relDir: string): string {
  const rewritten = content
    .split(CLAUDE_PLUGIN_ROOT_TOKEN)
    .join(pluginRootText(absInstallDir, process.platform));
  return insertAfterFrontmatter(rewritten, generatedCommandMarkerLine(relDir));
}

/** Split a markdown file into its leading YAML frontmatter lines and the body after it. */
function splitFrontmatter(content: string): { frontmatter: string[]; body: string } {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return { frontmatter: [], body: content };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      return { frontmatter: lines.slice(1, i), body: lines.slice(i + 1).join('\n') };
    }
  }
  return { frontmatter: [], body: content }; // unterminated frontmatter: treat the whole file as body
}

/** Read a single-line scalar frontmatter field (e.g. `description`) from split frontmatter lines. */
function frontmatterField(frontmatter: string[], field: string): string | undefined {
  const prefix = `${field}:`;
  for (const line of frontmatter) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return undefined;
}

/** The flat, hyphen-joined OpenCode wrapper filename for a plugin command (invoked `/<pkg>-<name>`). */
export function opencodeWrapperFilename(pkg: string, command: string): string {
  return `${pkg}-${command}.md`;
}

/**
 * Build an OpenCode command wrapper from a source Claude command: rewrite the
 * plugin-root token to absolute, REPLACE the frontmatter with only its
 * `description` (OpenCode documents `description`/`agent`/`model`/`subtask`/
 * `template` and its tolerance of unknown keys is undocumented, so Claude-only
 * keys like `allowed-tools`/`argument-hint`/`category` are stripped), and insert
 * the engine ownership marker after the reduced frontmatter.
 */
function buildOpencodeCommandWrapper(
  content: string,
  absInstallDir: string,
  relDir: string
): string {
  const rewritten = content
    .split(CLAUDE_PLUGIN_ROOT_TOKEN)
    .join(pluginRootText(absInstallDir, process.platform));
  const { frontmatter, body } = splitFrontmatter(rewritten);
  const description = frontmatterField(frontmatter, 'description');
  const marker = generatedCommandMarkerLine(relDir);
  const reducedFrontmatter =
    description !== undefined ? `---\ndescription: ${description}\n---\n` : '';
  return `${reducedFrontmatter}${marker}\n${body}`;
}

/**
 * The self-listing `.gitignore` body the engine writes at
 * `.opencode/commands/.gitignore`: the ownership marker (so the sweep recognizes
 * the file as engine-owned), then the exact generated wrapper filenames plus the
 * `.gitignore` itself. It NEVER uses a `*` wildcard — the flat dir may hold
 * authored commands, which must stay committable — so only the named engine files
 * are ignored.
 */
function generatedOpencodeGitignore(wrapperFilenames: readonly string[]): string {
  const header = `# ${GENERATED_COMMAND_MARKER} (regenerated by dorkos harness sync; do not edit)`;
  return [header, '.gitignore', ...wrapperFilenames].join('\n') + '\n';
}

/**
 * Rewrite every `${CLAUDE_PLUGIN_ROOT}` occurrence in an installed plugin's hook
 * commands to its absolute install dir, leaving the matcher-group shape otherwise
 * intact.
 *
 * For an INSTALLED plugin the install root is known at plan time, so its hooks
 * become portable — the generated Codex/Cursor/Copilot hook files then carry the
 * resolved absolute path and work in those harnesses (only authored hooks, whose
 * root is unknown, or other unresolved `${CLAUDE_*}` tokens still earn a warning).
 * Used both to fold plugin hooks into the generated hook files and as the first
 * half of {@link toManagedHooks}.
 *
 * @param hooks - the plugin's raw Claude-format hooks (may be undefined).
 * @param absInstallDir - the plugin's absolute install directory.
 * @returns the token-rewritten hooks, or `undefined` when the input was undefined.
 */
export function rewritePluginRootInHooks(
  hooks: ClaudeHooksConfig | undefined,
  absInstallDir: string
): ClaudeHooksConfig | undefined {
  if (!hooks) return undefined;
  const out = emptyHooksConfig();
  for (const [event, groups] of Object.entries(hooks)) {
    out[event] = groups.map((group) => ({
      ...group,
      hooks: group.hooks.map((h) => ({
        ...h,
        command: h.command
          .split(CLAUDE_PLUGIN_ROOT_TOKEN)
          .join(pluginRootText(absInstallDir, process.platform)),
      })),
    }));
  }
  return out;
}

/** One hook a package would install: when it fires, what narrows it, what it runs. */
export interface ProjectedHook {
  /** The Claude-format event that triggers it (`Stop`, `PreToolUse`, …). */
  event: string;
  /** What the event is narrowed to, when the matcher group declares one. */
  matcher?: string;
  /**
   * The command exactly as it would be written into a harness's hook config —
   * `${CLAUDE_PLUGIN_ROOT}` already resolved, so this is the text a shell would
   * actually execute.
   */
  command: string;
}

/** One installed package's hooks, reduced to what a person has to decide about. */
export interface ProjectedPluginHooks {
  /** The package that declared them. */
  packageName: string;
  /** Its hooks, in a stable order (see {@link projectedHooks}). */
  hooks: ProjectedHook[];
}

/** Order hooks by event, then matcher, then command — stable across file rewrites. */
function compareProjectedHooks(a: ProjectedHook, b: ProjectedHook): number {
  return (
    a.event.localeCompare(b.event) ||
    (a.matcher ?? '').localeCompare(b.matcher ?? '') ||
    a.command.localeCompare(b.command)
  );
}

/**
 * Enumerate the hooks each installed package would install into the project's
 * harnesses.
 *
 * This is the "what am I about to be asked to allow" question, answered without
 * building or applying a plan: a package's hooks reach BOTH
 * `.claude/settings.local.json` (the merge) and the generated Codex/Cursor/Copilot
 * hook files (folded into {@link buildPlan}'s merged hooks), so a caller deciding
 * whether to let a package's hooks project needs one list per package, not one per
 * target file.
 *
 * WHEN a command fires is part of it, never only the command text. `echo x` on
 * `Stop` runs once when a session ends; the same string on `PreToolUse` with
 * `matcher: "*"` runs before every tool call. A caller that compared commands
 * alone would let the second silently inherit consent given for the first, so the
 * event and matcher travel with the command.
 *
 * Only project-scoped, projectable-type packages are listed, matching what
 * {@link buildPlan} would actually project — a global install records no hooks at
 * all (see `sources/installed.ts`), and a non-portable package type never
 * contributes.
 *
 * The result is SORTED, so a package that only reorders its `hooks.json` produces
 * an identical list. A caller keying a stored decision off this therefore does not
 * re-ask over a cosmetic edit.
 *
 * Pure: no filesystem access. `repoRoot` is used only to resolve each package's
 * install dir into the commands' absolute paths.
 *
 * @param plugins - the scanned installed plugins.
 * @param repoRoot - absolute repo root, used to resolve `${CLAUDE_PLUGIN_ROOT}`.
 * @returns one entry per hook-declaring package (packages with no hooks are omitted).
 */
export function projectedHooks(
  plugins: readonly InstalledPlugin[],
  repoRoot: string
): ProjectedPluginHooks[] {
  const out: ProjectedPluginHooks[] = [];
  for (const plugin of plugins) {
    if (plugin.location.scope !== 'project' || !PROJECTABLE_PLUGIN_TYPES.has(plugin.type)) continue;
    const rewritten = rewritePluginRootInHooks(
      plugin.hooks,
      join(repoRoot, plugin.location.relDir)
    );
    if (!rewritten) continue;
    const hooks: ProjectedHook[] = [];
    for (const [event, groups] of Object.entries(rewritten)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          hooks.push({
            event,
            ...(group.matcher !== undefined ? { matcher: group.matcher } : {}),
            command: hook.command,
          });
        }
      }
    }
    if (hooks.length > 0) {
      out.push({ packageName: plugin.name, hooks: hooks.sort(compareProjectedHooks) });
    }
  }
  return out;
}

/**
 * Prepare one plugin's hooks for the settings merge: rewrite
 * `${CLAUDE_PLUGIN_ROOT}` to the absolute install dir in every command, and tag
 * every matcher group with the {@link MANAGED_HOOK_SENTINEL_KEY} ownership
 * sentinel (value: the plugin's package name) so the apply stage can identify
 * managed groups exactly, per plugin.
 */
function toManagedHooks(
  plugin: InstalledPlugin,
  absInstallDir: string
): ClaudeHooksConfig | undefined {
  const rewritten = rewritePluginRootInHooks(plugin.hooks, absInstallDir);
  if (!rewritten) return undefined;
  const out = emptyHooksConfig();
  for (const [event, groups] of Object.entries(rewritten)) {
    out[event] = groups.map((group): ManagedHookGroup => ({
      ...group,
      [MANAGED_HOOK_SENTINEL_KEY]: plugin.name,
    }));
  }
  return out;
}

/**
 * The `${CLAUDE_PLUGIN_ROOT}`-in-a-projected-skill warning, or `undefined` when
 * the skill is clean.
 *
 * The `source` is the skill's own directory — the same path the action beside
 * this warning carries. A warning is matched to the artifact it concerns by its
 * source, so a sourceless one matches nothing and is reported as a thing of its
 * own: measured, a project whose plugin skill mentions the token drew TWO rows
 * for one skill and counted it twice.
 */
function pluginRootSkillWarning(
  harness: HarnessId,
  namespaced: string,
  usesPluginRoot: boolean,
  source: string
): ProjectionWarning | undefined {
  if (!usesPluginRoot) return undefined;
  return {
    artifact: 'skill',
    harness,
    name: namespaced,
    source,
    reason: `skill SKILL.md references ${CLAUDE_PLUGIN_ROOT_TOKEN}, which only resolves in plugin context; the projected copy will not expand it`,
  };
}

/**
 * Project one installed plugin's skills to a single harness.
 *
 * claude-code and codex get namespaced `<pkg>__<name>` symlinks into their skill
 * dir. OpenCode, Cursor, Gemini CLI and Copilot all read `.agents/skills`
 * directly (vendor docs, 2026-09-07), so each takes the skill `native` — no
 * symlink of its own — and the reason NAMES the `.agents/skills` link it reads,
 * which {@link planCanonicalSkillLinks} plans whatever harnesses are enabled.
 *
 * That link used to be planned only by the codex target, so with codex disabled
 * OpenCode's `native` pointed at a directory nothing had linked into and the
 * skills reached nobody (SK-05, reproduced 2026-09-07 with
 * `harnesses: ['opencode']`), while Cursor, Gemini and Copilot were handed a
 * whole-plugin drop for a directory they read perfectly well.
 *
 * A skill whose `SKILL.md` still references `${CLAUDE_PLUGIN_ROOT}` projects but
 * earns a warning (the token will not resolve off disk).
 *
 * @param harness - the target harness.
 * @param plugin - the project-scoped installed plugin.
 * @returns the per-skill actions and any plugin-root warnings for them.
 */
export function planInstalledSkills(
  harness: HarnessId,
  plugin: ProjectInstalledPlugin
): { actions: ProjectionAction[]; warnings: ProjectionWarning[] } {
  const dir = INSTALLED_SKILL_TARGET_DIRS[harness];
  const actions: ProjectionAction[] = [];
  const warnings: ProjectionWarning[] = [];

  for (const skill of plugin.skills) {
    const namespaced = `${plugin.name}__${skill.name}`;
    const base = {
      artifact: 'skill',
      harness,
      provenance: 'installed',
      name: namespaced,
      source: skill.sourceDir,
    } as const;
    actions.push(
      dir
        ? { ...base, kind: 'symlink', target: `${dir}/${namespaced}` }
        : {
            ...base,
            kind: 'native',
            reason: `${HARNESS_LABELS[harness]} reads ${AGENTS_SKILLS_DIR} directly; this plugin's skills are linked at ${AGENTS_SKILLS_DIR}/${namespaced}`,
          }
    );
    const warning = pluginRootSkillWarning(
      harness,
      namespaced,
      skill.usesPluginRoot,
      skill.sourceDir
    );
    if (warning) warnings.push(warning);
  }

  return { actions, warnings };
}

/**
 * Link EVERY installed skill into `.agents/skills`, whatever harnesses the
 * project enables.
 *
 * `.agents/skills` is the one skills directory five of the six harnesses read —
 * Codex, OpenCode, Cursor, Gemini CLI and Copilot; only Claude Code does not —
 * AND the only project skills root the DorkOS scheduler watches (the other is
 * `<dorkHome>/skills`; `specs/universal-scheduled-tasks` §DD2). Never
 * `.claude/skills`. So the link is not a per-harness projection at all: it is the
 * one place a package's skills have to be for anything else to find them.
 *
 * It arrived scoped to schedules (DOR-1518): on the stock project — manifest
 * `harnesses` defaults to `['claude-code']` — a plugin's scheduled skills
 * projected only into a directory nothing watches, and the person was never
 * offered the schedule to approve. DOR-1847 widened it to every installed skill,
 * because the same hole swallowed an OpenCode- or Cursor-only project's ordinary
 * skills with no schedule involved: the codex target was the only thing that ever
 * planned this link, so with codex disabled nothing did.
 *
 * The action still says WHY it is there: {@link SCHEDULE_LINK_REASON} when the
 * skill declares a schedule (the sharper reason, and the one a person is asked
 * to approve against), {@link CANONICAL_LINK_REASON} otherwise.
 *
 * It runs ONCE per plan, not per harness, and stands down entirely when an
 * enabled harness already links installed skills into `.agents/skills` (Codex
 * does) — the per-harness pass then plans the identical target, and planning it
 * twice would make apply write it twice and the drift check compare it twice.
 * The dedup is derived from {@link INSTALLED_SKILL_TARGET_DIRS} rather than
 * hardcoding "codex", so it stays correct if another harness adopts the
 * directory.
 *
 * Only project-scoped plugins reach here; a globally installed plugin's skills
 * are still undiscoverable, because no projection stage targets
 * `<dorkHome>/skills` at all (see `sources/installed.ts`).
 *
 * One interaction worth knowing: `dorkos harness sync --harness <id> --fix`
 * narrows the plan by action `harness`, so a run narrowed to anything but
 * {@link SCHEDULE_LINK_ATTRIBUTION} filters these links out and does not write
 * them. That is the flag behaving as asked — it projects one harness's files —
 * and every default path (a bare sync, `--fix`, DorkOS's own install-triggered
 * projection) passes an unfiltered plan and is unaffected.
 *
 * @param input - the projectable project-scoped plugins and the enabled harnesses.
 * @returns the symlink actions and any plugin-root warnings for them (both empty
 *   when an enabled harness already covers the directory).
 */
export function planCanonicalSkillLinks(input: {
  plugins: readonly ProjectInstalledPlugin[];
  harnesses: readonly HarnessId[];
}): { actions: ProjectionAction[]; warnings: ProjectionWarning[] } {
  const alreadyLinked = input.harnesses.some(
    (harness) => INSTALLED_SKILL_TARGET_DIRS[harness] === AGENTS_SKILLS_DIR
  );
  if (alreadyLinked) return { actions: [], warnings: [] };

  const actions: ProjectionAction[] = [];
  const warnings: ProjectionWarning[] = [];
  for (const plugin of input.plugins) {
    for (const skill of plugin.skills) {
      const namespaced = `${plugin.name}__${skill.name}`;
      actions.push({
        kind: 'symlink',
        artifact: 'skill',
        harness: SCHEDULE_LINK_ATTRIBUTION,
        provenance: 'installed',
        name: namespaced,
        source: skill.sourceDir,
        target: `${AGENTS_SKILLS_DIR}/${namespaced}`,
        reason: skill.hasSchedule ? SCHEDULE_LINK_REASON : CANONICAL_LINK_REASON,
      });
      const warning = pluginRootSkillWarning(
        SCHEDULE_LINK_ATTRIBUTION,
        namespaced,
        skill.usesPluginRoot,
        skill.sourceDir
      );
      if (warning) warnings.push(warning);
    }
  }
  return { actions, warnings };
}

/**
 * Project one installed plugin's slash commands to a single harness.
 *
 * Claude Code gets a generated repo-local wrapper per command at
 * `.claude/commands/<pkg>/<name>.md` (namespaced subdir) plus a self-ignoring
 * `.gitignore` beside them. OpenCode gets a flat, hyphen-joined wrapper per
 * command at `.opencode/commands/<pkg>-<name>.md` (invoked `/<pkg>-<name>`, since
 * OpenCode has no command namespacing) with the frontmatter reduced to
 * `description`; its shared-dir `.gitignore` is emitted once by
 * {@link planOpencodeCommandsGitignore}, not per plugin. Both rewrite every
 * `${CLAUDE_PLUGIN_ROOT}` to the absolute install dir and mark each wrapper
 * engine-generated. Nothing projects into the other harnesses' command
 * directories yet, so a plugin that ships commands drops for them — with a
 * reason naming that harness's own documented format, or its genuine absence in
 * Codex's case (see `plan/command-formats.ts`).
 *
 * @param harness - the target harness.
 * @param plugin - the project-scoped installed plugin.
 * @param repoRoot - absolute repo root, used to build absolute install paths.
 */
export function planInstalledCommands(
  harness: HarnessId,
  plugin: ProjectInstalledPlugin,
  repoRoot: string
): ProjectionAction[] {
  if (plugin.commands.length === 0) return [];
  const { relDir } = plugin.location;

  if (harness === 'claude-code') return planClaudeInstalledCommands(plugin, relDir, repoRoot);
  if (harness === 'opencode') return planOpencodeInstalledCommands(plugin, relDir, repoRoot);

  return [
    {
      kind: 'drop',
      artifact: 'command',
      harness,
      provenance: 'installed',
      name: `${plugin.name}:commands`,
      reason: commandDropReason(harness),
    },
  ];
}

/** Claude Code wrappers under `.claude/commands/<pkg>/` plus their self-ignoring `.gitignore`. */
function planClaudeInstalledCommands(
  plugin: InstalledPlugin,
  relDir: string,
  repoRoot: string
): ProjectionAction[] {
  const absInstallDir = join(repoRoot, relDir);
  const pkgDir = `${CLAUDE_COMMANDS_DIR}/${plugin.name}`;
  const actions: ProjectionAction[] = [];
  for (const cmd of plugin.commands) {
    const action: ProjectionAction = {
      kind: 'generate',
      artifact: 'command',
      harness: 'claude-code',
      provenance: 'installed',
      name: `${plugin.name}:${cmd.name}`,
      source: cmd.sourcePath,
      target: `${pkgDir}/${cmd.name}.md`,
    };
    setActionContent(action, buildCommandWrapper(cmd.content, absInstallDir, relDir));
    actions.push(action);
  }
  // A self-ignoring `.gitignore` inside the wrapper dir keeps the machine-local
  // wrappers out of git without touching sibling authored command namespaces
  // (a static `.claude/commands/*/` ignore would swallow authored `<ns>/` dirs).
  const gitignore: ProjectionAction = {
    kind: 'generate',
    artifact: 'command',
    harness: 'claude-code',
    provenance: 'installed',
    name: `${plugin.name}:.gitignore`,
    target: `${pkgDir}/.gitignore`,
  };
  setActionContent(gitignore, generatedWrapperGitignore(relDir));
  actions.push(gitignore);
  return actions;
}

/**
 * OpenCode wrappers under the flat `.opencode/commands/` dir. No per-plugin
 * `.gitignore` — the shared dir gets one aggregated `.gitignore` from
 * {@link planOpencodeCommandsGitignore}, so authored commands there stay
 * committable.
 */
function planOpencodeInstalledCommands(
  plugin: InstalledPlugin,
  relDir: string,
  repoRoot: string
): ProjectionAction[] {
  const absInstallDir = join(repoRoot, relDir);
  const actions: ProjectionAction[] = [];
  for (const cmd of plugin.commands) {
    const action: ProjectionAction = {
      kind: 'generate',
      artifact: 'command',
      harness: 'opencode',
      provenance: 'installed',
      name: `${plugin.name}:${cmd.name}`,
      source: cmd.sourcePath,
      target: `${OPENCODE_COMMANDS_DIR}/${opencodeWrapperFilename(plugin.name, cmd.name)}`,
    };
    setActionContent(action, buildOpencodeCommandWrapper(cmd.content, absInstallDir, relDir));
    actions.push(action);
  }
  return actions;
}

/**
 * Build the single OpenCode-commands `.gitignore` generate action, aggregating
 * the wrapper filenames of every projectable plugin (the flat `.opencode/commands`
 * dir is shared, so one `.gitignore` names every engine wrapper explicitly and
 * ignores itself, never using a `*` that would swallow authored commands).
 *
 * @param plugins - the project-scoped installed plugins to aggregate.
 * @returns the `.gitignore` generate action, or `undefined` when no plugin ships a command.
 */
export function planOpencodeCommandsGitignore(
  plugins: readonly ProjectInstalledPlugin[]
): ProjectionAction | undefined {
  const filenames: string[] = [];
  for (const plugin of plugins) {
    for (const cmd of plugin.commands) {
      filenames.push(opencodeWrapperFilename(plugin.name, cmd.name));
    }
  }
  if (filenames.length === 0) return undefined;
  filenames.sort();

  const action: ProjectionAction = {
    kind: 'generate',
    artifact: 'command',
    harness: 'opencode',
    provenance: 'installed',
    name: 'opencode-commands:.gitignore',
    target: OPENCODE_COMMANDS_GITIGNORE_TARGET,
  };
  setActionContent(action, generatedOpencodeGitignore(filenames));
  return action;
}

/**
 * Build the single claude-code merge action that folds every projectable
 * plugin's hooks into `.claude/settings.local.json`: each `${CLAUDE_PLUGIN_ROOT}`
 * is rewritten to that plugin's absolute install dir, and each matcher group is
 * tagged with the {@link MANAGED_HOOK_SENTINEL_KEY} ownership sentinel. The
 * attached content is the managed {@link ClaudeHooksConfig}; the apply stage
 * merges it into the user-owned file, touching only the sentinel-tagged entries.
 *
 * @param plugins - the project-scoped installed plugins to fold in.
 * @param repoRoot - absolute repo root, used to build absolute install paths.
 * @returns the merge action, or `undefined` when no plugin contributes a hook.
 */
export function planInstalledPluginHooks(
  plugins: readonly ProjectInstalledPlugin[],
  repoRoot: string
): ProjectionAction | undefined {
  const merged = mergeHookConfigs(
    plugins.map((p) => toManagedHooks(p, join(repoRoot, p.location.relDir)))
  );
  if (Object.keys(merged).length === 0) return undefined;

  const action: ProjectionAction = {
    kind: 'merge',
    artifact: 'hook',
    harness: 'claude-code',
    provenance: 'installed',
    name: 'plugin-hooks',
    target: CLAUDE_SETTINGS_LOCAL_TARGET,
  };
  setActionContent(action, JSON.stringify(merged));
  return action;
}

/** Drop a project plugin's non-portable layers, one drop per layer (with reasons). */
export function dropNonPortableLayers(plugin: InstalledPlugin): ProjectionAction[] {
  return plugin.layers
    .filter((layer) => layer in NON_PORTABLE_LAYER_REASONS)
    .map((layer) => ({
      kind: 'drop' as const,
      artifact: 'plugin' as const,
      harness: DROP_ATTRIBUTION,
      // Not about Codex: a non-portable layer has no home in ANY harness.
      harnessAgnostic: true,
      provenance: 'installed' as const,
      name: `${plugin.name}:${layer}`,
      reason: `plugin layer "${layer}" is not a portable harness asset — ${NON_PORTABLE_LAYER_REASONS[layer]}`,
    }));
}

/** Drop a whole plugin (one action) with the given reason — for global or unsupported-type plugins. */
export function dropWholePlugin(plugin: InstalledPlugin, reason: string): ProjectionAction {
  return {
    kind: 'drop',
    artifact: 'plugin',
    harness: DROP_ATTRIBUTION,
    // Not about Codex: a package this shape is not portable to any harness.
    harnessAgnostic: true,
    provenance: 'installed',
    name: plugin.name,
    reason,
  };
}

/**
 * Merge several Claude-format hooks configs into one, concatenating the matcher
 * groups for each event. Used to fold installed-plugin hooks into the authored
 * hooks before generating the single Codex hooks file, and to merge several
 * plugins' hooks for the settings.local.json merge. Order is preserved.
 *
 * @param configs - hooks configs to merge (undefined entries are ignored).
 * @returns the merged hooks config (empty when no input has hooks).
 */
export function mergeHookConfigs(
  configs: ReadonlyArray<ClaudeHooksConfig | undefined>
): ClaudeHooksConfig {
  const merged = emptyHooksConfig();
  for (const config of configs) {
    if (!config) continue;
    for (const [event, groups] of Object.entries(config)) {
      if (!Array.isArray(groups)) continue; // defense-in-depth: never spread a non-array value
      merged[event] = [...(merged[event] ?? []), ...groups];
    }
  }
  return merged;
}

/** One installed skill by its effective (frontmatter) identity, plus its namespaced projection name. */
interface EffectiveInstalledSkill {
  /** The effective identity in a frontmatter-keyed harness: `SKILL.md` `name` (falling back to the dir name). */
  effectiveName: string;
  /** The `<pkg>__<name>` namespaced projection name, used to name the warning. */
  namespaced: string;
}

/** Enumerate every installed skill by its effective (frontmatter) identity. */
function effectiveInstalledSkills(plugins: readonly InstalledPlugin[]): EffectiveInstalledSkill[] {
  const out: EffectiveInstalledSkill[] = [];
  for (const plugin of plugins) {
    for (const skill of plugin.skills) {
      out.push({
        effectiveName: skill.frontmatterName ?? skill.name,
        namespaced: `${plugin.name}__${skill.name}`,
      });
    }
  }
  return out;
}

/**
 * Warn when an installed plugin skill's effective `SKILL.md` frontmatter `name`
 * collides with an authored skill's name or another installed plugin skill's
 * frontmatter name.
 *
 * Claude Code keys a skill by its DIRECTORY name, so the `<pkg>__<name>`
 * projection namespacing already prevents an installed skill from shadowing an
 * authored one there. OpenCode and Codex, however, key a skill by its FRONTMATTER
 * `name` ({@link FRONTMATTER_KEYED_HARNESSES}), which the namespacing does NOT
 * change — so two skills sharing a frontmatter name collide in those harnesses.
 * One warning is emitted per colliding installed skill per enabled
 * frontmatter-keyed harness; no warning fires when no such harness is enabled.
 *
 * @param input - the authored skill names, the projectable installed plugins, and
 *   the enabled harness set.
 * @returns the collision warnings (empty when there is no collision or no
 *   frontmatter-keyed harness is enabled).
 */
export function planSkillNameCollisions(input: {
  authoredSkillNames: readonly string[];
  plugins: readonly InstalledPlugin[];
  harnesses: readonly HarnessId[];
}): ProjectionWarning[] {
  const affectedHarnesses = input.harnesses.filter((h) => FRONTMATTER_KEYED_HARNESSES.includes(h));
  if (affectedHarnesses.length === 0) return [];

  const authored = new Set(input.authoredSkillNames);
  const installed = effectiveInstalledSkills(input.plugins);
  const countByName = new Map<string, number>();
  for (const name of authored) countByName.set(name, (countByName.get(name) ?? 0) + 1);
  for (const skill of installed) {
    countByName.set(skill.effectiveName, (countByName.get(skill.effectiveName) ?? 0) + 1);
  }

  const warnings: ProjectionWarning[] = [];
  for (const skill of installed) {
    if ((countByName.get(skill.effectiveName) ?? 0) < 2) continue; // unique — no collision

    const others: string[] = [];
    if (authored.has(skill.effectiveName)) others.push(`authored skill "${skill.effectiveName}"`);
    for (const other of installed) {
      if (other.namespaced !== skill.namespaced && other.effectiveName === skill.effectiveName) {
        others.push(`installed skill "${other.namespaced}"`);
      }
    }

    for (const harness of affectedHarnesses) {
      warnings.push({
        artifact: 'skill',
        harness,
        name: skill.namespaced,
        reason: `skill frontmatter name "${skill.effectiveName}" collides with ${others.join(
          ', '
        )}; ${harness} keys skills by SKILL.md frontmatter name, so the "<pkg>__<name>" directory namespacing does not prevent this collision`,
      });
    }
  }
  return warnings;
}

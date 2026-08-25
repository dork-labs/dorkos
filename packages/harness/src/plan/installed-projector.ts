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
 *   OpenCode reads `.agents/skills` directly, so it takes the same skills
 *   `native` (via the Codex namespaced symlink) rather than a symlink of its own.
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
 *
 * One projection is NOT for a harness at all. A plugin skill that carries a
 * `schedule:` block is a scheduled task, and the DorkOS scheduler watches exactly
 * one project skills root — `.agents/skills` — so such a skill is linked there
 * whatever harnesses the project enables (see
 * {@link planScheduledSkillLinks}). Without it, the stock project (harnesses
 * `['claude-code']`) projected the flow plugin's scheduled skills only into
 * `.claude/skills`, which nothing watches, and their schedules were never offered
 * for approval (DOR-1518).
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
import type { HarnessId } from '../manifest/schema.js';
import type { ProjectionAction, ProjectionWarning } from './types.js';
import type { InstalledPlugin } from '../sources/installed.js';
import type { ClaudeHooksConfig, HookMatcherGroup } from '../generate/hooks.js';
import { setActionContent } from './content-map.js';
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
 * The harness a scheduler-driven `.agents/skills` link is attributed to.
 *
 * The link exists for the DorkOS scheduler, not for a harness, but every
 * {@link ProjectionAction} must name one and `HarnessId` has no "DorkOS" member.
 * Codex is the honest answer available: `.agents/skills` is the directory it
 * reads, so the link genuinely serves Codex too whenever Codex is enabled — and
 * when it is not, {@link SCHEDULE_LINK_REASON} on the action says plainly why the
 * link is there anyway.
 */
const SCHEDULE_LINK_ATTRIBUTION: HarnessId = 'codex';

/** The note carried on a scheduler-driven link, so the report never looks arbitrary. */
const SCHEDULE_LINK_REASON = `skill declares a schedule; linked into ${AGENTS_SKILLS_DIR} so the DorkOS scheduler can find it (the only project skills root it watches)`;

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

/** Build a command wrapper: rewrite the plugin-root token to absolute, mark it generated. */
function buildCommandWrapper(content: string, absInstallDir: string, relDir: string): string {
  const rewritten = content.split(CLAUDE_PLUGIN_ROOT_TOKEN).join(absInstallDir);
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
  const rewritten = content.split(CLAUDE_PLUGIN_ROOT_TOKEN).join(absInstallDir);
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
  const out: ClaudeHooksConfig = {};
  for (const [event, groups] of Object.entries(hooks)) {
    out[event] = groups.map((group) => ({
      ...group,
      hooks: group.hooks.map((h) => ({
        ...h,
        command: h.command.split(CLAUDE_PLUGIN_ROOT_TOKEN).join(absInstallDir),
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
    if (plugin.scope !== 'project' || !PROJECTABLE_PLUGIN_TYPES.has(plugin.type)) continue;
    if (!plugin.relDir) continue;
    const rewritten = rewritePluginRootInHooks(plugin.hooks, join(repoRoot, plugin.relDir));
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
  const out: ClaudeHooksConfig = {};
  for (const [event, groups] of Object.entries(rewritten)) {
    out[event] = groups.map(
      (group): ManagedHookGroup => ({
        ...group,
        [MANAGED_HOOK_SENTINEL_KEY]: plugin.name,
      })
    );
  }
  return out;
}

/** The `${CLAUDE_PLUGIN_ROOT}`-in-a-projected-skill warning, or `undefined` when the skill is clean. */
function pluginRootSkillWarning(
  harness: HarnessId,
  namespaced: string,
  usesPluginRoot: boolean
): ProjectionWarning | undefined {
  if (!usesPluginRoot) return undefined;
  return {
    artifact: 'skill',
    harness,
    name: namespaced,
    reason: `skill SKILL.md references ${CLAUDE_PLUGIN_ROOT_TOKEN}, which only resolves in plugin context; the projected copy will not expand it`,
  };
}

/**
 * Project one installed plugin's skills to a single harness.
 *
 * claude-code and codex get namespaced `<pkg>__<name>` symlinks into their skill
 * dir. OpenCode reads `.agents/skills` (and `.claude/skills`) directly, so it
 * takes each skill `native` — no symlink of its own — relying on the Codex/Claude
 * Code namespaced symlink already on disk. A skill whose `SKILL.md` still
 * references `${CLAUDE_PLUGIN_ROOT}` projects but earns a warning (the token will
 * not resolve off disk). Harnesses with no skill home drop the whole plugin.
 */
export function planInstalledSkills(
  harness: HarnessId,
  plugin: InstalledPlugin
): { actions: ProjectionAction[]; warnings: ProjectionWarning[] } {
  const dir = INSTALLED_SKILL_TARGET_DIRS[harness];
  if (dir) {
    const actions: ProjectionAction[] = [];
    const warnings: ProjectionWarning[] = [];
    for (const skill of plugin.skills) {
      const namespaced = `${plugin.name}__${skill.name}`;
      actions.push({
        kind: 'symlink',
        artifact: 'skill',
        harness,
        provenance: 'installed',
        name: namespaced,
        source: skill.sourceDir,
        target: `${dir}/${namespaced}`,
      });
      const warning = pluginRootSkillWarning(harness, namespaced, skill.usesPluginRoot);
      if (warning) warnings.push(warning);
    }
    return { actions, warnings };
  }

  if (harness === 'opencode') {
    const actions: ProjectionAction[] = [];
    const warnings: ProjectionWarning[] = [];
    for (const skill of plugin.skills) {
      const namespaced = `${plugin.name}__${skill.name}`;
      actions.push({
        kind: 'native',
        artifact: 'skill',
        harness,
        provenance: 'installed',
        name: namespaced,
        source: skill.sourceDir,
        reason: `OpenCode reads ${AGENTS_SKILLS_DIR} directly (via the Codex namespaced symlink)`,
      });
      const warning = pluginRootSkillWarning(harness, namespaced, skill.usesPluginRoot);
      if (warning) warnings.push(warning);
    }
    return { actions, warnings };
  }

  return {
    actions: [
      {
        kind: 'drop',
        artifact: 'plugin',
        harness,
        provenance: 'installed',
        name: plugin.name,
        reason: `installed-plugin skills are not auto-projected to ${harness} in v1; see DOR-143`,
      },
    ],
    warnings: [],
  };
}

/**
 * Link every schedule-bearing installed skill into `.agents/skills`, whatever
 * harnesses the project enables.
 *
 * A skill's `schedule:` block makes it a scheduled task, and the DorkOS
 * scheduler watches exactly two roots: `<dorkHome>/skills` and
 * `<project>/.agents/skills` (`specs/universal-scheduled-tasks` §DD2). Never
 * `.claude/skills`. So on the stock project — manifest `harnesses` defaults to
 * `['claude-code']` — a plugin's scheduled skills projected only into a directory
 * nothing watches, and the person was never offered the schedule to approve
 * (DOR-1518). This rule is the fix: the schedule, not the harness list, decides
 * that the link exists.
 *
 * It runs ONCE per plan, not per harness, and stands down entirely when an
 * enabled harness already links installed skills into `.agents/skills` (Codex
 * does) — the per-harness pass then plans the identical target, and planning it
 * twice would make apply write it twice and the drift check compare it twice.
 * The dedup is derived from {@link INSTALLED_SKILL_TARGET_DIRS} rather than
 * hardcoding "codex", so it stays correct if another harness adopts the
 * directory.
 *
 * Only project-scoped plugins reach here; a globally installed plugin's
 * scheduled skill is still undiscoverable, because no projection stage targets
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
 * @returns the scheduler-driven symlink actions and any plugin-root warnings for
 *   them (both empty when an enabled harness already covers the directory).
 */
export function planScheduledSkillLinks(input: {
  plugins: readonly InstalledPlugin[];
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
      if (!skill.hasSchedule) continue;
      const namespaced = `${plugin.name}__${skill.name}`;
      actions.push({
        kind: 'symlink',
        artifact: 'skill',
        harness: SCHEDULE_LINK_ATTRIBUTION,
        provenance: 'installed',
        name: namespaced,
        source: skill.sourceDir,
        target: `${AGENTS_SKILLS_DIR}/${namespaced}`,
        reason: SCHEDULE_LINK_REASON,
      });
      const warning = pluginRootSkillWarning(
        SCHEDULE_LINK_ATTRIBUTION,
        namespaced,
        skill.usesPluginRoot
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
 * engine-generated. Other harnesses have no repo-local slash-command format, so a
 * plugin that ships commands drops with a reason.
 *
 * @param harness - the target harness.
 * @param plugin - the project-scoped installed plugin.
 * @param repoRoot - absolute repo root, used to build absolute install paths.
 */
export function planInstalledCommands(
  harness: HarnessId,
  plugin: InstalledPlugin,
  repoRoot: string
): ProjectionAction[] {
  if (plugin.commands.length === 0) return [];
  if (!plugin.relDir) return [];

  if (harness === 'claude-code')
    return planClaudeInstalledCommands(plugin, plugin.relDir, repoRoot);
  if (harness === 'opencode') return planOpencodeInstalledCommands(plugin, plugin.relDir, repoRoot);

  return [
    {
      kind: 'drop',
      artifact: 'command',
      harness,
      provenance: 'installed',
      name: `${plugin.name}:commands`,
      reason: `installed-plugin slash commands need a repo-local command format; ${harness} has none`,
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
  plugins: InstalledPlugin[]
): ProjectionAction | undefined {
  const filenames: string[] = [];
  for (const plugin of plugins) {
    if (!plugin.relDir) continue;
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
  plugins: InstalledPlugin[],
  repoRoot: string
): ProjectionAction | undefined {
  const merged = mergeHookConfigs(
    plugins.map((p) => (p.relDir ? toManagedHooks(p, join(repoRoot, p.relDir)) : undefined))
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
  const merged: ClaudeHooksConfig = {};
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

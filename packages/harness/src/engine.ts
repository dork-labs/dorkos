/**
 * Engine entry — convenience loaders that wire disk state into the projector.
 *
 * These read the canonical inputs (`.agents/harness.manifest.json`,
 * `.claude/settings.json`, `AGENTS.md`, `.claude/commands`, `.claude/skills`)
 * and hand them to {@link buildPlan}. Three of them exist to answer one
 * question the planner must not guess at: whether the file a projection would
 * call `native` is really there.
 * They are the thin glue a CLI or server calls; the pure planning logic lives in
 * `plan/projector.ts` and stays filesystem-free.
 *
 * @module engine
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseHarnessManifest, type HarnessId, type HarnessManifest } from './manifest/schema.js';
import { buildPlan } from './plan/projector.js';
import { CLAUDE_COMMANDS_DIR, CLAUDE_SKILLS_DIR } from './plan/installed-projector.js';
import type { ClaudeOnlySkillLocation, ProjectionPlan } from './plan/types.js';
import type { ClaudeHooksConfig } from './generate/hooks.js';
import { scanInstalledPlugins } from './sources/installed.js';
import { inventorySourceTree } from './inventory/index.js';
import { detectHarnessFootprints } from './scaffold/manifest.js';

/**
 * Read and validate `.agents/harness.manifest.json` for a repository.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns the validated harness manifest.
 */
export function loadManifest(repoRoot: string): HarnessManifest {
  const raw: unknown = JSON.parse(
    readFileSync(join(repoRoot, '.agents', 'harness.manifest.json'), 'utf8')
  );
  return parseHarnessManifest(raw);
}

/**
 * Read the `.hooks` object from `.claude/settings.json`, if present.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns the Claude hooks config, or `undefined` when settings/hooks are absent.
 */
export function loadClaudeHooks(repoRoot: string): ClaudeHooksConfig | undefined {
  const settingsPath = join(repoRoot, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return undefined;
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    hooks?: ClaudeHooksConfig;
  };
  return settings.hooks;
}

/**
 * Whether a canonical `AGENTS.md` exists at the repository root.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns `true` when `AGENTS.md` is present.
 */
export function agentsMdExists(repoRoot: string): boolean {
  return existsSync(join(repoRoot, 'AGENTS.md'));
}

/**
 * Whether `.claude/commands` holds at least one slash command.
 *
 * Claude Code reads `.claude/commands/**\/*.md`, namespaced by subdirectory, so
 * the walk is recursive and stops at the first `.md` it finds. This is what
 * decides whether the plan may call Claude Code's commands `native`: an absent
 * or command-less directory is nothing to read, and the engine asserted that
 * `native` unconditionally until 2026-09-07.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns `true` when at least one `.md` lives anywhere under `.claude/commands`.
 */
export function claudeCommandsExist(repoRoot: string): boolean {
  const walk = (dir: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) return true;
      // Directories only — never follow a symlink out of the tree while
      // answering a question about this repository's own commands.
      if (entry.isDirectory() && walk(join(dir, entry.name))) return true;
    }
    return false;
  };
  return walk(join(repoRoot, CLAUDE_COMMANDS_DIR));
}

/**
 * Resolve every `manifest.claudeOnlySkills` entry's declared `path` against disk.
 *
 * A skill on that list is kept out of the canonical `.agents/skills` layer on
 * purpose, so the scanner never sees it and the manifest entry is the only
 * evidence it exists. The entry says where: its `path`, or — for an entry
 * written before `path` was required — the conventional
 * `.claude/skills/<name>`. Reading the entry's own claim rather than assuming
 * the convention is what stops the projector reporting a real skill at
 * `docs/skills/oddball` as a stale entry (DOR-1847 review).
 *
 * A **symlink** is reported as such whatever it points at: `claudeOnlySkills` is
 * for skills kept as real directories where Claude Code reads, and a link there
 * is either the engine's own projection of a canonical skill or a skill that
 * lives somewhere else. Both make the entry wrong, and the projector says so.
 *
 * The lookup is the filesystem's, so its case behaviour is the filesystem's: an
 * entry whose case does not match its directory resolves on macOS and does not
 * on Linux. Match the case.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param manifest - the validated manifest whose `claudeOnlySkills` to resolve.
 * @returns one {@link ClaudeOnlySkillLocation} per entry, keyed by entry name.
 */
export function scanClaudeOnlySkills(
  repoRoot: string,
  manifest: HarnessManifest
): Map<string, ClaudeOnlySkillLocation> {
  const resolved = new Map<string, ClaudeOnlySkillLocation>();
  for (const entry of manifest.claudeOnlySkills) {
    const defaultPath = `${CLAUDE_SKILLS_DIR}/${entry.name}`;
    const path = entry.path.trim() === '' ? defaultPath : entry.path;
    const abs = join(repoRoot, path);

    let kind: ClaudeOnlySkillLocation['kind'] = 'missing';
    const stats = lstatSync(abs, { throwIfNoEntry: false });
    if (stats?.isSymbolicLink()) kind = 'symlink';
    else if (stats?.isDirectory() && existsSync(join(abs, 'SKILL.md'))) kind = 'directory';

    resolved.set(entry.name, { path, kind, atProjectionTarget: path === defaultPath });
  }
  return resolved;
}

/**
 * Load every canonical input and build the projection plan for a repository.
 *
 * Project-scoped marketplace-installed plugins (`<repoRoot>/.dork/plugins`) are
 * always scanned and included — they are repo-relative and need no dork home, so
 * an offline `dorkos harness sync` still projects a repo's own installs. When
 * `opts.dorkHome` is also provided, global-scope installs (`${dorkHome}/plugins`)
 * are scanned too.
 *
 * The source-tree inventory is read here too, so the tree is walked once and
 * `buildPlan` is handed everything it needs rather than scanning again: it is
 * what makes the plan report the kinds the engine does not project (subagents,
 * rules, MCP servers, `settings.local.json` and skill-frontmatter hooks) instead
 * of being silent about them.
 *
 * `opts.allowPluginHooks` gates which installed packages may contribute hooks —
 * shell commands the harnesses run on the person's behalf. Omitted, every
 * package's hooks project, which is what a person running `dorkos harness sync`
 * asks for; DorkOS's own install-triggered projection passes a gate instead
 * (`services/harness/hook-approval.ts`, DOR-522).
 *
 * `opts.dorkosHarness` is the harness DorkOS's own default runtime reads. It
 * changes nothing a sync WRITES — it only adds a `dorkos-runtime` entry to
 * `plan.notEnabled` when the manifest does not enable it, so a report can say so
 * (DOR-1901). It is injected because this engine reads no config.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param opts - optional resolved dork home, enabling global-scope projection,
 *   an optional per-package gate on hook contribution, and the harness DorkOS's
 *   own runtime reads.
 * @returns the full projection plan (actions + honest drop list).
 */
export function project(
  repoRoot: string,
  opts?: {
    dorkHome?: string;
    allowPluginHooks?: (packageName: string) => boolean;
    dorkosHarness?: HarnessId;
  }
): ProjectionPlan {
  const installedPlugins = scanInstalledPlugins({
    dorkHome: opts?.dorkHome,
    projectRoot: repoRoot,
  });
  const manifest = loadManifest(repoRoot);
  return buildPlan({
    repoRoot,
    manifest,
    inventory: inventorySourceTree(repoRoot),
    claudeHooks: loadClaudeHooks(repoRoot),
    agentsMdExists: agentsMdExists(repoRoot),
    claudeCommandsExist: claudeCommandsExist(repoRoot),
    claudeOnlySkills: scanClaudeOnlySkills(repoRoot, manifest),
    installedPlugins,
    // Detection is not a one-shot scaffold question any more. Every plan asks
    // the repo which harnesses it can see, so one added after the manifest was
    // written is reported instead of silently never projected to (TR-11).
    detectedHarnesses: detectHarnessFootprints(repoRoot),
    ...(opts?.allowPluginHooks ? { allowPluginHooks: opts.allowPluginHooks } : {}),
    ...(opts?.dorkosHarness ? { dorkosHarness: opts.dorkosHarness } : {}),
  });
}

/**
 * What in a worktree's committed repo settings differs from the default branch
 * (DOR-3298), and the default branch's own MCP servers.
 *
 * - **`hooks`**: the parts of `<cwd>/.claude/settings.json` that run code or
 *   widen what runs (`pickPowerSettings`: the code-running keys and
 *   `permissions.allow`, `additionalDirectories` and `defaultMode`), the
 *   `hooks` and `mcpServers` frontmatter of `.claude/agents/**` and
 *   `.claude/skills/*\/SKILL.md`, every file under `<cwd>/.claude/hooks/`, the
 *   file each hook symlink points at, and every file inside the repo a hook,
 *   status line or helper command names (the agent-home pin's own
 *   `namedTargets`). A script is compared byte for byte, as a git blob id;
 *   settings and frontmatter as parsed JSON.
 * - **`mcpJson`**: every `.mcp.json` from the turn's folder up to the repo top,
 *   compared as parsed JSON.
 *
 * Unchanged means equal to one of the baseline's trusted commits
 * (`repo-baseline.ts`). A file the worktree does not have is never a change:
 * removing a hook only runs less. A file DorkOS can't read is a change no
 * person can approve. A symlink target outside the repo has nothing to compare
 * against, so it is always a change, approved by its content.
 *
 * Each change carries a content digest (what a person approves, the same in
 * every worktree), the file names (for the card and the Activity line), and a
 * diff against the default branch (for the card).
 *
 * @module services/runtimes/claude-code/repo-settings/repo-config-parts
 */
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { canonicalJson, collectCommands } from '../folder-settings/folder-config-pin.js';
import {
  agentFileHooks,
  namedTargets,
  pickAgentFileFields,
} from '../folder-settings/folder-config-scripts.js';
import { baselineTrees, type BaselineFile, type RepoBaseline } from './repo-baseline.js';
import { gitBlobId } from './repo-git.js';
import {
  isWithin,
  readScript,
  readSettingsFile,
  repoRelative,
  sha256,
  walkScripts,
} from './repo-files.js';
import { pickPowerSettings } from './repo-local-settings.js';
import { fileDiff } from './text-diff.js';

/** One kind of repo setting that differs from the default branch. */
export interface RepoDrift {
  /** The content digest a person approves. */
  digest: string;
  /** The changed files, repo-relative, in order. */
  files: string[];
  /** The diff against the default branch, for the card. */
  detail: string;
  /** False when a file can't be read: never approved, never asked about. */
  approvable: boolean;
}

/** What a worktree's committed repo settings hold. */
export interface RepoReading {
  /** Hook settings or scripts that differ, or `null`. */
  hooks:
    | (RepoDrift & {
        /** The settings or frontmatter that pick MCP servers changed too. */
        mcpKeysChanged: boolean;
        /** `permissions.allow` rules the default branch does not have. */
        addedAllows: string[];
      })
    | null;
  /** `.mcp.json` files that differ, or `null`. */
  mcpJson: RepoDrift | null;
  /** The servers the default branch's `.mcp.json` files declare, minus any its settings disable. */
  baselineServers: Record<string, unknown>;
}

/** The settings keys that pick which `.mcp.json` servers start. */
const MCP_KEYS = ['enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers'];

/** Nothing differs. */
const CLEAN: RepoReading = { hooks: null, mcpJson: null, baselineServers: {} };

/** A path by its real path, or resolved when it is not there. */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** A repo-relative path under `prefix` (`''` at the repo top). */
function under(prefix: string, rel: string): string {
  return prefix ? `${prefix}/${rel}` : rel;
}

/** A path as the card names it: repo-relative inside the repo, absolute outside it. */
function displayPath(root: string, abs: string): string {
  return isWithin(root, abs) ? repoRelative(root, abs) : abs;
}

/** A blob's text parsed and canonical, or its text's hash when it does not parse. */
function canonicalText(text: string): string {
  try {
    return canonicalJson(JSON.parse(text) as unknown);
  } catch {
    return canonicalJson({ malformed: sha256(text) });
  }
}

/** The file a symlink finally points at, or `undefined` when `abs` is not a symlink. */
function symlinkTarget(abs: string): string | undefined {
  try {
    if (!lstatSync(abs).isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  return real(abs);
}

/** The `permissions.allow` rules of a picked settings object. */
function allowRules(picked: Record<string, unknown> | null): string[] {
  const allow = (picked?.permissions as { allow?: unknown } | undefined)?.allow;
  return Array.isArray(allow)
    ? allow.filter((rule): rule is string => typeof rule === 'string')
    : [];
}

/**
 * Read the worktree's committed repo settings and compare them with the
 * baseline.
 *
 * @param cwd - The folder the turn launches in.
 * @param baseline - What it is compared against.
 * @param dorkHome - DorkOS's data folder, whose `plugins/` scripts are not the repo's.
 */
export async function readRepoConfig(
  cwd: string,
  baseline: RepoBaseline,
  dorkHome: string
): Promise<RepoReading> {
  const root = real(baseline.root);
  const here = real(cwd);
  if (!isWithin(root, here)) return CLEAN;
  const prefix = repoRelative(root, here);
  const settingsRel = under(prefix, '.claude/settings.json');
  const hooksRel = under(prefix, '.claude/hooks');

  // The worktree first: a folder with none of these files needs no git at all.
  const settings = readSettingsFile(path.join(here, '.claude', 'settings.json'));
  const workingPicked = settings.kind === 'parsed' ? pickPowerSettings(settings.value) : null;
  const walked = walkScripts(path.join(here, '.claude', 'hooks'));
  // Subagents and skills can set hooks and MCP servers in their frontmatter.
  const agentFiles = agentFileHooks(here);
  // Every `.mcp.json` Claude Code could read, from here up to the repo top.
  const mcpRels: string[] = [];
  for (let dir = here; ; dir = path.dirname(dir)) {
    mcpRels.push(under(repoRelative(root, dir), '.mcp.json'));
    if (dir === root || path.dirname(dir) === dir) break;
  }
  const mcpPresent = mcpRels.some(
    (rel) => readSettingsFile(path.join(root, rel)).kind !== 'absent'
  );
  const settingsPresent =
    settings.kind !== 'absent' && (settings.kind !== 'parsed' || workingPicked !== null);
  if (!settingsPresent && walked?.length === 0 && agentFiles?.length === 0 && !mcpPresent) {
    return CLEAN;
  }

  const agentRels = (agentFiles ?? []).map(([rel]) => under(prefix, rel));
  const first = await baselineTrees(baseline, [settingsRel, hooksRel, ...mcpRels, ...agentRels]);
  const atHead = first.trees[0];
  const blobText = async (file: BaselineFile | undefined) => (file ? first.read(file.oid) : null);
  const baselinePicked = await Promise.all(
    first.trees.map(async (tree): Promise<Record<string, unknown> | null> => {
      const text = await blobText(tree.get(settingsRel));
      if (text === null) return null;
      try {
        return pickPowerSettings(JSON.parse(text) as unknown);
      } catch {
        return { malformed: sha256(text) };
      }
    })
  );

  // The scripts: everything under `.claude/hooks/`, every file in the repo a
  // command names (settings or frontmatter, either side), and what each
  // symlink among them points at.
  const commands: string[] = [];
  if (workingPicked) collectCommands(workingPicked, commands);
  for (const picked of baselinePicked) if (picked) collectCommands(picked, commands);
  for (const [, picked] of agentFiles ?? []) collectCommands(picked, commands);
  const scriptPaths = new Set<string>(walked ?? []);
  for (const target of namedTargets(here, path.resolve(dorkHome, 'plugins'), commands)) {
    if (isWithin(root, target) && target !== root) scriptPaths.add(target);
  }
  for (const abs of [...scriptPaths]) {
    const target = symlinkTarget(abs);
    if (target && target !== root) scriptPaths.add(target);
  }
  const named = [...scriptPaths]
    .filter((abs) => isWithin(root, abs))
    .map((abs) => repoRelative(root, abs))
    .filter((rel) => !rel.startsWith(`${hooksRel}/`));
  const second = named.length > 0 ? await baselineTrees(baseline, named) : null;
  const trees = first.trees.map((tree, index) => {
    const merged = new Map(tree);
    for (const [key, value] of second?.trees[index] ?? []) merged.set(key, value);
    return merged;
  });

  // Hooks: the settings keys, the frontmatter, then each script.
  const hookFiles: string[] = [];
  const hookDiffs: string[] = [];
  const hookContent: [string, string][] = [];
  let hooksApprovable =
    walked !== undefined && agentFiles !== undefined && settings.kind !== 'unverifiable';
  const settingsChanged =
    settings.kind === 'unverifiable' ||
    settings.kind === 'malformed' ||
    (workingPicked !== null &&
      !baselinePicked.some((picked) => canonicalJson(picked) === canonicalJson(workingPicked)));
  if (settingsChanged) {
    hookFiles.push(settingsRel);
    const working =
      settings.kind === 'malformed' ? { malformed: sha256(settings.text) } : workingPicked;
    hookContent.push([settingsRel, canonicalJson(working)]);
    hookDiffs.push(
      fileDiff(
        settingsRel,
        baselinePicked[0] ? JSON.stringify(baselinePicked[0], null, 2) : null,
        settings.kind === 'malformed' ? settings.text : JSON.stringify(workingPicked, null, 2)
      )
    );
  }
  let agentMcpChanged = false;
  for (const [rel0, picked] of agentFiles ?? []) {
    const rel = under(prefix, rel0);
    const working = canonicalJson(picked);
    const baseTexts = await Promise.all(trees.map((tree) => blobText(tree.get(rel))));
    const basePicked = baseTexts.map((text) => (text === null ? null : pickAgentFileFields(text)));
    if (basePicked.some((base) => base !== null && canonicalJson(base) === working)) continue;
    const servers = (picked as { mcpServers?: unknown }).mcpServers;
    if (canonicalJson(servers ?? null) !== canonicalJson(basePicked[0]?.mcpServers ?? null)) {
      agentMcpChanged = true;
    }
    hookFiles.push(rel);
    hookContent.push([rel, working]);
    hookDiffs.push(
      fileDiff(
        rel,
        basePicked[0] ? JSON.stringify(basePicked[0], null, 2) : null,
        JSON.stringify(picked, null, 2)
      )
    );
  }
  if (agentFiles === undefined) {
    const rel = under(prefix, '.claude/agents');
    hookFiles.push(rel);
    hookContent.push([rel, 'unverifiable']);
  }
  for (const abs of [...scriptPaths].sort()) {
    const rel = displayPath(root, abs);
    const script = readScript(abs);
    if (script.kind === 'absent' || script.kind === 'dir') continue;
    if (script.kind === 'unverifiable') {
      hooksApprovable = false;
      hookFiles.push(rel);
      hookContent.push([rel, 'unverifiable']);
      continue;
    }
    const oid = gitBlobId(script.bytes, baseline.oidLength);
    const same =
      isWithin(root, abs) &&
      trees.some((tree) => {
        const entry = tree.get(rel);
        return entry?.oid === oid && (entry.mode === '120000') === script.symlink;
      });
    if (same) continue;
    hookFiles.push(rel);
    hookContent.push([rel, oid]);
    const before = isWithin(root, abs) ? trees[0]?.get(rel) : undefined;
    hookDiffs.push(
      fileDiff(
        rel,
        before ? await first.read(before.oid) : null,
        script.symlink ? `-> ${script.bytes.toString('utf8')}` : script.bytes.toString('utf8')
      )
    );
  }
  if (walked === undefined) {
    hookFiles.push(hooksRel);
    hookContent.push([hooksRel, 'unverifiable']);
  }

  // `.mcp.json`: each file, and the default branch's servers from the repo top down.
  const mcpFiles: string[] = [];
  const mcpDiffs: string[] = [];
  const mcpContent: [string, string][] = [];
  let mcpApprovable = true;
  for (const rel of mcpRels) {
    const read = readSettingsFile(path.join(root, rel));
    if (read.kind === 'absent') continue;
    if (read.kind === 'unverifiable') {
      mcpApprovable = false;
      mcpFiles.push(rel);
      mcpContent.push([rel, 'unverifiable']);
      continue;
    }
    const working = canonicalText(read.text);
    const baseTexts = await Promise.all(trees.map((tree) => blobText(tree.get(rel))));
    if (baseTexts.some((text) => text !== null && canonicalText(text) === working)) continue;
    mcpFiles.push(rel);
    mcpContent.push([rel, working]);
    mcpDiffs.push(fileDiff(rel, baseTexts[0] ?? null, read.text));
  }
  const baselineServers = await defaultBranchServers(
    [...mcpRels].reverse(),
    atHead,
    blobText,
    baselinePicked[0]
  );

  // Every allow rule a trusted commit has was reviewed; the rest were not.
  const reviewedAllows = new Set(baselinePicked.flatMap(allowRules));
  const hooks =
    hookFiles.length === 0
      ? null
      : {
          digest: sha256(canonicalJson(hookContent)),
          files: hookFiles,
          detail: hookDiffs.join('\n\n'),
          approvable: hooksApprovable,
          mcpKeysChanged:
            agentMcpChanged ||
            (settingsChanged &&
              MCP_KEYS.some(
                (key) =>
                  canonicalJson(workingPicked?.[key] ?? null) !==
                  canonicalJson(baselinePicked[0]?.[key] ?? null)
              )),
          addedAllows: allowRules(workingPicked).filter((rule) => !reviewedAllows.has(rule)),
        };
  const mcpJson =
    mcpFiles.length === 0
      ? null
      : {
          digest: sha256(canonicalJson(mcpContent)),
          files: mcpFiles,
          detail: mcpDiffs.join('\n\n'),
          approvable: mcpApprovable,
        };
  return { hooks, mcpJson, baselineServers };
}

/**
 * The servers the default branch's `.mcp.json` files declare, the repo top's
 * first so a closer file wins, minus any its settings list in
 * `disabledMcpjsonServers`. Empty with no trusted commit.
 */
async function defaultBranchServers(
  rels: string[],
  tree: Map<string, BaselineFile> | undefined,
  blobText: (file: BaselineFile | undefined) => Promise<string | null>,
  settings: Record<string, unknown> | null | undefined
): Promise<Record<string, unknown>> {
  if (!tree) return {};
  const servers: Record<string, unknown> = {};
  for (const rel of rels) {
    const text = await blobText(tree.get(rel));
    if (text === null) continue;
    try {
      const declared = (JSON.parse(text) as { mcpServers?: unknown }).mcpServers;
      if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
        Object.assign(servers, declared);
      }
    } catch {
      // A default branch whose file does not parse starts nothing from it.
    }
  }
  const disabled = settings?.disabledMcpjsonServers;
  if (Array.isArray(disabled)) for (const name of disabled) delete servers[String(name)];
  return servers;
}

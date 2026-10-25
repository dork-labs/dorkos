/**
 * Decide, per launch, whether an agent's own folder allow list rides the
 * launch's flag-layer `settings` (DOR-3039), and merge it in when it does.
 *
 * It applies only when every condition holds:
 * - the turn is not a teammate's (DOR-2955: a teammate's turn loads no
 *   settings layer, so it gets none of these either);
 * - the turn's folder is a registered agent home, by real path, exactly
 *   (`isExactlyAgentHome`);
 * - a person approved exactly this list for this agent
 *   (`folder-allow-consent.ts`).
 *
 * The rules go into `settings.permissions.allow`, never `allowedTools`
 * (DOR-519). Deny rules from every layer still win over them: Claude Code
 * checks deny before allow.
 *
 * @module services/runtimes/claude-code/folder-settings/apply-folder-allows
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { rulePath, writeDenyRules } from '../messaging/directory-grants.js';
import { isExactlyAgentHome, readFolderAllowList } from './agent-folder-allows.js';
import {
  folderAllowEntry,
  isFolderAllowListApproved,
  isFolderAllowListRefused,
  lastApprovedRules,
  recordFolderAllowApproval,
  type FolderAllowRequest,
} from './folder-allow-consent.js';
import { cardShowsWholeList } from './folder-allow-approval.js';

/** What a launch does with an agent's folder allow list. */
export type FolderAllowsDecision =
  /** Nothing to apply or ask about: a teammate's turn, no registered agent, not the home, or an empty list. */
  | { kind: 'none' }
  /** Approved: these rules ride the launch. */
  | { kind: 'applied'; rules: string[]; hash: string; dropped: number }
  /** Not decided yet: nothing applies, and a person should be asked. */
  | { kind: 'waiting'; request: FolderAllowRequest; hash: string }
  /** Turned down: nothing applies, and nobody is asked again until it changes. */
  | { kind: 'refused'; hash: string }
  /** Too long to show whole on a card: nothing applies, and nobody is asked. */
  | { kind: 'unshowable'; hash: string };

/** What {@link resolveFolderAllows} needs to know about the turn. */
export interface FolderAllowsTurn {
  /** Whether this is a teammate's turn. */
  teammate: boolean;
  /** The registered agent the turn runs as, if any. */
  agent: { id: string; name: string } | undefined;
  /** The registered agent home the turn resolved to, if any. */
  home: string | undefined;
  /** The folder the turn launches in. */
  cwd: string;
}

/**
 * Decide what a launch does with the agent's folder allow list.
 *
 * @param turn - Who the turn is for and where it stands.
 */
export async function resolveFolderAllows(turn: FolderAllowsTurn): Promise<FolderAllowsDecision> {
  if (turn.teammate || !turn.agent || !turn.home) return { kind: 'none' };
  if (!(await isExactlyAgentHome(turn.cwd, turn.home))) return { kind: 'none' };
  const list = await readFolderAllowList(turn.home);
  if (list.rules.length === 0) return { kind: 'none' };
  const applied = {
    kind: 'applied',
    rules: list.rules,
    hash: list.hash,
    dropped: list.dropped.length,
  } as const;
  const request: FolderAllowRequest = {
    agentId: turn.agent.id,
    agentName: turn.agent.name,
    home: turn.home,
    rules: list.rules,
    dropped: list.dropped.length,
  };
  if (isFolderAllowListApproved(request)) return applied;
  if (isFolderAllowListRefused(request)) return { kind: 'refused', hash: list.hash };
  const previous = lastApprovedRules(turn.agent.id, turn.home);
  // A list that only lost rules since the person's yes can only narrow what
  // runs, so it applies without a card, and becomes the yes on record.
  if (previous && list.rules.every((rule) => previous.includes(rule))) {
    recordFolderAllowApproval(request, 'narrowing an approved agent folder allow list');
    return applied;
  }
  const asking = previous ? { ...request, previousRules: previous } : request;
  // A person may only approve what they can read in full.
  if (!cardShowsWholeList(asking)) return { kind: 'unshowable', hash: list.hash };
  return { kind: 'waiting', request: asking, hash: list.hash };
}

/** The slice of Claude Code settings this module writes. */
interface AllowSettings {
  allow?: string[];
  deny?: string[];
}

/** Where the files an approved rule must never write live, for one launch. */
export interface SelfGrantFiles {
  /** The registered agent home the list was read from. */
  home: string;
  /** DorkOS's data folder: its config holds the approval record. */
  dorkHome: string;
  /** The launch's Claude Code account folder (`CLAUDE_CONFIG_DIR`). */
  accountRoot: string;
}

/**
 * The files that would let an agent grant itself more, if a file tool could
 * write them: its own `.claude/` (the allow list and its hooks), `.mcp.json`
 * and `.dork/agent.json`, DorkOS's data folder (the approval record), and
 * Claude Code's account files (folder trust, user-level rules). Denied to
 * every file tool whenever a list applies, because deny beats allow: no rule a
 * person approves can reach them (Security review of #3072, M1).
 *
 * `undefined` when one of the paths can't be named exactly in a rule; the
 * caller then applies nothing rather than a list that might reach them.
 *
 * Bash is not covered: a shell rule a person approved writes where it likes,
 * which is why the card has to say what a shell rule means (DOR-3294).
 *
 * @param files - Where this launch's files live.
 */
export function selfGrantDenyRules(files: SelfGrantFiles): string[] | undefined {
  const home = path.resolve(files.home);
  const dorkHome = path.resolve(files.dorkHome);
  const targets: [string, 'folder' | 'file'][] = [
    [path.join(home, '.claude'), 'folder'],
    [path.join(home, '.mcp.json'), 'file'],
    [path.join(home, '.dork', 'agent.json'), 'file'],
    [path.resolve(files.accountRoot), 'folder'],
    // DorkOS's data folder: every entry at its top (config.json, host.key, its
    // own folders) but the two agents work in, each named on its own. Not one
    // `.dork/*` rule: run on the CLI, `*` there crosses folders, so it denied
    // every agent home inside the data folder too.
    ...dataEntriesAgentsNeverWrite(dorkHome).map(({ name, kind }): [string, 'folder' | 'file'] => [
      path.join(dorkHome, name),
      kind,
    ]),
  ];
  const rules: string[] = [];
  for (const [target, kind] of targets) {
    const named = writeDenyRules(target, kind);
    if (!named) return undefined;
    rules.push(...named);
  }
  const agentsRoot = rulePath(path.join(dorkHome, 'agents'));
  if (agentsRoot === undefined) return undefined;
  for (const tool of WRITE_TOOL_NAMES) {
    // Every agent home in the data folder keeps its own self-grant files, so
    // one agent's approved rule can't rewrite another's list either.
    rules.push(
      `${tool}(${agentsRoot}/*/.claude/**)`,
      `${tool}(${agentsRoot}/*/.mcp.json)`,
      `${tool}(${agentsRoot}/*/.dork/agent.json)`
    );
    // The home folder's own spellings, which Claude Code expands itself: the
    // default account and its `.claude.json`, and the default data folder's
    // record, whatever this launch's account and data folder are.
    rules.push(
      `${tool}(~/.claude/**)`,
      `${tool}(~/.claude.json)`,
      ...DATA_FILES_ALWAYS_DENIED.map((name) => `${tool}(~/.dork/${name})`)
    );
  }
  return [...new Set(rules)];
}

/**
 * The data folder's files that grant or prove something, denied even before
 * they exist: the config (the approval record among it), the key the secrets
 * are encrypted with, and the local tokens.
 */
const DATA_FILES_ALWAYS_DENIED = [
  'config.json',
  'host.key',
  'mcp-local-token',
  'better-auth-secret',
  'marketplaces.json',
] as const;

/** The file tools {@link selfGrantDenyRules} names, `MultiEdit` included for older CLIs. */
const WRITE_TOOL_NAMES = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;

/**
 * The data folder's own entries agents never write with file tools: every
 * file and folder at its top but `agents/` (where most agent homes live) and
 * `workspaces/` (the project checkouts agents work in), plus the
 * {@link DATA_FILES_ALWAYS_DENIED}. Read at launch, so an entry DorkOS added
 * since is covered; one an agent creates later is one DorkOS never reads.
 */
function dataEntriesAgentsNeverWrite(
  dorkHome: string
): { name: string; kind: 'folder' | 'file' }[] {
  const entries = new Map<string, 'folder' | 'file'>(
    DATA_FILES_ALWAYS_DENIED.map((name) => [name, 'file'])
  );
  try {
    for (const entry of readdirSync(dorkHome, { withFileTypes: true })) {
      if (entry.name === 'agents' || entry.name === 'workspaces') continue;
      entries.set(entry.name, entry.isDirectory() || entry.isSymbolicLink() ? 'folder' : 'file');
    }
  } catch {
    // No data folder yet: the always-denied files are still named.
  }
  return [...entries].map(([name, kind]) => ({ name, kind }));
}

/**
 * Merge approved rules into the launch's `settings.permissions.allow`, and the
 * {@link selfGrantDenyRules} into its `deny`, keeping every other setting
 * (fast mode, folder grants, a credits endpoint).
 *
 * @param sdkOptions - The launch options, mutated.
 * @param rules - The approved rules.
 * @param deny - The self-grant deny rules for this launch.
 */
export function mergeFolderAllows(
  sdkOptions: Options,
  rules: readonly string[],
  deny: readonly string[]
): void {
  if (rules.length === 0) return;
  const base =
    typeof sdkOptions.settings === 'object' && sdkOptions.settings !== null
      ? sdkOptions.settings
      : {};
  const permissions = ((base as { permissions?: AllowSettings }).permissions ??
    {}) as AllowSettings;
  const allow = [...(permissions.allow ?? [])];
  for (const rule of rules) if (!allow.includes(rule)) allow.push(rule);
  const denied = [...(permissions.deny ?? [])];
  for (const rule of deny) if (!denied.includes(rule)) denied.push(rule);
  sdkOptions.settings = {
    ...base,
    permissions: { ...permissions, allow, deny: denied },
  } as Options['settings'];
}

/**
 * The allow rules a launch's settings carry, for the launch fingerprint.
 *
 * @param settings - A launch's `Options.settings`.
 */
export function folderAllowsFromSettings(settings: Options['settings']): string[] {
  if (typeof settings !== 'object' || settings === null) return [];
  const allow = (settings as { permissions?: AllowSettings }).permissions?.allow;
  return Array.isArray(allow) ? [...allow] : [];
}

/**
 * The status line a Never ask chat shows while its agent's list waits for a
 * person (DOR-3042), so the refusals that follow have a reason on screen.
 * Copy signed off by designer. It never says "Never ask": it only shows there.
 *
 * @param agentName - The agent's display name.
 */
export function folderAllowsWaitingStatus(agentName: string): string {
  return `Folder rules for ${agentName} are waiting for your approval in Needs you. Until then, this chat won't run the commands they allow.`;
}

/** The waiting card each chat was last told about. */
const toldChats = new WeakMap<object, string>();

/**
 * Whether this chat has yet to be told about this waiting list: once per chat
 * per card, so the line does not become wallpaper. A newer change is a new
 * card, and is told again.
 *
 * @param chat - The chat's session object.
 * @param request - The waiting list.
 */
export function firstTimeToldAbout(chat: object, request: FolderAllowRequest): boolean {
  const entry = folderAllowEntry(request);
  if (toldChats.get(chat) === entry) return false;
  toldChats.set(chat, entry);
  return true;
}

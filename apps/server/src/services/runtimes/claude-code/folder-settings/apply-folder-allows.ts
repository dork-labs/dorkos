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
import { isExactlyAgentHome, readFolderAllowList } from './agent-folder-allows.js';
import {
  folderAllowEntry,
  isFolderAllowListApproved,
  isFolderAllowListRefused,
  lastApprovedRules,
  recordFolderAllowApproval,
  type FolderAllowRequest,
} from './folder-allow-consent.js';

/** What a launch does with an agent's folder allow list. */
export type FolderAllowsDecision =
  /** Nothing to apply or ask about: a teammate's turn, no registered agent, not the home, or an empty list. */
  | { kind: 'none' }
  /** Approved: these rules ride the launch. */
  | { kind: 'applied'; rules: string[]; hash: string; dropped: number }
  /** Not decided yet: nothing applies, and a person should be asked. */
  | { kind: 'waiting'; request: FolderAllowRequest; hash: string }
  /** Turned down: nothing applies, and nobody is asked again until it changes. */
  | { kind: 'refused'; hash: string };

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
  return {
    kind: 'waiting',
    request: previous ? { ...request, previousRules: previous } : request,
    hash: list.hash,
  };
}

/** The slice of Claude Code settings this module writes. */
interface AllowSettings {
  allow?: string[];
}

/**
 * Merge approved rules into the launch's `settings.permissions.allow`, keeping
 * every other setting (fast mode, folder grants, a credits endpoint).
 *
 * @param sdkOptions - The launch options, mutated.
 * @param rules - The approved rules.
 */
export function mergeFolderAllows(sdkOptions: Options, rules: readonly string[]): void {
  if (rules.length === 0) return;
  const base =
    typeof sdkOptions.settings === 'object' && sdkOptions.settings !== null
      ? sdkOptions.settings
      : {};
  const permissions = ((base as { permissions?: AllowSettings }).permissions ??
    {}) as AllowSettings;
  const allow = [...(permissions.allow ?? [])];
  for (const rule of rules) if (!allow.includes(rule)) allow.push(rule);
  sdkOptions.settings = {
    ...base,
    permissions: { ...permissions, allow },
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

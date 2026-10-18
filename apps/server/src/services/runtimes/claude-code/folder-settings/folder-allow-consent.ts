/**
 * The durable record of which agents' folder allow lists a person let apply,
 * and which they turned down (DOR-3039).
 *
 * ## What an entry is
 *
 * `<agentId>@folder-allows-<digest>`, where the digest covers the agent's
 * resolved home and the exact rules the approval card showed. Keyed by agent
 * id, not folder, so a new agent registered at an old folder starts
 * unapproved. Any edit to the list (a rule added, removed or reordered)
 * changes the digest, and the old yes stops matching: the edited list does not
 * apply until a person approves it again.
 *
 * Each agent holds at most one yes: approving a new list forgets the agent's
 * earlier ones, so going back to an older list asks again too. The rules behind
 * that yes are kept beside it (`permissions.approvedFolderAllowRules`) so a
 * card can say what changed, and so a list that only lost rules can apply
 * without asking: removing a rule can only narrow what runs.
 *
 * ## Where the record lives
 *
 * `permissions.approvedFolderAllows` and `permissions.refusedFolderAllows` in
 * `~/.dork/config.json`, both `operator-only` (`config-write-policy.ts`): an
 * agent that could write the yes would approve its own permissions. The
 * residual is the one `hook-consent.ts` states: with login off, a caller that
 * omits its agent header is treated as the operator (DOR-505).
 *
 * @module services/runtimes/claude-code/folder-settings/folder-allow-consent
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { configManager } from '../../../core/config-manager.js';
import { logConfigWrite } from '../../../core/operator/config-write.js';

/** One agent's folder allow list, as a person is asked about it. */
export interface FolderAllowRequest {
  /** The registered agent's id. */
  agentId: string;
  /** The agent's display name, for the card. */
  agentName: string;
  /** The registered agent home the rules were read from. */
  home: string;
  /** The rules DorkOS would apply, in order (already judged). */
  rules: readonly string[];
  /** The rules behind the agent's current yes, when it had one: the card says what changed. */
  previousRules?: readonly string[];
  /** How many rules in the file DorkOS left out (wildcards, its own tools). */
  dropped?: number;
}

/** What sits between the agent id and the digest in a stored entry. */
export const FOLDER_ALLOWS_ENTRY_MARKER = '@folder-allows-';

/**
 * The stored form of one decision about one agent's list.
 *
 * @param request - The agent, its home and its rules.
 */
export function folderAllowEntry(
  request: Pick<FolderAllowRequest, 'agentId' | 'home' | 'rules'>
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ home: path.resolve(request.home), rules: request.rules }))
    .digest('hex');
  return `${request.agentId}${FOLDER_ALLOWS_ENTRY_MARKER}${digest}`;
}

/** Whether a stored entry is about this agent. */
function isAgentEntry(agentId: string): (stored: string) => boolean {
  return (stored) => stored.startsWith(`${agentId}${FOLDER_ALLOWS_ENTRY_MARKER}`);
}

/** Both lists, and the rules behind each agent's yes, as stored now. */
function storedDecisions(): {
  approved: string[];
  refused: string[];
  rules: Record<string, string[]>;
} {
  const permissions = configManager.get('permissions');
  return {
    approved: [...(permissions.approvedFolderAllows ?? [])],
    refused: [...(permissions.refusedFolderAllows ?? [])],
    rules: { ...(permissions.approvedFolderAllowRules ?? {}) },
  };
}

/** Write the decisions back, and say nothing when nothing changed. */
function writeDecisions(
  reason: string,
  approved: string[],
  refused: string[],
  rules: Record<string, string[]>
): void {
  const permissions = configManager.get('permissions');
  const next = {
    approvedFolderAllows: approved,
    refusedFolderAllows: refused,
    approvedFolderAllowRules: rules,
  };
  const current = {
    approvedFolderAllows: permissions.approvedFolderAllows ?? [],
    refusedFolderAllows: permissions.refusedFolderAllows ?? [],
    approvedFolderAllowRules: permissions.approvedFolderAllowRules ?? {},
  };
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  configManager.set('permissions', { ...permissions, ...next });
  logConfigWrite(reason, 'permissions', permissions, configManager.get('permissions'));
}

/**
 * Whether a person approved exactly this list for this agent.
 *
 * @param request - The agent, its home and its rules.
 */
export function isFolderAllowListApproved(
  request: Pick<FolderAllowRequest, 'agentId' | 'home' | 'rules'>
): boolean {
  return storedDecisions().approved.includes(folderAllowEntry(request));
}

/**
 * Whether a person turned down exactly this list for this agent.
 *
 * @param request - The agent, its home and its rules.
 */
export function isFolderAllowListRefused(
  request: Pick<FolderAllowRequest, 'agentId' | 'home' | 'rules'>
): boolean {
  return storedDecisions().refused.includes(folderAllowEntry(request));
}

/**
 * Record a person's yes. Replaces the agent's earlier yes, and clears a
 * matching no.
 *
 * @param request - The list that was allowed.
 */
export function recordFolderAllowApproval(
  request: Pick<FolderAllowRequest, 'agentId' | 'home' | 'rules'>,
  reason = 'approving an agent folder allow list'
): void {
  const entry = folderAllowEntry(request);
  const { approved, refused, rules } = storedDecisions();
  writeDecisions(
    reason,
    [...approved.filter((stored) => !isAgentEntry(request.agentId)(stored)), entry],
    refused.filter((stored) => stored !== entry),
    { ...rules, [request.agentId]: [...request.rules] }
  );
}

/**
 * Record a person's no. Clears a matching yes; the agent's yes for a different
 * list is already dead (only the current list is ever looked up), so it is
 * dropped too.
 *
 * @param request - The list that was turned down.
 */
export function recordFolderAllowRefusal(request: FolderAllowRequest): void {
  const entry = folderAllowEntry(request);
  const { approved, refused, rules } = storedDecisions();
  const { [request.agentId]: _forgotten, ...kept } = rules;
  writeDecisions(
    'turning down an agent folder allow list',
    approved.filter((stored) => !isAgentEntry(request.agentId)(stored)),
    refused.includes(entry) ? refused : [...refused, entry],
    kept
  );
}

/**
 * The rules behind the agent's current yes, for the card's "what changed"
 * sentence and for applying a list that only shrank. Only rules a stored yes
 * still vouches for are returned: the record must digest to an approved entry
 * for this agent and home.
 *
 * @param agentId - The registered agent's id.
 * @param home - The agent's home now.
 */
export function lastApprovedRules(agentId: string, home: string): string[] | undefined {
  const { approved, rules } = storedDecisions();
  const previous = rules[agentId];
  if (!previous) return undefined;
  return approved.includes(folderAllowEntry({ agentId, home, rules: previous }))
    ? [...previous]
    : undefined;
}

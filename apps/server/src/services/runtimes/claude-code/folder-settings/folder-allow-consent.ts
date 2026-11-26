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
 * agent that could write the yes would approve its own permissions. The space
 * side writes them (`core/approvals/computer-asks/folder-decisions.ts`), from a
 * card's answer or a decision this side reports through the asks port; this
 * module only reads. The
 * residual is the one `hook-consent.ts` states: with login off, a caller that
 * omits its agent header is treated as the operator (DOR-505).
 *
 * @module services/runtimes/claude-code/folder-settings/folder-allow-consent
 */
import type { FolderAllowRequest } from '@dorkos/shared/computer-asks';
import { FOLDER_ALLOWS_ENTRY_MARKER, folderAllowEntry } from '@dorkos/shared/consent-entries';
import { configManager } from '../../../core/config-manager.js';

// The stored form of a decision is the space side's too: it writes these lists
// (`core/approvals/computer-asks/folder-decisions.ts`), this module reads them.
export type { FolderAllowRequest };
export { FOLDER_ALLOWS_ENTRY_MARKER, folderAllowEntry };

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

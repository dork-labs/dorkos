/**
 * Writing the durable record of an agent folder's two consents on the space
 * side (spec `computer-side-starts-alone` §5.7):
 *
 * - its own allow list (DOR-3039): `permissions.approvedFolderAllows`,
 *   `refusedFolderAllows` and the rules behind each yes,
 *   `approvedFolderAllowRules`;
 * - its folder settings (DOR-3068): `harness.approvedFolderConfig`,
 *   `refusedFolderConfig`, the part digests behind each yes,
 *   `approvedFolderConfigParts`, and the one-time upgrade pin
 *   `folderConfigPinned`.
 *
 * Every leaf is `operator-only` (`core/operator/config-write-policy.ts`): an
 * agent that could write the yes would approve its own permissions. What an
 * entry binds, and how the computer side reads the lists, is
 * `runtimes/claude-code/folder-settings/folder-allow-consent.ts` and
 * `folder-config-consent.ts`.
 *
 * @module services/core/approvals/computer-asks/folder-decisions
 */
import {
  FOLDER_ALLOWS_ENTRY_MARKER,
  FOLDER_CONFIG_ENTRY_MARKER,
  folderAllowEntry,
  folderConfigEntry,
} from '@dorkos/shared/consent-entries';
import type {
  FolderAllowRequest,
  FolderConfigDigests,
  FolderConfigPart,
} from '@dorkos/shared/computer-asks';
import { readConsent, requireConsentConfig, writeConsent } from './consent-config.js';

// === The allow list ===

/** Both allow list leaves, and the rules behind each agent's yes, as stored now. */
function storedAllows(): {
  approved: string[];
  refused: string[];
  rules: Record<string, string[]>;
} {
  const permissions = readConsent('permissions');
  return {
    approved: [...(permissions.approvedFolderAllows ?? [])],
    refused: [...(permissions.refusedFolderAllows ?? [])],
    rules: { ...(permissions.approvedFolderAllowRules ?? {}) },
  };
}

/** Write the allow list leaves back, and say nothing when nothing changed. */
function writeAllows(
  reason: string,
  approved: string[],
  refused: string[],
  rules: Record<string, string[]>
): void {
  const permissions = readConsent('permissions');
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
  writeConsent('permissions', reason, { ...permissions, ...next });
}

/** Whether a stored allow list entry is about this agent. */
function isAllowsEntryOf(agentId: string): (stored: string) => boolean {
  return (stored) => stored.startsWith(`${agentId}${FOLDER_ALLOWS_ENTRY_MARKER}`);
}

/**
 * Record a yes to an agent's allow list. Replaces the agent's earlier yes, and
 * clears a matching no.
 *
 * @param request - The list that was allowed.
 * @param reason - The config-write log line.
 */
export function recordFolderAllowApproval(
  request: Pick<FolderAllowRequest, 'agentId' | 'home' | 'rules'>,
  reason = 'approving an agent folder allow list'
): void {
  // A write with no store throws, so no decision is ever skipped or allowed.
  requireConsentConfig();
  const entry = folderAllowEntry(request);
  const { approved, refused, rules } = storedAllows();
  writeAllows(
    reason,
    [...approved.filter((stored) => !isAllowsEntryOf(request.agentId)(stored)), entry],
    refused.filter((stored) => stored !== entry),
    { ...rules, [request.agentId]: [...request.rules] }
  );
}

/**
 * Record a no to an agent's allow list. Clears a matching yes; the agent's yes
 * for a different list is already dead (only the current list is ever looked
 * up), so it is dropped too.
 *
 * @param request - The list that was turned down.
 */
export function recordFolderAllowRefusal(
  request: Pick<FolderAllowRequest, 'agentId' | 'home' | 'rules'>
): void {
  // A write with no store throws, so no decision is ever skipped or allowed.
  requireConsentConfig();
  const entry = folderAllowEntry(request);
  const { approved, refused, rules } = storedAllows();
  const { [request.agentId]: _forgotten, ...kept } = rules;
  writeAllows(
    'turning down an agent folder allow list',
    approved.filter((stored) => !isAllowsEntryOf(request.agentId)(stored)),
    refused.includes(entry) ? refused : [...refused, entry],
    kept
  );
}

// === The folder settings ===

/** The agent, its home and a state of its settings. */
interface FolderConfigState {
  agentId: string;
  home: string;
  digests: FolderConfigDigests;
}

/** The three folder settings leaves. */
interface FolderConfigDecisions {
  approved: string[];
  refused: string[];
  parts: Record<string, FolderConfigDigests>;
}

/** The three leaves as stored now; a missing section reads as nothing decided. */
function storedFolderConfig(): FolderConfigDecisions {
  const harness = (readConsent('harness') ?? {}) as {
    approvedFolderConfig?: string[];
    refusedFolderConfig?: string[];
    approvedFolderConfigParts?: Record<string, FolderConfigDigests>;
  };
  return {
    approved: [...(harness.approvedFolderConfig ?? [])],
    refused: [...(harness.refusedFolderConfig ?? [])],
    parts: { ...(harness.approvedFolderConfigParts ?? {}) },
  };
}

/** Write the leaves back, and say nothing when nothing changed. */
function writeFolderConfig(reason: string, next: FolderConfigDecisions): void {
  const harness = readConsent('harness');
  if (JSON.stringify(next) === JSON.stringify(storedFolderConfig())) return;
  writeConsent('harness', reason, {
    ...harness,
    approvedFolderConfig: next.approved,
    refusedFolderConfig: next.refused,
    approvedFolderConfigParts: next.parts,
  });
}

/** Whether a stored folder settings entry is about this agent. */
function isConfigEntryOf(agentId: string): (stored: string) => boolean {
  return (stored) => stored.startsWith(`${agentId}${FOLDER_CONFIG_ENTRY_MARKER}`);
}

/**
 * Record a yes to a state of an agent's folder settings: it replaces the
 * agent's earlier yes, and clears a matching no.
 *
 * @param state - The state that was allowed.
 * @param reason - The config-write log line.
 */
export function recordFolderConfigApproval(
  state: FolderConfigState,
  reason = "allowing an agent's folder settings"
): void {
  // A write with no store throws, so no decision is ever skipped or allowed.
  requireConsentConfig();
  const entry = folderConfigEntry(state);
  const { approved, refused, parts } = storedFolderConfig();
  writeFolderConfig(reason, {
    approved: [...approved.filter((stored) => !isConfigEntryOf(state.agentId)(stored)), entry],
    refused: refused.filter((stored) => stored !== entry),
    parts: { ...parts, [state.agentId]: { ...state.digests } },
  });
}

/**
 * Record a no. The agent's earlier yes stays: what it ran before is still what
 * a person approved, and the agent must not look unpinned.
 *
 * @param state - The state that was turned down.
 */
export function recordFolderConfigRefusal(state: FolderConfigState): void {
  // A write with no store throws, so no decision is ever skipped or allowed.
  requireConsentConfig();
  const entry = folderConfigEntry(state);
  const current = storedFolderConfig();
  writeFolderConfig("turning down an agent's folder settings", {
    ...current,
    refused: current.refused.includes(entry) ? current.refused : [...current.refused, entry],
  });
}

/**
 * Move one part of an agent's yes from `before` to `after`, when a PERSON just
 * made that change through DorkOS. Only when the agent's yes had exactly
 * `before` for that part: a part the agent already changed on its own stays
 * unapproved, so the card still asks about it. The other parts keep their
 * approved digests.
 *
 * @param move - The agent, its home, the part, its digests before and after,
 *   and the config-write log line.
 * @returns Whether the yes moved.
 */
export function repinFolderConfigPart(move: {
  agentId: string;
  home: string;
  part: FolderConfigPart;
  before: string;
  after: string;
  reason: string;
}): boolean {
  // A write with no store throws, so no decision is ever skipped or allowed.
  requireConsentConfig();
  const { agentId, home, part, before, after, reason } = move;
  const { approved, parts } = storedFolderConfig();
  const previous = parts[agentId];
  const vouched =
    previous && approved.includes(folderConfigEntry({ agentId, home, digests: previous }))
      ? previous
      : undefined;
  if (!vouched || vouched[part] !== before) return false;
  if (before === after) return true;
  recordFolderConfigApproval({ agentId, home, digests: { ...vouched, [part]: after } }, reason);
  return true;
}

/** Record that the agents that already existed were pinned, so it never happens again. */
export function markFolderConfigsPinned(): void {
  // A write with no store throws, so no decision is ever skipped or allowed.
  requireConsentConfig();
  const harness = readConsent('harness') as { folderConfigPinned?: boolean } | undefined;
  if (harness?.folderConfigPinned === true) return;
  writeConsent('harness', 'pinning the agents DorkOS already had', {
    ...readConsent('harness'),
    folderConfigPinned: true,
  });
}

/**
 * The launch's half of an agent folder's allow list (DOR-3039): decide, merge
 * an approved list and its self-grant deny rules into the launch, or ask a
 * person and say why a Never ask chat is refusing.
 *
 * @module services/runtimes/claude-code/folder-settings/launch-folder-allows
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import {
  firstTimeToldAbout,
  folderAllowsWaitingStatus,
  mergeFolderAllows,
  resolveFolderAllows,
  selfGrantDenyRules,
  type FolderAllowsTurn,
} from './apply-folder-allows.js';
import {
  askForFolderAllows,
  folderAllowApprovalGateway,
  mayAskAboutFolderAllows,
} from './folder-allow-approval.js';

/** What {@link applyFolderAllowsToLaunch} needs beyond the turn itself. */
export interface FolderAllowsLaunch extends FolderAllowsTurn {
  /** The launch options, mutated when a list applies. */
  sdkOptions: Options;
  /** DorkOS's data folder. */
  dorkHome: string;
  /** The launch's Claude Code account folder. */
  accountRoot: string;
  /** Whether the turn runs at Never ask, which refuses what a waiting list would allow. */
  neverAsk: boolean;
  /** The chat's session object, so the waiting notice is told once per chat. */
  chat: object;
  /** Whether the turn may write its own folder setup (DOR-3483). */
  ownFolderOpen?: boolean;
}

/**
 * Apply the agent's own folder allow list to one launch. Only an approved list
 * rides, only into `settings.permissions.allow` (never `allowedTools`,
 * DOR-519), always beside its self-grant deny rules, only in the exact
 * registered home, and never on a teammate's turn.
 *
 * @param launch - The turn and the launch it rides.
 * @returns The status line to show first, when a Never ask chat should hear
 *   why it is refusing; otherwise `undefined`.
 */
export async function applyFolderAllowsToLaunch(
  launch: FolderAllowsLaunch
): Promise<StreamEvent | undefined> {
  const { sdkOptions, agent } = launch;
  const decision = await resolveFolderAllows(launch);
  if (decision.kind === 'none') return undefined;
  const agentId = agent?.id;
  if (decision.kind === 'applied') {
    const deny = launch.home
      ? selfGrantDenyRules({
          home: launch.home,
          dorkHome: launch.dorkHome,
          accountRoot: launch.accountRoot,
          ownFolderOpen: launch.ownFolderOpen === true,
        })
      : undefined;
    if (!deny) {
      // A home, data folder or account path no rule can name exactly: the
      // list could reach the files that grant more, so none of it rides.
      logger.warn('[FolderAllows] Not applying: a protected path cannot be named in a rule', {
        agentId,
        hash: decision.hash,
      });
      return undefined;
    }
    mergeFolderAllows(sdkOptions, decision.rules, deny);
    logger.info('[FolderAllows] Applying the agent folder allow list', {
      agentId,
      hash: decision.hash,
      rules: decision.rules.length,
      dropped: decision.dropped,
    });
    return undefined;
  }
  logger.info('[FolderAllows] Not applying an unapproved agent folder allow list', {
    agentId,
    hash: decision.hash,
    state: decision.kind,
  });
  if (decision.kind !== 'waiting') return undefined;
  const gateway = folderAllowApprovalGateway();
  if (gateway && mayAskAboutFolderAllows(decision.request)) {
    void askForFolderAllows(gateway, decision.request).catch((err: unknown) => {
      logger.warn('[FolderAllows] Could not ask about an agent folder allow list', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  // Never ask refuses what the list would have allowed; say why (DOR-3042).
  if (launch.neverAsk && firstTimeToldAbout(launch.chat, decision.request)) {
    return {
      type: 'system_status',
      data: { message: folderAllowsWaitingStatus(decision.request.agentName) },
    };
  }
  return undefined;
}

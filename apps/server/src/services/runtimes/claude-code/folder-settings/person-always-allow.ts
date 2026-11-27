/**
 * A person's own Always allow is a person's approval, so the rule it writes keeps working on the
 * next launch without a second card (DOR-5237). Recorded at the moment the answer is given:
 *
 * - **In the agent's own home**: the rule joins the rules behind the agent's yes on its folder
 *   allow list (`folder-allow-consent.ts`). Nothing else in the folder's settings is approved by
 *   it.
 * - **In a workspace**: the local settings' content as it will read with the rule added is
 *   recorded as approved (`repo-config-consent.ts`), only when the content before the answer was
 *   itself approved or needed none: a yes to one rule is never a yes to the rest of a file.
 *
 * Never throws: the answer has already been given, and a record that could not be written only
 * means the next launch asks again.
 *
 * @module services/runtimes/claude-code/folder-settings/person-always-allow
 */
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../lib/logger.js';
import { runtimeAsks } from '../../computer-asks.js';
import { isRepoConfigApproved } from '../repo-settings/repo-config-consent.js';
import {
  readLocalSettings,
  readLocalSettingsWithAllows,
} from '../repo-settings/repo-local-settings.js';
import { judgeAllowRule } from './agent-folder-allows.js';
import { lastApprovedRules } from './folder-allow-consent.js';

/** Where an answer was given. */
export interface PersonAnswerTurn {
  /** The registered agent the turn runs as, if any. */
  agentId: string | undefined;
  /** The registered agent home, if any. */
  home: string | undefined;
  /** The folder the answer is kept in. */
  cwd: string;
  /** DorkOS's data folder. */
  dorkHome: string;
  /** The folder the turn launches in, where the scripts its settings name are read; `cwd` when left out. */
  runsIn?: string;
}

/**
 * The allow rules a batch of permission updates adds, as Claude Code spells them, optionally only
 * those bound for some destinations.
 *
 * @param updates - The permission updates an answer forwards.
 * @param destinations - Only these destinations; every one when left out.
 */
export function allowRulesOf(
  updates: readonly PermissionUpdate[],
  destinations?: readonly PermissionUpdate['destination'][]
): string[] {
  return updates.flatMap((update) =>
    update.type === 'addRules' &&
    update.behavior === 'allow' &&
    (destinations === undefined || destinations.includes(update.destination))
      ? update.rules.map((rule) =>
          rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
        )
      : []
  );
}

/** Add the person's rules to the agent's yes on its folder allow list. */
function rememberAtHome(turn: PersonAnswerTurn, updates: readonly PermissionUpdate[]): void {
  if (!turn.agentId || !turn.home) return;
  const added = allowRulesOf(updates, ['localSettings', 'projectSettings']).flatMap((rule) => {
    const verdict = judgeAllowRule(rule);
    return verdict.ok ? [verdict.rule] : [];
  });
  if (added.length === 0) return;
  const rules = [...(lastApprovedRules(turn.agentId, turn.home) ?? [])];
  for (const rule of added) if (!rules.includes(rule)) rules.push(rule);
  runtimeAsks().record({
    kind: 'folder_allows_approved',
    agentId: turn.agentId,
    home: turn.home,
    rules,
    reason: 'a person chose Always allow in the agent folder',
  });
}

/** Approve the worktree's local file as it will read with the person's rules added. */
function rememberInWorkspace(turn: PersonAnswerTurn, updates: readonly PermissionUpdate[]): void {
  // Anything else written to the local file (a folder, a mode) can't be predicted here.
  const local = updates.filter((update) => update.destination === 'localSettings');
  if (local.some((update) => update.type !== 'addRules' || update.behavior !== 'allow')) return;
  const added = allowRulesOf(local);
  if (added.length === 0) return;
  const runsIn = turn.runsIn ?? turn.cwd;
  const before = readLocalSettings(turn.cwd, turn.dorkHome, runsIn);
  if (before && !(before.approvable && isRepoConfigApproved('local', before.digest))) return;
  const after = readLocalSettingsWithAllows(turn.cwd, turn.dorkHome, added, runsIn);
  if (!after?.approvable) return;
  runtimeAsks().record({ kind: 'repo_config_approved', setting: 'local', digest: after.digest });
}

/**
 * Record a person's Always allow answer as approved, where it lands.
 *
 * @param turn - Who the turn is for and where it stands.
 * @param atHome - Whether the turn stands in the agent's registered home exactly.
 * @param updates - The permission updates the answer forwards to Claude Code.
 */
export function rememberPersonAlwaysAllow(
  turn: PersonAnswerTurn,
  atHome: boolean,
  updates: readonly PermissionUpdate[]
): void {
  try {
    if (atHome) rememberAtHome(turn, updates);
    else rememberInWorkspace(turn, updates);
  } catch (err) {
    logger.warn("[FolderAllows] Couldn't record a person's Always allow; the next launch asks", {
      cwd: turn.cwd,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

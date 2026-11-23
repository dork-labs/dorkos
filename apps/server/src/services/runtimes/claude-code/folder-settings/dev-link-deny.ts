/**
 * Keep a held turn's file tools out of every dev-linked folder (DOR-4896).
 *
 * A dev link runs whatever its working folder holds, approved by path, so an edit there runs
 * with no click (DOR-2696). That is the point for a person working on their own package, and
 * the same shape as an agent's own mini apps folder, which a held turn may not write
 * (`agent-extensions-deny.ts`, Security S1 on #3280). So a turn that read words from someone
 * other than the owner (the outsider mark or the outside-words note, `turnReadOutsideWords`, the
 * predicate the permission gate uses) or runs under a ceiling may not write a dev-linked folder
 * either. Every other turn is unchanged. Claude Code only, like the own mini apps rule.
 *
 * Two layers, as for the own mini apps folder: deny rules added at launch, which hold at every
 * permission level, and a `PreToolUse` hook (`tool-gate/dev-link-hook.ts`) that re-reads the
 * turn and the links at each call, so a mark that lands after launch, or a link made after
 * launch, is covered too, and the agent is told why. Bash is not covered, as for every file
 * rule.
 *
 * Each link is named by its working folder and its slot (the link in the package's normal
 * place), each as written and through its real path, so a write through either reaches the
 * rule. A registry DorkOS cannot read names no folder: then no slot counts as dev-linked and
 * nothing in one runs (`dev-links/registry.ts`).
 *
 * @module services/runtimes/claude-code/folder-settings/dev-link-deny
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { logger } from '../../../../lib/logger.js';
import { readDevLinks } from '../../../marketplace/dev-links/registry.js';
import { turnReadOutsideWords } from '../../../core/turn-power/outsider-turn.js';
import { heldToACeiling } from '../turn-permission.js';
import { addLaunchDenyRules, writeDenyRules } from '../messaging/directory-grants.js';
import { applyLaunchExtensionsDeny } from './agent-extensions-deny.js';

/** The session's ceilings, as `heldToACeiling` reads them. */
type CeilingedSession = Parameters<typeof heldToACeiling>[0];

/** The real path of `target`, or `undefined` when it does not exist. */
async function realpathOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch {
    return undefined;
  }
}

/**
 * Every spelling of every dev-linked folder: each link's working folder and slot, as recorded
 * and through their real paths.
 *
 * @param dorkHome - DorkOS's data directory.
 */
export async function devLinkFolderNames(dorkHome: string): Promise<string[]> {
  const reading = await readDevLinks(dorkHome);
  if (!('links' in reading)) return [];
  const names = new Set<string>();
  for (const link of reading.links) {
    for (const folder of [link.target, link.slot]) {
      names.add(path.resolve(folder));
      const real = await realpathOrUndefined(folder);
      if (real) names.add(real);
    }
  }
  return [...names];
}

/**
 * Whether this turn may not write a dev-linked folder: it runs under a ceiling, or read words
 * from someone other than the owner (its outsider mark, which is every mark that holds, or the
 * outside-words note).
 *
 * @param session - The session's ceilings.
 * @param sessionId - The calling session.
 * @param agentHome - The turn's agent's home, when it runs as one.
 */
export function devLinksHeld(
  session: CeilingedSession,
  sessionId: string,
  agentHome: string | undefined
): boolean {
  return heldToACeiling(session) || turnReadOutsideWords(sessionId, agentHome);
}

/**
 * What an agent is told when a dev-linked folder is read-only this turn: the rule and why, so
 * it never guesses or asks someone to copy the change in by hand. A person may read it in the
 * chat, so each sentence keeps to the app-copy length (`writing-app-copy`).
 *
 * @param folder - The dev-linked folder the write was aimed at, when known.
 */
export function devLinkReadOnlyMessage(folder?: string): string {
  return (
    `${folder ? `${folder} is linked for development` : 'This folder is linked for development'}` +
    ', so it’s read-only in this turn. ' +
    'This turn read words from outside your team, or runs under a limit. ' +
    'Tell your owner the change instead. Don’t ask anyone to copy files in.'
  );
}

/**
 * Add deny rules for every dev-linked folder to a held launch's settings, beside any rules
 * already there. A launch that is not held is left as it is.
 *
 * @param sdkOptions - The launch options, mutated in place.
 * @param turn - The session's ceilings, its id, the turn's agent home and DorkOS's data directory.
 */
export async function applyLaunchDevLinkDeny(
  sdkOptions: Options,
  turn: {
    session: CeilingedSession;
    sessionId: string;
    agentHome: string | undefined;
    dorkHome: string;
  }
): Promise<void> {
  if (!devLinksHeld(turn.session, turn.sessionId, turn.agentHome)) return;
  const rules = new Set<string>();
  for (const folder of await devLinkFolderNames(turn.dorkHome)) {
    const denied = writeDenyRules(folder, 'folder');
    if (!denied) {
      // The hook still refuses writes there; only the launch rule is missing.
      logger.warn(
        `[claude-code] Could not add a launch rule for the dev-linked folder ${folder}: its ` +
          `path has a character file rules cannot match`
      );
      continue;
    }
    for (const rule of denied) rules.add(rule);
  }
  addLaunchDenyRules(sdkOptions, [...rules]);
}

/**
 * Every launch's rules for the folders a held turn may not write: other agents' mini apps and,
 * when held, its own (`applyLaunchExtensionsDeny`), and every dev-linked folder
 * ({@link applyLaunchDevLinkDeny}).
 *
 * @param sdkOptions - The launch options, mutated in place.
 * @param turn - The session's ceilings, its id, the turn's agent home and the agent registry.
 */
export async function applyLaunchHeldFolderDeny(
  sdkOptions: Options,
  turn: Parameters<typeof applyLaunchExtensionsDeny>[1]
): Promise<void> {
  applyLaunchExtensionsDeny(sdkOptions, turn);
  await applyLaunchDevLinkDeny(sdkOptions, { ...turn, dorkHome: resolveDorkHome() });
}

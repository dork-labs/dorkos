/**
 * Ask a person before a repo's changed hooks, a worktree's local settings or
 * a changed `.mcp.json` run (DOR-3298), through the asks port (spec
 * `computer-side-starts-alone` §5.7).
 *
 * This side reads the worktree and writes what the card shows: the diff
 * against the default branch (the local settings' content, which has no
 * default branch). The space side builds the card around it
 * (`core/approvals/computer-asks/repo-config-card-ask.ts`), waits, and records
 * the answer against that content's digest before this hears it.
 *
 * ## While the card is open
 *
 * The wait has this side re-read the worktree on every poll. If the content
 * changed, the card is withdrawn with "The hook changed again." and a new card
 * asks about the new content. If it went back to the default branch's (byte
 * for byte for a script), the card is withdrawn and the Activity feed says the
 * setting runs again. A withdrawn card records nothing.
 *
 * Fire-and-forget from the launch: a turn never waits on the card.
 *
 * @module services/runtimes/claude-code/repo-settings/repo-config-approval
 */
import type { ComputerAsks, RepoConfigRequest } from '@dorkos/shared/computer-asks';
import { worktreeName } from '@dorkos/shared/consent-entries';
import { noteRunning } from './repo-config-activity.js';
import {
  isRepoConfigApproved,
  isRepoConfigRefused,
  repoConfigEntry,
  type RepoConfigKind,
} from './repo-config-consent.js';

export type { RepoConfigRequest };
export { worktreeName };

/** Cards on screen now, by entry, so a second turn does not raise a second card. */
const askingNow = new Set<string>();

/** Seams the open-card memory uses, so one test cannot answer for the next. */
export const _internal = {
  forgetOpenCards: (): void => {
    askingNow.clear();
  },
};

/**
 * Whether a card for this content would be new information: approvable, not
 * already decided, and not already on screen.
 *
 * @param kind - Which setting.
 * @param digest - The content digest.
 */
export function mayAskAboutRepoConfig(kind: RepoConfigKind, digest: string): boolean {
  return (
    !askingNow.has(repoConfigEntry(kind, digest)) &&
    !isRepoConfigApproved(kind, digest) &&
    !isRepoConfigRefused(kind, digest)
  );
}

/** What the worktree holds now, re-read while the card is open. */
export type RepoConfigReread = () => Promise<'clean' | { digest: string } | 'unknown'>;

/**
 * Ask a person whether this content may run, and wait for the answer. Fails
 * closed on everything but an explicit yes, including no space side to ask;
 * the space side records the answer before it gives it.
 *
 * @param asks - The asks port.
 * @param request - The setting and what changed.
 * @param reread - Reads the worktree again, for the stale and undone states.
 * @param onChanged - Called when the content changed under the card, to ask again.
 * @returns True only when a person granted it.
 */
export async function askForRepoConfig(
  asks: ComputerAsks,
  request: RepoConfigRequest,
  reread: RepoConfigReread,
  onChanged: () => void
): Promise<boolean> {
  const entry = repoConfigEntry(request.kind, request.digest);
  askingNow.add(entry);
  let outcome: string;
  try {
    const answer = await asks.raise({ kind: 'repo_config', request }, async () => {
      const now = await reread();
      if (now === 'clean') return 'undone';
      if (now !== 'unknown' && now.digest !== request.digest) return 'changed';
      return 'unchanged';
    });
    outcome = answer.outcome;
  } finally {
    askingNow.delete(entry);
  }
  if (outcome === 'undone') {
    noteRunning(request.kind, request.cwd, worktreeName(request.cwd));
  } else if (outcome === 'changed') {
    onChanged();
  }
  return outcome === 'granted';
}

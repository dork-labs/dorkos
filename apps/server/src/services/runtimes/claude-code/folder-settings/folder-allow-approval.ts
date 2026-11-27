/**
 * Ask a person before an agent's own folder allow list applies (DOR-3039),
 * through the asks port (spec `computer-side-starts-alone` §5.7).
 *
 * The space side builds the card (`core/approvals/computer-asks/folder-allows-card-ask.ts`;
 * its words are `@dorkos/shared/folder-allows-card`), waits, and records the
 * answer against a digest of exactly the rules it showed, before this hears
 * it. This side only knows which cards it has out, so a second turn does not
 * raise a second one.
 *
 * Fire-and-forget from the launch: a turn never waits on the card. Until a
 * person says yes the list does not apply, and the turn runs as it always did.
 *
 * @module services/runtimes/claude-code/folder-settings/folder-allow-approval
 */
import type { ComputerAsks } from '@dorkos/shared/computer-asks';
import {
  folderAllowEntry,
  isFolderAllowListApproved,
  isFolderAllowListRefused,
  type FolderAllowRequest,
} from './folder-allow-consent.js';

/** Cards on screen now, so a second turn does not raise a second card. */
const askingNow = new Set<string>();

/** Seams the open-card memory uses, so one test cannot answer for the next. */
export const _internal = {
  forgetOpenCards: (): void => {
    askingNow.clear();
  },
};

/**
 * Whether a card for this list would be new information: not already decided,
 * and not already on screen.
 *
 * @param request - The agent and its rules.
 */
export function mayAskAboutFolderAllows(request: FolderAllowRequest): boolean {
  return (
    request.rules.length > 0 &&
    !askingNow.has(folderAllowEntry(request)) &&
    !isFolderAllowListApproved(request) &&
    !isFolderAllowListRefused(request)
  );
}

/**
 * Ask a person whether this agent's list may apply, and wait for the answer.
 * Fails closed on everything but an explicit yes, including no space side to
 * ask; the space side records the answer before it gives it.
 *
 * @param asks - The asks port.
 * @param request - The agent and its rules.
 * @returns True only when a person granted it.
 */
export async function askForFolderAllows(
  asks: ComputerAsks,
  request: FolderAllowRequest
): Promise<boolean> {
  const entry = folderAllowEntry(request);
  askingNow.add(entry);
  try {
    const answer = await asks.raise({ kind: 'folder_allows', request });
    return answer.outcome === 'granted';
  } finally {
    askingNow.delete(entry);
  }
}

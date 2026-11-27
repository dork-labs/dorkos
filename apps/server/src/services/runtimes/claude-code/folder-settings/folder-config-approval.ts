/**
 * Ask a person before an agent's changed folder settings run (DOR-3068),
 * through the asks port (spec `computer-side-starts-alone` §5.7).
 *
 * The space side builds the card (`core/approvals/computer-asks/folder-config-card-ask.ts`):
 * it names the agent and which of its settings changed; this side reads the
 * folder and writes the detail, what those settings would run. The space side
 * waits, has this side read the folder again between presentations (a folder
 * that changed again takes the card down), and records the answer against the
 * exact digests the card was raised for, before this hears it.
 *
 * Fire-and-forget from the launch: a turn never waits on the card. Until a
 * person says yes, the turn runs without the changed parts.
 *
 * @module services/runtimes/claude-code/folder-settings/folder-config-approval
 */
import type { ComputerAsks } from '@dorkos/shared/computer-asks';
import {
  folderConfigEntry,
  isFolderConfigApproved,
  isFolderConfigRefused,
  type FolderConfigRequest,
} from './folder-config-consent.js';
import {
  canonicalJson,
  readFolderConfigParts,
  type FolderConfigPart,
} from './folder-config-pin.js';

/** The words a part goes by in a card's detail. */
const PART_HEADINGS: Record<FolderConfigPart, string> = {
  hooks: 'Hooks, code settings, scripts and skill, command and subagent settings',
  mcpJson: '.mcp.json',
  manifest: 'Agent file: runtime, MCP servers and account',
};

/**
 * What the changed parts would run, as the card shows it: each part's value,
 * read and built on the server, fenced as data.
 *
 * @param values - Each part's value as read.
 * @param parts - The parts the card asks about.
 */
export function folderConfigDetail(
  values: Record<FolderConfigPart, unknown>,
  parts: readonly FolderConfigPart[]
): string {
  return parts
    .map((part) => `${PART_HEADINGS[part]}:\n${JSON.stringify(values[part] ?? null, null, 2)}`)
    .join('\n\n');
}

/** Whether the folder no longer holds the state the card asks about. */
function isStale(request: FolderConfigRequest): boolean {
  try {
    const now = readFolderConfigParts(request.home).digests;
    return canonicalJson(now) !== canonicalJson(request.digests);
  } catch {
    return true;
  }
}

/** Cards on screen now, so a second turn does not raise a second card. */
const askingNow = new Set<string>();

/** Seams the open-card memory uses, so one test cannot answer for the next. */
export const _internal = {
  forgetOpenCards: (): void => {
    askingNow.clear();
  },
};

/**
 * Whether a card for this state would be new information: something changed,
 * not already decided, and not already on screen.
 *
 * @param request - The agent and its changed parts.
 */
export function mayAskAboutFolderConfig(request: FolderConfigRequest): boolean {
  return (
    request.changed.length > 0 &&
    !askingNow.has(folderConfigEntry(request)) &&
    !isFolderConfigApproved(request) &&
    !isFolderConfigRefused(request)
  );
}

/**
 * Ask a person whether this state of the agent's settings may run, and wait
 * for the answer. Fails closed on everything but an explicit yes, including no
 * space side to ask; the space side records the answer before it gives it.
 *
 * @param asks - The asks port.
 * @param request - The agent, its home, the digests and what changed.
 * @returns True only when a person granted it.
 */
export async function askForFolderConfig(
  asks: ComputerAsks,
  request: FolderConfigRequest
): Promise<boolean> {
  const entry = folderConfigEntry(request);
  askingNow.add(entry);
  try {
    const answer = await asks.raise({ kind: 'folder_config', request }, () =>
      isStale(request) ? 'changed' : 'unchanged'
    );
    return answer.outcome === 'granted';
  } finally {
    askingNow.delete(entry);
  }
}

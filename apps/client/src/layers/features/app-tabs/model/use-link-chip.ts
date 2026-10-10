/**
 * A link chip's page, resolved from live data (DOR-2824).
 *
 * The name and status come from {@link useTabIdentity}, the same hook every
 * tab reads, so a chip and the tab for the same chat cannot disagree. This
 * hook adds the one thing a tab never needs to know: whether the page exists.
 *
 * @module features/app-tabs/model/use-link-chip
 */
import { useMemo } from 'react';
import { useSessionRow } from '@/layers/entities/session';
import { useRoom } from '@/layers/entities/room';
import { linkChipKind, type LinkChipKind, type LinkChipState } from '../lib/link-chip';
import type { TabIdentity } from '../lib/tab-identity';
import { parseTabHref } from '../lib/tab-target';
import { useTabIdentity } from './use-tab-identity';

/** A read the server refused because the page is not there for you. */
function isGone(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 403;
}

/** Fold a read's outcome into a chip state. */
function chipState(read: { data?: unknown; error: unknown }): LinkChipState {
  if (isGone(read.error)) return 'missing';
  return read.data !== undefined ? 'ready' : 'resolving';
}

/**
 * Whether the chat or room behind a link exists. Each read shares its cache
 * entry with the tab identity's own, so a chip costs no extra request.
 */
function useLinkChipState(
  kind: LinkChipKind | null,
  sessionId: string | null,
  roomId: string | null
): LinkChipState {
  const chat = useSessionRow(kind === 'chat' ? sessionId : null, {
    nameOnly: true,
    select: () => true,
  });
  const room = useRoom(kind === 'room' ? roomId : null);
  if (kind === 'chat') return chipState(chat);
  if (kind === 'room') return chipState(room);
  return 'resolving';
}

/** What a link chip knows about its page. */
export interface LinkChipData {
  /** Which kind of page it is, or `null` for an address no chip names. */
  kind: LinkChipKind | null;
  /** The page's identity, the tab's own. */
  identity: TabIdentity;
  /** Whether the page has resolved, or is gone. */
  state: LinkChipState;
}

/**
 * Resolve a link's address to what its chip shows.
 *
 * @param address - The router-relative address the link points at.
 */
export function useLinkChip(address: string): LinkChipData {
  const target = useMemo(() => parseTabHref(address), [address]);
  const kind = linkChipKind(target);
  const identity = useTabIdentity(address);
  const state = useLinkChipState(kind, target.sessionId, target.roomId);
  return { kind, identity, state };
}

/**
 * A link chip's page, resolved from live data (DOR-2824).
 *
 * The name and status come from {@link useTabIdentity}, the same hook every
 * tab reads, so a chip and the tab for the same chat cannot disagree. This
 * hook adds the one thing a tab never needs to know: whether the page exists.
 * A `/r/dork:chat:` link whose chat is not found under its id asks the link
 * resolver once, so a link written before the chat's re-key names the chat it
 * moved to (DOR-5202).
 *
 * @module features/app-tabs/model/use-link-chip
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { dorkUriFromLink } from '@dorkos/shared/dork-ref';
import { sessionHref } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { useSessionRouteContext, useSessionRow } from '@/layers/entities/session';
import { useRoom } from '@/layers/entities/room';
import {
  linkChipAddress,
  linkChipKind,
  type LinkChipKind,
  type LinkChipState,
} from '../lib/link-chip';
import type { TabIdentity } from '../lib/tab-identity';
import { parseTabHref } from '../lib/tab-target';
import { useTabIdentity } from './use-tab-identity';

/**
 * A read the server refused because the page is not there for you: gone (404),
 * not yours to see (403), or an id that could never name one (400, a made-up
 * chat id).
 */
function isGone(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 404 || status === 403 || status === 400;
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
  // A chat still a draft in this window has no row yet: asking would earn a
  // 404 and call a live chat "not found". The tab's own read skips it too.
  const draft = useSessionRouteContext(kind === 'chat' ? sessionId : null)?.draft ?? false;
  const chat = useSessionRow(kind === 'chat' ? sessionId : null, {
    enabled: !draft,
    nameOnly: true,
    select: () => true,
  });
  const room = useRoom(kind === 'room' ? roomId : null);
  if (kind === 'chat') return draft ? 'ready' : chipState(chat);
  if (kind === 'room') return chipState(room);
  return 'resolving';
}

/** Where a `/r/` chat link's resolver is in finding the chat it moved to. */
interface RekeyedChat {
  /** The resolver is being asked. */
  pending: boolean;
  /** The id the chat answers under now, when it differs from the link's. */
  sessionId: string | null;
}

/**
 * The id a `/r/dork:chat:` link's chat moved to, asked of the link resolver
 * only once the chat is not found under the link's own id. A `/session` link
 * never asks: it has no `dork:` reference to resolve. The answer is cached for
 * good, since a re-key never moves back.
 *
 * @param address - The link as written.
 * @param sessionId - The chat id the link holds.
 * @param ask - Whether the chat was not found under that id.
 */
function useRekeyedChat(address: string, sessionId: string | null, ask: boolean): RekeyedChat {
  const transport = useTransport();
  const uri = useMemo(() => dorkUriFromLink(address), [address]);
  const resolved = useQuery({
    queryKey: ['dork-link-target', uri],
    queryFn: () => transport.resolveDorkLink(uri!),
    enabled: ask && uri !== null,
    retry: false,
    staleTime: Infinity,
  });
  const link = resolved.data;
  const moved = link?.kind === 'chat' && link.sessionId !== sessionId ? link.sessionId : null;
  return { pending: resolved.isLoading, sessionId: moved };
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
  const pageAddress = useMemo(() => linkChipAddress(address), [address]);
  const target = useMemo(() => parseTabHref(pageAddress), [pageAddress]);
  const kind = linkChipKind(target);
  const asLinked = useLinkChipState(kind, target.sessionId, target.roomId);
  const rekeyed = useRekeyedChat(
    address,
    target.sessionId,
    kind === 'chat' && asLinked === 'missing'
  );
  const shownAddress = useMemo(
    () => (rekeyed.sessionId ? sessionHref({ session: rekeyed.sessionId }) : pageAddress),
    [rekeyed.sessionId, pageAddress]
  );
  const identity = useTabIdentity(shownAddress);
  const asMoved = useLinkChipState(rekeyed.sessionId ? 'chat' : null, rekeyed.sessionId, null);
  // While the resolver is asked, the chip keeps resolving rather than flash "not found".
  const state = rekeyed.sessionId ? asMoved : rekeyed.pending ? 'resolving' : asLinked;
  return { kind, identity, state };
}

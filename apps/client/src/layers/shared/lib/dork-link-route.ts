/**
 * The `/r/<dork-uri>` link (DOR-5046, ADR 261122-124821 §5.4): one address for
 * a chat, a room, a message or an agent, the same on every DorkOS origin and,
 * as `dorkos://r/<dork-uri>`, on the desktop.
 *
 * The route asks the server what the reference opens for this person
 * (`link.resolve`, `GET /api/links/target`), then replaces itself with the
 * screen that shows it, built with the app's own route factories. Replace,
 * not push: Back leaves the thing the link opened rather than landing on a
 * link that opens it again.
 *
 * A reference that opens nothing, because it is malformed, unknown, private
 * or a kind no screen shows, leaves the route where it is, and the route shows
 * the app's ordinary not-found page. The server gives the same 404 for missing
 * and private, so the page is the same too.
 *
 * @module shared/lib/dork-link-route
 */
import { redirect, type ParsedLocation } from '@tanstack/react-router';
import type { ResolvedDorkLink } from '@dorkos/shared/dork-link-schemas';
import { dorkUriFromLink } from '@dorkos/shared/dork-ref';
import type { Transport } from '@dorkos/shared/transport';
import { appRoutes } from './route-factory';
import { toSession } from './session-link';

/** Whether an error is the server's "nothing here" answer. */
function isNotFound(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'status' in error && error.status === 404;
}

/**
 * Throw the redirect to the screen a resolved link opens.
 *
 * @param link - What the server said the reference opens.
 * @throws Always: the redirect, replacing the link in history.
 */
function openResolved(link: ResolvedDorkLink): never {
  switch (link.kind) {
    case 'chat':
      throw redirect({ ...toSession({ session: link.sessionId }), replace: true });
    case 'room':
      throw redirect({ ...appRoutes.channels(), search: { id: link.roomId }, replace: true });
    case 'entry':
      throw redirect({
        ...appRoutes.channels(),
        search: {
          id: link.roomId,
          entry: link.seq,
          ...(link.threadRootEntryId ? { thread: link.threadRootEntryId } : {}),
        },
        replace: true,
      });
    case 'agent':
      throw redirect({ ...appRoutes.team(), search: { profile: link.agentId }, replace: true });
  }
}

/** What the `/r/$` route's `beforeLoad` receives that this reads. */
export interface DorkLinkBeforeLoadArgs {
  /** The router context, for the transport. */
  context: { transport: Pick<Transport, 'resolveDorkLink'> };
  /** Where the router is going: the link itself. */
  location: Pick<ParsedLocation, 'href'>;
  /** Whether this is a hover preload rather than a real navigation. */
  preload: boolean;
}

/**
 * Open what a `/r/` link names, or leave the route to show not-found.
 *
 * Reads the link from `location.href`, the path as it was sent, rather than
 * the route's decoded splat: the router has already decoded that once, and a
 * second decode would let a double-encoded link through. A preload resolves
 * nothing, so hovering a link never asks the server about it.
 *
 * @param args - The route's `beforeLoad` arguments.
 * @returns Nothing when the link opens nothing: the route then shows not-found.
 * @throws The redirect to what the link opens, or any error other than the
 *   server's 404, for the route's error page.
 */
export async function dorkLinkBeforeLoad({
  context,
  location,
  preload,
}: DorkLinkBeforeLoadArgs): Promise<void> {
  if (preload) return;
  const uri = dorkUriFromLink(location.href);
  if (!uri) return;
  let link: ResolvedDorkLink;
  try {
    link = await context.transport.resolveDorkLink(uri);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
  openResolved(link);
}

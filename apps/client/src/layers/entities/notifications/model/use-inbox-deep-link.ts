/**
 * `?inbox=` — the address of the Inbox.
 *
 * The Inbox is a popover, not a page, so before this nothing outside the app's
 * own buttons could send a person to it: a link from an extension's page, a
 * notification or a bookmark could only name a route, and the open asks are
 * on no route (DOR-2577). This makes the popover reachable from a plain href.
 *
 * - `?inbox=open` opens the Inbox.
 * - `?inbox=<id>` opens it on one waiting item, an extension decision's id, and
 *   focuses that row. An id that names nothing waiting (already answered, or
 *   never real) opens the Inbox as usual, so the link is never a dead click.
 *
 * It works on every route because the param rides on whatever page the person
 * is on: `?inbox=…` from an extension page keeps them on that page, with the
 * Inbox over it (a bottom sheet on a phone).
 *
 * **One-shot.** The param is read once and removed from the address in place
 * (a replace, so Back does not reopen it). The Inbox has no open state in the
 * URL anywhere else, and a param left behind would reopen it on every reload.
 *
 * @module entities/notifications/model/use-inbox-deep-link
 */
import { useEffect } from 'react';
import { useInPlaceNavigate, useSafeSearch } from '@/layers/shared/model';
import { requestInbox, settleInboxRequest } from './inbox-request-store';

/** The search param that opens the Inbox. */
const INBOX_SEARCH_PARAM = 'inbox';

/** The `?inbox=` value that opens the whole Inbox with nothing singled out. */
const INBOX_OPEN = 'open';

/** Options for {@link useInboxDeepLink}. */
export interface InboxDeepLinkOptions {
  /**
   * True while something has taken the whole window (first-run onboarding).
   * A link read meanwhile is still taken out of the address, but no bell opens
   * for it afterwards: by then the person has moved on.
   */
  blocked?: boolean;
}

/**
 * Answer `?inbox=` on whatever route the shell is showing. Mount once, at the
 * shell, so a link works from every page.
 *
 * @param options - Whether the window is taken by something else right now.
 */
export function useInboxDeepLink({ blocked = false }: InboxDeepLinkOptions = {}): void {
  const raw = useSafeSearch()[INBOX_SEARCH_PARAM];
  const inPlaceNavigate = useInPlaceNavigate();
  const present = raw !== undefined;
  // `String` because the app's search parser turns a number-looking value
  // into a number; an id is still an id. A bare `?inbox` reads as empty.
  const target = raw === null || raw === undefined ? '' : String(raw).trim();

  useEffect(() => {
    if (!present || !inPlaceNavigate) return;
    // An empty `?inbox=` names nothing, and a link read while the window is
    // taken asks for nothing, but both are still taken out of the address.
    if (target && !blocked) {
      requestInbox(undefined, target === INBOX_OPEN ? undefined : { focus: target });
    }
    inPlaceNavigate({
      search: (prev) => ({ ...prev, [INBOX_SEARCH_PARAM]: undefined }),
      replace: true,
    });
  }, [present, target, blocked, inPlaceNavigate]);

  // A request made before the window was taken (one still waiting for a
  // bell) is dropped once it is.
  useEffect(() => {
    if (blocked) settleInboxRequest();
  }, [blocked]);
}

import { useEffect, useRef } from 'react';
import { hashToEmoji } from '@/layers/shared/lib';

interface UseDocumentTitleOptions {
  cwd: string | null;
  activeForm: string | null;
  isStreaming: boolean;
  isWaitingForUser: boolean;
  /** Agent name override — when provided, replaces directory name in the title */
  agentName?: string;
  /** Agent emoji override — when provided, replaces CWD-hashed emoji */
  agentEmoji?: string;
  /** Tasks badge count — shown as (N) prefix when tab is hidden */
  tasksBadgeCount?: number;
  /**
   * The room on screen, already written the way it is spoken (`#general`). Takes
   * the title over the session, because it is what the tab is actually showing.
   */
  roomTitle?: string | null;
  /**
   * How many ROOMS hold unread entries — not how many messages. "Three
   * conversations want you" is the useful number, and counting messages would
   * make one chatty agent look like an emergency.
   */
  unreadRoomCount?: number;
}

const MAX_ACTIVE_FORM_LENGTH = 40;

/** What every title ends with, so a pinned tab is still recognisably ours. */
const SUFFIX = ' — DorkOS';

interface BuildTitleOpts {
  cwd: string | null;
  roomTitle: string | null;
  activeForm: string | null;
  prefix: string;
  agentName?: string;
  agentEmoji?: string;
  badgeCount: number;
  isTabHidden?: boolean;
}

/**
 * The whole title, for whichever surface currently owns the tab.
 *
 * Three shapes, in priority order:
 *
 * 1. **A room** — `(2) #general — DorkOS`. Status prefixes stay behind with the
 *    session: `🔔 #general` would read as the channel wanting you, when what is
 *    waiting is a session you are not looking at. The badge still carries that.
 * 2. **A session** — `(2) 🔔 🐧 apps — Running tests — DorkOS`, unchanged.
 * 3. **Neither** — the bare product name, still badged, because a backgrounded
 *    tab parked on `/agents` should say that a room wants you.
 */
function buildTitle({
  cwd,
  roomTitle,
  activeForm,
  prefix,
  agentName,
  agentEmoji,
  badgeCount,
  isTabHidden,
}: BuildTitleOpts): string {
  const badgePrefix = isTabHidden && badgeCount > 0 ? `(${badgeCount}) ` : '';
  if (roomTitle) return `${badgePrefix}${roomTitle}${SUFFIX}`;
  if (!cwd) return `${badgePrefix}DorkOS`;

  const emoji = agentEmoji ?? hashToEmoji(cwd);
  const label = agentName ?? cwd.split('/').filter(Boolean).pop() ?? cwd;
  let title = `${badgePrefix}${prefix}${emoji} ${label}`;
  if (activeForm) {
    const truncated =
      activeForm.length > MAX_ACTIVE_FORM_LENGTH
        ? activeForm.slice(0, MAX_ACTIVE_FORM_LENGTH) + '…'
        : activeForm;
    title += ` — ${truncated}`;
  }
  title += SUFFIX;
  return title;
}

/**
 * Manage the browser document title with status prefixes, badge counts, and
 * visibility tracking.
 *
 * The tab names what you are looking at — the room you are reading, otherwise
 * the session — and, while it is backgrounded, how many things are waiting.
 * Tasks and unread rooms share that one `(N)`: they are both "something wants
 * you", and two separate counters in a browser tab is noise, not information.
 */
export function useDocumentTitle({
  cwd,
  activeForm,
  isStreaming,
  isWaitingForUser,
  agentName,
  agentEmoji,
  tasksBadgeCount,
  roomTitle,
  unreadRoomCount,
}: UseDocumentTitleOptions) {
  const isTabHiddenRef = useRef(document.hidden);
  const hasUnseenResponseRef = useRef(false);
  const wasStreamingRef = useRef(isStreaming);

  const badgeCount = (tasksBadgeCount ?? 0) + (unreadRoomCount ?? 0);

  // Single ref to keep visibility handler in sync with latest prop values
  const optionsRef = useRef({
    cwd,
    activeForm,
    isWaitingForUser,
    agentName,
    agentEmoji,
    badgeCount,
    roomTitle,
  });
  useEffect(() => {
    optionsRef.current = {
      cwd,
      activeForm,
      isWaitingForUser,
      agentName,
      agentEmoji,
      badgeCount,
      roomTitle,
    };
  }, [cwd, activeForm, isWaitingForUser, agentName, agentEmoji, badgeCount, roomTitle]);

  // Track tab visibility and rebuild title on return (clears 🏁 and badge)
  useEffect(() => {
    const handler = () => {
      isTabHiddenRef.current = document.hidden;
      if (!document.hidden) {
        const opts = optionsRef.current;
        // Rebuild when returning from hidden: clears (N) badge and/or 🏁 prefix
        const hadUnseenResponse = hasUnseenResponseRef.current;
        const hadBadge = opts.badgeCount > 0;
        if (hadUnseenResponse || hadBadge) {
          hasUnseenResponseRef.current = false;
          const prefix = opts.isWaitingForUser ? '🔔 ' : '';
          document.title = buildTitle({
            cwd: opts.cwd,
            roomTitle: opts.roomTitle ?? null,
            activeForm: opts.activeForm,
            prefix,
            agentName: opts.agentName,
            agentEmoji: opts.agentEmoji,
            badgeCount: opts.badgeCount,
            isTabHidden: false,
          });
        }
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // Detect streaming→idle transition while tab is hidden
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming && isTabHiddenRef.current) {
      hasUnseenResponseRef.current = true;
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Build title (runs on all relevant state changes)
  useEffect(() => {
    // Compute prefix (priority: 🔔 > 🏁 > none). Only the session title wears
    // one; `buildTitle` drops it for the other two shapes.
    let prefix = '';
    if (isWaitingForUser) {
      prefix = '🔔 ';
    } else if (hasUnseenResponseRef.current) {
      prefix = '🏁 ';
    }

    document.title = buildTitle({
      cwd,
      roomTitle: roomTitle ?? null,
      activeForm,
      prefix,
      agentName,
      agentEmoji,
      badgeCount,
      isTabHidden: isTabHiddenRef.current,
    });
  }, [
    cwd,
    roomTitle,
    activeForm,
    isStreaming,
    isWaitingForUser,
    agentName,
    agentEmoji,
    badgeCount,
  ]);
}

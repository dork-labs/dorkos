import { useEffect, useRef } from 'react';
import { hashToEmoji } from '@/layers/shared/lib/favicon-utils';

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
 * 1. **A room** — `(2) 🔔 #general — DorkOS`.
 * 2. **A session** — `(2) 🔔 🐧 apps — Running tests — DorkOS`, unchanged.
 * 3. **Neither** — the bare product name, still badged, because a backgrounded
 *    tab parked on `/agents` should say that a room wants you.
 *
 * The status prefix rides shapes 1 and 2 alike. `🔔` means "an agent is blocked
 * on you", which is the highest-priority signal in the product and does not stop
 * being true because you navigated to a channel — and nothing else carries it,
 * since `useFavicon` takes only `{ cwd, isStreaming, color }`. Dropping it on
 * `/channels` meant an agent stuck on a permission prompt showed up nowhere at
 * all while you were reading a room. It reads as a flag, not as an adjective on
 * the name: the badge already sits outside the prefix in shape 2, so `(2) 🔔 `
 * has always been the tab's status column rather than part of the label.
 *
 * Shape 3 stays prefix-free: with no `cwd` there is no session to be waiting.
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
  if (roomTitle) return `${badgePrefix}${prefix}${roomTitle}${SUFFIX}`;
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
 *
 * One knock-on worth stating, because it is the only behaviour change outside
 * the cockpit: with no `cwd` the title used to be an unconditional `'DorkOS'`,
 * and is now `'(N) DorkOS'` when something is waiting and the surface is
 * hidden. That path is the Obsidian embed (`App.tsx`, which always passes
 * `cwd: null`), so a minimised Obsidian window now counts pending tasks in its
 * title where it previously said nothing. That is the badge doing its job on a
 * surface that never had one, not a regression — but it was not asked for, so
 * it is written down rather than left to be discovered.
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
    // Compute prefix (priority: 🔔 > 🏁 > none). A room title wears it too;
    // only the bare-product shape, which has no session behind it, does not.
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

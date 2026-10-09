/**
 * The browser and desktop window title, named from the page on screen.
 *
 * @module app/use-window-title
 */
import { useRouterState } from '@tanstack/react-router';
import { useDocumentTitle } from '@/layers/shared/model';
import { useTabIdentity, useTabSignalsSync, windowTitle } from '@/layers/features/app-tabs';

/** What the title needs beyond the page itself. */
export interface WindowTitleInputs {
  /** Whether a reply is streaming, so one that finishes while hidden is flagged 🏁. */
  isStreaming: boolean;
  /** Whether the open chat is blocked on you, flagged 🔔. */
  isWaitingForUser: boolean;
  /** Unread rooms plus waiting schedules, shown as `(N)` while hidden. */
  badgeCount: number;
}

/**
 * Keep the window title naming the page on screen exactly as its tab does.
 *
 * One identity, read by the tab strip, the History menu and this (DOR-2820).
 * Naming the title from the last-selected agent put that agent on every
 * non-chat page. Also keeps the shared tab facts current, since the shell is
 * the one place mounted for the whole life of the window.
 *
 * @param inputs - What the title needs beyond the page itself.
 */
export function useWindowTitle({ isStreaming, isWaitingForUser, badgeCount }: WindowTitleInputs) {
  useTabSignalsSync();
  const href = useRouterState({ select: (state) => state.location.href });
  const page = useTabIdentity(href);
  useDocumentTitle(
    (window) => windowTitle(page, { ...window, badgeCount, needsYou: isWaitingForUser }),
    isStreaming
  );
}

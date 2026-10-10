/**
 * The browser and desktop window title, named from the page on screen.
 *
 * @module app/WindowTitle
 */
import { useRouterState } from '@tanstack/react-router';
import { useAppStore, useDocumentTitle } from '@/layers/shared/model';
import {
  useTabIdentity,
  useTabSignalsStore,
  useTabSignalsSync,
  windowTitle,
} from '@/layers/features/app-tabs';

interface WindowTitleProps {
  /** Rooms with unread entries, the shell's own count; part of `(N)` while hidden. */
  unreadRoomCount: number;
}

/**
 * Keep the window title naming the page on screen exactly as its tab does.
 *
 * One identity, read by the tab strip, the History menu and this (DOR-2820).
 * Naming the title from the last-selected agent put that agent on every
 * non-chat page. A leaf that renders nothing, so the live status it reads (a
 * tool step, the window hiding) re-renders this and not the whole shell. It
 * also keeps the shared tab facts current, since it is mounted for the whole
 * life of the window.
 */
export function WindowTitle({ unreadRoomCount }: WindowTitleProps) {
  useTabSignalsSync();
  const isStreaming = useAppStore((s) => s.isStreaming);
  const isWaitingForUser = useAppStore((s) => s.isWaitingForUser);
  const tasksBadgeCount = useAppStore((s) => s.tasksBadgeCount);
  const needsYouCount = useTabSignalsStore((s) => s.needsYouCount);
  const href = useRouterState({ select: (state) => state.location.href });
  const page = useTabIdentity(href);
  useDocumentTitle(
    (window) =>
      windowTitle(page, {
        ...window,
        badgeCount: tasksBadgeCount + unreadRoomCount,
        // 🔔 on every page while anything is waiting on you, not only the chat.
        needsYou: isWaitingForUser || needsYouCount > 0,
      }),
    isStreaming
  );
  return null;
}

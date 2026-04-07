import { useEffect, useRef } from 'react';
import { useAppStore, useTasksDeepLink } from '@/layers/shared/model';
import { useTasksEnabled, useCompletedTaskRunBadge } from '@/layers/entities/tasks';
import { toast } from 'sonner';

/**
 * Manage Tasks completion badge and toast notifications as side effects.
 *
 * - Clears the badge when the Tasks panel opens.
 * - Toasts on new run completions (if notifications are enabled).
 * - Flows the unviewed count into Zustand so `useDocumentTitle` can render it.
 */
export function useTaskNotifications(): void {
  const tasksEnabled = useTasksEnabled();
  const { unviewedCount, clearBadge } = useCompletedTaskRunBadge(tasksEnabled);
  const enableTasksNotifications = useAppStore((s) => s.enableTasksNotifications);
  const tasksDeepLink = useTasksDeepLink();
  const setTasksBadgeCount = useAppStore((s) => s.setTasksBadgeCount);
  // Read BOTH signals so agent-dispatched opens (which flip the store flag
  // via `executeUiCommand({ panel: 'tasks' })` without touching the URL)
  // still clear the badge. See spec §6.10 / §13 Q4 — store-based opens
  // remain a valid dual-signal path.
  const tasksStoreOpen = useAppStore((s) => s.tasksOpen);
  const tasksIsOpen = tasksStoreOpen || tasksDeepLink.isOpen;
  const openTasks = tasksDeepLink.open;

  // Clear completion badge when Tasks panel opens (via either signal)
  useEffect(() => {
    if (tasksIsOpen) clearBadge();
  }, [tasksIsOpen, clearBadge]);

  // Toast on new run completions
  const prevUnviewedRef = useRef(0);
  useEffect(() => {
    if (!enableTasksNotifications) return;
    if (unviewedCount > prevUnviewedRef.current) {
      toast('Tasks run completed', {
        description: 'A scheduled run has finished.',
        duration: 6000,
        action: {
          label: 'View history',
          onClick: () => openTasks(),
        },
      });
    }
    prevUnviewedRef.current = unviewedCount;
  }, [unviewedCount, enableTasksNotifications, openTasks]);

  // Flow badge count to Zustand so useDocumentTitle can render it
  useEffect(() => {
    setTasksBadgeCount(unviewedCount);
    return () => setTasksBadgeCount(0);
  }, [unviewedCount, setTasksBadgeCount]);
}

import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTransport, useAppStore, useTabVisibility } from '@/layers/shared/model';
import { QUERY_TIMING } from '@/layers/shared/lib';
import {
  isSessionScopeReady,
  useSessionScopedCwd,
  useSessionStreamLifecycle,
} from '@/layers/entities/session';
import type { TaskItem, TaskUpdateEvent, SessionTaskStatus } from '@dorkos/shared/types';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import { applyTaskEvent, createTaskFoldState, type TaskFoldState } from '@dorkos/shared/task-fold';

/** Check if a task is blocked by any incomplete dependency. */
function isTaskBlocked(task: TaskItem, taskMap: Map<string, TaskItem>): boolean {
  if (!task.blockedBy?.length) return false;
  return task.blockedBy.some((depId) => {
    const dep = taskMap.get(depId);
    return dep && dep.status !== 'completed';
  });
}

function sortTasks(tasks: TaskItem[], taskMap: Map<string, TaskItem>): TaskItem[] {
  return [...tasks].sort((a, b) => {
    const aOrder =
      a.status === 'in_progress'
        ? 0
        : a.status === 'pending' && !isTaskBlocked(a, taskMap)
          ? 1
          : a.status === 'pending'
            ? 2
            : 3;
    const bOrder =
      b.status === 'in_progress'
        ? 0
        : b.status === 'pending' && !isTaskBlocked(b, taskMap)
          ? 1
          : b.status === 'pending'
            ? 2
            : 3;
    return aOrder - bOrder;
  });
}

export interface TaskState {
  tasks: TaskItem[];
  taskMap: Map<string, TaskItem>;
  activeForm: string | null;
  isCollapsed: boolean;
  toggleCollapse: () => void;
  handleTaskEvent: (event: TaskUpdateEvent) => void;
  statusTimestamps: Map<string, { status: SessionTaskStatus; since: number }>;
}

const MAX_VISIBLE = 10;

/**
 * Whether a turn is still writing the plan.
 *
 * `blocked` counts: an agent parked on a permission ask has not finished its
 * turn, and folding its plan away mid-question would hide the very list that
 * explains what it is asking to do.
 */
function isTurnRunning(lifecycle: SessionLifecycle | undefined): boolean {
  return lifecycle === 'streaming' || lifecycle === 'blocked';
}

/**
 * Manages task state for a session, combining historical tasks from the API
 * with real-time streaming updates.
 *
 * Both the historical snapshot and the live stream fold through the same
 * {@link applyTaskEvent} the server's JSONL history reader uses
 * (`task-reader.ts`) — DOR-1441 was these two folds drifting apart when each
 * kept its own keying scheme. A `TaskCreate` event carries a provisional id
 * (the SDK's `TaskCreate` tool never returns one synchronously) until an
 * `id_assigned` event re-keys it to the SDK's confirmed real id, or `remove`
 * drops it if the call failed.
 *
 * It also owns whether the plan is open: the list is shown while a turn writes
 * it and folded to its progress header once that turn ends, unless the person
 * has said otherwise. See the collapse effect.
 *
 * @param sessionId - The active session ID, or null when no session is selected.
 *   When null, the initial task query is disabled and no API requests are made.
 * @param isStreaming - Whether the session is currently streaming. When true,
 *   polling is disabled to avoid redundant fetches during active streams.
 */
export function useTaskState(sessionId: string | null, isStreaming: boolean = false): TaskState {
  const transport = useTransport();
  // The session's own directory, not the selected one — a session opened
  // without `&dir=` does not live in the store's default (DOR-1444).
  const sessionCwd = useSessionScopedCwd();
  const selectedCwd = sessionCwd.cwd;
  const enableMessagePolling = useAppStore((s) => s.enableMessagePolling);
  const isTabVisible = useTabVisibility();
  const [state, setState] = useState<TaskFoldState>(createTaskFoldState());
  // Whether the plan is still being written. Read from the session stream rather
  // than passed in, because the host that renders the panel resolves its own
  // `status` from a hook this one feeds — see the collapse effect below.
  const lifecycle = useSessionStreamLifecycle(sessionId ?? '');
  // Open while a turn writes the plan, folded once it is done — including a plan
  // this window opens onto long after its turn ended.
  const [isCollapsed, setIsCollapsed] = useState(() => !isTurnRunning(lifecycle));

  // Stamped in handleTaskEvent (last live fold) and inside queryFn (when the
  // in-flight fetch was ISSUED, not when it resolves) so an empty history
  // response can be judged against what the live stream already knows —
  // see the reset effect below (DOR-1632).
  const lastLiveEventAtRef = useRef(0);
  const fetchStartedAtRef = useRef(0);

  // Load historical tasks via TanStack Query (polled while a turn streams)
  const { data: initialTasks } = useQuery({
    queryKey: ['tasks', sessionId, selectedCwd],
    queryFn: () => {
      fetchStartedAtRef.current = Date.now();
      return transport.getTasks(sessionId!, selectedCwd ?? undefined);
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    // A null directory is a complete question — the server resolves the
    // session's own (DOR-1444). Only an UNSETTLED one is worth waiting for.
    enabled: isSessionScopeReady(sessionId, sessionCwd),
    refetchInterval: () => {
      if (!enableMessagePolling) return false;
      if (isStreaming) return false;
      return isTabVisible
        ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
        : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
    },
  });

  // Reset state when query data changes (initial load or sync invalidation).
  // An empty response is NOT automatically a reason to wipe local state, but
  // it is not automatically safe to ignore either — both directions are real:
  //
  // - IGNORE: the history fetch and the live stream race. A fetch already
  //   in flight when a live event lands can still resolve afterward (network
  //   latency), and its empty answer reflects server state from BEFORE that
  //   event. Wiping local state on that stale answer was the original
  //   DOR-1632 bug.
  // - HONOR: a cleared task list has no live signal of its own — opencode's
  //   `mapTodos` and claude-code's `buildTodoWriteEvent` both emit nothing
  //   for an empty list (session-event-mapper.ts, build-task-event.ts), so a
  //   fresh history fetch returning `[]` is the ONLY way a genuine clear
  //   ever reaches this hook. `use-turn-end-reconcile.ts` invalidates this
  //   query specifically to deliver that answer. Ignoring every empty
  //   response for an unchanged scope (the first round of this fix) would
  //   leave a cleared list stuck on screen forever.
  //
  // The fetch that is settling is judged by when it was ISSUED
  // (`fetchStartedAtRef`, stamped inside `queryFn`) against the newest live
  // fold (`lastLiveEventAtRef`, stamped in handleTaskEvent) — not by when it
  // RESOLVED. Commit time is the wrong axis: network latency means a fetch
  // issued before a live event can still commit after it, and a fetch's
  // commit time tells you nothing about which happened first on the server.
  // A fetch issued strictly before the newest fold predates it and is
  // ignored; anything issued at or after is judged authoritative. A genuine
  // session (or scope) change always resets, regardless of timing.
  const scopeKeyRef = useRef<string | null>(null);
  /* eslint-disable react-hooks/set-state-in-effect -- sync TanStack Query data to local state */
  useEffect(() => {
    const scopeKey = `${sessionId ?? ''}::${selectedCwd ?? ''}`;
    const scopeChanged = scopeKeyRef.current !== scopeKey;
    scopeKeyRef.current = scopeKey;

    if (initialTasks && initialTasks.tasks.length > 0) {
      const next = createTaskFoldState();
      applyTaskEvent(
        next,
        { action: 'snapshot', task: initialTasks.tasks[0]!, tasks: initialTasks.tasks },
        Date.now()
      );
      setState(next);
    } else if (scopeChanged || fetchStartedAtRef.current >= lastLiveEventAtRef.current) {
      setState(createTaskFoldState());
    }
  }, [initialTasks, sessionId, selectedCwd]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleTaskEvent = useCallback((event: TaskUpdateEvent) => {
    lastLiveEventAtRef.current = Date.now();
    setState((prev) => {
      const next: TaskFoldState = {
        tasks: new Map(prev.tasks),
        statusTimestamps: new Map(prev.statusTimestamps),
        legacyCreateCount: prev.legacyCreateCount,
      };
      applyTaskEvent(next, event, Date.now());
      return next;
    });
  }, []);

  // Whether the person put the plan away themselves. A hand-collapsed panel stays
  // shut through the next turn; re-opening it hands the panel back to the rule
  // below.
  const collapsedByHandRef = useRef(false);
  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => {
      collapsedByHandRef.current = !prev;
      return !prev;
    });
  }, []);

  // **The plan follows the turn that writes it.** Ten rows plus a progress header
  // sit between the transcript and the composer, so a finished plan left open is
  // a screenful of history in the place a person is trying to type. It opens
  // while a turn is writing it and folds to its progress header — which still
  // carries the counts — when that turn ends.
  //
  // Edge-triggered, so neither direction fights the person: after the fold they
  // can open it and it stays open until the next turn ends, and a panel they
  // collapsed by hand is not re-opened by the next turn.
  const wasRunningRef = useRef(isTurnRunning(lifecycle));
  /* eslint-disable react-hooks/set-state-in-effect -- follows a stream transition, not render state */
  useEffect(() => {
    const running = isTurnRunning(lifecycle);
    if (running === wasRunningRef.current) return;
    wasRunningRef.current = running;
    if (!running) {
      setIsCollapsed(true);
    } else if (!collapsedByHandRef.current) {
      setIsCollapsed(false);
    }
  }, [lifecycle]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const allTasks = Array.from(state.tasks.values());
  const sorted = sortTasks(allTasks, state.tasks);
  const inProgressTask = allTasks.find((t) => t.status === 'in_progress');
  const activeForm = inProgressTask?.activeForm ?? null;

  return {
    tasks: sorted.slice(0, MAX_VISIBLE),
    taskMap: state.tasks,
    activeForm,
    isCollapsed,
    toggleCollapse,
    handleTaskEvent,
    statusTimestamps: state.statusTimestamps,
  };
}

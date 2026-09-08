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

// Query results survive hook remounts in the shared cache. One process-local
// sequence keeps their issuance order comparable with live folds across mounts.
// Wall-clock milliseconds cannot distinguish a fetch from a later same-tick fold.
let taskHistoryOrder = 0;

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

  const liveEventsRef = useRef<
    Array<{ order: number; event: TaskUpdateEvent; receivedAt: number }>
  >([]);
  const appliedHistoryOrderRef = useRef(0);

  // Load historical tasks via TanStack Query (polled while a turn streams)
  const { data: initialTasks } = useQuery({
    queryKey: ['tasks', sessionId, selectedCwd],
    queryFn: async () => {
      const fetchOrder = ++taskHistoryOrder;
      const history = await transport.getTasks(sessionId!, selectedCwd ?? undefined);
      // Bind issuance to this completed response. A newer in-flight request
      // cannot make an older result authoritative; the order also distinguishes
      // identical empty completions that query structural sharing would hide.
      return { ...history, fetchOrder };
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

  // A live TaskCreate/TaskUpdate is a delta, not a complete task list. Hydrate
  // history first, then replay newer live events so an older fetch neither
  // erases live work nor hides preexisting tasks. A full live snapshot replaces
  // history through the same fold. Covered events are discarded after each
  // accepted completion; a newer fetch cannot relabel an older response.
  const scopeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const scopeKey = `${sessionId ?? ''}::${selectedCwd ?? ''}`;
    const scopeChanged = scopeKeyRef.current !== scopeKey;
    scopeKeyRef.current = scopeKey;

    if (scopeChanged) {
      liveEventsRef.current = [];
      appliedHistoryOrderRef.current = 0;
      setState(createTaskFoldState());
    }
    if (!initialTasks || initialTasks.fetchOrder <= appliedHistoryOrderRef.current) return;
    appliedHistoryOrderRef.current = initialTasks.fetchOrder;
    const next = createTaskFoldState();
    if (initialTasks.tasks.length > 0) {
      applyTaskEvent(
        next,
        { action: 'snapshot', task: initialTasks.tasks[0]!, tasks: initialTasks.tasks },
        Date.now()
      );
    }
    liveEventsRef.current = liveEventsRef.current.filter(
      ({ order }) => order > initialTasks.fetchOrder
    );
    for (const { event, receivedAt } of liveEventsRef.current) {
      applyTaskEvent(next, event, receivedAt);
    }
    setState(next);
  }, [initialTasks, sessionId, selectedCwd]);

  const handleTaskEvent = useCallback((event: TaskUpdateEvent) => {
    const receivedAt = Date.now();
    // A full snapshot subsumes all prior deltas, even while history is pending.
    if (event.action === 'snapshot') liveEventsRef.current = [];
    liveEventsRef.current.push({ order: ++taskHistoryOrder, event, receivedAt });
    setState((prev) => {
      const next: TaskFoldState = {
        tasks: new Map(prev.tasks),
        statusTimestamps: new Map(prev.statusTimestamps),
        legacyCreateCount: prev.legacyCreateCount,
      };
      applyTaskEvent(next, event, receivedAt);
      return next;
    });
  }, []);

  // Whether the person put the plan away themselves. A hand-collapsed panel
  // stays shut through every LATER turn, not just the next one — the effect
  // below only reopens on a running transition when this is false, and nothing
  // ever clears it on its own. Reopening it by hand (`toggleCollapse`) is the
  // only thing that hands the panel back to the auto-fold rule.
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

  // Reset the fold state on a session (or scope) change — mirrors the
  // scopeKeyRef/scopeChanged reset the task data above already does. The
  // effect just above is keyed on `[lifecycle]` alone, so it only fires when
  // that STRING VALUE changes; two different sessions can land on the same
  // value (both mid-turn, or both idle) with nothing to trigger it, and a
  // hand-collapse or auto-fold left over from the PREVIOUS session bleeds
  // into whichever session is shown next (DOR-1759). This effect always runs
  // on a scope change, so it wins regardless of how the effect above reacted
  // in the same commit: it sets `isCollapsed` fresh from this session's own
  // lifecycle and clears the hand-collapse latch, which belongs to the
  // session that set it, not the one being switched to.
  const foldScopeKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const scopeKey = `${sessionId ?? ''}::${selectedCwd ?? ''}`;
    if (foldScopeKeyRef.current === scopeKey) return;
    foldScopeKeyRef.current = scopeKey;
    const running = isTurnRunning(lifecycle);
    wasRunningRef.current = running;
    collapsedByHandRef.current = false;
    setIsCollapsed(!running);
  }, [sessionId, selectedCwd, lifecycle]);

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

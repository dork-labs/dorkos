/**
 * The background commands a Stop left running in a session, and where the
 * line naming them is drawn (DOR-3285), for the session header's pill.
 *
 * Read from the session stream store, so the pill appears the moment the line
 * arrives and clears the moment the last command ends, without a refetch.
 *
 * @module entities/session/model/stream/use-session-work-left
 */
import { useCallback } from 'react';
import type { WorkLeftRunningPart } from '@dorkos/shared/types';
import { useSessionStreamStore, type SessionStreamState } from './session-stream-store';

/**
 * The stable DOM id of a Stop's line, from the first task it names, so the
 * header pill can scroll to it on a live turn and after a reload alike.
 *
 * @param part - The line's part.
 */
export function workLeftLineId(part: Pick<WorkLeftRunningPart, 'tasks'>): string {
  const first = part.tasks[0]?.taskId ?? 'none';
  return `work-left-${first.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** What the header pill needs: how many commands still run, and where. */
export interface SessionWorkLeft {
  /** Commands a Stop left running that have not ended. */
  count: number;
  /** The DOM id of the newest line still naming one. */
  lineId: string;
}

/** Every line in a session, history first, then the live turn's. */
function linesOf(state: SessionStreamState): Pick<WorkLeftRunningPart, 'tasks'>[] {
  const lines: Pick<WorkLeftRunningPart, 'tasks'>[] = [];
  for (const message of state.messages) {
    for (const part of message.parts ?? []) {
      if (part.type === 'work_left_running') lines.push(part);
    }
  }
  for (const event of state.inProgressTurn) {
    if (event.type === 'work_left_running') lines.push(event);
  }
  return lines;
}

/**
 * The pill's answer as one string, so the selector is stable across renders:
 * `count` and `lineId` joined, or `null` when nothing still runs.
 */
function workLeftKey(state: SessionStreamState | undefined): string | null {
  if (!state) return null;
  const lines = linesOf(state);
  if (lines.length === 0) return null;
  // Every end first, wherever it was said: the server's fold after a reload,
  // or a live `work_left_ended`.
  const ended = new Set<string>();
  for (const event of state.inProgressTurn) {
    if (event.type === 'work_left_ended') ended.add(event.taskId);
  }
  for (const line of lines) {
    for (const task of line.tasks) if (task.ended) ended.add(task.taskId);
  }
  const running = new Set<string>();
  let lineId: string | null = null;
  for (const line of lines) {
    const open = line.tasks.filter((task) => !ended.has(task.taskId));
    if (open.length === 0) continue;
    for (const task of open) running.add(task.taskId);
    lineId = workLeftLineId(line);
  }
  return running.size > 0 && lineId ? `${running.size}\u0000${lineId}` : null;
}

/**
 * Granular selector: the commands a Stop left running in a session, or `null`
 * when none still run (DOR-3285).
 *
 * @param sessionId - The session, or `null` before one is chosen.
 */
export function useSessionWorkLeft(sessionId: string | null): SessionWorkLeft | null {
  const key = useSessionStreamStore(
    useCallback((s) => (sessionId ? workLeftKey(s.sessions[sessionId]) : null), [sessionId])
  );
  if (key === null) return null;
  const [count, lineId] = key.split('\u0000');
  return { count: Number(count), lineId: lineId! };
}

import { useMemo, useRef, useState, useEffect } from 'react';
import type { SubagentPart } from '@dorkos/shared/types';
import type { ChatMessage } from './chat-types';

export interface RunningAgent {
  taskId: string;
  description: string;
  status: 'running' | 'complete' | 'error';
  color: string;
  toolUses?: number;
  lastToolName?: string;
  durationMs?: number;
  summary?: string;
}

export const AGENT_COLORS = [
  'hsl(210 80% 60%)', // blue
  'hsl(150 60% 50%)', // green
  'hsl(270 60% 65%)', // purple
  'hsl(36 90% 55%)', // amber
  'hsl(340 75% 60%)', // rose
] as const;

/** Celebration window duration in milliseconds. */
const CELEBRATION_DURATION_MS = 1500;

/** Derive running background subagents from the message stream with stable color assignment. */
export function useRunningSubagents(messages: ChatMessage[]): RunningAgent[] {
  const colorMapRef = useRef<Map<string, string>>(new Map());
  const colorIndexRef = useRef(0);
  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const celebratingRef = useRef<Set<string>>(new Set());
  const [, setRenderTick] = useState(0);

  // Collect the latest subagent part per taskId across all messages
  const subagentMap = useMemo(() => {
    const map = new Map<string, SubagentPart>();
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type === 'subagent') {
          map.set(part.taskId, part);
        }
      }
    }
    return map;
  }, [messages]);

  // Detect status transitions and manage celebration windows
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];

    for (const [taskId, part] of subagentMap) {
      const prevStatus = prevStatusRef.current.get(taskId);
      const justCompleted =
        prevStatus === 'running' && (part.status === 'complete' || part.status === 'error');

      if (justCompleted && !celebratingRef.current.has(taskId)) {
        celebratingRef.current.add(taskId);
        const timer = setTimeout(() => {
          celebratingRef.current.delete(taskId);
          setRenderTick((t) => t + 1);
        }, CELEBRATION_DURATION_MS);
        timers.push(timer);
      }

      prevStatusRef.current.set(taskId, part.status);
    }

    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [subagentMap]);

  // Build the result array: running agents + celebrating agents
  return useMemo(() => {
    const result: RunningAgent[] = [];

    for (const [taskId, part] of subagentMap) {
      const isRunning = part.status === 'running';
      const isCelebrating = celebratingRef.current.has(taskId);

      if (!isRunning && !isCelebrating) continue;

      // Assign stable color
      if (!colorMapRef.current.has(taskId)) {
        colorMapRef.current.set(taskId, AGENT_COLORS[colorIndexRef.current % AGENT_COLORS.length]);
        colorIndexRef.current += 1;
      }

      result.push({
        taskId: part.taskId,
        description: part.description,
        status: part.status,
        color: colorMapRef.current.get(taskId)!,
        toolUses: part.toolUses,
        lastToolName: part.lastToolName,
        durationMs: part.durationMs,
        summary: part.summary,
      });
    }

    return result;
    // celebratingRef is a ref but renderTick forces re-evaluation when celebrations expire
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subagentMap /* renderTick drives re-computation via state change */]);
}

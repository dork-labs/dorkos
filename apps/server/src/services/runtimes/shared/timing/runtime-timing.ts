import type { StreamEvent } from '@dorkos/shared/types';

interface TimingState {
  tools: Map<string, number>;
  compaction?: number;
}
const states = new WeakMap<object, TimingState>();

/**
 * Timestamp observed lifecycle signals. A synthesized tool start is explicitly excluded;
 * argument completion with status running is never an execution end.
 * State is owned by one runtime turn and cannot leak across sessions.
 */
export function timeRuntimeEvents(
  owner: object,
  events: StreamEvent[],
  options: { observeStart?: boolean; now?: number } = {}
): StreamEvent[] {
  const { observeStart = true, now = Date.now() } = options;
  let state = states.get(owner);
  if (!state) {
    state = { tools: new Map() };
    states.set(owner, state);
  }
  return events.map((event) => {
    if (
      ['tool_call_start', 'tool_call_delta', 'tool_call_end', 'tool_result'].includes(event.type)
    ) {
      const data = event.data as Record<string, unknown>;
      const id = String(data.toolCallId);
      if (event.type === 'tool_call_start' && observeStart && !state.tools.has(id))
        state.tools.set(id, now);
      const startedAt = state.tools.get(id);
      const terminal = data.status === 'complete' || data.status === 'error';
      return {
        ...event,
        data: {
          ...data,
          ...(startedAt === undefined ? {} : { startedAt }),
          ...(terminal ? { endedAt: now } : {}),
        },
      } as StreamEvent;
    }
    if (event.type === 'operation_progress') {
      const data = event.data as Record<string, unknown>;
      if (data.operation === 'compaction' && data.state === 'started') state.compaction = now;
      if (data.operation === 'compaction' && data.state === 'failed') state.compaction = undefined;
    }
    if (event.type === 'compact_boundary') {
      const startedAt = state.compaction;
      state.compaction = undefined;
      return {
        ...event,
        data: { ...event.data, ...(startedAt === undefined ? {} : { startedAt }), endedAt: now },
      };
    }
    if (event.type === 'done') state.tools.clear();
    return event;
  });
}

import { expect } from 'vitest';
import {
  ToolCallEventSchema,
  ModelRequestEventSchema,
  CompactBoundaryEventSchema,
} from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';

/** Check optional timing readings without requiring runtimes to invent missing measurements. */
export function assertRuntimeTimingEvents(events: StreamEvent[]): void {
  const tools = new Map<string, number>();
  for (const event of events) {
    if (
      ['tool_call_start', 'tool_call_delta', 'tool_call_end', 'tool_result'].includes(event.type)
    ) {
      const data = ToolCallEventSchema.parse(event.data);
      if (data.startedAt !== undefined) {
        if (tools.has(data.toolCallId)) expect(data.startedAt).toBe(tools.get(data.toolCallId));
        tools.set(data.toolCallId, data.startedAt);
      }
      if (data.endedAt !== undefined) expect(['complete', 'error']).toContain(data.status);
    } else if (event.type === 'model_request') {
      ModelRequestEventSchema.parse(event.data);
    } else if (event.type === 'compact_boundary') {
      CompactBoundaryEventSchema.parse(event.data);
    }
  }
}

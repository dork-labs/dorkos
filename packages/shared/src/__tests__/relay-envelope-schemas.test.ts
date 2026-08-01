import { describe, it, expect } from 'vitest';
import { RelayFlowEventSchema, TaskDispatchPayloadSchema } from '../relay-schemas.js';

// === Fixtures ===

const validFlowEvent = {
  bindingId: 'binding-1',
  adapterId: 'adapter-1',
  agentId: 'agent-1',
  direction: 'inbound' as const,
  at: new Date().toISOString(),
};

// === Tests ===

describe('RelayFlowEventSchema', () => {
  it('accepts a valid delivered-flow event', () => {
    // Purpose: the wire contract accepts the exact routing-skeleton shape.
    const result = RelayFlowEventSchema.safeParse(validFlowEvent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bindingId).toBe('binding-1');
      expect(result.data.direction).toBe('inbound');
    }
  });

  it('rejects an event missing bindingId', () => {
    // Purpose: the primary join key is required — no ambiguous edge lookup.
    const { bindingId: _bindingId, ...invalid } = validFlowEvent;
    const result = RelayFlowEventSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects an event missing direction', () => {
    // Purpose: direction drives which way the pulse animates — required.
    const { direction: _direction, ...invalid } = validFlowEvent;
    const result = RelayFlowEventSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('rejects an event with an invalid direction value', () => {
    // Purpose: direction is a closed enum, not an arbitrary string.
    const result = RelayFlowEventSchema.safeParse({ ...validFlowEvent, direction: 'sideways' });
    expect(result.success).toBe(false);
  });

  it('strips an extra payload/text key rather than surfacing message content', () => {
    // Purpose: proves the wire contract stays metadata-only even if a caller
    // accidentally attaches content — no payload/content field survives parsing.
    const result = RelayFlowEventSchema.safeParse({
      ...validFlowEvent,
      payload: { secret: 'do not leak' },
      text: 'hello world',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('payload');
      expect(result.data).not.toHaveProperty('text');
      expect(Object.keys(result.data).sort()).toEqual(
        ['adapterId', 'agentId', 'at', 'bindingId', 'direction'].sort()
      );
    }
  });
});

describe('TaskDispatchPayloadSchema', () => {
  const validDispatch = {
    type: 'task_dispatch' as const,
    taskId: 'task-1',
    runId: 'run-1',
    prompt: 'do the thing',
    cwd: '/work',
    permissionMode: 'acceptEdits',
    taskName: 'Nightly digest',
    cron: '0 9 * * *',
    trigger: 'schedule',
  };

  it('accepts a dispatch carrying a real permission mode', () => {
    const result = TaskDispatchPayloadSchema.safeParse(validDispatch);
    expect(result.success).toBe(true);
  });

  it('rejects a dispatch carrying a mode nothing can run', () => {
    // Purpose: a scheduled run hands its mode straight to the agent session.
    // An arbitrary string used to pass the wire contract and only fail (or,
    // worse, silently degrade) deep inside the runtime.
    const result = TaskDispatchPayloadSchema.safeParse({
      ...validDispatch,
      permissionMode: 'yolo',
    });
    expect(result.success).toBe(false);
  });
});

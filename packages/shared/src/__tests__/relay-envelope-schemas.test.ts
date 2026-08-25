import { describe, it, expect } from 'vitest';
import {
  RelayFlowEventSchema,
  TaskDispatchPayloadSchema,
  isTaskDispatchSubject,
  taskDispatchSubject,
} from '../relay-schemas.js';

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

describe('isTaskDispatchSubject', () => {
  it('accepts exactly one task dispatch subject', () => {
    expect(isTaskDispatchSubject(taskDispatchSubject('01J8ZQ2K3M4N5P6Q7R8S9T0V'))).toBe(true);
    expect(isTaskDispatchSubject('relay.system.tasks.sched-1')).toBe(true);
  });

  it('refuses every subject BENEATH a dispatch subject', () => {
    // Purpose: the runtime adapter claims `relay.system.tasks.` as a prefix, so
    // a bare startsWith read a run's own progress stream as a fresh dispatch.
    // Every event failed to parse and dead-lettered — 279 from one live run
    // (DOR-1567).
    expect(isTaskDispatchSubject('relay.system.tasks.sched-1.response')).toBe(false);
    expect(isTaskDispatchSubject('relay.system.tasks.sched-1.anything.else')).toBe(false);
  });

  it('refuses the prefix on its own and unrelated subjects', () => {
    expect(isTaskDispatchSubject('relay.system.tasks.')).toBe(false);
    expect(isTaskDispatchSubject('relay.system.other.sched-1')).toBe(false);
    expect(isTaskDispatchSubject('relay.agent.session-abc')).toBe(false);
  });
});

describe('TaskDispatchPayloadSchema systemPromptAppend', () => {
  const base = {
    type: 'task_dispatch' as const,
    taskId: 'sched-1',
    runId: 'run-1',
    prompt: 'do the thing',
    cwd: null,
    permissionMode: 'acceptEdits' as const,
    taskName: 'Nightly',
    cron: '0 9 * * *',
    trigger: 'schedule',
  };

  it('carries the unattended briefing when one is set', () => {
    const result = TaskDispatchPayloadSchema.safeParse({
      ...base,
      systemPromptAppend: '=== TASK SCHEDULER CONTEXT ===',
    });
    expect(result.success).toBe(true);
    expect(result.data?.systemPromptAppend).toBe('=== TASK SCHEDULER CONTEXT ===');
  });

  it('still accepts an envelope written before the field existed', () => {
    // Purpose: a dead-letter replay carries the old shape.
    expect(TaskDispatchPayloadSchema.safeParse(base).success).toBe(true);
  });
});

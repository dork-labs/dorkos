import { describe, it, expect, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '../fake-agent-runtime.js';

describe('FakeAgentRuntime', () => {
  it('implements AgentRuntime — can be instantiated without error', () => {
    // Purpose: runtime check that the class can be instantiated without error.
    // The real enforcement is TypeScript: a compile error fires if AgentRuntime
    // adds a new method that FakeAgentRuntime does not implement.
    expect(() => new FakeAgentRuntime()).not.toThrow();
  });

  it('sendMessage yields events from the first queued scenario', async () => {
    // Purpose: verify the scenario queue dequeues in order.
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const events: StreamEvent[] = [];
    for await (const e of runtime.sendMessage('s1', 'hello')) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
  });

  it('multi-turn: dequeues next scenario on second sendMessage call', async () => {
    // Purpose: verify withScenarios([s1, s2]) supports multi-turn test flows.
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'first' } } as StreamEvent;
      },
      async function* () {
        yield { type: 'text_delta', data: { text: 'second' } } as StreamEvent;
      },
    ]);
    const first: StreamEvent[] = [];
    for await (const e of runtime.sendMessage('s1', 'q1')) first.push(e);
    const second: StreamEvent[] = [];
    for await (const e of runtime.sendMessage('s1', 'q2')) second.push(e);
    expect((first[0] as { data: { text: string } }).data.text).toBe('first');
    expect((second[0] as { data: { text: string } }).data.text).toBe('second');
  });

  it('sendMessage is a vi.fn() spy — call count is observable', async () => {
    // Purpose: verify test assertions like expect(runtime.sendMessage).toHaveBeenCalledOnce()
    // work correctly — important for route tests that verify message dispatch.
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([async function* () {}]);
     
    for await (const _ of runtime.sendMessage('s1', 'x')) {
      /* noop */
    }
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
  });

  it('withScenarios resets the scenario index', async () => {
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'first' } } as StreamEvent;
      },
    ]);
     
    for await (const _event of runtime.sendMessage('s1', 'x')) { /* drain */ }
    // Reset with a new scenario — should dequeue from index 0 again
    runtime.withScenarios([
      async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const events: StreamEvent[] = [];
    for await (const e of runtime.sendMessage('s1', 'x')) events.push(e);
    expect(events[0].type).toBe('done');
  });

  it('sendMessage yields nothing when no scenarios are loaded', async () => {
    const runtime = new FakeAgentRuntime();
    const events: StreamEvent[] = [];
    for await (const e of runtime.sendMessage('s1', 'x')) events.push(e);
    expect(events).toHaveLength(0);
  });

  it('hasSession defaults to false', () => {
    const runtime = new FakeAgentRuntime();
    expect(runtime.hasSession('s1')).toBe(false);
  });

  it('acquireLock defaults to true', () => {
    const runtime = new FakeAgentRuntime();
    // SseResponse mock — only needs the on() method signature
    const mockRes = { on: vi.fn() };
    expect(runtime.acquireLock('s1', 'client-1', mockRes as any)).toBe(true);
  });
});

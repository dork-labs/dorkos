import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { ClaudeCodeAdapter } from '../../index.js';
import type { AgentRuntimeLike, AgentSessionStoreLike, TraceStoreLike } from '../../index.js';
import type { RelayPublisher, AdapterContext } from '../../../../types.js';
import {
  createAdapterHarness,
  createTasksEnvelope,
  createTestEnvelope,
} from './claude-code-adapter.fixtures.js';

describe('ClaudeCodeAdapter', () => {
  let agentManager: AgentRuntimeLike;
  let traceStore: TraceStoreLike;
  let relay: RelayPublisher;
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    ({ agentManager, traceStore, relay, adapter } = createAdapterHarness());
  });

  describe('the concurrency ceiling', () => {
    /**
     * A turn that occupies its slot until the test lets it go.
     *
     * `defaultTimeoutMs` is the hold ceiling. It is set well BELOW the
     * envelope's own TTL so the two clocks cannot race: a hold expires while
     * the turn in its way is still running, which is the case worth pinning.
     */
    function hangingAdapter(maxConcurrent: number, defaultTimeoutMs = 60_000) {
      let release!: () => void;
      const hanging = new Promise<void>((resolve) => {
        release = resolve;
      });
      const manager: AgentRuntimeLike = {
        ensureSession: vi.fn(),
        // A fresh generator per call: two deliveries to different sessions must
        // not share one stream, or the second would end the moment the first did.
        sendMessage: vi.fn().mockImplementation(() =>
          (async function* () {
            await hanging;
            yield { type: 'done', data: {} } as StreamEvent;
          })()
        ),
        getSdkSessionId: vi.fn().mockReturnValue(undefined),
        approveTool: vi.fn(),
        interruptQuery: vi.fn().mockResolvedValue(true),
      };
      const adapter = new ClaudeCodeAdapter(
        'capped',
        { maxConcurrent, defaultTimeoutMs, defaultCwd: '/tmp' },
        // This suite is about the capacity hold, not the approval bus, so the
        // approval gate is a permissive stand-in — `approval-handler.test.ts`
        // owns proving it refuses.
        { agentManager: manager, traceStore, approvalAuthorizer: () => true }
      );
      return { adapter, manager, release };
    }

    /**
     * The context the publish pipeline builds for a DETACHED delivery.
     *
     * Its `onHeld` is the adapter's licence to wait: an awaited delivery gets
     * no context at all, which is what keeps it out of the waiting line.
     */
    function detached(onHeld: () => void = () => {}): AdapterContext {
      return { onHeld };
    }

    it('holds an agent message until a slot frees instead of turning it away', async () => {
      vi.useFakeTimers();
      try {
        const { adapter: capped, manager, release } = hangingAdapter(1);
        await capped.start(relay);

        const first = capped.deliver(
          'relay.agent.claude-code.busy-one',
          createTestEnvelope(),
          detached()
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(manager.sendMessage).toHaveBeenCalledTimes(1);

        // The second message is for a DIFFERENT session, so the per-session
        // queue does not cover it. Before the hold this returned `at_capacity`
        // and the message was dead-lettered — the drop this change exists to end.
        const second = capped.deliver(
          'relay.agent.claude-code.busy-two',
          createTestEnvelope(),
          detached()
        );
        // Fake time, so "it has not started" is a drained scheduler rather than
        // a sleep long enough to have probably drained it.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(manager.sendMessage).toHaveBeenCalledTimes(1);

        release();
        await vi.advanceTimersByTimeAsync(1);
        await expect(first).resolves.toMatchObject({ success: true });
        // Seeded defect: put the old `if (activeCount >= maxConcurrent) return
        // at_capacity` back. `second` resolves `success: false` and the second
        // turn never runs.
        await expect(second).resolves.toMatchObject({ success: true });
        expect(manager.sendMessage).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses a delivery somebody is awaiting rather than holding it', async () => {
      const { adapter: capped, manager, release } = hangingAdapter(1);
      await capped.start(relay);

      const first = capped.deliver(
        'relay.agent.claude-code.busy-one',
        createTestEnvelope(),
        detached()
      );
      await vi.waitFor(() => expect(manager.sendMessage).toHaveBeenCalledTimes(1));

      // A Tasks dispatch is AWAITED by the publish pipeline under its own 120s
      // ceiling, so it arrives with no `onHeld` and must be answered now.
      // Holding one would spend the caller's budget and report a timeout where
      // the truth was capacity.
      // Seeded defect: make `mayWait` anything other than "the pipeline gave me
      // an onHeld" — `mayWait: !isTasks`, say. Every awaited control message
      // then parks behind the running turn and its publish hangs, which is
      // exactly how `task-cancel-roundtrip` catches it.
      const task = await capped.deliver('relay.system.tasks.dispatch', createTasksEnvelope());
      expect(task).toMatchObject({ success: false, code: 'at_capacity' });

      release();
      await first;
    });

    it('never holds a message past its own TTL', async () => {
      vi.useFakeTimers();
      try {
        // Hold ceiling 60s, but this envelope has only 5s of budget left.
        const { adapter: capped, manager, release } = hangingAdapter(1);
        await capped.start(relay);

        const first = capped.deliver(
          'relay.agent.claude-code.busy-one',
          createTestEnvelope(),
          detached()
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(manager.sendMessage).toHaveBeenCalledTimes(1);

        const shortLived = createTestEnvelope({
          budget: { ...createTestEnvelope().budget, ttl: Date.now() + 5_000 },
        });
        const second = capped.deliver('relay.agent.claude-code.busy-two', shortLived, detached());

        await vi.advanceTimersByTimeAsync(5_000);
        // Seeded defect: drop `ceilingMs` from the `acquire()` call. The wait
        // runs the full 60s, and the message then reaches `handleAgentMessage`
        // with nothing left, where it is refused (DOR-1770) — so a person who
        // could have been told "busy" at five seconds is told "expired" a
        // minute later instead. The wait ends when the message's own time does.
        await expect(second).resolves.toMatchObject({ success: false, code: 'at_capacity' });
        expect(manager.sendMessage).toHaveBeenCalledTimes(1);

        release();
        await vi.advanceTimersByTimeAsync(1);
        await first;
      } finally {
        vi.useRealTimers();
      }
    });

    it('ends every wait when the adapter stops, rather than dropping it in silence', async () => {
      vi.useFakeTimers();
      try {
        const { adapter: capped, manager, release } = hangingAdapter(1);
        await capped.start(relay);

        const first = capped.deliver(
          'relay.agent.claude-code.busy-one',
          createTestEnvelope(),
          detached()
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(manager.sendMessage).toHaveBeenCalledTimes(1);
        const second = capped.deliver(
          'relay.agent.claude-code.busy-two',
          createTestEnvelope(),
          detached()
        );
        await vi.advanceTimersByTimeAsync(1);

        await capped.stop();

        // Seeded defect: drop `this.capacity.drain()` from `stop()`. The promise
        // outlives the machinery that could keep it and nothing is said in the chat.
        const settled = await second;
        expect(settled.success).toBe(false);
        expect(settled.error).toMatch(/stopped while this message was waiting/);

        release();
        await vi.advanceTimersByTimeAsync(1);
        await first;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // === An expired envelope never runs (DOR-1770) ===

  // === Inbox replyTo path ===

  describe('inbox replyTo path', () => {
    it('publishes progress events + final agent_result to relay.inbox.* — unified streaming', async () => {
      vi.mocked(agentManager.sendMessage).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', data: { text: 'Hello' } } as StreamEvent;
          yield { type: 'text_delta', data: { text: ' world' } } as StreamEvent;
          yield { type: 'done', data: {} } as StreamEvent;
        })()
      );

      await adapter.start(relay);
      const envelope = createTestEnvelope({ replyTo: 'relay.inbox.sender' });

      await adapter.deliver(envelope.subject, envelope);

      const calls = vi.mocked(relay.publish).mock.calls;
      // Text-only stream: post-loop flushes buffer as progress (1) + agent_result (1) = 2 calls
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.every(([subject]) => subject === 'relay.inbox.sender')).toBe(true);

      // Final publish must be the agent_result with full accumulated text
      const lastCall = calls[calls.length - 1];
      expect(lastCall[0]).toBe('relay.inbox.sender');
      expect(lastCall[1]).toMatchObject({ type: 'agent_result', text: 'Hello world' });

      // No raw text_delta payloads published (progress uses dispatch_progress type)
      const hasTextDelta = calls.some(
        ([, payload]) => (payload as Record<string, unknown>).type === 'text_delta'
      );
      expect(hasTextDelta).toBe(false);
    });

    // DOR-1337 (F6). An upstream API failure surfaces as an in-stream `error`
    // event followed by a normal `done` — the iterator does not throw, so the
    // crashed-turn guard in the `finally` never fires. The inbox branch used to
    // forward neither, and published `{ type: 'agent_result', text: '', done: true }`:
    // a caller could not tell "answered nothing" from "crashed", which on an
    // unattended schedule is a silent no-op.
    it('carries the failure on the agent_result when the turn errors and still ends with done', async () => {
      vi.mocked(agentManager.sendMessage).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', data: { text: 'partial' } } as StreamEvent;
          yield { type: 'error', data: { message: 'API Error: 500' } } as StreamEvent;
          yield { type: 'done', data: {} } as StreamEvent;
        })()
      );

      await adapter.start(relay);
      const envelope = createTestEnvelope({ replyTo: 'relay.inbox.sender' });

      await adapter.deliver(envelope.subject, envelope);

      const calls = vi.mocked(relay.publish).mock.calls;
      const final = calls[calls.length - 1];
      expect(final[0]).toBe('relay.inbox.sender');
      expect(final[1]).toMatchObject({
        type: 'agent_result',
        done: true,
        error: 'API Error: 500',
      });
      // Whatever was streamed before the failure still travels, as partial work.
      expect((final[1] as { text: string }).text).toBe('partial');
    });

    // The other half of the same rule. The claude-code runtime escalates ANY
    // non-tool hook that exits non-zero — Stop, SubagentStop, SessionStart, all
    // three configured in this repo — to a stream `error` with
    // `code: 'hook_failure'`, and the turn then finishes normally with the whole
    // answer. Folding that in would turn a correct reply into an AGENT_ERROR
    // whose partialText is the answer nobody reads.
    it('ignores a failed hook: the operator script is not the turn', async () => {
      vi.mocked(agentManager.sendMessage).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', data: { text: 'the whole answer' } } as StreamEvent;
          yield {
            type: 'error',
            data: { message: 'Hook "notify" failed (Stop)', code: 'hook_failure' },
          } as StreamEvent;
          yield { type: 'done', data: {} } as StreamEvent;
        })()
      );

      await adapter.start(relay);
      await adapter.deliver(
        'relay.agent.session-abc',
        createTestEnvelope({ replyTo: 'relay.inbox.sender' })
      );

      const calls = vi.mocked(relay.publish).mock.calls;
      const final = calls[calls.length - 1];
      expect(final[1]).toMatchObject({
        type: 'agent_result',
        text: 'the whole answer',
        done: true,
      });
      expect((final[1] as { error?: string }).error).toBeUndefined();
    });
  });

  // === Persistent session mapping ===

  describe('persistent session mapping', () => {
    function createMockAgentSessionStore(initial?: Map<string, string>): AgentSessionStoreLike {
      const store = new Map<string, string>(initial);
      return {
        get: vi.fn((agentId: string) => store.get(agentId)),
        set: vi.fn((agentId: string, sdkId: string) => {
          store.set(agentId, sdkId);
        }),
      };
    }

    it('uses persisted SDK session ID on subsequent delivery (not raw subject key)', async () => {
      const sdkUUID = 'sdk-uuid-0000-bbbb-1234567890ab';
      // Store already has a mapping from a previous delivery
      const agentSessionStore = createMockAgentSessionStore(new Map([['agent-ulid-002', sdkUUID]]));

      const adapterWithStore = new ClaudeCodeAdapter(
        'cca-resume',
        { defaultCwd: '/tmp' },
        { agentManager, traceStore, agentSessionStore, approvalAuthorizer: () => true }
      );
      await adapterWithStore.start(relay);

      const envelope = createTestEnvelope({ subject: 'relay.agent.agent-ulid-002' });
      await adapterWithStore.deliver(envelope.subject, envelope);

      // ensureSession and sendMessage must use the persisted SDK UUID, not 'agent-ulid-002'.
      // hasStarted is true because the store has a real SDK session ID to resume.
      expect(agentManager.ensureSession).toHaveBeenCalledWith(
        sdkUUID,
        expect.objectContaining({ permissionMode: 'default', hasStarted: true })
      );
      expect(agentManager.sendMessage).toHaveBeenCalledWith(
        sdkUUID,
        expect.stringContaining('Run the budget report'),
        expect.anything()
      );
      // set() must NOT be called — the mapping already exists
      expect(agentSessionStore.set).not.toHaveBeenCalled();
    });
  });

  // === Per-agentId queue (concurrency safety) ===

  describe('per-agentId queue (concurrency safety)', () => {
    it('same agentId delivers are serialized — second sendMessage starts only after first completes', async () => {
      const callOrder: string[] = [];
      let resolveFirst!: () => void;

      // First call: hangs until manually resolved
      const hangingStream = (async function* () {
        callOrder.push('first:start');
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        callOrder.push('first:end');
      })();

      // Second call: resolves immediately
      const quickStream = (async function* () {
        callOrder.push('second:start');
        yield { type: 'done', data: {} } as StreamEvent;
        callOrder.push('second:end');
      })();

      const serializedManager: AgentRuntimeLike = {
        ensureSession: vi.fn(),
        sendMessage: vi.fn().mockReturnValueOnce(hangingStream).mockReturnValueOnce(quickStream),
        getSdkSessionId: vi.fn().mockReturnValue(undefined),
        approveTool: vi.fn(),
        interruptQuery: vi.fn().mockResolvedValue(true),
      };

      const serializedAdapter = new ClaudeCodeAdapter(
        'serialized',
        { defaultCwd: '/tmp', maxConcurrent: 10 },
        { agentManager: serializedManager, traceStore, approvalAuthorizer: () => true }
      );
      await serializedAdapter.start(relay);

      const sameSubject = 'relay.agent.SAME_AGENT';
      const envelope1 = createTestEnvelope({ id: 'msg-s1', subject: sameSubject });
      const envelope2 = createTestEnvelope({ id: 'msg-s2', subject: sameSubject });

      // Fire both concurrently
      const first = serializedAdapter.deliver(sameSubject, envelope1);
      const second = serializedAdapter.deliver(sameSubject, envelope2);

      // Wait for the first call to reach the runtime, rather than counting
      // microtasks: how many awaits sit between `deliver()` and `sendMessage`
      // is an implementation detail (taking a concurrency slot added one), and
      // the property under test is the ORDER, not the tick count.
      await vi.waitFor(() => expect(callOrder).toContain('first:start'));

      // At this point, only the first call should have started
      expect(callOrder).not.toContain('second:start');

      // Unblock the first call
      resolveFirst();
      await first;

      // Now the second can run
      await second;

      expect(callOrder).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    });
  });

  // === Terminal done event and delivery diagnostics (tasks 1.3, 1.4) ===

  describe('terminal done event on generator error', () => {
    it('publishes an error event BEFORE the synthesized done when the SDK generator throws', async () => {
      // Regression: a crashed turn used to publish only a bare done, so reply
      // consumers (A2A executor, relay_send_and_wait) treated the partial
      // streamed text as a successful completion. The error event lets them
      // fail the turn.
      vi.mocked(agentManager.sendMessage).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', data: { text: 'partial' } } as StreamEvent;
          throw new Error('SDK stream error');
        })()
      );

      await adapter.start(relay);
      // Non-inbox replyTo → the A2A-shaped raw-StreamEvent reply path.
      const envelope = createTestEnvelope({ replyTo: 'relay.a2a.reply.task-1.nonce' });

      const result = await adapter.deliver(envelope.subject, envelope);
      expect(result.success).toBe(false);

      const publishCalls = vi.mocked(relay.publish).mock.calls;
      const types = publishCalls.map(([, p]) => (p as Record<string, unknown>).type);
      const errorIdx = types.indexOf('error');
      const doneIdx = types.lastIndexOf('done');

      expect(errorIdx).toBeGreaterThanOrEqual(0);
      expect(doneIdx).toBeGreaterThan(errorIdx);

      // Error payload matches ErrorEventSchema ({ message }) — what
      // a2a-gateway/reply-events parses into a stream_error that fails the task.
      const errorPayload = publishCalls[errorIdx]![1] as { data: { message: string } };
      expect(errorPayload.data.message).toMatch(/SDK stream error/);
    });

    it('sends done in finally even when publishResponse throws', async () => {
      let publishCount = 0;
      vi.mocked(relay.publish).mockImplementation(async () => {
        publishCount++;
        if (publishCount === 1) {
          throw new Error('Publish failed for text_delta');
        }
        return { messageId: `resp-${publishCount}`, deliveredTo: 1 };
      });

      vi.mocked(agentManager.sendMessage).mockReturnValue(
        (async function* () {
          yield { type: 'text_delta', data: { text: 'hello' } } as StreamEvent;
          yield { type: 'done', data: {} } as StreamEvent;
        })()
      );

      await adapter.start(relay);
      const envelope = createTestEnvelope({ replyTo: 'relay.human.console.client-1' });

      await adapter.deliver(envelope.subject, envelope);

      // done event should still have been published despite earlier publish failure
      const publishCalls = vi.mocked(relay.publish).mock.calls;
      const donePublish = publishCalls.find(
        ([, payload]) => (payload as Record<string, unknown>).type === 'done'
      );
      expect(donePublish).toBeDefined();
    });
  });
});

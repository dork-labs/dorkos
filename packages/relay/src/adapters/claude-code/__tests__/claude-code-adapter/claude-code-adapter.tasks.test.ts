import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamEventTypeSchema } from '@dorkos/shared/schemas';
import { ClaudeCodeAdapter } from '../../index.js';
import type { AgentRuntimeLike, TraceStoreLike, TasksStoreLike } from '../../index.js';
import type { RelayPublisher } from '../../../../types.js';
import {
  UUID_RE,
  createAdapterHarness,
  createTasksEnvelope,
  createTestEnvelope,
  parkedTurn,
} from './claude-code-adapter.fixtures.js';

describe('ClaudeCodeAdapter', () => {
  let agentManager: AgentRuntimeLike;
  let traceStore: TraceStoreLike;
  let taskStore: TasksStoreLike;
  let relay: RelayPublisher;
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    ({ agentManager, traceStore, taskStore, relay, adapter } = createAdapterHarness());
  });

  // === Tasks message delivery ===

  it('handles Tasks dispatch messages — validates payload, updates TasksStore lifecycle', async () => {
    await adapter.start(relay);
    const envelope = createTasksEnvelope();

    const result = await adapter.deliver(envelope.subject, envelope);

    expect(result.success).toBe(true);
    // The turn runs under a freshly minted session, not the run id — the run
    // id is what the store keeps below.
    const [sessionId] = vi.mocked(agentManager.sendMessage).mock.calls[0]!;
    expect(sessionId).not.toBe('run-1');
    expect(sessionId).toMatch(UUID_RE);
    expect(agentManager.sendMessage).toHaveBeenCalledWith(
      sessionId,
      'Check the budget',
      expect.anything()
    );
    expect(taskStore.updateRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'completed' })
    );
  });

  it('Tasks: updates TasksStore to cancelled when TTL already expired', async () => {
    await adapter.start(relay);
    const envelope = createTasksEnvelope({
      budget: {
        hopCount: 0,
        maxHops: 5,
        ancestorChain: [],
        ttl: Date.now() - 1000, // expired
        callBudgetRemaining: 5,
      },
    });

    const result = await adapter.deliver(envelope.subject, envelope);

    // Should fail due to expired TTL
    expect(result.success).toBe(false);
    // TasksStore should be updated (failed or cancelled)
    expect(taskStore.updateRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: expect.stringMatching(/failed|cancelled/) })
    );
  });

  it('Tasks: stops a parked run when the TTL budget runs out', async () => {
    await adapter.start(relay);
    const turn = parkedTurn();
    vi.mocked(agentManager.sendMessage).mockReturnValue(turn.stream);
    // The run outlives its budget while parked on a prompt: no further events
    // arrive, so nothing inside the consumer's loop body ever runs again.
    const envelope = createTasksEnvelope({
      budget: {
        hopCount: 0,
        maxHops: 5,
        ancestorChain: [],
        ttl: Date.now() + 150,
        callBudgetRemaining: 5,
      },
    });

    // Deliver concurrently and wait until the turn is genuinely parked before
    // the budget expires: a TTL that fired while the first event was still in
    // flight would be caught by the loop body and prove nothing.
    const delivery = adapter.deliver(envelope.subject, envelope);
    await turn.parked;
    const result = await delivery;

    // The runtime is told to stop, not merely marked stopped in the store —
    // and it is told by the run's SESSION id, not its run id (`interrupt.ts`
    // takes the id the turn actually runs under).
    const [sessionId] = vi.mocked(agentManager.sendMessage).mock.calls[0]!;
    expect(sessionId).not.toBe('run-1');
    expect(sessionId).toMatch(UUID_RE);
    expect(agentManager.interruptQuery).toHaveBeenCalledWith(sessionId);
    expect(taskStore.updateRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'cancelled' })
    );
    expect(result.success).toBe(false);
  });

  // === The tasks prefix is a claim, not a dispatch test (DOR-1567) ===

  describe('subjects beneath a task dispatch subject', () => {
    // A run's own progress used to be republished to
    // `relay.system.tasks.<id>.response`, which is under the prefix this
    // adapter claims. Every event came straight back in, failed to parse as a
    // dispatch, and dead-lettered: one live run produced 279 "could not be
    // delivered" notifications.
    const ECHO_SUBJECT = 'relay.system.tasks.sched-1.response';

    it('skips the echo instead of reading it as a malformed dispatch', async () => {
      await adapter.start(relay);
      const echo = createTasksEnvelope({
        subject: ECHO_SUBJECT,
        payload: { type: 'text_delta', data: { text: 'partial answer' } },
      });

      const result = await adapter.deliver(ECHO_SUBJECT, echo);

      // `skipped` is what keeps it out of the dead-letter queue: the publish
      // pipeline dead-letters every unsuccessful adapter delivery.
      expect(result).toMatchObject({ success: true, skipped: true });
      expect(traceStore.insertSpan).not.toHaveBeenCalled();
    });
  });

  // === What a scheduled run is told about itself (DOR-1567) ===

  describe('Tasks: the unattended context a relay-dispatched run carries', () => {
    it('starts a timer-started run unattended, so an ask nobody can answer is refused', async () => {
      await adapter.start(relay);
      const envelope = createTasksEnvelope();

      await adapter.deliver(envelope.subject, envelope);

      // The session id is a fresh UUID minted for this run, not the run id
      // itself — only the `unattended`/`permissionMode` relationship is what
      // this test is about.
      const [sessionId] = vi.mocked(agentManager.ensureSession).mock.calls[0]!;
      expect(sessionId).not.toBe('run-1');
      expect(sessionId).toMatch(UUID_RE);
      expect(agentManager.ensureSession).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ unattended: true, permissionMode: 'default' })
      );
    });

    it('leaves a "Run now" answerable, on this path as on the direct one', async () => {
      // A hand-started run can travel the bus too, and somebody is sitting in
      // front of it. A run must not lose its approval cards because of which
      // path carried it (spec `unattended-session-permission-prompts`).
      await adapter.start(relay);
      const base = createTasksEnvelope();
      const envelope = createTasksEnvelope({
        payload: { ...(base.payload as Record<string, unknown>), trigger: 'manual' },
      });

      await adapter.deliver(envelope.subject, envelope);

      const [sessionId] = vi.mocked(agentManager.ensureSession).mock.calls[0]!;
      expect(sessionId).not.toBe('run-1');
      expect(sessionId).toMatch(UUID_RE);
      expect(agentManager.ensureSession).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ unattended: false })
      );
    });

    it('hands the run its briefing and its permission mode', async () => {
      await adapter.start(relay);
      const envelope = createTasksEnvelope({
        payload: {
          ...(createTasksEnvelope().payload as Record<string, unknown>),
          systemPromptAppend: '=== TASK SCHEDULER CONTEXT ===\nDo not ask questions',
        },
      });

      await adapter.deliver(envelope.subject, envelope);

      const [sessionId] = vi.mocked(agentManager.sendMessage).mock.calls[0]!;
      expect(sessionId).not.toBe('run-1');
      expect(sessionId).toMatch(UUID_RE);
      expect(agentManager.sendMessage).toHaveBeenCalledWith(
        sessionId,
        'Check the budget',
        expect.objectContaining({
          permissionMode: 'default',
          systemPromptAppend: '=== TASK SCHEDULER CONTEXT ===\nDo not ask questions',
        })
      );
    });

    it('passes approved task rules to the run turn as task-scoped rules', async () => {
      const rule = 'Bash(/abs/path/script.sh --once)';
      await adapter.start(relay);
      const envelope = createTasksEnvelope({
        payload: {
          ...(createTasksEnvelope().payload as Record<string, unknown>),
          approvedAllow: [rule],
        },
      });

      await adapter.deliver(envelope.subject, envelope);

      expect(agentManager.sendMessage).toHaveBeenCalledWith(
        expect.any(String),
        'Check the budget',
        expect.objectContaining({ taskApprovedAllow: [rule] })
      );
    });
  });

  // === StreamEvent filter (Bug 1 guard) ===

  describe('agent message delivery', () => {
    it('skips every type StreamEventTypeSchema declares, not just the ones remembered above (DOR-804)', async () => {
      // The production guard derives its set from StreamEventTypeSchema.options
      // rather than a hand-copied literal (DOR-804), so a new stream event type
      // joins the guard automatically. This test reads from the SCHEMA
      // directly — not from the guard's own derived set, and not from the
      // literal list in the test above — so a future regression back to a
      // hand-copied, incomplete literal in production is what this test would
      // catch: it cannot move in lockstep with that regression the way
      // importing the production set would.
      await adapter.start(relay);

      for (const type of StreamEventTypeSchema.options) {
        vi.clearAllMocks();
        const envelope = createTestEnvelope({
          payload: { type, data: { text: 'response from peer agent' } },
          replyTo: 'relay.human.console.client-1',
        });

        const result = await adapter.deliver(envelope.subject, envelope);

        expect(result.success, `type=${type}`).toBe(true);
        expect(agentManager.sendMessage, `type=${type}`).not.toHaveBeenCalled();
      }
    });
  });
});

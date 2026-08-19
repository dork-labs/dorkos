import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AdapterDelivery, type AdapterDeliveryDeps } from '../adapter-delivery.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AdapterRegistryLike, DeliveryResult } from '../types.js';
import type { SqliteIndex } from '../sqlite-index.js';
import type { MaildirStore } from '../maildir-store.js';
import type { DeadLetterQueue } from '../dead-letter-queue.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Non-agent subject: exercises the awaited (timeout-protected) path. */
const CHANNEL_SUBJECT = 'relay.human.telegram.bot.chat-1';

/** Agent subject: exercises the detached (fire-and-forget) path. */
const AGENT_SUBJECT = 'relay.agent.test-session';

function createEnvelope(overrides?: Partial<RelayEnvelope>): RelayEnvelope {
  return {
    id: 'test-id',
    subject: CHANNEL_SUBJECT,
    from: 'relay.agent.sender',
    budget: {
      maxHops: 5,
      hopCount: 0,
      ttl: Date.now() + 3_600_000,
      callBudgetRemaining: 10,
      ancestorChain: [],
    },
    createdAt: new Date().toISOString(),
    payload: { hello: 'world' },
    ...overrides,
  };
}

function createMockAdapterRegistry(): AdapterRegistryLike {
  return {
    deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 100 } as DeliveryResult),
    setRelay: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

function createDeps(overrides?: Partial<AdapterDeliveryDeps>): AdapterDeliveryDeps {
  return {
    adapterRegistry: createMockAdapterRegistry(),
    sqliteIndex: { insertMessage: vi.fn() } as unknown as SqliteIndex,
    maildirStore: {
      ensureMaildir: vi.fn().mockResolvedValue(undefined),
    } as unknown as MaildirStore,
    deadLetterQueue: {
      reject: vi.fn().mockResolvedValue({ ok: true, messageId: 'test-id' }),
    } as unknown as DeadLetterQueue,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AdapterDelivery', () => {
  let deps: AdapterDeliveryDeps;

  beforeEach(() => {
    deps = createDeps();
  });

  describe('deliver (non-agent subjects — awaited path)', () => {
    it('returns null when no adapter registry is configured', async () => {
      const delivery = new AdapterDelivery(createDeps({ adapterRegistry: undefined }));
      const result = await delivery.deliver(CHANNEL_SUBJECT, createEnvelope());
      expect(result).toBeNull();
    });

    it('delivers successfully and indexes in SQLite', async () => {
      const delivery = new AdapterDelivery(deps);
      const envelope = createEnvelope();

      const result = await delivery.deliver(CHANNEL_SUBJECT, envelope);

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(deps.adapterRegistry!.deliver).toHaveBeenCalledWith(
        CHANNEL_SUBJECT,
        envelope,
        undefined
      );
      expect(deps.sqliteIndex.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: envelope.id,
          subject: CHANNEL_SUBJECT,
          status: 'delivered',
        })
      );
    });

    it('does not index when delivery fails', async () => {
      vi.mocked(deps.adapterRegistry!.deliver).mockResolvedValue({
        success: false,
        error: 'adapter error',
      } as DeliveryResult);
      const delivery = new AdapterDelivery(deps);

      const result = await delivery.deliver(CHANNEL_SUBJECT, createEnvelope());

      expect(result!.success).toBe(false);
      expect(deps.sqliteIndex.insertMessage).not.toHaveBeenCalled();
    });

    it('returns null (not a failure) when no adapter matches a non-agent subject', async () => {
      // A maildir-only publish with an adapter registry configured is not an
      // adapter failure — coercing null to {success:false} caused spurious
      // relay.message_failed activity events and misleading DLQ reasons.
      vi.mocked(deps.adapterRegistry!.deliver).mockResolvedValue(null);
      const delivery = new AdapterDelivery(deps);

      const result = await delivery.deliver(CHANNEL_SUBJECT, createEnvelope());

      expect(result).toBeNull();
      expect(deps.sqliteIndex.insertMessage).not.toHaveBeenCalled();
      expect(deps.logger!.warn).not.toHaveBeenCalled();
    });

    it('handles adapter errors gracefully', async () => {
      vi.mocked(deps.adapterRegistry!.deliver).mockRejectedValue(new Error('network error'));
      const delivery = new AdapterDelivery(deps);

      const result = await delivery.deliver(CHANNEL_SUBJECT, createEnvelope());

      expect(result).toEqual({
        success: false,
        error: 'network error',
        deadLettered: false,
        durationMs: undefined,
      });
      expect(deps.logger!.warn).toHaveBeenCalledWith(
        'RelayCore: adapter delivery failed:',
        'network error'
      );
    });

    it('clears timeout timer on success (no timer leak)', async () => {
      const delivery = new AdapterDelivery(deps);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      await delivery.deliver(CHANNEL_SUBJECT, createEnvelope());

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('clears timeout timer on error (no timer leak)', async () => {
      vi.mocked(deps.adapterRegistry!.deliver).mockRejectedValue(new Error('fail'));
      const delivery = new AdapterDelivery(deps);
      const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

      await delivery.deliver(CHANNEL_SUBJECT, createEnvelope());

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it('times out after TIMEOUT_MS', async () => {
      vi.useFakeTimers();
      vi.mocked(deps.adapterRegistry!.deliver).mockReturnValue(
        new Promise(() => {
          // Never resolves
        })
      );
      const delivery = new AdapterDelivery(deps);

      const promise = delivery.deliver(CHANNEL_SUBJECT, createEnvelope());
      vi.advanceTimersByTime(AdapterDelivery.TIMEOUT_MS);

      const result = await promise;
      expect(result!.success).toBe(false);
      expect(result!.error).toContain('timeout');

      vi.useRealTimers();
    });

    it('handles synchronous throw before timer initialization', async () => {
      vi.mocked(deps.adapterRegistry!.deliver).mockImplementation(() => {
        throw new Error('synchronous throw before timer init');
      });
      const delivery = new AdapterDelivery(deps);

      const result = await delivery.deliver(CHANNEL_SUBJECT, createEnvelope());

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: 'synchronous throw before timer init',
        })
      );
    });

    it('passes context from contextBuilder', async () => {
      const delivery = new AdapterDelivery(deps);
      const contextBuilder = vi.fn().mockReturnValue({ agentCwd: '/test' });

      await delivery.deliver(CHANNEL_SUBJECT, createEnvelope(), contextBuilder);

      expect(contextBuilder).toHaveBeenCalledWith(CHANNEL_SUBJECT);
      expect(deps.adapterRegistry!.deliver).toHaveBeenCalledWith(
        CHANNEL_SUBJECT,
        expect.any(Object),
        { agentCwd: '/test' }
      );
    });
  });

  describe('deliver (relay.agent.* subjects — detached path)', () => {
    it('returns null when the registry reports no matching adapter — no phantom acceptance', async () => {
      // If no adapter matches (e.g. the CCA adapter failed to start), the
      // message must fall back to the normal pending-buffer / dead-letter
      // pipeline instead of being counted as delivered and swallowed.
      const registry = createMockAdapterRegistry();
      registry.getBySubject = vi.fn().mockReturnValue(undefined);
      const delivery = new AdapterDelivery(createDeps({ adapterRegistry: registry }));

      const result = await delivery.deliver(
        AGENT_SUBJECT,
        createEnvelope({ subject: AGENT_SUBJECT })
      );

      expect(result).toBeNull();
      expect(registry.deliver).not.toHaveBeenCalled();
    });

    it('dead-letters when a registry without getBySubject resolves null in the background', async () => {
      // Acceptance was already reported, so a null (no adapter took the
      // message) must dead-letter rather than fall through silently.
      vi.mocked(deps.adapterRegistry!.deliver).mockResolvedValue(null);
      const delivery = new AdapterDelivery(deps);
      const envelope = createEnvelope({ subject: AGENT_SUBJECT });

      const result = await delivery.deliver(AGENT_SUBJECT, envelope);
      expect(result).toMatchObject({ success: true }); // accepted

      await vi.waitFor(() => {
        expect(deps.deadLetterQueue.reject).toHaveBeenCalledWith(
          AGENT_SUBJECT,
          envelope,
          'adapter delivery failed: no adapter matched subject'
        );
      });
      expect(deps.sqliteIndex.insertMessage).not.toHaveBeenCalled();
    });

    it('acknowledges acceptance immediately without awaiting the agent turn', async () => {
      // A never-resolving turn must not block publish().
      vi.mocked(deps.adapterRegistry!.deliver).mockReturnValue(
        new Promise(() => {
          // Never resolves — simulates a long-running agent turn
        })
      );
      const delivery = new AdapterDelivery(deps);

      const result = await delivery.deliver(
        AGENT_SUBJECT,
        createEnvelope({ subject: AGENT_SUBJECT })
      );

      expect(result).toMatchObject({ success: true });
      expect(deps.adapterRegistry!.deliver).toHaveBeenCalledWith(
        AGENT_SUBJECT,
        expect.objectContaining({ subject: AGENT_SUBJECT }),
        // The detached path always hands the adapter a context, even when the
        // caller built none: it carries `onHeld`, the adapter's way of saying
        // this message is waiting for a free slot rather than lost.
        { onHeld: expect.any(Function) }
      );
    });

    it('agent turns longer than TIMEOUT_MS are not failed by the delivery timeout', async () => {
      vi.useFakeTimers();
      let resolveTurn: (r: DeliveryResult) => void = () => {};
      vi.mocked(deps.adapterRegistry!.deliver).mockReturnValue(
        new Promise<DeliveryResult>((resolve) => {
          resolveTurn = resolve;
        })
      );
      const delivery = new AdapterDelivery(deps);

      const result = await delivery.deliver(
        AGENT_SUBJECT,
        createEnvelope({ subject: AGENT_SUBJECT })
      );
      expect(result!.success).toBe(true);

      // Well past the adapter timeout the turn finally completes — no
      // dead letter is written and the audit row is indexed.
      vi.advanceTimersByTime(AdapterDelivery.TIMEOUT_MS * 3);
      resolveTurn({ success: true, durationMs: AdapterDelivery.TIMEOUT_MS * 3 });
      await vi.runAllTimersAsync();

      expect(deps.deadLetterQueue.reject).not.toHaveBeenCalled();
      expect(deps.sqliteIndex.insertMessage).toHaveBeenCalledWith(
        expect.objectContaining({ subject: AGENT_SUBJECT, status: 'delivered' })
      );
      vi.useRealTimers();
    });

    it('dead-letters when the background delivery reports failure', async () => {
      vi.mocked(deps.adapterRegistry!.deliver).mockResolvedValue({
        success: false,
        error: 'agent session crashed',
      } as DeliveryResult);
      const delivery = new AdapterDelivery(deps);
      const envelope = createEnvelope({ subject: AGENT_SUBJECT });

      const result = await delivery.deliver(AGENT_SUBJECT, envelope);
      expect(result!.success).toBe(true); // accepted

      await vi.waitFor(() => {
        expect(deps.deadLetterQueue.reject).toHaveBeenCalledWith(
          AGENT_SUBJECT,
          envelope,
          'adapter delivery failed: agent session crashed'
        );
      });
      expect(deps.maildirStore.ensureMaildir).toHaveBeenCalledWith(AGENT_SUBJECT);
      expect(deps.sqliteIndex.insertMessage).not.toHaveBeenCalled();
    });

    it('dead-letters when the background delivery throws', async () => {
      vi.mocked(deps.adapterRegistry!.deliver).mockRejectedValue(new Error('boom'));
      const delivery = new AdapterDelivery(deps);
      const envelope = createEnvelope({ subject: AGENT_SUBJECT });

      const result = await delivery.deliver(AGENT_SUBJECT, envelope);
      expect(result!.success).toBe(true); // accepted

      await vi.waitFor(() => {
        expect(deps.deadLetterQueue.reject).toHaveBeenCalledWith(
          AGENT_SUBJECT,
          envelope,
          'adapter delivery failed: boom'
        );
      });
    });

    it('indexes the audit row when the background delivery succeeds', async () => {
      const delivery = new AdapterDelivery(deps);
      const envelope = createEnvelope({ subject: AGENT_SUBJECT });

      await delivery.deliver(AGENT_SUBJECT, envelope);

      await vi.waitFor(() => {
        expect(deps.sqliteIndex.insertMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            id: envelope.id,
            subject: AGENT_SUBJECT,
            status: 'delivered',
          })
        );
      });
      expect(deps.deadLetterQueue.reject).not.toHaveBeenCalled();
    });

    it('notifies the reply inbox when a detached delivery dead-letters', async () => {
      const notifier = vi.fn().mockResolvedValue(undefined);
      vi.mocked(deps.adapterRegistry!.deliver).mockResolvedValue({
        success: false,
        error: 'agent crashed',
      } as DeliveryResult);
      const delivery = new AdapterDelivery(deps);
      delivery.setReplyFailureNotifier(notifier);
      const envelope = createEnvelope({
        subject: AGENT_SUBJECT,
        replyTo: 'relay.inbox.query.abc',
      });

      await delivery.deliver(AGENT_SUBJECT, envelope);

      await vi.waitFor(() => {
        expect(notifier).toHaveBeenCalledWith('relay.inbox.query.abc', 'agent crashed', envelope);
      });
    });

    it('does not notify when the envelope has no replyTo', async () => {
      const notifier = vi.fn().mockResolvedValue(undefined);
      vi.mocked(deps.adapterRegistry!.deliver).mockResolvedValue({
        success: false,
        error: 'agent crashed',
      } as DeliveryResult);
      const delivery = new AdapterDelivery(deps);
      delivery.setReplyFailureNotifier(notifier);

      await delivery.deliver(AGENT_SUBJECT, createEnvelope({ subject: AGENT_SUBJECT }));

      await vi.waitFor(() => expect(deps.deadLetterQueue.reject).toHaveBeenCalled());
      expect(notifier).not.toHaveBeenCalled();
    });

    it('swallows a throwing notifier so it never cascades', async () => {
      const notifier = vi.fn().mockRejectedValue(new Error('notify boom'));
      vi.mocked(deps.adapterRegistry!.deliver).mockResolvedValue({
        success: false,
        error: 'agent crashed',
      } as DeliveryResult);
      const delivery = new AdapterDelivery(deps);
      delivery.setReplyFailureNotifier(notifier);
      const envelope = createEnvelope({
        subject: AGENT_SUBJECT,
        replyTo: 'relay.inbox.query.abc',
      });

      const result = await delivery.deliver(AGENT_SUBJECT, envelope);
      expect(result).toMatchObject({ success: true });

      await vi.waitFor(() => {
        expect(deps.logger!.warn).toHaveBeenCalledWith(
          expect.stringContaining('failed to notify reply inbox')
        );
      });
    });
  });

  // A chat message's replyTo IS the chat. The reply-inbox notifier above
  // deliberately ignores those subjects, so before this the person whose turn
  // died at the capacity check was told nothing at all (DOR-789).
  describe('chat failure notice (detached path)', () => {
    it('tells the chat when the runtime turned the turn away at capacity', async () => {
      const chatNotice = vi.fn().mockResolvedValue(true);
      vi.mocked(deps.adapterRegistry!.deliver).mockResolvedValue({
        success: false,
        // The machine code decides, so rewording the message cannot break it.
        code: 'at_capacity',
        error: 'the runtime is not taking any more right now',
      } as DeliveryResult);
      const delivery = new AdapterDelivery(deps);
      delivery.setChatFailureNotifier(chatNotice);

      await delivery.deliver(
        AGENT_SUBJECT,
        createEnvelope({ subject: AGENT_SUBJECT, replyTo: CHANNEL_SUBJECT })
      );

      await vi.waitFor(() =>
        expect(chatNotice).toHaveBeenCalledWith(CHANNEL_SUBJECT, 'agent_busy')
      );
    });

    it('never licenses an AWAITED delivery to wait for capacity', async () => {
      const delivery = new AdapterDelivery(deps);

      await delivery.deliver(CHANNEL_SUBJECT, createEnvelope());

      // `onHeld` is the adapter's licence to park a delivery, and the awaited
      // path must never grant it: a parked delivery here would sit in the
      // adapter's line spending this caller's 120s timeout, and report a
      // timeout where the truth was capacity.
      // Seeded defect: build the held context in `deliver()` instead of
      // `deliverDetached()`. Every Tasks dispatch and control message then
      // becomes holdable, and a stop published while a run is parked never
      // resolves at all.
      const context = vi.mocked(deps.adapterRegistry!.deliver).mock.calls[0]![2];
      expect(context?.onHeld).toBeUndefined();
    });

    it('tells the chat its message is waiting when the adapter parks it', async () => {
      const chatNotice = vi.fn().mockResolvedValue(true);
      // An adapter that HOLDS: it announces the wait, then succeeds. Nothing is
      // dead-lettered, because nothing was dropped.
      vi.mocked(deps.adapterRegistry!.deliver).mockImplementation(
        async (_subject, _envelope, context) => {
          context?.onHeld?.();
          return { success: true } as DeliveryResult;
        }
      );
      const delivery = new AdapterDelivery(deps);
      delivery.setChatFailureNotifier(chatNotice);

      await delivery.deliver(
        AGENT_SUBJECT,
        createEnvelope({ subject: AGENT_SUBJECT, replyTo: CHANNEL_SUBJECT })
      );

      // Seeded defect: pass `context` straight through to the registry instead
      // of the `heldContext` that carries `onHeld`. The adapter then holds the
      // message in silence and the chat sees nothing until the answer lands.
      await vi.waitFor(() =>
        expect(chatNotice).toHaveBeenCalledWith(CHANNEL_SUBJECT, 'agent_held')
      );
      expect(deps.deadLetterQueue.reject).not.toHaveBeenCalled();
      // `agent_held` and nothing else: a held message is not a failed one.
      expect(chatNotice.mock.calls.map((call) => call[1])).toEqual(['agent_held']);
    });

    it('says nothing about a hold in a chat that has no reply subject', async () => {
      const chatNotice = vi.fn().mockResolvedValue(true);
      vi.mocked(deps.adapterRegistry!.deliver).mockImplementation(
        async (_subject, _envelope, context) => {
          context?.onHeld?.();
          return { success: true } as DeliveryResult;
        }
      );
      const delivery = new AdapterDelivery(deps);
      delivery.setChatFailureNotifier(chatNotice);

      await delivery.deliver(AGENT_SUBJECT, createEnvelope({ subject: AGENT_SUBJECT }));
      await new Promise((r) => setTimeout(r, 20));

      expect(chatNotice).not.toHaveBeenCalled();
    });

    it('reports a hold that ran out of time as the busy line, not a resend request', async () => {
      const chatNotice = vi.fn().mockResolvedValue(true);
      // The whole life of a hold that never got its slot: it announces the
      // wait, then gives up at the ceiling and reports capacity.
      vi.mocked(deps.adapterRegistry!.deliver).mockImplementation(
        async (_subject, _envelope, context) => {
          context?.onHeld?.();
          return {
            success: false,
            code: 'at_capacity',
            error: 'waited 300000ms for a free session slot and none came free',
          } as DeliveryResult;
        }
      );
      const delivery = new AdapterDelivery(deps);
      delivery.setChatFailureNotifier(chatNotice);

      await delivery.deliver(
        AGENT_SUBJECT,
        createEnvelope({ subject: AGENT_SUBJECT, replyTo: CHANNEL_SUBJECT })
      );

      // Both lines, in order, on separate damper keys: "it is waiting", then
      // "it stayed busy". Seeded defect: reuse `agent_held` for the expiry.
      // The damper swallows the second line and the hold ends in silence —
      // the person is left with a promise the machine quietly broke.
      await vi.waitFor(() =>
        expect(chatNotice.mock.calls.map((call) => call[1])).toEqual(['agent_held', 'agent_busy'])
      );
      expect(deps.deadLetterQueue.reject).toHaveBeenCalledTimes(1);
    });

    it('reports any other failure as a plain delivery failure', async () => {
      const chatNotice = vi.fn().mockResolvedValue(true);
      vi.mocked(deps.adapterRegistry!.deliver).mockResolvedValue({
        success: false,
        error: 'runtime exploded',
      } as DeliveryResult);
      const delivery = new AdapterDelivery(deps);
      delivery.setChatFailureNotifier(chatNotice);

      await delivery.deliver(
        AGENT_SUBJECT,
        createEnvelope({ subject: AGENT_SUBJECT, replyTo: CHANNEL_SUBJECT })
      );

      await vi.waitFor(() =>
        expect(chatNotice).toHaveBeenCalledWith(CHANNEL_SUBJECT, 'delivery_failed')
      );
    });

    it('says nothing when there is no reply subject to say it in', async () => {
      const chatNotice = vi.fn().mockResolvedValue(true);
      vi.mocked(deps.adapterRegistry!.deliver).mockResolvedValue({
        success: false,
        error: 'runtime exploded',
      } as DeliveryResult);
      const delivery = new AdapterDelivery(deps);
      delivery.setChatFailureNotifier(chatNotice);

      await delivery.deliver(AGENT_SUBJECT, createEnvelope({ subject: AGENT_SUBJECT }));

      await vi.waitFor(() => expect(deps.deadLetterQueue.reject).toHaveBeenCalled());
      expect(chatNotice).not.toHaveBeenCalled();
    });
  });
});

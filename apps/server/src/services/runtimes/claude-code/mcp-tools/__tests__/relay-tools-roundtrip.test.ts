/**
 * Integration: relay MCP tools against a REAL RelayCore with a CCA-like adapter.
 *
 * Regression coverage for the delivery-loss cluster:
 * - H1: relay_send_and_wait subscribes before publishing and agent delivery is
 *   detached, so progress events streamed DURING the agent turn reach the
 *   caller (the old code subscribed after a publish that blocked on the whole
 *   turn — progress was always lost and long turns dead-lettered).
 * - C2: relay_send_async + relay_inbox polling returns actual payloads and
 *   ack transitions messages out of unread.
 *
 * Unlike relay-cca-roundtrip.test.ts (which subscribes manually before
 * publishing and masked H1), this exercises the real tool handlers in their
 * real call order.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RelayCore } from '@dorkos/relay';
import type { AdapterRegistryLike, RelayPublisher, DeliveryResult } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import {
  createRelayQueryHandler,
  createRelayDispatchHandler,
  createRelayInboxHandler,
} from '../relay-tools.js';
import type { McpToolDeps } from '../types.js';
import type { SenderIdentity } from '../relay-helpers.js';

/** Server-injected caller identity (relay tools no longer accept a `from` arg). */
const CALLER: SenderIdentity = { subject: 'relay.agent.caller', agentId: 'caller' };

/**
 * Adapter registry that mimics ClaudeCodeAdapter's behavior for
 * relay.agent.* deliveries: it streams progress events and a final
 * agent_result to envelope.replyTo WHILE the turn runs, and its deliver()
 * promise resolves only after the whole turn completes — exactly the shape
 * that made the old awaited-publish ordering lose progress events.
 */
class FakeAgentTurnRegistry implements AdapterRegistryLike {
  private relay: RelayPublisher | null = null;

  setRelay(relay: RelayPublisher): void {
    this.relay = relay;
  }

  async deliver(subject: string, envelope: RelayEnvelope): Promise<DeliveryResult | null> {
    if (!subject.startsWith('relay.agent.') || !envelope.replyTo || !this.relay) return null;

    const reply = (payload: unknown) =>
      this.relay!.publish(envelope.replyTo!, payload, {
        from: 'agent:responder',
        budget: { hopCount: envelope.budget.hopCount + 1 },
      });

    // Simulated agent turn: two progress steps, then the final result.
    await tick();
    await reply({ type: 'progress', step: 1, step_type: 'message', text: 'thinking', done: false });
    await tick();
    await reply({
      type: 'progress',
      step: 2,
      step_type: 'tool_result',
      text: 'tool output',
      done: false,
    });
    await tick();
    await reply({ type: 'agent_result', text: 'final answer', done: true });

    return { success: true, durationMs: 30 };
  }

  async shutdown(): Promise<void> {}
}

/** Yield to the event loop so each reply lands as a distinct delivery. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function parse(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('relay MCP tools → real RelayCore round-trip', () => {
  let tmpDir: string;
  let relay: RelayCore;
  let deps: McpToolDeps;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-tools-roundtrip-'));
    relay = new RelayCore({ dataDir: tmpDir, adapterRegistry: new FakeAgentTurnRegistry() });
    deps = { relayCore: relay } as McpToolDeps;
  });

  afterEach(async () => {
    await relay.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('relay_send_and_wait receives progress events + final result with real tool ordering (H1)', async () => {
    const handler = createRelayQueryHandler(deps, CALLER);

    const result = await handler({
      to_subject: 'relay.agent.responder',
      payload: { task: 'answer the question' },
      timeout_ms: 10_000,
    });

    expect(result.isError).toBeUndefined();
    const data = parse(result);

    expect(data.reply).toMatchObject({ type: 'agent_result', text: 'final answer', done: true });
    expect(data.progress).toEqual([
      { type: 'progress', step: 1, step_type: 'message', text: 'thinking', done: false },
      { type: 'progress', step: 2, step_type: 'tool_result', text: 'tool output', done: false },
    ]);
    expect(data.sentMessageId).toBeTruthy();
    expect(data.replyMessageId).toBeTruthy();

    // Ephemeral query inbox is cleaned up.
    expect(relay.listEndpoints()).toHaveLength(0);
  });

  it('relay_send_async + relay_inbox polling returns payloads and ack drains unread (C2)', async () => {
    const dispatchHandler = createRelayDispatchHandler(deps, CALLER);
    const inboxHandler = createRelayInboxHandler(deps);

    const dispatchResult = await dispatchHandler({
      to_subject: 'relay.agent.responder',
      payload: { task: 'long-running work' },
    });
    expect(dispatchResult.isError).toBeUndefined();
    const { inboxSubject } = parse(dispatchResult) as { inboxSubject: string };
    expect(inboxSubject).toMatch(/^relay\.inbox\.dispatch\./);

    // Wait for the detached agent turn to finish streaming into the inbox.
    await vi.waitFor(async () => {
      const peek = parse(await inboxHandler({ endpoint_subject: inboxSubject, status: 'unread' }));
      expect((peek.messages as unknown[]).length).toBe(3);
    });

    // Poll with ack: payloads are the actual envelope contents.
    const polled = parse(
      await inboxHandler({ endpoint_subject: inboxSubject, status: 'unread', ack: true })
    );
    const payloads = (polled.messages as Array<{ payload: Record<string, unknown> }>).map(
      (m) => m.payload
    );
    expect(payloads[0]).toMatchObject({ type: 'progress', step: 1, done: false });
    expect(payloads[1]).toMatchObject({ type: 'progress', step: 2, done: false });
    expect(payloads[2]).toMatchObject({ type: 'agent_result', text: 'final answer', done: true });

    // Acked messages stop being returned as unread — polling terminates.
    const afterAck = parse(
      await inboxHandler({ endpoint_subject: inboxSubject, status: 'unread' })
    );
    expect(afterAck.messages).toEqual([]);
  });
});

/**
 * Integration: platform message → binding router → agent turn → reply delivery,
 * through the REAL RelayCore + REAL BindingStore + REAL BindingRouter.
 *
 * The unit test (`binding-router.test.ts`) mocks the relay and drives the
 * captured handler directly — it can't catch the seam drifting (subject
 * grammar, subscription wildcard, reply fan-out to the platform adapter, the
 * agent-reply echo guard). This test wires the real relay so a Telegram-shaped
 * inbound StandardPayload actually flows: it resolves a binding, triggers a
 * turn, and the agent's reply is delivered back to the platform adapter's
 * `deliver()` path — with echo prevention keeping it from looping, and a
 * crashed turn surfacing as the error+done sequence at the platform.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RelayCore } from '@dorkos/relay';
import type { RelayPublisher, AdapterRegistryLike, DeliveryResult } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { BindingRouter } from '../binding-router.js';
import { BindingStore } from '../binding-store.js';
import type { AdapterMeshCoreLike } from '../adapter-manager.js';

const PLATFORM_SUBJECT = 'relay.human.telegram.tg-bot.12345';
const PROJECT_PATH = '/proj/agent-a';

interface Recorded {
  subject: string;
  envelope: RelayEnvelope;
}

/**
 * A CCA-shaped multiplexing adapter registry:
 * - `relay.agent.*` deliveries record the dispatch and stream a realistic reply
 *   (text_delta… then done, or error then done) back to the envelope's replyTo.
 * - `relay.human.*` deliveries record the platform-side delivery — this is the
 *   adapter `deliver()` path the agent reply must reach.
 */
class SeamRegistry implements AdapterRegistryLike {
  private relay: RelayPublisher | null = null;
  readonly dispatches: Recorded[] = [];
  readonly platformDeliveries: Recorded[] = [];
  mode: 'ok' | 'crash' = 'ok';

  setRelay(relay: RelayPublisher): void {
    this.relay = relay;
  }

  async deliver(subject: string, envelope: RelayEnvelope): Promise<DeliveryResult | null> {
    if (subject.startsWith('relay.agent.')) {
      this.dispatches.push({ subject, envelope });
      const replyTo = envelope.replyTo;
      const relay = this.relay;
      if (replyTo && relay) setTimeout(() => void this.stream(relay, replyTo), 0);
      return { success: true };
    }
    if (subject.startsWith('relay.human.')) {
      this.platformDeliveries.push({ subject, envelope });
      return { success: true };
    }
    return null;
  }

  async shutdown(): Promise<void> {
    /* nothing to tear down */
  }

  private async stream(relay: RelayPublisher, replyTo: string): Promise<void> {
    const from = 'agent:cca-session-1';
    if (this.mode === 'crash') {
      await relay.publish(
        replyTo,
        { type: 'error', data: { message: 'SDK session crashed' } },
        {
          from,
        }
      );
      await relay.publish(
        replyTo,
        { type: 'done', data: { sessionId: 'cca-session-1' } },
        { from }
      );
      return;
    }
    await relay.publish(replyTo, { type: 'text_delta', data: { text: 'Hi back!' } }, { from });
    await relay.publish(replyTo, { type: 'done', data: { sessionId: 'cca-session-1' } }, { from });
  }

  /** Platform deliveries that carry an agent reply (from `agent:…`), not the inbound echo. */
  agentReplies(): RelayEnvelope[] {
    return this.platformDeliveries
      .filter((d) => d.envelope.from.startsWith('agent:'))
      .map((d) => d.envelope);
  }
}

const tempDirs: string[] = [];
let relay: RelayCore;
let bindingStore: BindingStore;
let router: BindingRouter;
let registry: SeamRegistry;
let createSession: ReturnType<typeof vi.fn>;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'binding-router-int-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  const dataDir = await makeTempDir();
  const relayDir = await makeTempDir();

  registry = new SeamRegistry();
  relay = new RelayCore({ dataDir, adapterRegistry: registry });

  bindingStore = new BindingStore(relayDir);
  await bindingStore.init();
  await bindingStore.create({ adapterId: 'tg-bot', agentId: 'agent-a' });

  createSession = vi.fn(async () => ({ id: 'session-1' }));

  const meshCore = {
    getProjectPath: (agentId: string) => (agentId === 'agent-a' ? PROJECT_PATH : undefined),
  } as unknown as AdapterMeshCoreLike;

  router = new BindingRouter({
    bindingStore,
    relayCore: relay,
    agentManager: { createSession },
    meshCore,
    relayDir,
    runtimeResolver: { getSessionRuntimeType: async () => 'claude-code' },
  });
  await router.init();
});

afterEach(async () => {
  await router.shutdown();
  await bindingStore.shutdown();
  await relay.close();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** Publish a Telegram-shaped inbound StandardPayload onto the platform subject. */
async function sendInbound(content: string): Promise<void> {
  await relay.publish(
    PLATFORM_SUBJECT,
    { content },
    { from: 'relay.human.telegram.tg-bot.bot', replyTo: PLATFORM_SUBJECT }
  );
}

describe('platform → binding router → agent turn → reply delivery (real relay)', () => {
  it('triggers a turn, dispatches enriched payload, and delivers the reply to the platform without looping', async () => {
    await sendInbound('Hello from Telegram');

    // Turn triggered exactly once — the agent reply (from agent:) does not loop
    // back into a second turn (the from:'agent:' echo guard).
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession).toHaveBeenCalledWith(PROJECT_PATH, 'acceptEdits');

    // Dispatched to the runtime-scoped agent subject with the enriched payload.
    await vi.waitFor(() => expect(registry.dispatches.length).toBe(1));
    const dispatch = registry.dispatches[0]!;
    expect(dispatch.subject).toBe('relay.agent.claude-code.session-1');
    const payload = dispatch.envelope.payload as Record<string, unknown>;
    expect(payload.content).toBe('Hello from Telegram');
    expect(payload.cwd).toBe(PROJECT_PATH);
    expect(payload.__bindingPermissions).toBeDefined();

    // The agent reply reached the platform adapter's deliver() path.
    await vi.waitFor(() => {
      const replies = registry.agentReplies();
      expect(replies.some((e) => (e.payload as Record<string, unknown>).type === 'done')).toBe(
        true
      );
    });
    const replyTypes = registry
      .agentReplies()
      .map((e) => (e.payload as Record<string, unknown>).type);
    expect(replyTypes).toContain('text_delta');
    expect(replyTypes).toContain('done');

    // Still exactly one turn after the reply round-trip — no echo loop.
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('a crashed turn surfaces as the error+done sequence at the platform, without looping', async () => {
    registry.mode = 'crash';
    await sendInbound('Do something risky');

    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

    // The failure is delivered to the platform as error then done (PR #123 contract).
    await vi.waitFor(() => {
      const types = registry.agentReplies().map((e) => (e.payload as Record<string, unknown>).type);
      expect(types).toEqual(['error', 'done']);
    });
    const errorReply = registry
      .agentReplies()
      .find((e) => (e.payload as Record<string, unknown>).type === 'error');
    expect((errorReply!.payload as { data: { message: string } }).data.message).toContain(
      'SDK session crashed'
    );

    // The error reply did not re-trigger a turn.
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});

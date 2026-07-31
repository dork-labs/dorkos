/**
 * Integration: a chat message the router refuses, through the REAL RelayCore.
 *
 * Nine conditions could stop a chat message before the agent ran, and every one
 * of them ended at a log line: the person saw nothing, and the delivery trace
 * said `delivered` for a turn that never happened (DOR-789). These tests drive
 * the real relay so all three halves are exercised at once — the notice
 * actually reaches the platform adapter's `deliver()`, the notice does not loop
 * back as a new prompt, and the trace tells the truth.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RelayCore, createChatNoticeSender, CHAT_NOTICE_SENDER } from '@dorkos/relay';
import type {
  RelayPublisher,
  AdapterRegistryLike,
  DeliveryResult,
  TraceStoreLike,
} from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { BindingRouter } from '../binding-router.js';
import { BindingStore } from '../binding-store.js';
import { createInitiateConsentGate } from '../initiate-consent.js';
import type { AdapterMeshCoreLike } from '../adapter-manager.js';

const PLATFORM_SUBJECT = 'relay.human.telegram.tg-bot.12345';
const PROJECT_PATH = '/proj/agent-a';

interface Recorded {
  subject: string;
  envelope: RelayEnvelope;
}

/** Records what reached the platform and what reached an agent. */
class RecordingRegistry implements AdapterRegistryLike {
  readonly dispatches: Recorded[] = [];
  readonly platformDeliveries: Recorded[] = [];

  setRelay(_relay: RelayPublisher): void {
    /* nothing to hold */
  }

  async deliver(subject: string, envelope: RelayEnvelope): Promise<DeliveryResult | null> {
    if (subject.startsWith('relay.agent.')) {
      this.dispatches.push({ subject, envelope });
      return { success: true };
    }
    if (subject.startsWith('relay.human.')) {
      // The real adapters skip an echo of their own inbound publish; only a
      // message from somebody else is actually sent to the chat.
      if (envelope.from.startsWith('relay.human.telegram')) {
        return { success: true, skipped: true };
      }
      this.platformDeliveries.push({ subject, envelope });
      return { success: true };
    }
    return null;
  }

  async shutdown(): Promise<void> {
    /* nothing to tear down */
  }

  /** What a person would actually read in the chat. */
  noticeTexts(): string[] {
    return this.platformDeliveries
      .filter((d) => d.envelope.from === CHAT_NOTICE_SENDER)
      .map((d) => String((d.envelope.payload as { content?: unknown }).content ?? ''));
  }
}

const tempDirs: string[] = [];
let relay: RelayCore;
let bindingStore: BindingStore;
let router: BindingRouter;
let registry: RecordingRegistry;
let createSession: ReturnType<typeof vi.fn<() => Promise<{ id: string }>>>;
let spans: Array<Record<string, unknown>>;
let bindingId: string;
let knownAgents: Set<string>;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-refusal-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * The span the publish pipeline recorded for the inbound message on a subject.
 *
 * The LAST one, deliberately: a refusal publishes its notice to the same chat
 * subject from inside the inbound handler, so that notice's span is recorded
 * first and the inbound message's own span closes afterwards.
 */
function spanFor(subject: string): Record<string, unknown> | undefined {
  return spans.filter((s) => s.subject === subject).at(-1);
}

beforeEach(async () => {
  const dataDir = await makeTempDir();
  const relayDir = await makeTempDir();

  spans = [];
  knownAgents = new Set(['agent-a']);
  registry = new RecordingRegistry();
  const traceStore: TraceStoreLike = {
    insertSpan: (span) => {
      spans.push(span as Record<string, unknown>);
    },
    updateSpan: () => {},
  };
  relay = new RelayCore({ dataDir, adapterRegistry: registry, traceStore });

  bindingStore = new BindingStore(relayDir);
  await bindingStore.init();
  const binding = await bindingStore.create({ adapterId: 'tg-bot', agentId: 'agent-a' });
  bindingId = binding.id;

  relay.setInitiateConsentGate(
    createInitiateConsentGate({
      bindingStore,
      resolveAgentSubject: (agentId) =>
        agentId === 'agent-a' ? 'relay.agent.ns.agent-a' : undefined,
    })
  );

  createSession = vi.fn(async () => ({ id: 'session-1' }));

  const meshCore = {
    getProjectPath: (agentId: string) => (knownAgents.has(agentId) ? PROJECT_PATH : undefined),
  } as unknown as AdapterMeshCoreLike;

  router = new BindingRouter({
    bindingStore,
    relayCore: relay,
    agentManager: { createSession },
    meshCore,
    relayDir,
    runtimeResolver: { getSessionRuntimeType: async () => 'claude-code' },
    chatNotice: createChatNoticeSender({
      publish: (subject, payload, options) => relay.publish(subject, payload, options),
    }),
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

/** Publish a Telegram-shaped inbound message onto the platform subject. */
async function sendInbound(content: string): Promise<void> {
  await relay.publish(
    PLATFORM_SUBJECT,
    { content },
    { from: 'relay.human.telegram.tg-bot.bot', replyTo: PLATFORM_SUBJECT }
  );
}

describe('a refused chat message', () => {
  it('reaches the person as a line in their own chat when the binding is paused', async () => {
    await bindingStore.update(bindingId, { enabled: false });

    await sendInbound('anyone there?');

    await vi.waitFor(() => expect(registry.noticeTexts()).toHaveLength(1));
    expect(registry.noticeTexts()[0]).toContain('paused');
    // …and nothing ran.
    expect(createSession).not.toHaveBeenCalled();
    expect(registry.dispatches).toHaveLength(0);
  });

  it('never becomes a new prompt for the agent', async () => {
    await bindingStore.update(bindingId, { enabled: false });

    await sendInbound('anyone there?');
    await vi.waitFor(() => expect(registry.noticeTexts()).toHaveLength(1));

    // The notice is published to the same chat subject the router subscribes
    // to. Without the system-principal guard it would be routed straight back
    // into a turn — the loop this design has to avoid.
    expect(registry.dispatches).toHaveLength(0);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('says so once, however many times the person retries', async () => {
    await bindingStore.update(bindingId, { enabled: false });

    await sendInbound('hello?');
    await sendInbound('hello??');
    await sendInbound('hello???');

    await vi.waitFor(() => expect(registry.noticeTexts().length).toBeGreaterThan(0));
    expect(registry.noticeTexts()).toHaveLength(1);
  });

  it('does not trace as delivered, and names the cause', async () => {
    await bindingStore.update(bindingId, { enabled: false });

    await sendInbound('anyone there?');
    await vi.waitFor(() => expect(registry.noticeTexts()).toHaveLength(1));

    const span = spanFor(PLATFORM_SUBJECT);
    expect(span).toBeDefined();
    expect(span!.status).not.toBe('delivered');
    expect(String(span!.error)).toContain('paused');
  });

  it('tells the person when the chat is set not to reach its agent', async () => {
    await bindingStore.update(bindingId, { canReceive: false });

    await sendInbound('hi');

    await vi.waitFor(() => expect(registry.noticeTexts()).toHaveLength(1));
    expect(registry.noticeTexts()[0]).toContain('not to send messages');
    expect(createSession).not.toHaveBeenCalled();
  });

  it('tells the person when the bound agent is gone', async () => {
    knownAgents.clear();

    await sendInbound('hi');

    await vi.waitFor(() => expect(registry.noticeTexts()).toHaveLength(1));
    expect(registry.noticeTexts()[0]).toContain('not available');
  });

  it('tells the person when the session cannot be started', async () => {
    createSession.mockRejectedValue(new Error('no runtime'));

    await sendInbound('hi');

    await vi.waitFor(() => expect(registry.noticeTexts()).toHaveLength(1));
    expect(registry.noticeTexts()[0]).toContain('could not start a session');
    const span = spanFor(PLATFORM_SUBJECT);
    expect(span!.status).not.toBe('delivered');
  });

  it('stays silent in a chat nothing is bound to, and still traces the drop', async () => {
    const unbound = 'relay.human.telegram.tg-bot-other.999';
    await relay.publish(
      unbound,
      { content: 'hi' },
      { from: 'relay.human.telegram.tg-bot-other.bot', replyTo: unbound }
    );

    // Nobody asked this machine to speak here, and speaking would be starting a
    // conversation it has no consent for.
    expect(registry.noticeTexts()).toHaveLength(0);
    const span = spanFor(unbound);
    expect(span).toBeDefined();
    expect(span!.status).not.toBe('delivered');
    expect(String(span!.error)).toContain('no binding');
  });
});

describe('a routed chat message', () => {
  it('still runs the turn and traces as delivered', async () => {
    await sendInbound('do the thing');

    await vi.waitFor(() => expect(registry.dispatches).toHaveLength(1));
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(registry.noticeTexts()).toHaveLength(0);
    expect(spanFor(PLATFORM_SUBJECT)!.status).toBe('delivered');
  });
});

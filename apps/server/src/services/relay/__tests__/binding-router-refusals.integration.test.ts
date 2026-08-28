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
import type { ChatBridgeIngest, IngestResult } from '../chat-bridge/index.js';
import { BindingStore } from '../binding-store.js';
import { createInitiateConsentGate } from '../initiate-consent.js';
import { makeChatNoticeTargetResolver } from '../binding-subsystem.js';
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
let bridgeIngest: ChatBridgeIngest & { ingest: ReturnType<typeof vi.fn> };
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
  // The inbound chat bridge, as the router sees it: a `bridge: 'room'` binding
  // routes here (chats-as-channels §5.1) instead of to session dispatch.
  bridgeIngest = {
    ingest: vi.fn(async (): Promise<IngestResult> => ({
      status: 'ingested',
      entryId: 'e1',
      joined: false,
    })),
  };

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
      resolveTarget: makeChatNoticeTargetResolver(bindingStore),
    }),
    bridgeIngest,
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

  // The loop guard is NOT tested here on purpose: with a paused binding nothing
  // routes either way, so the assertion holds with or without the guard and
  // proves nothing. `chat-notice-boundaries.integration.test.ts` drives the
  // discriminating case — a HEALTHY binding whose turn dies — where removing
  // the guard really does produce a second dispatch.

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

describe('the interim empty-content gate (DOR-866)', () => {
  // The Telegram adapter publishes a captionless photo/sticker/voice/
  // document/video/location with `content: ''` and a `platformData.media`
  // descriptor (spec `chats-as-channels` §5.5) so a future bridge (task 1.6)
  // can build a placeholder from it. Nothing on the classic, unbridged path
  // reads that descriptor yet — without this gate, an empty-content envelope
  // reaches a real agent turn and the agent replies about a message that
  // said nothing. These tests drive the real RelayCore end to end, the same
  // way `sendInbound` does for the text cases above.

  /** Publish a captionless-media-shaped inbound message. */
  async function sendCaptionlessMedia(): Promise<void> {
    await relay.publish(
      PLATFORM_SUBJECT,
      { content: '', platformData: { media: { type: 'photo' } } },
      { from: 'relay.human.telegram.tg-bot.bot', replyTo: PLATFORM_SUBJECT }
    );
  }

  it('drops a captionless-media message on an unbridged binding — no session, no dispatch, no notice', async () => {
    await sendCaptionlessMedia();

    // Give the router a chance to route it — there is no dispatch to wait
    // for, so this waits on the trace instead, which is written either way.
    await vi.waitFor(() => expect(spanFor(PLATFORM_SUBJECT)).toBeDefined());

    expect(createSession).not.toHaveBeenCalled();
    expect(registry.dispatches).toHaveLength(0);
    // Silent by design (no regression to explain — nothing was said about an
    // empty message before this task either).
    expect(registry.noticeTexts()).toHaveLength(0);
    expect(spanFor(PLATFORM_SUBJECT)!.status).not.toBe('delivered');
  });

  it('does NOT drop the same message once the binding is bridged — the bridge inherits the unfiltered envelope', async () => {
    await bindingStore.update(bindingId, { bridge: 'room', chatId: '12345' });

    await sendCaptionlessMedia();

    // The empty-content gate lets a bridged binding through (DOR-866), and
    // ChatBridge.ingest (DOR-870) now consumes exactly this envelope — the
    // terminal branch that builds a media placeholder server-side. It never
    // touches session dispatch.
    await vi.waitFor(() => expect(bridgeIngest.ingest).toHaveBeenCalledTimes(1));
    expect(createSession).not.toHaveBeenCalled();
    expect(registry.dispatches).toHaveLength(0);
  });

  it('still runs a real turn for non-empty content on the same unbridged binding', async () => {
    // The negative control: proves the gate keys on content emptiness, not
    // on the mere presence of `platformData.media`.
    await relay.publish(
      PLATFORM_SUBJECT,
      { content: 'a real caption', platformData: { media: { type: 'photo' } } },
      { from: 'relay.human.telegram.tg-bot.bot', replyTo: PLATFORM_SUBJECT }
    );

    await vi.waitFor(() => expect(registry.dispatches).toHaveLength(1));
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});

/**
 * Integration: the lines this machine says in a chat, through the REAL RelayCore.
 *
 * A refused message used to end at a log line while its trace said
 * `delivered` (DOR-789). A notice must reach the person, never loop back as a
 * new prompt (it lands on the subject the router subscribes to), and never be a
 * side door into a chat nobody bound (a failed envelope's `replyTo` is
 * agent-written). Those bugs live in the seam, so only the real relay finds them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RelayCore, createChatNoticeSender, CHAT_NOTICE_SENDER } from '@dorkos/relay';
import type {
  RelayPublisher,
  RelayAdapter,
  AdapterRegistryLike,
  AdapterContext,
  DeliveryResult,
} from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { BindingRouter } from '../binding-router.js';
import { BindingStore } from '../binding-store.js';
import { createInitiateConsentGate } from '../initiate-consent.js';
import { makeChatNoticeTargetResolver } from '../binding-subsystem.js';
import type { AdapterMeshCoreLike } from '../adapter-manager.js';

const BOUND_CHAT = 'relay.human.telegram.tg-bot.12345';
const UNBOUND_CHAT = 'relay.human.telegram.tg-bot-other.99999';

/** Agent deliveries succeed, fail at capacity, or wait and say so; platform deliveries are recorded. */
class RecordingRegistry implements AdapterRegistryLike {
  readonly dispatches: RelayEnvelope[] = [];
  readonly platform: Array<{ subject: string; envelope: RelayEnvelope }> = [];
  mode: 'ok' | 'fail' | 'hold' = 'ok';

  setRelay(_relay: RelayPublisher): void {}

  /** Any truthy adapter: `AdapterDelivery` only checks that one matched. */
  getBySubject(): RelayAdapter {
    return { id: 'cca' } as unknown as RelayAdapter;
  }

  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext
  ): Promise<DeliveryResult | null> {
    if (subject.startsWith('relay.agent.')) {
      this.dispatches.push(envelope);
      if (this.mode === 'hold') context?.onHeld?.();
      if (this.mode === 'fail') {
        return { success: false, code: 'at_capacity', error: 'agent queue at capacity' };
      }
      return { success: true };
    }
    // The real adapters skip an echo of their own inbound publish.
    if (envelope.from.startsWith('relay.human.telegram')) return { success: true, skipped: true };
    this.platform.push({ subject, envelope });
    return { success: true };
  }

  async shutdown(): Promise<void> {}

  /** Notices that reached a chat, with the subject they landed on. */
  notices(): Array<{ subject: string; text: string }> {
    return this.platform
      .filter((d) => d.envelope.from === CHAT_NOTICE_SENDER)
      .map((d) => ({
        subject: d.subject,
        text: String((d.envelope.payload as { content?: unknown }).content ?? ''),
      }));
  }
}

const dirs: string[] = [];
let relay: RelayCore;
let store: BindingStore;
let router: BindingRouter;
let registry: RecordingRegistry;
let createSession: ReturnType<typeof vi.fn<() => Promise<{ id: string }>>>;
let spans: Array<Record<string, unknown>>;
let bindingId: string;
let knownAgents: Set<string>;

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-notice-'));
  dirs.push(dir);
  return dir;
}

/** The inbound message's span on `subject`: the LAST one, since a notice's span closes first. */
const spanFor = (subject: string) => spans.filter((s) => s.subject === subject).at(-1);
const texts = () => registry.notices().map((n) => n.text);

beforeEach(async () => {
  const relayDir = await tmp();
  spans = [];
  knownAgents = new Set(['agent-a']);
  registry = new RecordingRegistry();
  relay = new RelayCore({
    dataDir: await tmp(),
    adapterRegistry: registry,
    traceStore: { insertSpan: (span) => void spans.push(span as never), updateSpan: () => {} },
  });
  store = new BindingStore(relayDir);
  await store.init();
  bindingId = (await store.create({ adapterId: 'tg-bot', agentId: 'agent-a' })).id;
  // Exactly what apps/server/src/index.ts wires; this is worthless against a relay with neither.
  relay.setInitiateConsentGate(
    createInitiateConsentGate({
      bindingStore: store,
      resolveAgentSubject: (id) => (id === 'agent-a' ? 'relay.agent.ns.agent-a' : undefined),
    })
  );
  relay.setChatNoticeTargetResolver(makeChatNoticeTargetResolver(store));
  createSession = vi.fn(async () => ({ id: 'session-1' }));
  router = new BindingRouter({
    bindingStore: store,
    relayCore: relay,
    agentManager: { createSession },
    meshCore: {
      getProjectPath: (id: string) => (knownAgents.has(id) ? '/proj/agent-a' : undefined),
    } as unknown as AdapterMeshCoreLike,
    relayDir,
    runtimeResolver: { getSessionRuntimeType: async () => 'claude-code' },
    chatNotice: createChatNoticeSender({
      publish: (s, p, o) => relay.publish(s, p, o),
      resolveTarget: makeChatNoticeTargetResolver(store),
    }),
  });
  await router.init();
});

afterEach(async () => {
  await router.shutdown();
  await store.shutdown();
  await relay.close();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** Publish a Telegram-shaped inbound message onto `subject`. */
async function sendInbound(content: string, subject = BOUND_CHAT): Promise<void> {
  const bot = subject.split('.').slice(0, 4).join('.') + '.bot';
  await relay.publish(subject, { content }, { from: bot, replyTo: subject });
}

/** Give a re-routed notice every chance to become a turn before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 120));

describe('a refused chat message', () => {
  it('reaches the person once, however often they retry, and does not trace as delivered', async () => {
    await store.update(bindingId, { enabled: false });
    await sendInbound('hello?');
    await sendInbound('hello??');
    await vi.waitFor(() => expect(texts().length).toBeGreaterThan(0));
    expect(texts()).toEqual([expect.stringContaining('paused')]);
    expect(createSession).not.toHaveBeenCalled();
    expect(registry.dispatches).toHaveLength(0);
    expect(spanFor(BOUND_CHAT)!.status).not.toBe('delivered');
    expect(String(spanFor(BOUND_CHAT)!.error)).toContain('paused');
  });

  it.each([
    [
      'the chat is set not to reach its agent',
      'not to send messages',
      () => store.update(bindingId, { canReceive: false }),
    ],
    ['the bound agent is gone', 'not available', () => knownAgents.clear()],
    [
      'the session cannot be started',
      'could not start a session',
      () => createSession.mockRejectedValue(new Error('no runtime')),
    ],
  ])('tells the person when %s', async (_label, text, arrange) => {
    await arrange();
    await sendInbound('hi');
    await vi.waitFor(() => expect(texts()).toHaveLength(1));
    expect(texts()[0]).toContain(text);
    expect(spanFor(BOUND_CHAT)!.status).not.toBe('delivered');
  });

  it('stays silent in a chat nothing is bound to, and still traces the drop', async () => {
    await sendInbound('hi', UNBOUND_CHAT);
    expect(texts()).toHaveLength(0);
    expect(spanFor(UNBOUND_CHAT)!.status).not.toBe('delivered');
    expect(String(spanFor(UNBOUND_CHAT)!.error)).toContain('no binding');
  });

  it('still runs a routed turn and traces it as delivered', async () => {
    await sendInbound('do the thing');
    await vi.waitFor(() => expect(registry.dispatches).toHaveLength(1));
    expect(texts()).toHaveLength(0);
    expect(spanFor(BOUND_CHAT)!.status).toBe('delivered');
  });
});

describe('the notice for a turn that died or waits', () => {
  // A HEALTHY binding, so routing really happens and the guard is all that
  // stands between the notice and a second dispatch.
  it.each([
    ['fail', ['too busy to take this message', 'send it again now']],
    ['hold', ['waiting its turn']],
  ] as const)('in %s mode is said once and never becomes a second turn', async (mode, phrases) => {
    registry.mode = mode;
    await sendInbound('do the thing');
    await vi.waitFor(() => expect(registry.notices()).toHaveLength(1));
    await settle();
    expect(registry.dispatches).toHaveLength(1);
    expect(registry.notices()).toHaveLength(1);
    expect(registry.notices()[0]!.subject).toBe(BOUND_CHAT);
    for (const phrase of phrases) expect(texts()[0]).toContain(phrase);
    if (mode === 'hold') expect(texts()[0]).not.toMatch(/again/i);
  });

  it('does not post into a chat nobody bound, however the agent addresses it', async () => {
    registry.mode = 'fail';
    await relay.publish(
      'relay.agent.claude-code.session-x',
      { content: 'anything' },
      { from: 'relay.agent.ns.agent-a', replyTo: UNBOUND_CHAT }
    );
    await vi.waitFor(() => expect(registry.dispatches.length).toBeGreaterThan(0));
    await settle();
    expect(registry.platform.map((d) => d.subject)).not.toContain(UNBOUND_CHAT);
  });

  it('cannot be repeated by varying the agent subject it failed on', async () => {
    registry.mode = 'fail';
    for (const session of ['s1', 's2', 's3', 's4']) {
      await relay.publish(
        `relay.agent.claude-code.${session}`,
        { content: 'anything' },
        { from: 'relay.agent.ns.agent-a', replyTo: BOUND_CHAT }
      );
    }
    await vi.waitFor(() => expect(registry.notices().length).toBeGreaterThan(0));
    await settle();
    // The damper is keyed on (binding, chat, reason), not the failed subject.
    expect(registry.notices()).toHaveLength(1);
  });
});

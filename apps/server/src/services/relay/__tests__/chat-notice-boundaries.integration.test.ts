/**
 * Integration: the two ways a chat notice could go wrong, driven end to end.
 *
 * 1. **It must not be a side door into an unbound chat.** The notice for a turn
 *    that died speaks on the failed envelope's `replyTo`, and on `relay_send`
 *    that field is written by the model. Under a `relay.system.*` principal the
 *    consent gate exempts, an unchecked notice would post this machine's text
 *    into any chat an agent cared to name.
 * 2. **It must not become a new prompt.** The notice lands on the same subject
 *    the binding router subscribes to. Without the system-principal guard, a
 *    healthy binding routes the notice straight back into a second turn.
 *
 * Both are driven through the REAL RelayCore, because both bugs live in the
 * seam between the publish pipeline, the router's subscription, and the
 * adapter — not in any one of them.
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

/** The chat the operator actually bound. */
const BOUND_CHAT = 'relay.human.telegram.tg-bot.12345';
/** A chat on the same adapter that nobody bound to anything. */
const UNBOUND_CHAT = 'relay.human.telegram.tg-bot-other.99999';

/**
 * Every agent delivery FAILS after acceptance — the detached dead-letter path.
 *
 * Switch {@link FailingRegistry.mode} to `'hold'` and it behaves like the real
 * adapter instead: it parks the delivery, announces the wait through
 * `context.onHeld`, and then succeeds. Nothing is dropped on that path, so the
 * only thing to check is what the chat is told.
 */
class FailingRegistry implements AdapterRegistryLike {
  readonly dispatches: RelayEnvelope[] = [];
  readonly platform: Array<{ subject: string; envelope: RelayEnvelope }> = [];
  /** `'fail'` refuses at capacity; `'hold'` waits and says so. */
  mode: 'fail' | 'hold' = 'fail';

  setRelay(_relay: RelayPublisher): void {
    /* nothing to hold */
  }

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
      if (this.mode === 'hold') {
        context?.onHeld?.();
        return { success: true };
      }
      return { success: false, code: 'at_capacity', error: 'agent queue at capacity' };
    }
    if (envelope.from.startsWith('relay.human.telegram')) return { success: true, skipped: true };
    this.platform.push({ subject, envelope });
    return { success: true };
  }

  async shutdown(): Promise<void> {
    /* nothing to tear down */
  }

  /** Notices that actually reached a chat, with the subject they landed on. */
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
let registry: FailingRegistry;

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-notice-'));
  dirs.push(dir);
  return dir;
}

beforeEach(async () => {
  const dataDir = await tmp();
  const relayDir = await tmp();
  registry = new FailingRegistry();
  relay = new RelayCore({ dataDir, adapterRegistry: registry });

  store = new BindingStore(relayDir);
  await store.init();
  await store.create({ adapterId: 'tg-bot', agentId: 'agent-a' });

  relay.setInitiateConsentGate(
    createInitiateConsentGate({
      bindingStore: store,
      resolveAgentSubject: (id) => (id === 'agent-a' ? 'relay.agent.ns.agent-a' : undefined),
    })
  );
  // Exactly what apps/server/src/index.ts wires, in the same breath as the
  // consent gate — this test is worthless against a relay that has neither.
  relay.setChatNoticeTargetResolver(makeChatNoticeTargetResolver(store));

  router = new BindingRouter({
    bindingStore: store,
    relayCore: relay,
    agentManager: { createSession: vi.fn(async () => ({ id: 'session-1' })) },
    meshCore: { getProjectPath: () => '/proj/a' } as unknown as AdapterMeshCoreLike,
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

describe('the notice for a turn that died', () => {
  it('never becomes a second turn', async () => {
    // A HEALTHY binding, so routing really happens and the guard is the only
    // thing standing between the notice and a second dispatch. (Testing this
    // with a paused binding proves nothing: nothing routes there either way.)
    await relay.publish(
      BOUND_CHAT,
      { content: 'do the thing' },
      { from: 'relay.human.telegram.tg-bot.bot', replyTo: BOUND_CHAT }
    );

    await vi.waitFor(() => expect(registry.notices()).toHaveLength(1));
    // Give a re-routed notice every chance to become a turn before asserting.
    await new Promise((r) => setTimeout(r, 120));

    expect(registry.dispatches).toHaveLength(1);
    expect(registry.notices()).toHaveLength(1);
    // This registry refuses at capacity outright, which is what an adapter that
    // cannot hold does. The line it produces states what happened and asks for
    // nothing — it used to end "Send it again in a moment."
    expect(registry.notices()[0]!.text).toContain('stayed busy');
    expect(registry.notices()[0]!.text).not.toMatch(/again/i);
  });

  it('says a held message is waiting, and that line does not start a turn either', async () => {
    registry.mode = 'hold';

    await relay.publish(
      BOUND_CHAT,
      { content: 'do the thing' },
      { from: 'relay.human.telegram.tg-bot.bot', replyTo: BOUND_CHAT }
    );

    await vi.waitFor(() => expect(registry.notices()).toHaveLength(1));
    // A held notice lands on the same chat subject the binding router
    // subscribes to, exactly as a failure notice does. Give it every chance to
    // be routed back into a second turn before asserting it was not.
    await new Promise((r) => setTimeout(r, 120));

    expect(registry.notices()[0]!.subject).toBe(BOUND_CHAT);
    expect(registry.notices()[0]!.text).toContain('waiting its turn');
    expect(registry.notices()[0]!.text).not.toMatch(/again/i);
    // One dispatch: the message itself. The notice did not become a second one.
    expect(registry.dispatches).toHaveLength(1);
  });

  it('does not post into a chat nobody bound, however the agent addresses it', async () => {
    // An agent doing exactly what `relay_send` allows: naming its own reply
    // subject. The delivery then fails, which is what triggers the notice.
    await relay.publish(
      'relay.agent.claude-code.session-x',
      { content: 'anything' },
      { from: 'relay.agent.ns.agent-a', replyTo: UNBOUND_CHAT }
    );

    await vi.waitFor(() => expect(registry.dispatches.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 120));

    // Nothing was delivered to that chat, and nothing was said in it.
    expect(registry.notices()).toHaveLength(0);
    expect(registry.platform.map((d) => d.subject)).not.toContain(UNBOUND_CHAT);
  });

  it('cannot be repeated by varying the agent subject it failed on', async () => {
    for (const session of ['s1', 's2', 's3', 's4']) {
      await relay.publish(
        `relay.agent.claude-code.${session}`,
        { content: 'anything' },
        { from: 'relay.agent.ns.agent-a', replyTo: BOUND_CHAT }
      );
    }

    await vi.waitFor(() => expect(registry.notices().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 120));

    // The damper is keyed on (binding, chat, reason). Four failures in one
    // chat are one line, not four — whatever the failed subject was.
    expect(registry.notices()).toHaveLength(1);
  });
});

/**
 * The banner's idea of "this binding could run something" against the real
 * `BindingRouter`'s.
 *
 * The collector copies the router's liveness rules rather than importing them,
 * because the router decides one envelope at a time and the banner has to
 * answer for a whole store at once. A copy drifts, and the way it drifts is
 * silent: the router grows a refusal, the collector keeps reporting, and a
 * person stares at a non-dismissible amber row about a thing that cannot
 * happen. That is not hypothetical — it is exactly what DOR-814's review found
 * by switching an integration off in a browser.
 *
 * So each case below drives the REAL router with a real `RelayCore` and a real
 * `BindingStore`, asserts the turn did NOT run, and then hands the same store's
 * rows to the collector and asserts it agrees. The last case is the control: a
 * healthy binding, where the router runs the turn and the collector reports it.
 * Without that one, a collector hardcoded to `[]` would pass every other test
 * here.
 *
 * The one refusal deliberately not paired is `session_start_failed` — it is a
 * runtime failure of a binding that IS live, not a statement about whether it
 * should be reported.
 *
 * ## One file watcher this cannot avoid
 *
 * `new RelayCore(...)` builds an `AccessControl`, which opens a chokidar watcher
 * on its rules file — one per test here, closed again by `relay.close()` in
 * `afterEach`. On a machine already near its descriptor ceiling that watcher can
 * surface as an `EMFILE` unhandled rejection in the run output; the sibling
 * suite `relay/__tests__/binding-router-refusals.integration.test.ts` has always
 * done the same, and this repo has EMFILE flake history. It is noise from the
 * real relay being real, not a leak in this file, and removing it would take a
 * production change to `RelayCore`. The watcher this file COULD avoid —
 * `BindingStore.init()`'s — is not opened at all; see the note in `beforeEach`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RelayCore, createChatNoticeSender } from '@dorkos/relay';
import type { RelayPublisher, AdapterRegistryLike, DeliveryResult } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { PermissionMode } from '@dorkos/shared/schemas';
import { BindingRouter } from '../../../relay/binding-router.js';
import { BindingStore } from '../../../relay/binding-store.js';
import { createInitiateConsentGate } from '../../../relay/initiate-consent.js';
import { makeChatNoticeTargetResolver } from '../../../relay/binding-subsystem.js';
import type { AdapterMeshCoreLike } from '../../../relay/adapter-manager.js';
import { collectUnattendedAutonomy } from '../unattended-autonomy.js';

const PLATFORM_SUBJECT = 'relay.human.telegram.tg-bot.12345';
const PROJECT_PATH = '/proj/agent-a';
const ADAPTER_ID = 'tg-bot';

/** The autonomy stop, so every binding in this file is one the banner would report. */
const AUTONOMY: PermissionModeDescriptor = {
  id: 'bypassPermissions',
  label: 'Bypass permissions',
  stop: 'autonomy',
  asks: 'never',
  reach: 'everything',
  promise: 'Runs everything without asking.',
};

/** Records what reached an agent, so "the turn ran" is observable. */
class RecordingRegistry implements AdapterRegistryLike {
  readonly dispatches: Array<{ subject: string }> = [];

  setRelay(_relay: RelayPublisher): void {
    /* nothing to hold */
  }

  async deliver(subject: string, envelope: RelayEnvelope): Promise<DeliveryResult | null> {
    if (subject.startsWith('relay.agent.')) {
      this.dispatches.push({ subject });
      return { success: true };
    }
    if (subject.startsWith('relay.human.')) {
      if (envelope.from.startsWith('relay.human.telegram')) return { success: true, skipped: true };
      return { success: true };
    }
    return null;
  }

  async shutdown(): Promise<void> {
    /* nothing to tear down */
  }
}

const tempDirs: string[] = [];
let relay: RelayCore;
let bindingStore: BindingStore;
let router: BindingRouter;
let registry: RecordingRegistry;
let createSession: ReturnType<typeof vi.fn<() => Promise<{ id: string }>>>;
let bindingId: string;
let knownAgents: Set<string>;
/** The integrations the relay has registered — what `adapterLive` reads in production. */
let liveAdapters: Set<string>;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'unattended-router-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(async () => {
  const dataDir = await makeTempDir();
  const relayDir = await makeTempDir();

  knownAgents = new Set(['agent-a']);
  liveAdapters = new Set([ADAPTER_ID]);
  registry = new RecordingRegistry();
  relay = new RelayCore({ dataDir, adapterRegistry: registry });

  // Constructed but NOT `init()`ed, deliberately. `init()` is `load()` plus a
  // chokidar watcher on `bindings.json`, and this file never edits that file
  // from outside — every change goes through the store's own methods, which
  // keep the in-memory map the router reads. Calling it would open a real
  // watcher per test for nothing, and a suite that opens file watchers it does
  // not use is how this repo has met EMFILE before. `create()` and `update()`
  // populate the map and `save()` writes the file without needing the load.
  bindingStore = new BindingStore(relayDir);
  const binding = await bindingStore.create({
    adapterId: ADAPTER_ID,
    agentId: 'agent-a',
    permissionMode: AUTONOMY.id as PermissionMode,
  });
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
      resolveTarget: makeChatNoticeTargetResolver(bindingStore),
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

/** What the banner would say about the very rows the router just judged. */
function bannerDrivers(): Array<{ id: string }> {
  return collectUnattendedAutonomy({
    bindings: bindingStore.getAll(),
    tasks: [],
    modes: [AUTONOMY],
    adapterName: (id) => id,
    adapterLive: (id) => liveAdapters.has(id),
    agentLive: (id) => knownAgents.has(id),
  }).drivers;
}

describe('the banner agrees with the router about what could run', () => {
  it('says nothing about a paused binding, which the router refuses', async () => {
    await bindingStore.update(bindingId, { enabled: false });

    await sendInbound('anyone there?');
    await vi.waitFor(() => expect(createSession).not.toHaveBeenCalled());

    expect(registry.dispatches).toHaveLength(0);
    expect(bannerDrivers()).toEqual([]);
  });

  it('says nothing about a binding set not to reach its agent', async () => {
    await bindingStore.update(bindingId, { canReceive: false });

    await sendInbound('hi');
    await vi.waitFor(() => expect(createSession).not.toHaveBeenCalled());

    expect(registry.dispatches).toHaveLength(0);
    expect(bannerDrivers()).toEqual([]);
  });

  it('says nothing about a binding whose agent the mesh has lost', async () => {
    knownAgents.clear();

    await sendInbound('hi');
    await vi.waitFor(() => expect(createSession).not.toHaveBeenCalled());

    expect(registry.dispatches).toHaveLength(0);
    expect(bannerDrivers()).toEqual([]);
  });

  it('says nothing when the integration is not registered — no message can arrive', async () => {
    // The router cannot be driven into this state, and that is the whole point:
    // an unregistered adapter never publishes, so not one of its checks runs.
    // Silence from the router here is silence for the right reason, and the
    // banner has to reach the same answer from a different fact.
    liveAdapters.clear();

    expect(bannerDrivers()).toEqual([]);
  });

  it('DOES report a healthy binding — the control that keeps the rest honest', async () => {
    await sendInbound('do the thing');

    await vi.waitFor(() => expect(registry.dispatches).toHaveLength(1));
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(bannerDrivers()).toEqual([{ kind: 'binding', id: bindingId, name: ADAPTER_ID }]);
  });
});

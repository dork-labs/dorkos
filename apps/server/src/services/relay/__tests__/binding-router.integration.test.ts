/**
 * Integration: platform message → binding router → agent turn → reply delivery,
 * through the REAL RelayCore, BindingStore and BindingRouter, so subject
 * grammar, the subscription wildcard, reply fan-out and the echo guard are all
 * exercised together.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import { initBoundary } from '../../../lib/boundary.js';
import { AgentManifestSchema } from '@dorkos/shared/mesh-schemas';
import type { WorkspaceManager } from '@dorkos/shared/workspace';
import { setWorkspaceManager } from '../../workspace/index.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RelayCore } from '@dorkos/relay';
import type { RelayPublisher, AdapterRegistryLike, DeliveryResult } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { BindingRouter } from '../binding-router.js';
import { BindingStore } from '../binding-store.js';
import { createInitiateConsentGate } from '../initiate-consent.js';
import type { AdapterMeshCoreLike } from '../adapter-manager.js';

const PLATFORM_SUBJECT = 'relay.human.telegram.tg-bot.12345';
/** The bound agent's own directory, under a real temp root the boundary check accepts. */
let PROJECT_PATH: string;

/**
 * Where a turn for that agent RUNS: its managed checkout, deliberately a
 * different path from {@link PROJECT_PATH} so the cwd assertions can fail.
 */
let WORKTREE_CWD: string;

interface Recorded {
  subject: string;
  envelope: RelayEnvelope;
}

/** Records agent dispatches and streams a reply back; records platform deliveries. */
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
    const first =
      this.mode === 'crash'
        ? { type: 'error', data: { message: 'SDK session crashed' } }
        : { type: 'text_delta', data: { text: 'Hi back!' } };
    await relay.publish(replyTo, first, { from });
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
  const boundaryRoot = await fs.realpath(os.tmpdir());
  const agentRoot = await fs.realpath(await makeTempDir());
  PROJECT_PATH = path.join(agentRoot, 'proj', 'agent-a');
  WORKTREE_CWD = path.join(agentRoot, 'workspaces', 'dorkos', 'agent-a-checkout');
  await initBoundary(boundaryRoot);
  registerTestHomes([PROJECT_PATH], { managed: { [WORKTREE_CWD]: PROJECT_PATH } });

  await fs.mkdir(path.join(PROJECT_PATH, '.dork'), { recursive: true });
  await fs.writeFile(
    path.join(PROJECT_PATH, '.dork', 'agent.json'),
    JSON.stringify(
      AgentManifestSchema.parse({
        id: '01HV7KJZZZ0000000000000000',
        name: 'agent-a',
        description: '',
        runtime: 'claude-code',
        registeredAt: '2026-08-27T00:00:00.000Z',
        registeredBy: 'test',
        workspace: { mode: 'managed', source: '/repos/dorkos' },
      })
    ),
    'utf-8'
  );
  setWorkspaceManager({
    ensure: async () => ({ id: 'ws_1', path: WORKTREE_CWD }),
  } as unknown as WorkspaceManager);

  const dataDir = await makeTempDir();
  const relayDir = await makeTempDir();

  registry = new SeamRegistry();
  relay = new RelayCore({ dataDir, adapterRegistry: registry });

  bindingStore = new BindingStore(relayDir);
  await bindingStore.init();
  await bindingStore.create({ adapterId: 'tg-bot', agentId: 'agent-a' });

  relay.setInitiateConsentGate(
    createInitiateConsentGate({
      bindingStore,
      resolveAgentSubject: (agentId) =>
        agentId === 'agent-a' ? 'relay.agent.ns.agent-a' : undefined,
    })
  );

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
  clearTestHomes();
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

    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(createSession).toHaveBeenCalledWith(WORKTREE_CWD, 'default', PROJECT_PATH);

    await vi.waitFor(() => expect(registry.dispatches.length).toBe(1));
    const dispatch = registry.dispatches[0]!;
    expect(dispatch.subject).toBe('relay.agent.claude-code.session-1');
    const payload = dispatch.envelope.payload as Record<string, unknown>;
    expect(payload.content).toBe('Hello from Telegram');
    expect(payload.cwd).toBe(WORKTREE_CWD);
    expect(WORKTREE_CWD).not.toBe(PROJECT_PATH);
    expect(payload.__bindingPermissions).toBeDefined();

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

    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('a crashed turn surfaces as the error+done sequence at the platform, without looping', async () => {
    registry.mode = 'crash';
    await sendInbound('Do something risky');

    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

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

    expect(createSession).toHaveBeenCalledTimes(1);
  });
});

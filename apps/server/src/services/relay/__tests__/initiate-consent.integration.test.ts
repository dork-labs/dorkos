import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RelayCore } from '@dorkos/relay';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { BindingStore } from '../binding-store.js';
import { createInitiateConsentGate } from '../initiate-consent.js';

/**
 * DOR-277 end-to-end: a REAL RelayCore, a REAL BindingStore, and the REAL
 * consent gate wired exactly as `index.ts` wires them. Proves the side door is
 * closed — an agent-principal `relay_send` to a `relay.human.*` subject no
 * longer reaches the channel when the binding forbids initiation — while the
 * reply and system paths DOR-239/DOR-240 depend on keep flowing.
 */

let tmpDir: string;
let relay: RelayCore;
let bindingStore: BindingStore;

/** The outbound-channel subject an agent would target to DM the user. */
const HUMAN = 'relay.human.telegram.tg1.chat-42';

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dor277-integration-'));
  relay = new RelayCore({ dataDir: join(tmpDir, 'relay') });
  bindingStore = new BindingStore(join(tmpDir, 'relay'));
  // Wire the gate against the real store — the exact index.ts seam.
  relay.setInitiateConsentGate(createInitiateConsentGate({ bindingStore }));
});

afterEach(async () => {
  await relay.close();
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Subscribe a spy to the outbound human subject. A real deployment has the
 * Telegram adapter here; delivery to this subscriber === "the DM was sent".
 */
function watchOutbound(): RelayEnvelope[] {
  const delivered: RelayEnvelope[] = [];
  relay.subscribe(HUMAN, (env) => {
    delivered.push(env);
  });
  return delivered;
}

describe('DOR-277 — canInitiate enforced at the delivery layer', () => {
  it('BLOCKS an agent relay_send to a human subject when canInitiate is off', async () => {
    await bindingStore.create({ adapterId: 'tg1', agentId: 'agent-1', canInitiate: false });
    const delivered = watchOutbound();

    const result = await relay.publish(
      HUMAN,
      { text: 'unsolicited' },
      { from: 'relay.agent.ns.agent-1' }
    );

    expect(result.deliveredTo).toBe(0);
    expect(result.rejected?.[0]?.reason).toBe('initiate_denied');
    expect(delivered).toHaveLength(0);
    const dead = await relay.getDeadLetters();
    expect(dead.some((d) => d.envelope?.subject === HUMAN)).toBe(true);
  });

  it('ALLOWS the agent send once canInitiate is turned on', async () => {
    const binding = await bindingStore.create({
      adapterId: 'tg1',
      agentId: 'agent-1',
      canInitiate: false,
    });
    const delivered = watchOutbound();

    // Blocked before consent...
    const blocked = await relay.publish(
      HUMAN,
      { text: 'first try' },
      { from: 'relay.agent.ns.agent-1' }
    );
    expect(blocked.deliveredTo).toBe(0);

    // ...flows after the user flips the switch on.
    await bindingStore.update(binding.id, { canInitiate: true });
    const allowed = await relay.publish(
      HUMAN,
      { text: 'now allowed' },
      { from: 'relay.agent.ns.agent-1' }
    );

    expect(allowed.deliveredTo).toBe(1);
    expect(delivered.map((e) => (e.payload as { text: string }).text)).toEqual(['now allowed']);
  });

  it('ALWAYS delivers an automatic reply (agent: principal), even with canInitiate off', async () => {
    await bindingStore.create({ adapterId: 'tg1', agentId: 'agent-1', canInitiate: false });
    const delivered = watchOutbound();

    // The runtime adapter forwards a turn's reply under the `agent:` principal.
    const result = await relay.publish(
      HUMAN,
      { text: 'here is your answer' },
      { from: 'agent:sess-1' }
    );

    expect(result.deliveredTo).toBe(1);
    expect(delivered).toHaveLength(1);
  });

  it('ALWAYS delivers a task-completion notification (system principal), even with canInitiate off', async () => {
    await bindingStore.create({ adapterId: 'tg1', agentId: 'agent-1', canInitiate: false });
    const delivered = watchOutbound();

    // The TaskCompletionNotifier resolved consent upstream and publishes as the
    // trusted system principal; the delivery gate exempts it.
    const result = await relay.publish(
      HUMAN,
      { text: '✅ done' },
      { from: 'relay.system.tasks.notifier' }
    );

    expect(result.deliveredTo).toBe(1);
    expect(delivered).toHaveLength(1);
  });
});

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
 * closed — an agent-principal publish to a `relay.human.*` subject no
 * longer reaches the channel when the binding forbids initiation — while the
 * reply and system paths DOR-239/DOR-240 depend on keep flowing.
 */

let tmpDir: string;
let relay: RelayCore;
let bindingStore: BindingStore;

/** The outbound-channel subject an agent would target to DM the user. */
const HUMAN = 'relay.human.telegram.tg1.chat-42';

/** The publish principal of the bound agent, as the mesh derives it. */
const AGENT_SUBJECT = 'relay.agent.ns.agent-1';

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'dor277-integration-'));
  relay = new RelayCore({ dataDir: join(tmpDir, 'relay') });
  bindingStore = new BindingStore(join(tmpDir, 'relay'));
  // Wire the gate against the real store — the exact index.ts seam. The mesh
  // lookup stands in for `meshCore`: `agent-1` publishes as AGENT_SUBJECT.
  relay.setInitiateConsentGate(
    createInitiateConsentGate({
      bindingStore,
      resolveAgentSubject: (agentId) => (agentId === 'agent-1' ? AGENT_SUBJECT : undefined),
    })
  );
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
  it('blocks an agent send until canInitiate is on, dead-lettering the refused one', async () => {
    const binding = await bindingStore.create({
      adapterId: 'tg1',
      agentId: 'agent-1',
      canInitiate: false,
    });
    const delivered = watchOutbound();
    const blocked = await relay.publish(HUMAN, { text: 'first try' }, { from: AGENT_SUBJECT });
    expect(blocked.deliveredTo).toBe(0);
    expect(blocked.rejected?.[0]?.reason).toBe('initiate_denied');
    expect((await relay.getDeadLetters()).some((d) => d.envelope?.subject === HUMAN)).toBe(true);
    await bindingStore.update(binding.id, { canInitiate: true });
    expect(
      (await relay.publish(HUMAN, { text: 'now allowed' }, { from: AGENT_SUBJECT })).deliveredTo
    ).toBe(1);
    expect(delivered.map((e) => (e.payload as { text: string }).text)).toEqual(['now allowed']);
  });

  // Replies and the task notifier resolved consent upstream; the gate exempts them.
  it.each([['agent:sess-1'], ['relay.system.tasks.notifier']])(
    'always delivers from %s, even with canInitiate off',
    async (from) => {
      await bindingStore.create({ adapterId: 'tg1', agentId: 'agent-1', canInitiate: false });
      const delivered = watchOutbound();
      expect((await relay.publish(HUMAN, { text: 'reply' }, { from })).deliveredTo).toBe(1);
      expect(delivered).toHaveLength(1);
    }
  );

  it('blocks a DIFFERENT agent from riding a consenting binding', async () => {
    await bindingStore.create({ adapterId: 'tg1', agentId: 'agent-1', canInitiate: true });
    const delivered = watchOutbound();
    const result = await relay.publish(
      HUMAN,
      { text: 'not mine' },
      { from: 'relay.agent.ns.agent-2' }
    );
    expect(result.rejected?.[0]?.reason).toBe('initiate_denied');
    expect(delivered).toHaveLength(0);
  });
});

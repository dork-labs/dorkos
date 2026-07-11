import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RelayCore } from '../relay-core.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { InitiateConsentGate } from '../types.js';

/**
 * DOR-277: the publish pipeline enforces an injected agent→human
 * initiate-consent gate as a sibling to the DOR-260 budget gate. These tests
 * exercise the pipeline MECHANISM with a stub gate; the host-side gate logic
 * (which principals/subjects are gated) is covered in the server package.
 */

let tmpDir: string;
let relay: RelayCore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-consent-test-'));
  relay = new RelayCore({ dataDir: tmpDir });
});

afterEach(async () => {
  await relay.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Gate that denies exactly agent→human sends, mirroring the real host gate. */
const denyAgentToHuman: InitiateConsentGate = (from, subject) => {
  if (subject.startsWith('relay.human.') && from.startsWith('relay.agent.')) {
    return { allowed: false, code: 'INITIATE_NOT_ALLOWED', reason: 'canInitiate is off' };
  }
  return { allowed: true };
};

describe('publish pipeline — initiate-consent gate (DOR-277)', () => {
  it('denies an agent-principal send to a human subject: no delivery, dead-lettered, rejected', async () => {
    relay.setInitiateConsentGate(denyAgentToHuman);

    const received: RelayEnvelope[] = [];
    relay.subscribe('relay.human.telegram.tg1.chat-42', (env) => {
      received.push(env);
    });

    const result = await relay.publish(
      'relay.human.telegram.tg1.chat-42',
      { text: 'unsolicited ping' },
      { from: 'relay.agent.ns.agent-1' }
    );

    // Nothing delivered — the subscriber (the outbound adapter's stand-in) never fires.
    expect(result.deliveredTo).toBe(0);
    expect(received).toHaveLength(0);
    expect(result.rejected?.[0]?.reason).toBe('initiate_denied');

    // The denied message is dead-lettered under the target subject.
    const deadLetters = await relay.getDeadLetters();
    expect(
      deadLetters.some((d) => d.envelope?.subject === 'relay.human.telegram.tg1.chat-42')
    ).toBe(true);
  });

  it('allows the same send when the gate permits it', async () => {
    relay.setInitiateConsentGate(denyAgentToHuman);

    const received: RelayEnvelope[] = [];
    relay.subscribe('relay.human.telegram.tg1.chat-42', (env) => {
      received.push(env);
    });

    // canInitiate=true is modeled by the gate returning allowed — here a
    // reply principal (`agent:`) is one such allowed path.
    const result = await relay.publish(
      'relay.human.telegram.tg1.chat-42',
      { text: 'reply to the human' },
      { from: 'agent:session-abc' }
    );

    expect(result.deliveredTo).toBe(1);
    expect(received).toHaveLength(1);
  });

  it('settles a waiting reply inbox when it denies a send that carried a replyTo', async () => {
    relay.setInitiateConsentGate(denyAgentToHuman);

    const replyInbox = 'relay.inbox.query.caller-1';
    const replies: RelayEnvelope[] = [];
    await relay.registerEndpoint(replyInbox);
    relay.subscribe(replyInbox, (env) => {
      replies.push(env);
    });

    await relay.publish(
      'relay.human.telegram.tg1.chat-42',
      { text: 'ping with a waiter' },
      { from: 'relay.agent.ns.agent-1', replyTo: replyInbox }
    );

    // The blocked caller is settled with a failure instead of hanging to timeout.
    expect(replies.length).toBeGreaterThanOrEqual(1);
  });

  it('fails closed when the gate throws: denies, dead-letters, no delivery', async () => {
    relay.setInitiateConsentGate(() => {
      throw new Error('bindingStore.resolve blew up');
    });

    const received: RelayEnvelope[] = [];
    relay.subscribe('relay.human.telegram.tg1.chat-42', (env) => {
      received.push(env);
    });

    const result = await relay.publish(
      'relay.human.telegram.tg1.chat-42',
      { text: 'gate throws' },
      { from: 'relay.agent.ns.agent-1' }
    );

    expect(result.deliveredTo).toBe(0);
    expect(received).toHaveLength(0);
    expect(result.rejected?.[0]?.reason).toBe('initiate_denied');
  });

  it('is a no-op when no gate is injected (backward compatible)', async () => {
    const received: RelayEnvelope[] = [];
    relay.subscribe('relay.human.telegram.tg1.chat-42', (env) => {
      received.push(env);
    });

    const result = await relay.publish(
      'relay.human.telegram.tg1.chat-42',
      { text: 'no gate wired' },
      { from: 'relay.agent.ns.agent-1' }
    );

    expect(result.deliveredTo).toBe(1);
    expect(received).toHaveLength(1);
  });
});

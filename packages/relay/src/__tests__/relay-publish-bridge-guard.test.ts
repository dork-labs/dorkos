import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RelayCore } from '../relay-core.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { InitiateConsentGate } from '../types.js';

/**
 * DOR-889: the publish pipeline enforces a server-only trust marker for
 * `relay.bridge.*` principals, ahead of the DOR-277 consent gate. A bridge
 * `from` is publishable only by trusted server code that sets
 * `serverBridgePrincipal: true`; anything else — a future ingress forwarding a
 * caller-supplied `from` past or around the HTTP route guard — is rejected at
 * the pipeline with no delivery. These tests exercise the MECHANISM directly
 * against RelayCore, with no HTTP route in the path, which is exactly the
 * scenario the guard exists to cover.
 */

let tmpDir: string;
let relay: RelayCore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-bridge-guard-test-'));
  relay = new RelayCore({ dataDir: tmpDir });
});

afterEach(async () => {
  await relay.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * A permissive consent gate that allows every publish. Installed so a test can
 * prove the bridge guard fires on its OWN account, not because consent denied
 * — and so the legitimate (marked) bridge path actually delivers.
 */
const allowAll: InitiateConsentGate = () => ({ allowed: true });

const BRIDGE_SUBJECT = 'relay.human.telegram.tg1.chat-42';

describe('publish pipeline — server-only bridge-principal guard (DOR-889)', () => {
  it('rejects a bridge `from` with NO trust marker: no delivery, dead-lettered, distinct code — even with a permissive consent gate installed', async () => {
    // A permissive gate would say YES to this publish. The rejection therefore
    // proves the bridge guard is a SEPARATE, EARLIER line of defense that does
    // not depend on the consent gate's verdict.
    relay.setInitiateConsentGate(allowAll);

    const received: RelayEnvelope[] = [];
    relay.subscribe(BRIDGE_SUBJECT, (env) => {
      received.push(env);
    });

    const result = await relay.publish(
      BRIDGE_SUBJECT,
      { text: 'forwarded caller-supplied bridge principal' },
      { from: 'relay.bridge.reply.tg1.chat-42' } // no serverBridgePrincipal marker
    );

    // Nothing delivered — the outbound adapter's stand-in never fires.
    expect(result.deliveredTo).toBe(0);
    expect(received).toHaveLength(0);
    // A code distinct from the consent gate's `initiate_denied`, so a caller
    // can tell "you spoofed a server principal" apart from "consent said no".
    expect(result.rejected?.[0]?.reason).toBe('untrusted_bridge_principal');

    // Dead-lettered under the target subject, so the security event is visible.
    const deadLetters = await relay.getDeadLetters();
    expect(deadLetters.some((d) => d.envelope?.subject === BRIDGE_SUBJECT)).toBe(true);
  });

  it('rejects an unmarked bridge `initiate` principal too', async () => {
    relay.setInitiateConsentGate(allowAll);

    const result = await relay.publish(
      BRIDGE_SUBJECT,
      { text: 'unmarked initiate' },
      { from: 'relay.bridge.initiate.tg1.chat-42' }
    );

    expect(result.deliveredTo).toBe(0);
    expect(result.rejected?.[0]?.reason).toBe('untrusted_bridge_principal');
  });

  it('rejects an unmarked bridge `from` with NO consent gate installed at all', async () => {
    // The guard runs ahead of the consent evaluation, so it stands even during
    // the window where the binding subsystem has not wired the gate yet — the
    // rejection is the bridge guard's own, not the no-gate consent fallback.
    const received: RelayEnvelope[] = [];
    relay.subscribe(BRIDGE_SUBJECT, (env) => {
      received.push(env);
    });

    const result = await relay.publish(
      BRIDGE_SUBJECT,
      { text: 'unmarked, no gate' },
      { from: 'relay.bridge.reply.tg1.chat-42' }
    );

    expect(result.deliveredTo).toBe(0);
    expect(received).toHaveLength(0);
    expect(result.rejected?.[0]?.reason).toBe('untrusted_bridge_principal');
  });

  it('settles a waiting reply inbox when it rejects an unmarked bridge send that carried a replyTo', async () => {
    relay.setInitiateConsentGate(allowAll);

    const replyInbox = 'relay.inbox.query.caller-1';
    const replies: RelayEnvelope[] = [];
    await relay.registerEndpoint(replyInbox);
    relay.subscribe(replyInbox, (env) => {
      replies.push(env);
    });

    await relay.publish(
      BRIDGE_SUBJECT,
      { text: 'unmarked with a waiter' },
      { from: 'relay.bridge.reply.tg1.chat-42', replyTo: replyInbox }
    );

    // The blocked caller is settled with a failure instead of hanging to timeout.
    expect(replies.length).toBeGreaterThanOrEqual(1);
  });

  it('ADMITS a bridge `from` that carries the trust marker: the legitimate server delivery path still works', async () => {
    relay.setInitiateConsentGate(allowAll);

    const received: RelayEnvelope[] = [];
    relay.subscribe(BRIDGE_SUBJECT, (env) => {
      received.push(env);
    });

    const result = await relay.publish(
      BRIDGE_SUBJECT,
      { text: 'a real bridge delivery' },
      { from: 'relay.bridge.reply.tg1.chat-42', serverBridgePrincipal: true }
    );

    // The marked publish is admitted and delivered end-to-end.
    expect(result.deliveredTo).toBe(1);
    expect(received).toHaveLength(1);
    expect(result.rejected ?? []).toHaveLength(0);
  });

  it('leaves non-bridge principals untouched by the guard: an agent-to-agent send delivers with no marker', async () => {
    const received: RelayEnvelope[] = [];
    relay.subscribe('relay.agent.ns.other', (env) => {
      received.push(env);
    });

    const result = await relay.publish(
      'relay.agent.ns.other',
      { text: 'peer to peer' },
      { from: 'relay.agent.ns.agent-1' } // no marker; not a bridge principal
    );

    expect(result.deliveredTo).toBe(1);
    expect(received).toHaveLength(1);
  });

  it('leaves a human-console send from an agent untouched by the guard', async () => {
    const received: RelayEnvelope[] = [];
    relay.subscribe('relay.human.console.client-9', (env) => {
      received.push(env);
    });

    const result = await relay.publish(
      'relay.human.console.client-9',
      { text: 'talking to myself' },
      { from: 'relay.agent.ns.agent-1' }
    );

    expect(result.deliveredTo).toBe(1);
    expect(received).toHaveLength(1);
  });
});

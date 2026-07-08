/**
 * Integration: end-to-end message survivorship across a real RelayCore restart.
 *
 * The GC unit tests (`relay-gc.test.ts`) prove a persistent inbox survives a
 * reconstruct and the construction sweep defers reaping; `relay-core.test.ts`
 * proves a late subscriber drains an endpoint's backlog. This test ties those
 * together into the realistic distributed story the deep review called out:
 * the process restarts with unread mail sitting in a persistent inbox, and a
 * consumer that reconnects (subscribes) *after* the restart must receive the
 * pre-restart messages — nothing destroyed by the construction-time GC sweep,
 * nothing stranded because the subscriber attached late.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RelayCore } from '../relay-core.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

/** Sweep interval large enough never to fire mid-test — sweeps are driven explicitly. */
const NEVER_MS = 60 * 60 * 1000;

const PERSIST_SUBJECT = 'relay.inbox.persist.survivor';

/** Poll until `collected` reaches `expectedLength` — avoids arbitrary sleeps. */
async function waitForDrain(collected: unknown[], expectedLength: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (collected.length < expectedLength) {
    if (Date.now() > deadline) {
      throw new Error(`drain timed out at ${collected.length}/${expectedLength}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-restart-int-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('message survivorship across a RelayCore restart', () => {
  it('a consumer reconnecting after restart drains the persistent mail buffered before the crash', async () => {
    // --- Before the crash: two messages land in a persistent inbox that has no
    //     live subscriber (the consumer is offline).
    const relay1 = new RelayCore({
      dataDir: tmpDir,
      gcIntervalMs: NEVER_MS,
      ttlSweepIntervalMs: NEVER_MS,
    });
    await relay1.registerEndpoint(PERSIST_SUBJECT);
    await relay1.publish(PERSIST_SUBJECT, { seq: 1 }, { from: 'relay.agent.sender' });
    await relay1.publish(PERSIST_SUBJECT, { seq: 2 }, { from: 'relay.agent.sender' });
    await relay1.close();

    // --- Restart with reaping aggressive (retention 0). The construction sweep
    //     runs immediately but must defer reaping; persistent inboxes are exempt
    //     regardless. Give the void construction sweep a beat.
    const relay2 = new RelayCore({
      dataDir: tmpDir,
      gcIntervalMs: NEVER_MS,
      ttlSweepIntervalMs: NEVER_MS,
      orphanMaildirRetentionMs: 0,
    });
    await new Promise((r) => setTimeout(r, 50));

    // --- The consumer reconnects: re-register the endpoint (boot re-registration).
    //     Nothing was destroyed by the restart or construction sweep: both
    //     messages are still on disk and readable.
    await relay2.registerEndpoint(PERSIST_SUBJECT);
    const beforeDrain = await relay2.readInbox(PERSIST_SUBJECT, { status: 'unread' });
    expect(beforeDrain.messages).toHaveLength(2);

    // Now subscribe. The late subscriber must drain the pre-restart backlog.
    const drained: RelayEnvelope[] = [];
    relay2.subscribe(PERSIST_SUBJECT, (envelope) => {
      drained.push(envelope);
    });

    await waitForDrain(drained, 2);
    const seqs = drained.map((e) => (e.payload as { seq: number }).seq).sort();
    expect(seqs).toEqual([1, 2]);

    // A fresh publish after reconnection also reaches the live subscriber.
    await relay2.publish(PERSIST_SUBJECT, { seq: 3 }, { from: 'relay.agent.sender' });
    await waitForDrain(drained, 3);
    expect(drained.map((e) => (e.payload as { seq: number }).seq).sort()).toEqual([1, 2, 3]);

    await relay2.close();
  });
});

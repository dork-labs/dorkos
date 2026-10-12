import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RelayCore } from '../relay-core.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

/**
 * The sending agent's turn level rides the envelope (spec
 * `trusted-by-default-flip` §4.4): stamped only from the in-process publish
 * option the server sets, so the agent that answers runs no looser.
 */

let tmpDir: string;
let relay: RelayCore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-sender-level-test-'));
  relay = new RelayCore({ dataDir: tmpDir });
});

afterEach(async () => {
  await relay.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const SUBJECT = 'relay.agent.default.agent-01';

/** Publish once and hand back the envelope the subscriber received. */
async function delivered(options: Parameters<RelayCore['publish']>[2]): Promise<RelayEnvelope> {
  const received: RelayEnvelope[] = [];
  relay.subscribe(SUBJECT, (env) => {
    received.push(env);
  });
  await relay.publish(SUBJECT, { content: 'hello' }, options);
  expect(received).toHaveLength(1);
  return received[0]!;
}

describe('publish stamps the sending turn’s level', () => {
  it('carries the level the server passed', async () => {
    const envelope = await delivered({
      from: 'relay.agent.default.agent-02',
      senderLevel: { asks: 'never', reach: 'everything' },
    });
    expect(envelope.senderLevel).toEqual({ asks: 'never', reach: 'everything' });
  });

  it('carries nothing when none was passed', async () => {
    const envelope = await delivered({ from: 'relay.agent.default.agent-02' });
    expect(envelope).not.toHaveProperty('senderLevel');
  });
});

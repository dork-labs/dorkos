/**
 * Integration: the limits the server seals onto a message survive the real
 * relay path to the turn (DOR-5201). A real `RelayCore` on a throwaway data
 * folder publishes the message through its whole publish pipeline, and the
 * Claude Code adapter reads it into the turn. A teammate's chain the server
 * sealed reaches the turn whole; one nobody sealed reaches it naming no room.
 * (Adapter delivery hands the envelope over in memory; a trip through JSON, as
 * a stored envelope takes, is pinned in `turn-shaping-sender.test.ts`.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RelayCore } from '../relay-core.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code/index.js';
import type { AgentRuntimeLike } from '../adapters/claude-code/index.js';
import type { RelayPublisher, AdapterRegistryLike, AdapterContext } from '../types.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { CARRIED_TURN_LIMITS_FIELD, sealTurnLimits } from '../lib/carried-turn-limits.js';

const SENDER = 'relay.agent.default.porter';
const SUBJECT = 'relay.agent.default.scout';
const CHAIN = {
  asks: 'never',
  reach: 'everything',
  teammate: [{ roomId: 'room-1', authorId: 'author-1' }],
};

class OneAdapter implements AdapterRegistryLike {
  constructor(private readonly adapter: ClaudeCodeAdapter) {}
  setRelay(_relay: RelayPublisher) {}
  deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext) {
    return this.adapter.deliver(subject, envelope, context);
  }
  async shutdown() {
    await this.adapter.stop();
  }
}

describe('sealed turn limits over the real relay path', () => {
  let tmpDir: string;
  let relay: RelayCore;
  let cca: ClaudeCodeAdapter;
  let agentManager: AgentRuntimeLike;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-sealed-limits-'));
    agentManager = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn().mockImplementation(() =>
        (async function* () {
          yield { type: 'done', data: {} } as StreamEvent;
        })()
      ),
      getSdkSessionId: vi.fn().mockReturnValue(undefined),
      approveTool: vi.fn(),
      interruptQuery: vi.fn().mockResolvedValue(true),
    };
    cca = new ClaudeCodeAdapter(
      'claude-code',
      { defaultCwd: tmpDir, maxConcurrent: 2 },
      {
        agentManager,
        traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
        approvalAuthorizer: () => true,
      }
    );
    relay = new RelayCore({
      dataDir: tmpDir,
      defaultTtlMs: 3_600_000,
      adapterRegistry: new OneAdapter(cca),
    });
    await cca.start(relay);
  });

  afterEach(async () => {
    await cca.stop();
    await relay.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Publish one message and return the ceiling its turn was sent with. */
  async function ceilingOf(carried: Record<string, unknown>): Promise<unknown> {
    await relay.publish(
      SUBJECT,
      { content: 'hello', [CARRIED_TURN_LIMITS_FIELD]: carried },
      { from: SENDER }
    );
    await vi.waitFor(() => expect(agentManager.sendMessage).toHaveBeenCalledTimes(1));
    const opts = vi.mocked(agentManager.sendMessage).mock.calls[0]![2] as {
      permissionCeiling?: unknown;
    };
    return opts.permissionCeiling;
  }

  it('carries a chain the server sealed onto the turn whole', async () => {
    expect(await ceilingOf(sealTurnLimits(SENDER, { permissionCeiling: CHAIN }))).toEqual([
      'runtime-default',
      CHAIN,
    ]);
  });

  it('carries a chain nobody sealed onto the turn naming no room', async () => {
    expect(await ceilingOf({ permissionCeiling: CHAIN })).toEqual([
      'runtime-default',
      { ...CHAIN, teammate: [] },
    ]);
  });
});

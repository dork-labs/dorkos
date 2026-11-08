/**
 * Sealed: what the turn-context record holds for an OpenCode turn is byte-equal
 * to the `session.promptAsync` body the sidecar was handed. A fake client, no
 * sidecar, no network, no key.
 *
 * The turn carries a refused approval, whose reason is fenced with a fresh
 * nonce every time it is rendered. So a record built by rendering the parts again, rather than by
 * keeping what was sent, cannot match.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GlobalEvent, OpencodeClient } from '@opencode-ai/sdk';
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import { createTestDb } from '@dorkos/test-utils/db';
import { OpenCodeRuntime } from '../opencode-runtime.js';
import { TurnEventQueue } from '../events/global-event-hub.js';
import { buildOpenCodeParts } from '../messaging/turn-input.js';
import { globalEvent, serverConnected, sessionIdle, sessionInfo } from './opencode-sse-fixtures.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { setTurnContextStore } from '../../../session/turn-context/record-turn-context.js';
import { TurnContextStore } from '../../../session/turn-context/turn-context-store.js';

vi.mock('../../../core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/config-manager.js')>();
  return { ...actual, configManager: { get: () => undefined, getAll: () => ({}) } };
});
vi.mock('../providers/check-dependencies.js', () => ({
  checkOpenCodeDependencies: vi.fn(() => []),
  resolveOpenCodeBinaryPath: vi.fn(() => null),
  getConnectedOpenCodeProvider: vi.fn(() => null),
}));
vi.mock('../providers/ollama.js', () => ({
  detectOllama: vi.fn(async () => ({ running: false, models: [] })),
}));

interface PromptBody {
  parts: { type: 'text'; text: string; synthetic?: boolean }[];
  system?: string;
}

/** A refusal whose reason rides a nonced fence: a fresh nonce on every render. */
const VERDICT: AdditionalContext = [
  {
    kind: 'approval_verdict',
    scope: 'per-turn',
    data: {
      approvalId: 'appr-made-up',
      capabilityTitle: 'Send a made-up email',
      outcome: 'denied',
      endedAt: '2026-11-08T00:00:00.000Z',
      denyReason: 'Made-up background for the test.',
    },
  },
];

let store: TurnContextStore;
let agentDir: string;
beforeEach(async () => {
  registerEveryFolderAsHome();
  store = new TurnContextStore(createTestDb());
  setTurnContextStore(store);
  agentDir = await mkdtemp(path.join(tmpdir(), 'opencode-turn-context-'));
});
afterEach(async () => {
  setTurnContextStore(null);
  clearTestHomes();
  await rm(agentDir, { recursive: true, force: true });
});

describe('OpenCode turn-context record', () => {
  it('records the exact system body and parts the sidecar received', async () => {
    const promptBodies: PromptBody[] = [];
    const queues: TurnEventQueue<GlobalEvent>[] = [];
    const info = sessionInfo('ses_test', agentDir);
    const client = {
      global: {
        event: vi.fn(async (options?: { signal?: AbortSignal }) => {
          const queue = new TurnEventQueue<GlobalEvent>();
          queues.push(queue);
          options?.signal?.addEventListener('abort', () => queue.end(), { once: true });
          return { stream: queue };
        }),
      },
      session: {
        create: vi.fn(async () => ({ data: info })),
        get: vi.fn(async () => ({ data: info })),
        list: vi.fn(async () => ({ data: [] })),
        messages: vi.fn(async () => ({ data: [] })),
        update: vi.fn(async () => ({ data: info })),
        fork: vi.fn(async () => ({ data: info })),
        abort: vi.fn(async () => ({ data: true })),
        todo: vi.fn(async () => ({ data: [] })),
        promptAsync: vi.fn(async (req: { body: PromptBody }) => {
          promptBodies.push(req.body);
          return {};
        }),
      },
      postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
      provider: { list: vi.fn(async () => ({ data: { all: [], default: {}, connected: [] } })) },
    };
    const runtime = new OpenCodeRuntime({
      provider: {
        getClient: vi.fn(async () => client as unknown as OpencodeClient),
        peekClient: vi.fn(() => client as unknown as OpencodeClient),
      },
    });
    runtime.setSessionSettings({
      getSessionSettings: vi.fn(async () => null),
      saveSessionSettings: vi.fn(async () => undefined),
      rekeySessionSettings: vi.fn(async () => undefined),
    });
    const sessionId = '3f2b8c1e-9d4a-4b6f-8a1c-2e5d7f9b0a3c';
    runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: agentDir });
    await vi.waitFor(() => expect(client.session.create).toHaveBeenCalled());

    const pump = (async () => {
      for await (const _event of runtime.sendMessage(sessionId, 'hello there', {
        cwd: agentDir,
        additionalContext: VERDICT,
        messageId: 'm-1',
      })) {
        // drained so the turn runs
      }
    })();
    await vi.waitFor(() => expect(queues.length).toBeGreaterThan(0));
    queues[0]!.push(globalEvent(agentDir, serverConnected()));
    await vi.waitFor(() => expect(promptBodies).toHaveLength(1));
    queues[0]!.push(globalEvent(agentDir, sessionIdle('ses_test')));
    await pump.catch(() => undefined);

    const sent = promptBodies[0]!;
    const [record] = store.listTurnContextsForSession(sessionId);
    expect(record).toMatchObject({
      runtime: 'opencode',
      place: 'chat',
      messageId: 'm-1',
      permissionMode: 'default',
      systemSentThisTurn: true,
    });
    // Byte-equal, piece by piece, in the order the sidecar got them.
    expect(record!.parts.map((part) => [part.slot, part.body])).toEqual([
      ['system', sent.system],
      ...sent.parts.map((part) => [part.synthetic ? 'synthetic' : 'message', part.text]),
    ]);
    expect(record!.parts.map((part) => part.slot)).toEqual(['system', 'synthetic', 'message']);
    expect(record!.parts.every((part) => !part.redacted)).toBe(true);

    // The mutant: rendering the parts again for the record gives a fresh nonce,
    // so a record rebuilt that way fails the check above.
    const rebuilt = buildOpenCodeParts('hello there', { additionalContext: VERDICT });
    expect(rebuilt[0]!.text).not.toBe(record!.parts[1]!.body);
  });
});

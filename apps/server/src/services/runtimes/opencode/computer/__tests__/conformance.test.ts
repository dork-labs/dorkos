/**
 * @vitest-environment node
 *
 * The computer-local runtime (OpenCode inside an agent computer) clears the
 * same shared `AgentRuntime` conformance gate as every other runtime
 * (DOR-4902). The cloud agent computer reuses this bridge, so a regression
 * here would land in the runtime cloud computers depend on.
 *
 * The VM is faked: no Lima, no network. The real composition runs
 * (`createComputerRuntime`: its policy proxy, credits and folder refusals,
 * session map and endpoint checks). Only the client the provider mints for a
 * guest endpoint is swapped for the same scripted sidecar client the host
 * OpenCode suite uses (`../../__tests__/conformance-client.ts`). The request
 * translation between host and guest folders is the wire's, proven in
 * `wire.test.ts`.
 */
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { afterAll, vi } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { runtimeConformance } from '@dorkos/test-utils';
import type { OpenCodeWireEvent } from '../../events/event-mapper.js';
import { createComputerRuntime } from '../index.js';
import { ComputerClientProvider } from '../provider.js';
import {
  CONFORMANCE_PROMPT,
  makeConformanceClient,
  opencodeCompactingTurn,
} from '../../__tests__/conformance-client.js';
import { OC_SESSION_A, opencodeSimpleTurn } from '../../__tests__/opencode-sse-fixtures.js';

// The computer's anchor: the one host folder its guest folder maps to.
const ANCHOR = realpathSync(mkdtempSync(join(tmpdir(), 'dorkos-computer-conformance-')));
chmodSync(ANCHOR, 0o700);
afterAll(() => rmSync(ANCHOR, { recursive: true, force: true }));

/** The scripted reply every turn gets unless a case scripts another. */
const SIMPLE_TURN = opencodeSimpleTurn(OC_SESSION_A, 'pong from opencode', {
  prompt: CONFORMANCE_PROMPT,
});

/**
 * One computer runtime over a faked guest, built the way host composition
 * builds it, and the scripted client its provider mints.
 *
 * @param turn - The turn the faked guest replays.
 */
function makeComputer(turn: OpenCodeWireEvent[] = SIMPLE_TURN) {
  const client = makeConformanceClient(turn, ANCHOR);
  vi.spyOn(
    ComputerClientProvider.prototype as unknown as { createClient(): OpencodeClient },
    'createClient'
  ).mockReturnValue(client as unknown as OpencodeClient);
  const { runtime } = createComputerRuntime({
    runtimeId: 'computer-local',
    anchor: ANCHOR,
    guestDirectory: '/home/agent/project',
    sessionMapPath: join(ANCHOR, `sessions-${randomUUID()}.json`),
    currentEnabled: () => true,
    ensureEndpoint: async () => ({
      generation: 1,
      opencodeUrl: 'http://127.0.0.1:8123',
      opencodePassword: 'guest-only-password',
    }),
  });
  return { runtime, client };
}

/** Drain one turn or command, telling `observe` after each event. */
async function drain(
  events: AsyncIterable<StreamEvent>,
  observe?: () => void
): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    observe?.();
  }
  return seen;
}

/** Start a session in the computer's one folder. */
function startSession(runtime: AgentRuntime): string {
  const sessionId = randomUUID();
  runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: ANCHOR });
  return sessionId;
}

runtimeConformance(() => makeComputer().runtime, {
  name: 'computer-local (faked guest) — AgentRuntime conformance',
  projectDir: ANCHOR,
  messageContent: CONFORMANCE_PROMPT,
  expectHistory: true,
  singleFolderRuntimeReason:
    'the computer maps exactly one host folder into its guest and refuses every other, so a session cannot start in a subfolder until DOR-5251 maps them',
  restartContinueUnprovenReason:
    'the agent computer is stopped at shutdown (`startup/computers.ts`), so no turn survives a restart to be continued',
  userLastMessageAtOmittedReason:
    'the guest OpenCode’s session list carries only created/updated times, and finding the person’s last message would cost a full message-history fetch per session on the listing path',
  creditsUnprovenReason:
    'the computer never runs on DorkOS credits: it refuses a credits model before any guest call (`factory.test.ts`), so there is no credits turn to prove negatives on',
  directoryGrantsUnprovenReason:
    'the computer refuses every extra folder grant before any guest call (`factory.test.ts`): the guest can reach only its one mapped folder',
  systemPromptAppendUnprovenReason:
    'the computer runtime is the host OpenCode runtime over another client and its proxy passes the append through untouched; delivery is proven in the host OpenCode suite',
  // DOR-2732, RT-CMP-03: the reply's usage names no window; the guest's catalog does.
  contextReadingTurn: async () => {
    const { runtime, client } = makeComputer();
    client.provider.list.mockResolvedValue({
      data: {
        all: [
          {
            // The model the scripted reply names (`opencode-sse-fixtures.ts`).
            id: 'anthropic',
            name: 'Anthropic',
            models: {
              'claude-sonnet-4-5': {
                id: 'claude-sonnet-4-5',
                limit: { context: 200_000, output: 64_000 },
              },
            },
          },
        ],
        default: {},
        connected: ['anthropic'],
      },
    } as never);
    const sessionId = startSession(runtime);
    return drain(runtime.sendMessage(sessionId, CONFORMANCE_PROMPT, { cwd: ANCHOR }));
  },
  // DOR-2732: a summary somebody asked for, answered by the guest's own compaction.
  compactIntentTurn: async (observe) => {
    const { runtime } = makeComputer(opencodeCompactingTurn(OC_SESSION_A));
    const sessionId = startSession(runtime);
    return drain(runtime.executeCommandIntent(sessionId, 'compact', { cwd: ANCHOR }), () =>
      observe?.(runtime, sessionId)
    );
  },
});

/**
 * @vitest-environment node
 *
 * OpenCodeRuntime must clear the SAME shared AgentRuntime conformance gate as
 * TestModeRuntime, ClaudeCodeRuntime, and CodexRuntime (spec
 * additional-agent-runtimes, tasks 1.5 + 3.7). The sidecar — SDK client plus
 * the `/global/event` SSE stream — and the dependency probe are fully mocked
 * by default: this suite must NEVER require the real `opencode` binary in CI.
 *
 * --- Local live smoke: OpenCode + a local open-source model (env-gated) ----
 *
 * To exercise a REAL sidecar end-to-end (real `opencode serve` boot, real
 * turns through the full adapter: session create, global-event demux, event
 * mapping, terminal `done`), run:
 *
 *   DORKOS_OPENCODE_LIVE=1 pnpm vitest run \
 *     src/services/runtimes/opencode/__tests__/conformance.test.ts
 *
 * Requirements: an `opencode` binary on PATH (or `runtimes.opencode.binaryPath`
 * configured) with at least one provider configured. The spec's
 * open-source-model acceptance is satisfied by pointing OpenCode's default
 * model at a local Ollama model — e.g. `ollama pull qwen2.5-coder:32b` (or any
 * qwen2.5-coder-class model your hardware runs) and an `ollama` provider in
 * `opencode.json` with that model as the default — so the identical
 * conformance assertions stream a real turn from a genuinely local model with
 * no proprietary API in the loop. Under the flag the vi.mock factory below
 * returns `importOriginal()` (the real dependency probe), the runtime is
 * constructed over a real `OpenCodeServerManager` (which spawns and owns the
 * sidecar, shared across tests and shut down in afterAll), `projectDir`
 * becomes a real temp directory, and per-test timeouts are raised for model
 * latency. Turns run in 'default' permission mode, so the sidecar's
 * conservative ask-ruleset (edit/bash/webfetch → ask) gates every mutation —
 * a live run cannot write unattended. CI never sets the flag: unset → fully
 * mocked, no binary, no Ollama.
 */
import { afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OpencodeClient, GlobalEvent } from '@opencode-ai/sdk';
import { runtimeConformance } from '@dorkos/test-utils';

/** Hoisted so the (also hoisted) vi.mock factory can branch on it. */
const LIVE = vi.hoisted(() => process.env.DORKOS_OPENCODE_LIVE === '1');

// checkDependencies() shells out to `opencode --version` / `opencode auth
// list` for real — mock the probe so conformance never spawns (or requires)
// the binary. The live smoke restores the real probe.
vi.mock('../check-dependencies.js', async (importOriginal) => {
  if (LIVE) return importOriginal();
  return {
    checkOpenCodeDependencies: vi.fn(() => [
      {
        name: 'OpenCode CLI',
        description: 'The OpenCode CLI powers OpenCode agent sessions in DorkOS.',
        status: 'satisfied',
        version: '1.17.13',
      },
      {
        name: 'OpenCode authentication',
        description: 'A stored provider credential lets OpenCode reach a model on your behalf.',
        status: 'satisfied',
      },
    ]),
    resolveOpenCodeBinaryPath: vi.fn(() => null),
  };
});

import { OpenCodeRuntime } from '../opencode-runtime.js';
import { driveDurableTurn } from '../../../session/__tests__/durable-turn-harness.js';
import { TurnEventQueue } from '../global-event-hub.js';
import type { OpenCodeWireEvent } from '../event-mapper.js';
import type { OpenCodeClientProvider } from '../session-mapper.js';
import {
  OC_SESSION_A,
  assistantMessage,
  globalEvent,
  opencodeErrorTurn,
  opencodeSimpleTurn,
  serverConnected,
  sessionInfo,
  textPart,
  userMessage,
} from './opencode-sse-fixtures.js';

// A real sidecar spawns `opencode serve` with the session's directory, which
// must exist; mocked turns never touch the filesystem, so the fixed fake path
// keeps them hermetic.
const PROJECT_DIR = LIVE
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-opencode-live-'))
  : '/projects/conformance';

if (LIVE) {
  // Real turns boot a sidecar and round-trip to a local model — well beyond
  // the default 5s test timeout.
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
}

// The live sidecar is shared across tests (one boot) and owned by this file;
// dynamic import so mocked CI runs never load the server-manager (whose
// module graph pulls in the real config store).
const liveManager = LIVE
  ? new (await import('../server-manager.js')).OpenCodeServerManager()
  : null;

afterAll(async () => {
  if (liveManager) await liveManager.shutdown();
  if (LIVE) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
});

/**
 * Mock sidecar client for one conformance runtime. The conformance suite
 * drains `sendMessage` to completion and cannot push wire events mid-turn, so
 * every `/global/event` connection is minted with ONE full scripted turn
 * PRE-QUEUED (the caller-provided `turn`): the runtime registers the turn's
 * demux listener before the hub's pump connects, and `TurnEventQueue`
 * buffers, so early-queued events are simply drained once mapping starts.
 * `session.get` reports the SAME directory the event envelopes carry — the
 * demux key is strict string equality on `{directory, sessionID}`, and any
 * drift drops every event.
 */
function makeConformanceClient(turn: OpenCodeWireEvent[]) {
  const info = sessionInfo(OC_SESSION_A, PROJECT_DIR);
  return {
    global: {
      event: vi.fn(async (options?: { signal?: AbortSignal }) => {
        const queue = new TurnEventQueue<GlobalEvent>();
        // End (never fail) on hub abort: the post-turn unsubscribe must read
        // as a quiet client-side wind-down, not a sidecar drop.
        options?.signal?.addEventListener('abort', () => queue.end(), { once: true });
        queue.push(globalEvent(PROJECT_DIR, serverConnected()));
        for (const event of turn) {
          queue.push(globalEvent(PROJECT_DIR, event));
        }
        return { stream: queue };
      }),
    },
    session: {
      create: vi.fn(async () => ({ data: info })),
      get: vi.fn(async () => ({ data: info })),
      list: vi.fn(async () => ({ data: [] })),
      // The turn as read back from the sidecar's durable store — OpenCode has
      // real native history, so the suite runs with `expectHistory: true`.
      messages: vi.fn(async () => ({
        data: [
          {
            info: userMessage(OC_SESSION_A, 'msg_0000'),
            parts: [
              textPart(OC_SESSION_A, 'prt_u1', 'conformance ping', { messageID: 'msg_0000' }),
            ],
          },
          {
            info: assistantMessage(OC_SESSION_A, { completed: true }),
            parts: [textPart(OC_SESSION_A, 'prt_text01', 'pong from opencode', { end: true })],
          },
        ],
      })),
      update: vi.fn(async () => ({ data: info })),
      fork: vi.fn(async () => ({ data: info })),
      promptAsync: vi.fn(async () => ({})),
      abort: vi.fn(async () => ({ data: true })),
      todo: vi.fn(async () => ({ data: [] })),
    },
    postSessionIdPermissionsPermissionId: vi.fn(async () => ({ data: true })),
    provider: { list: vi.fn(async () => ({ data: { all: [], default: {}, connected: [] } })) },
  };
}

/** Fresh mocked provider per runtime — task 3.6's verified construction seam. */
function makeMockedProvider(
  turn: OpenCodeWireEvent[] = opencodeSimpleTurn(OC_SESSION_A, 'pong from opencode')
): OpenCodeClientProvider {
  const client = makeConformanceClient(turn) as unknown as OpencodeClient;
  return {
    getClient: async () => client,
    peekClient: () => client,
  };
}

runtimeConformance(
  // Fresh runtime per test; the provider is the only dependency (ADR-0308).
  () => new OpenCodeRuntime({ provider: LIVE ? liveManager! : makeMockedProvider() }),
  {
    name: LIVE
      ? 'OpenCodeRuntime (LIVE sidecar + local model) — AgentRuntime conformance'
      : 'OpenCodeRuntime (mocked sidecar) — AgentRuntime conformance',
    projectDir: PROJECT_DIR,
    // OpenCode owns a durable native store (unlike stateless Codex), so a
    // completed turn MUST surface real history: scripted session.messages in
    // mocked mode, the sidecar's actual store in live mode.
    expectHistory: true,
    // DOR-189: the EventLog fallback is now persisted, so a completed turn is
    // reconstructable from the durable store after a restart too.
    durableHistory: (runtime, sessionId, content) =>
      driveDurableTurn(runtime, sessionId, content, PROJECT_DIR),
    // A deterministic failure cannot be scripted against a live sidecar, so
    // the turn-failure gate runs only in mocked mode: `session.error`
    // (non-abort) followed by the `session.idle` terminal.
    ...(LIVE
      ? {}
      : {
          makeFailingRuntime: () =>
            new OpenCodeRuntime({
              provider: makeMockedProvider(
                opencodeErrorTurn(OC_SESSION_A, 'Simulated OpenCode turn failure')
              ),
            }),
        }),
  }
);

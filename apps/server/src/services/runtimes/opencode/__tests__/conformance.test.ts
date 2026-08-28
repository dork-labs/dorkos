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
import { afterAll, expect, onTestFinished, vi } from 'vitest';
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
vi.mock('../providers/check-dependencies.js', async (importOriginal) => {
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
import {
  driveDurableTurn,
  drivePresenceTurn,
  driveTerminalOnce,
  driveQueueDurability,
} from '../../../session/__tests__/durable-turn-harness.js';
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
  sessionCompacted,
  sessionIdle,
  sessionInfo,
  statusEvent,
  textPart,
  userMessage,
} from './opencode-sse-fixtures.js';

/**
 * A turn that compacts before going idle. OpenCode reports compaction as a
 * single post-hoc `session.compacted` — the mapper emits an `operation_progress`
 * `done` (honest degradation: no start signal) plus the `compact_boundary` row.
 */
function opencodeCompactingTurn(sessionID: string): OpenCodeWireEvent[] {
  return [
    statusEvent(sessionID, { type: 'busy' }),
    sessionCompacted(sessionID),
    statusEvent(sessionID, { type: 'idle' }),
    sessionIdle(sessionID),
  ];
}

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
      // The command-intent (compact) trigger: OpenCodeRuntime.executeCommandIntent
      // calls session.summarize, then drains the SAME per-turn demux tap as a
      // prompt — so the pre-queued turn's terminal (session.idle → done)
      // satisfies the conformance dispatch gate.
      summarize: vi.fn(async () => ({})),
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
  lastClient = client as unknown as ReturnType<typeof makeConformanceClient>;
  return {
    getClient: async () => client,
    peekClient: () => client,
  };
}

/**
 * The mocked client behind whichever runtime `makeRuntime()` most recently
 * built. `makeMockedProvider` is the only place a fresh one is minted, so
 * this always names the current test's client — which C11's `hangingInterrupt`
 * driver needs to reach AFTER construction, to override `global.event` and
 * `session.abort` for one case without touching every other one's default
 * script. Never set in LIVE mode, where there is no mock to reach.
 */
let lastClient: ReturnType<typeof makeConformanceClient> | undefined;

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
    // Presence is only assertable against a turn that really runs: drive one
    // through the same projector the trigger path feeds.
    presenceTurn: (runtime, sessionId, content, probes) =>
      drivePresenceTurn(runtime, sessionId, content, PROJECT_DIR, probes),
    // C2/C3 are server-owned invariants every runtime inherits by construction,
    // so both drivers exercise the shared machinery rather than the sidecar —
    // safe in LIVE mode too. OpenCode declares neither steer nor stage, so it
    // wires NO dispositionTurn: its C1 is the not-declared arm.
    terminalOnce: () => driveTerminalOnce(PROJECT_DIR),
    queueDurability: () => driveQueueDurability(),
    // BC-16: the sidecar's session list reports only created/updated times, and
    // ADR-0308 forbids reading its store directly, so the person's last message
    // could only be found by fetching every session's full message history —
    // one whole-conversation read per row, on every cockpit boot.
    userLastMessageAtOmittedReason:
      'the OpenCode sidecar’s session list carries only created/updated times, and finding the person’s last message would cost a full message-history fetch per session on the listing path',
    // A deterministic failure cannot be scripted against a live sidecar, so
    // the turn-failure gate runs only in mocked mode: `session.error`
    // (non-abort) followed by the `session.idle` terminal.
    ...(LIVE
      ? {
          // The `project-rooms` §3.3 gate needs to read what the sidecar was
          // sent, and a live sidecar is a separate process this suite only
          // talks TO. The mocked run below is where the property is proven.
          systemPromptAppendUnprovenReason:
            'a live OpenCode sidecar is a separate process this suite can only send to, so what its prompt carried is only observable in the mocked run',
        }
      : {
          // The `project-rooms` §3.3 gate. OpenCode's caller append rides a
          // SYNTHETIC part of `session.promptAsync` (`buildOpenCodeParts`) —
          // composed per turn, never at session start — so the observation is
          // exactly what that call was handed, read off the mocked client. Both
          // turns run on ONE session; the second is the one that matters.
          systemPromptAppendTurns: async (runtime, sessionId, [first, second]) => {
            const client = lastClient;
            if (!client) {
              throw new Error('OpenCode conformance: no mocked client to read the prompt off');
            }
            for (const systemPromptAppend of [first, second]) {
              for await (const _event of runtime.sendMessage(sessionId, 'conformance ping', {
                cwd: PROJECT_DIR,
                systemPromptAppend,
              })) {
                // Drained: the assertion is about the sidecar's input.
              }
            }
            // ONE sidecar session across both turns. Without this, two separate
            // sessions would satisfy every assertion the suite makes and prove
            // nothing about "the NEXT turn of a session already running".
            expect(
              client.session.create,
              'both turns were supposed to run on one sidecar session'
            ).toHaveBeenCalledTimes(1);
            // The mocked `promptAsync` takes no declared parameters (it answers
            // `{}` and ignores its input), so the recorded arguments have to be
            // named here rather than inferred.
            const calls = vi.mocked(client.session.promptAsync).mock.calls as unknown as Array<
              [{ body?: { parts?: Array<{ text?: string }> } }]
            >;
            const sent = calls.map((call) =>
              (call[0]?.body?.parts ?? []).map((part) => part.text ?? '').join('\n\n')
            );
            return [sent[0] ?? '', sent[1] ?? ''] as const;
          },
          makeFailingRuntime: () =>
            new OpenCodeRuntime({
              provider: makeMockedProvider(
                opencodeErrorTurn(OC_SESSION_A, 'Simulated OpenCode turn failure')
              ),
            }),
          // A scripted compaction can't be forced against a live sidecar, so the
          // operation_progress gate runs only in mocked mode (DOR-110).
          makeCompactingRuntime: () =>
            new OpenCodeRuntime({
              provider: makeMockedProvider(opencodeCompactingTurn(OC_SESSION_A)),
            }),
          // C11 (DOR-1299): stage a turn the mocked sidecar never answers —
          // `global.event` reports connected and then falls silent (no
          // `session.idle` ever arrives, so the turn stays genuinely open),
          // and `session.abort` returns a promise nothing will ever settle,
          // the mocked equivalent of a wedged sidecar dropping the request.
          // `promptAsync` having been called is the real, observable signal
          // that `runOpenCodeTurn` reached past `this.activeTurns.set` — the
          // same point real DOR-1299 traffic reaches on a healthy sidecar —
          // so waiting for it (real timers; fake ones arm only for the race
          // itself, in the shared C11 case) proves the turn is armed rather
          // than guessing at a tick count. No session-scoped escalation exists
          // on expiry (`INTERRUPT_ACK_TIMEOUT_MS`'s TSDoc), so the pinned
          // settle value is `false` — honest, not an escalation.
          hangingInterrupt: async (runtime, sessionId) => {
            const client = lastClient;
            if (!client) {
              throw new Error('OpenCode conformance: no mocked client to arm for C11');
            }
            vi.mocked(client.global.event).mockImplementation(
              async (options?: { signal?: AbortSignal }) => {
                const queue = new TurnEventQueue<GlobalEvent>();
                options?.signal?.addEventListener('abort', () => queue.end(), { once: true });
                queue.push(globalEvent(PROJECT_DIR, serverConnected()));
                return { stream: queue };
              }
            );
            vi.mocked(client.session.abort).mockImplementation(() => new Promise(() => {}));
            // Owned, not floated: this generator never yields (the turn is
            // deliberately stuck open), so nothing else will ever close it —
            // `.return()` in cleanup is the only thing that does.
            const hungTurn = runtime.sendMessage(sessionId, 'hang on interrupt', {
              cwd: PROJECT_DIR,
            });
            onTestFinished(() => {
              void hungTurn.return(undefined);
            });
            void hungTurn.next();
            await vi.waitFor(() => expect(client.session.promptAsync).toHaveBeenCalled());
            return false;
          },
        }),
  }
);

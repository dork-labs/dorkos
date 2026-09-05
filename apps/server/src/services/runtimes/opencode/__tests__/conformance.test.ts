/**
 * @vitest-environment node
 *
 * OpenCodeRuntime must clear the SAME shared AgentRuntime conformance gate as
 * TestModeRuntime, ClaudeCodeRuntime, and CodexRuntime (spec
 * additional-agent-runtimes, tasks 1.5 + 3.7). The sidecar — SDK client plus
 * the `/global/event` SSE stream — and the dependency probe are fully mocked
 * by default: this suite must NEVER require the real `opencode` binary in CI.
 *
 * --- Two live smokes, two independent flags, and one of them costs money -----
 *
 * Both drive a REAL sidecar end to end (real `opencode serve` boot, real turns
 * through the full adapter: session create, global-event demux, event mapping,
 * terminal `done`). They are armed by SEPARATE variables on purpose, so the free
 * one can never turn into the paid one by accident:
 *
 *   FREE — a local open-source model, nothing billed:
 *     DORKOS_OPENCODE_LIVE=1 pnpm vitest run \
 *       src/services/runtimes/opencode/__tests__/conformance.test.ts
 *
 *   PAID — a cheap model on OpenRouter, billed to that account:
 *     DORKOS_EVALS_PAID_PROVIDER is NOT what arms this one; this file has its
 *     own flag, because it is a vitest file rather than an eval run:
 *     DORKOS_OPENCODE_LIVE_PAID=1 OPENROUTER_API_KEY=sk-or-… pnpm vitest run \
 *       src/services/runtimes/opencode/__tests__/conformance.test.ts
 *
 * The paid flag needs the key TOO, and a flag with no key is a hard collection
 * failure rather than a quiet fall back to the mocked run — a paid smoke that
 * silently ran mocked would report a green about a provider it never reached.
 * A key with no flag arms nothing: plenty of people leave `OPENROUTER_API_KEY`
 * exported, and having one is not the same as deciding to spend.
 *
 * FREE mode honors an `OPENCODE_CONFIG` file too (the sidecar merges it), which is the tidiest way to
 * pin a local model for one run without touching your own OpenCode config:
 *
 *     DORKOS_OPENCODE_LIVE=1 OPENCODE_CONFIG=/tmp/local.json pnpm vitest run …
 *
 * where `local.json` declares an `ollama` provider over `http://127.0.0.1:11434/v1` and names one of
 * its models as `model`. Otherwise FREE mode's model comes from OpenCode's own config — e.g. `ollama pull
 * qwen2.5-coder:32b` and an `ollama` provider in `opencode.json` with that model
 * as the default — so the identical conformance assertions stream a real turn
 * from a genuinely local model with no proprietary API in the loop.
 *
 * **"Free" there is a property of YOUR OpenCode config, not of this flag.** The
 * free arm writes `provider: null` / `defaultModel: null`, so the sidecar falls
 * back to whatever `~/.config/opencode` names as its default — and
 * `server-manager.ts` spreads `process.env` into the spawn, so an exported
 * `OPENROUTER_API_KEY` is reachable from it. If your OpenCode default is a hosted
 * model, `DORKOS_OPENCODE_LIVE=1` bills it. Point that default at a local model
 * before using this arm, or use the paid arm, which at least pins what it spends
 * on.
 *
 * PAID mode pins its model instead of inheriting one, because an unpinned run
 * cannot say what it spent on. The pin rides `OPENCODE_CONFIG`, a temp config
 * file the sidecar MERGES with the `OPENCODE_CONFIG_CONTENT` DorkOS injects
 * (verified live against 1.18.15: `GET /config` reports the model from the file
 * and the ask-ruleset from the injected content). The key itself travels as
 * `OPENROUTER_API_KEY` in the inherited environment — `server-manager.ts` spreads
 * `process.env` into the spawn — so nothing is written to disk.
 *
 * Both modes need a `runtimes.opencode` config section to boot a sidecar at all,
 * and neither may touch the operator's real one: this file writes a THROWAWAY
 * `DORK_HOME` and points the config manager at it. The `opencode` binary is
 * found at `DORKOS_OPENCODE_BINARY`, else the DorkOS-provisioned install under
 * `~/.dork`, else plain `opencode` on `PATH`.
 *
 * Under either flag the vi.mock factory below returns `importOriginal()` (the
 * real dependency probe), the runtime is constructed over a real
 * `OpenCodeServerManager` (which spawns and owns the sidecar, shared across
 * tests and shut down in afterAll), `projectDir` becomes a real temp directory,
 * and per-test timeouts are raised for model latency. Turns run in 'default'
 * permission mode, so the sidecar's conservative ask-ruleset (edit/bash/webfetch
 * → ask) gates every mutation — a live run cannot write unattended. CI never
 * sets either flag: unset → fully mocked, no binary, no provider, no spend.
 */
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OpencodeClient, GlobalEvent, Message, Part } from '@opencode-ai/sdk';
import { runtimeConformance } from '@dorkos/test-utils';

/**
 * The live-mode decision, hoisted so the (also hoisted) vi.mock factory can
 * branch on it — and computed in ONE callback so the paid arm's fail-closed
 * check cannot be evaluated before the flags it reads.
 *
 * `paid` requires the key as well as the flag, and a flag without a key THROWS
 * here. Collection fails with the reason on screen, which is the only honest
 * outcome: falling back to the mocked run would report a green about a provider
 * nothing reached, and skipping would report nothing at all to somebody who
 * explicitly asked for a paid run.
 */
const LIVE_MODE = vi.hoisted(() => {
  const free = process.env.DORKOS_OPENCODE_LIVE === '1';
  const paid = process.env.DORKOS_OPENCODE_LIVE_PAID === '1';
  const key = (process.env.OPENROUTER_API_KEY ?? '').trim();
  if (paid && key === '') {
    throw new Error(
      'DORKOS_OPENCODE_LIVE_PAID=1 was set with no OPENROUTER_API_KEY, so this suite has no way ' +
        'to reach a model. Set the key, or unset the flag to run fully mocked. Refusing rather ' +
        'than falling back to the mocked run, which would report a green about a provider ' +
        'nothing reached.'
    );
  }
  return { free, paid, live: free || paid };
});

/**
 * True in either live mode — the real sidecar, the real dependency probe.
 *
 * Hoisted in its own right, not merely derived: the `vi.mock` factory below is
 * lifted above every ordinary declaration in this file, so a plain
 * `const LIVE = LIVE_MODE.live` is in its temporal dead zone when the factory
 * runs (measured: "Cannot access 'LIVE' before initialization").
 */
const LIVE = vi.hoisted(() => LIVE_MODE.live);

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
import { LocalSessionAttachmentStore } from '../../../session/attachments/local-session-attachment-store.js';
import {
  driveDurableTurn,
  drivePresenceTurn,
  driveReloadedHistory,
  driveTerminalOnce,
  driveQueueDurability,
} from '../../../session/__tests__/durable-turn-harness.js';
import { TurnEventQueue } from '../events/global-event-hub.js';
import type { StreamEvent } from '@dorkos/shared/types';
import type { OpenCodeWireEvent } from '../events/event-mapper.js';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';
import {
  OC_SESSION_A,
  assistantMessage,
  globalEvent,
  opencodeErrorTurn,
  opencodeSimpleTurn,
  opencodeRepublishedImageTurn,
  providerAuthError,
  serverConnected,
  sessionCompacted,
  sessionError,
  sessionIdle,
  sessionInfo,
  statusEvent,
  textPart,
  userMessage,
} from './opencode-sse-fixtures.js';

/**
 * The provider's own words for a dead credential — what the mocked sidecar is
 * scripted with, and what a person must never be shown (DOR-1656).
 */
const OPENCODE_VENDOR_AUTH_TEXT =
  'AuthenticationError: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';

/**
 * A turn that fails on a dead provider credential: busy, a `session.error`
 * carrying `ProviderAuthError`, then idle. `ProviderAuthError` is the shape the
 * sidecar reports for every provider whose sign-in has stopped working, and its
 * `data.message` is whatever that provider chose to say.
 *
 * @param sessionID - The sidecar session the failure belongs to.
 */
function opencodeAuthFailedTurn(sessionID: string): OpenCodeWireEvent[] {
  return [
    statusEvent(sessionID, { type: 'busy' }),
    sessionError(sessionID, providerAuthError('anthropic', OPENCODE_VENDOR_AUTH_TEXT)),
    statusEvent(sessionID, { type: 'idle' }),
    sessionIdle(sessionID),
  ];
}

/**
 * What the sidecar's durable store holds for a session — the shape
 * `session.messages` answers with, and the one `getMessageHistory` reads.
 */
type StoredMessages = Array<{ info: Message; parts: Part[] }>;

/**
 * How the sidecar's own store records that same credential failure, and what a
 * reopened session is therefore read out of (DOR-1678).
 *
 * The person's message survives with its parts; the assistant message carries
 * the failure on `error` and has NO parts at all, because the turn died before
 * the model said anything. That is the measured shape class — every `APIError`
 * row in this machine's `opencode.db` has zero parts — and it is what made the
 * failure vanish from reopened transcripts entirely before DOR-1666, since a
 * parts-only reader had nothing to map.
 *
 * @param sessionID - The sidecar session the stored turn belongs to.
 */
function opencodeAuthFailedStore(sessionID: string): StoredMessages {
  return [
    {
      info: userMessage(sessionID, 'msg_0000'),
      parts: [textPart(sessionID, 'prt_u1', CONFORMANCE_PROMPT, { messageID: 'msg_0000' })],
    },
    {
      info: assistantMessage(sessionID, {
        id: 'msg_auth',
        error: providerAuthError('anthropic', OPENCODE_VENDOR_AUTH_TEXT),
      }),
      parts: [],
    },
  ];
}

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

/**
 * The cheap OpenRouter model the PAID smoke pins, in OpenCode's own
 * `provider/model` spelling.
 *
 * The two-segment tail is load-bearing and is the same pin
 * `packages/evals/src/types.ts` carries: `parseModelSelection` splits on the
 * FIRST `/`, so this is `{providerID: 'openrouter', modelID: 'qwen/qwen3.7-flash'}`.
 * Repeated here rather than imported because `packages/evals` depends on this
 * app, not the other way round; a test in `packages/evals` pins the two together.
 */
const PAID_MODEL = 'openrouter/qwen/qwen3.7-flash';

/**
 * The `opencode` binary a live run should boot.
 *
 * `DORKOS_OPENCODE_BINARY` wins, then the DorkOS-provisioned install under the
 * operator's real `~/.dork` (which is where `Settings → Runtimes → OpenCode`
 * puts it, and it is NOT on `PATH`), then a plain `opencode` for a machine that
 * installed one itself. `resolveDorkHome()` is deliberately not consulted: under
 * vitest it answers `<cwd>/.temp/.dork`, which never holds a provisioned copy.
 */
function resolveLiveBinary(): string {
  const override = process.env.DORKOS_OPENCODE_BINARY;
  if (override) return override;
  const provisioned = path.join(
    os.homedir(),
    '.dork',
    'runtimes',
    'opencode',
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'opencode.cmd' : 'opencode'
  );
  return fs.existsSync(provisioned) ? provisioned : 'opencode';
}

/**
 * Stand up a THROWAWAY `DORK_HOME` for a live run and point the config manager
 * at it, so the sidecar has a `runtimes.opencode` section to boot from without
 * this suite ever reading or writing the operator's real config.
 *
 * In PAID mode it also writes an `OPENCODE_CONFIG` file pinning the model and
 * exports the variable, which the sidecar merges with the ask-ruleset DorkOS
 * injects as `OPENCODE_CONFIG_CONTENT`.
 *
 * @returns The temp directory to remove afterwards.
 */
async function prepareLiveConfig(): Promise<string> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-opencode-live-home-'));
  fs.mkdirSync(path.join(home, '.dork'), { recursive: true });
  const dorkHome = path.join(home, '.dork');
  fs.writeFileSync(
    path.join(dorkHome, 'config.json'),
    JSON.stringify({
      // A PARTIAL `runtimes` section, deliberately: `conf` merges its defaults
      // at the top level, so this replaces the whole section — and the only
      // thing a live sidecar boot reads out of it is `runtimes.opencode`.
      runtimes: {
        default: 'opencode',
        opencode: {
          enabled: true,
          binaryPath: resolveLiveBinary(),
          port: 0,
          provider: LIVE_MODE.paid ? 'openrouter' : null,
          baseURL: null,
          defaultModel: LIVE_MODE.paid ? PAID_MODEL : null,
          defaultTrustStop: null,
        },
      },
    }),
    'utf8'
  );
  (await import('../../../core/config-manager.js')).initConfigManager(dorkHome);

  if (LIVE_MODE.paid) {
    const configFile = path.join(home, 'opencode.json');
    fs.writeFileSync(configFile, JSON.stringify({ model: PAID_MODEL }), 'utf8');
    // This suite owns the sidecar's environment for a manually-armed live run;
    // `server-manager.ts` spreads `process.env` into the spawn, which is how the
    // pin (and the key) reach it.
    process.env.OPENCODE_CONFIG = configFile;
  }
  return home;
}

let liveHome: string | undefined;

if (LIVE) {
  // Real turns boot a sidecar and round-trip to a local model — well beyond
  // the default 5s test timeout.
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
  liveHome = await prepareLiveConfig();
}

// The live sidecar is shared across tests (one boot) and owned by this file;
// dynamic import so mocked CI runs never load the server-manager (whose
// module graph pulls in the real config store).
const liveManager = LIVE
  ? new (await import('../server-manager.js')).OpenCodeServerManager()
  : null;

/**
 * Where the conformance runtime keeps images, in mocked mode.
 *
 * Wired only when mocked, and that asymmetry is the honest one: a live sidecar
 * talking to a local model will not deterministically produce a picture, so the
 * LIVE runtime declares `mediaOutput: 'none'` and the suite's media block takes
 * its not-declared arm rather than asserting something the run cannot show.
 */
const ATTACHMENT_HOME = LIVE
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-opencode-conformance-media-'));

afterAll(async () => {
  if (liveManager) await liveManager.shutdown();
  if (LIVE) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  if (liveHome) fs.rmSync(liveHome, { recursive: true, force: true });
  if (ATTACHMENT_HOME) fs.rmSync(ATTACHMENT_HOME, { recursive: true, force: true });
});

/**
 * The prompt every conformance turn sends. Shared with the suite (via
 * `messageContent`) and with the scripted turn's echo of it, so the sidecar
 * mock cannot drift from what was actually sent — the invariant that forbids a
 * turn from speaking its own prompt back is only as honest as that match.
 */
const CONFORMANCE_PROMPT = 'conformance ping';

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
function makeConformanceClient(turn: OpenCodeWireEvent[], stored?: StoredMessages) {
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
      // A caller that scripted a FAILED turn passes what that failure was
      // stored as instead: the sidecar records the outcome it actually had,
      // and a store still answering with a tidy success would make any
      // assertion about a reopened failed turn meaningless.
      messages: vi.fn(async () => ({
        data: stored ?? [
          {
            info: userMessage(OC_SESSION_A, 'msg_0000'),
            parts: [
              textPart(OC_SESSION_A, 'prt_u1', CONFORMANCE_PROMPT, { messageID: 'msg_0000' }),
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
  turn: OpenCodeWireEvent[] = opencodeSimpleTurn(OC_SESSION_A, 'pong from opencode', {
    prompt: CONFORMANCE_PROMPT,
  }),
  stored?: StoredMessages
): OpenCodeClientProvider {
  const client = makeConformanceClient(turn, stored) as unknown as OpencodeClient;
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
  () =>
    new OpenCodeRuntime({
      provider: LIVE ? liveManager! : makeMockedProvider(),
      ...(ATTACHMENT_HOME ? { attachments: new LocalSessionAttachmentStore(ATTACHMENT_HOME) } : {}),
    }),
  {
    name: LIVE_MODE.paid
      ? `OpenCodeRuntime (LIVE sidecar + ${PAID_MODEL} on OpenRouter) — AgentRuntime conformance`
      : LIVE
        ? 'OpenCodeRuntime (LIVE sidecar + local model) — AgentRuntime conformance'
        : 'OpenCodeRuntime (mocked sidecar) — AgentRuntime conformance',
    projectDir: PROJECT_DIR,
    messageContent: CONFORMANCE_PROMPT,
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
    // The media gate. Owns its own runtime because a media turn needs a
    // differently-scripted sidecar than the default `opencodeSimpleTurn`: a
    // tool that hands back a screenshot (the path OpenCode populates TODAY via
    // `ToolStateCompleted.attachments`, and read nothing of before this change)
    // plus a generated image published TWICE, so the suite's one-picture-one-
    // announcement assertion is actually exercised rather than passing because
    // nothing republished. Wired only when an attachment store is, which is what
    // keeps the declaration and the proof in step.
    ...(ATTACHMENT_HOME
      ? {
          mediaTurn: async () => {
            const runtime = new OpenCodeRuntime({
              provider: makeMockedProvider(opencodeRepublishedImageTurn(OC_SESSION_A)),
              attachments: new LocalSessionAttachmentStore(ATTACHMENT_HOME),
            });
            const sessionId = randomUUID();
            runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: PROJECT_DIR });
            const events = [];
            for await (const event of runtime.sendMessage(sessionId, 'take a screenshot', {
              cwd: PROJECT_DIR,
            })) {
              events.push(event);
            }
            return events;
          },
        }
      : {}),
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
          // The `project-rooms` §3.3 gate. OpenCode's caller append rides
          // `body.system` on `session.promptAsync` (`buildOpenCodeSystem`,
          // DOR-477) — composed per turn, never at session start — so the
          // observation is exactly what that call was handed, read off the
          // mocked client. Both turns run on ONE session; the second is the one
          // that matters, and it is the turn the old `parts` delivery made
          // expensive: a part is persisted into the conversation, a `system`
          // string is not.
          systemPromptAppendTurns: async (runtime, sessionId, [first, second]) => {
            const client = lastClient;
            if (!client) {
              throw new Error('OpenCode conformance: no mocked client to read the prompt off');
            }
            for (const systemPromptAppend of [first, second]) {
              for await (const _event of runtime.sendMessage(sessionId, CONFORMANCE_PROMPT, {
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
              [{ body?: { parts?: Array<{ text?: string }>; system?: string } }]
            >;
            // BOTH channels, joined: the gate asks what the turn carried, and
            // this adapter now splits that across `system` (identity + append)
            // and `parts` (the per-turn bag + the person's text). Reading only
            // one of the two would let a block move between them unnoticed.
            const sent = calls.map((call) =>
              [
                call[0]?.body?.system ?? '',
                ...(call[0]?.body?.parts ?? []).map((part) => part.text ?? ''),
              ]
                .filter(Boolean)
                .join('\n\n')
            );
            return [sent[0] ?? '', sent[1] ?? ''] as const;
          },
          makeFailingRuntime: () =>
            new OpenCodeRuntime({
              provider: makeMockedProvider(
                opencodeErrorTurn(OC_SESSION_A, 'Simulated OpenCode turn failure')
              ),
            }),
          // DOR-1656: a dead provider credential. Scripted rather than live —
          // a real sidecar's sign-in cannot be revoked on demand from here.
          authFailure: {
            vendorText: OPENCODE_VENDOR_AUTH_TEXT,
            makeRuntime: () =>
              new OpenCodeRuntime({
                provider: makeMockedProvider(
                  opencodeAuthFailedTurn(OC_SESSION_A),
                  // The store answers with what the failure was RECORDED as,
                  // not the default success transcript — see
                  // `opencodeAuthFailedStore`.
                  opencodeAuthFailedStore(OC_SESSION_A)
                ),
              }),
            // DOR-1678, the reload half. OpenCode owns a native store, so the
            // reopen path reads the sidecar rather than the EventLog — which is
            // why this goes through `getMessageHistory` (the call the reopen
            // makes) instead of the log-backed reader.
            hydratedHistory: (runtime, sessionId, content) =>
              driveReloadedHistory(runtime, sessionId, content, PROJECT_DIR),
          },
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
          // settle is `unconfirmed / ack-timeout` — honest, not an escalation,
          // and the ending that keeps the Stop button pressable.
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
            return { outcome: 'unconfirmed', reason: 'ack-timeout', runtime: 'opencode' };
          },
        }),
  }
);

/**
 * Compaction, against a REAL sidecar (DOR-1668).
 *
 * `POST /session/{id}/summarize` requires a `{providerID, modelID}` body, but
 * `@opencode-ai/sdk` types every payload as `body?:` — so DorkOS shipped
 * `session.summarize({ path })` with no body, the mocked run stayed green, and
 * every real `/compact` answered
 * `{"name":"BadRequest","data":{"message":"Expected object, got undefined","kind":"Payload"}}`.
 * No mock can catch that class of bug: a mock accepts whatever it is handed.
 *
 * The shared `command intents (DOR-109)` gate already drives `compact` in both
 * modes, but it settles for "a terminal event arrived". This case exists to say
 * the requirement out loud and to make a live run fail LOUDLY on it: the trigger
 * throws inside `runOpenCodeTurn`, so a rejected body rejects this generator —
 * the assertions below are only reached when the sidecar accepted the payload.
 *
 * It runs a real turn first, deliberately. That gives the session a model to
 * compact ON (the second rung of {@link resolveCompactionModel}, and the same
 * rung OpenCode's own automatic compaction uses) and something to compact.
 */
describe.skipIf(!LIVE)('OpenCode compaction against a live sidecar (DOR-1668)', () => {
  it('the sidecar ACCEPTS the summarize body — unprovable in the mocked run', async () => {
    const runtime = new OpenCodeRuntime({ provider: liveManager! });
    const sessionId = '5c1d0b9a-7e42-4f31-9c8b-1668000000ab';
    runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: PROJECT_DIR });

    for await (const _event of runtime.sendMessage(sessionId, CONFORMANCE_PROMPT, {
      cwd: PROJECT_DIR,
    })) {
      // Drained: this turn only exists to give compaction a conversation.
    }

    const events: StreamEvent[] = [];
    for await (const event of runtime.executeCommandIntent(sessionId, 'compact', {
      cwd: PROJECT_DIR,
    })) {
      events.push(event);
    }

    // Reaching here at all is the first finding: a rejected payload would have
    // thrown out of the loop above with the sidecar's own message attached.
    const failures = events.filter((event) => event.type === 'error');
    expect(failures, 'the sidecar reported the compaction turn as failed').toEqual([]);
    expect(
      events.filter((event) => event.type === 'done'),
      'a compaction must terminate exactly once, like any other turn'
    ).toHaveLength(1);
    // And the second: what the OPERATOR sees. A `/compact` that the sidecar
    // accepted but that surfaced no boundary would look, in the app, like
    // nothing happened. Safe to demand: OpenCode publishes `session.compacted`
    // on every compaction whose assistant message did not error, and the
    // assertion above has already excluded that branch. Nothing else in the
    // suite proves this live — the shared DOR-109 gate settles for
    // `compact_boundary` OR a terminal, so a terminal alone satisfies it.
    expect(
      events.filter((event) => event.type === 'compact_boundary'),
      'a real compaction must surface exactly one boundary the operator can see'
    ).toHaveLength(1);
  });
});

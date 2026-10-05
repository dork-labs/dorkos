import {
  DOC_VISIBLE_TRIGGER,
  docBoundaryEntry,
  assertDocBoundary,
} from '../../__tests__/doc-events-boundary-fixture.js';
/**
 * @vitest-environment node
 *
 * CodexRuntime must clear the SAME shared AgentRuntime conformance gate as
 * TestModeRuntime and ClaudeCodeRuntime (spec additional-agent-runtimes,
 * tasks 1.5 + 2.6). The Codex SDK and the dependency probe are fully mocked
 * by default — this suite must NEVER require the real `codex` binary in CI.
 *
 * --- Local live-binary smoke (env-gated, never required by CI) -----------
 *
 * To exercise the REAL Codex CLI end-to-end (real `codex exec` turns through
 * the full adapter: thread start/resume, event mapping, terminal `done`), run:
 *
 *   DORKOS_CODEX_LIVE=1 pnpm vitest run \
 *     src/services/runtimes/codex/__tests__/conformance.test.ts
 *
 * Requirements: an installed SDK-vendored `codex` binary (or one on PATH) and a
 * logged-in state (`codex login`). A configured `runtimes.codex.binaryPath` is
 * deliberately NOT honoured here: the live leg boots the config manager against
 * a throwaway temp directory, so `binaryPath` reads back unset and resolution
 * falls to the SDK-vendored binary — the exact version the pin under test
 * ships. Pointing this suite at whatever binary the operator happens to have
 * configured would verify someone else's Codex, which is the one thing a pinned
 * SDK's smoke test must never do.
 *
 * Under the flag the vi.mock factories below return `importOriginal()` — the
 * real SDK and the real dependency probe — so the identical conformance
 * assertions run against live turns. The project dir becomes a real temp
 * directory (the CLI spawns with `workingDirectory`, which must exist) and
 * per-test timeouts are raised. Turns run in the 'default' permission mode →
 * read-only sandbox, so a live run cannot write outside its temp cwd.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeConformance, type HandedGrants } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  makeMockThread,
  codexFailedTurn,
  codexFailedTurnWithErrorItem,
  codexMcpImageTurn,
  codexSimpleTurn,
} from './codex-scenarios.js';
import {
  driveDurableTurn,
  drivePresenceTurn,
  driveReloadedHistory,
  driveTerminalOnce,
  driveQueueDurability,
  driveRoomCanvasTurn,
  driveDispositionTurn,
} from '../../../session/__tests__/durable-turn-harness.js';

/** Hoisted so the (also hoisted) vi.mock factories can branch on it. */
const LIVE = vi.hoisted(() => process.env.DORKOS_CODEX_LIVE === '1');

/**
 * One-shot selector the mocked SDK reads at thread mint: when set, the next
 * minted thread streams a failed turn carrying THIS message, then the selector
 * self-clears. Matches the "next sendMessage turn fails" contract both
 * `makeFailingRuntime` and `authFailure` are written to (the adapter mints
 * exactly one thread per turn).
 *
 * Two knobs rather than one boolean, because the two cases need different
 * things. The message is carried because the credential-failure case asserts on
 * the exact vendor text it scripted (DOR-1656). `withErrorItem` picks the SHAPE:
 * a bare `turn.failed`, or the live-observed sequence where an error ITEM
 * carries the failure first and `turn.failed` repeats it (NOTES.md, §Additional
 * live-verified facts).
 */
const nextTurnFailure = vi.hoisted(() => ({
  message: null as string | null,
  withErrorItem: false,
}));

/**
 * The vendor's own words for an expired Codex sign-in — what the mocked SDK is
 * scripted with, and what a person must never be shown (DOR-1656).
 */
const CODEX_VENDOR_AUTH_TEXT =
  'stream error: unexpected status 401 Unauthorized: missing bearer authentication in header';

/**
 * Every prompt string the mocked SDK has been handed, in order.
 *
 * The `project-rooms` §3.3 gate reads it: codex has no system-prompt channel at
 * all, so `systemPromptAppend` reaches the model as part of the composed PROMPT
 * (`buildCodexPrompt`), and the only honest place to observe what the backend
 * received is where the backend receives it.
 */
const sdkPrompts = vi.hoisted(() => [] as string[]);

/**
 * The options every `Codex` client the adapter built was handed: its binary,
 * its environment, its config. The credits gate (ADR 261001-000811) searches
 * them, with each thread's options and prompt, for a credits token.
 */
const codexClientOptions = vi.hoisted(() => [] as unknown[]);

/**
 * How each thread the mocked SDK minted was reached: `'start'` for a new
 * conversation, `'resume'` for one that already existed.
 *
 * The §3.3 gate is about the NEXT turn of a session ALREADY RUNNING, and codex
 * has no warm process to read that off — a resumed thread is what "already
 * running" means here, so it is checked rather than assumed.
 */
const threadMints = vi.hoisted(() => [] as Array<'start' | 'resume'>);

/**
 * The `ThreadOptions` each minted thread was given, in order — what the SDK
 * turns into `--add-dir` and `--sandbox` for that run. The `agent-home-desk`
 * §4.6 gate reads folder grants off it.
 */
const threadOptionsSeen = vi.hoisted(
  () => [] as Array<{ additionalDirectories?: string[]; sandboxMode?: string }>
);

/**
 * One-shot selector for the media gate: when set, the next minted thread streams
 * a turn whose MCP tool answers with a picture, then the flag self-clears.
 *
 * The same shape as {@link nextTurnFailure}, and for the same reason — the
 * adapter mints exactly one thread per turn, so a one-shot flag is how a driver
 * scripts THAT turn without disturbing every other case.
 */
const imageNextThread = vi.hoisted(() => ({ value: false }));

/** Default success turn, or (one-shot) a scripted failed or image-bearing turn. */
function mintTurnEvents() {
  if (imageNextThread.value) {
    imageNextThread.value = false;
    // The terminal `item.completed` REPUBLISHED, on purpose. The gate's second
    // half — one picture, one announcement — only bites when the driver
    // actually publishes the same image twice; script it once and the case
    // passes for a reason unrelated to the property it is named after.
    return codexMcpImageTurn(2);
  }
  const failure = nextTurnFailure.message;
  if (failure === null) return codexSimpleTurn('pong');
  const { withErrorItem } = nextTurnFailure;
  nextTurnFailure.message = null;
  nextTurnFailure.withErrorItem = false;
  return withErrorItem ? codexFailedTurnWithErrorItem(failure) : codexFailedTurn(failure);
}

vi.mock('@openai/codex-sdk', async (importOriginal) => {
  if (LIVE) return importOriginal();
  return {
    // Per-instance vi.fn with a per-CALL implementation: makeMockThread wraps
    // ONE stream, so every runStreamed call needs a fresh thread — never
    // mockReturnValue here (a spent generator would end multi-turn tests with
    // zero events).
    Codex: class {
      constructor(options?: unknown) {
        codexClientOptions.push(options ?? {});
      }
      startThread = vi.fn((options?: (typeof threadOptionsSeen)[number]) => {
        threadMints.push('start');
        threadOptionsSeen.push(options ?? {});
        return recordPrompts(makeMockThread(mintTurnEvents()));
      });
      resumeThread = vi.fn((_id: string, options?: (typeof threadOptionsSeen)[number]) => {
        threadMints.push('resume');
        threadOptionsSeen.push(options ?? {});
        return recordPrompts(makeMockThread(mintTurnEvents()));
      });
    },
  };
});

/**
 * Tap a mock thread's `runStreamed` so every prompt the adapter sends lands in
 * {@link sdkPrompts}, then hand the thread back unchanged.
 *
 * A wrapper rather than a change to `makeMockThread`: what the SDK was handed is
 * this suite's question, and the shared fixture builder has no business growing
 * a recorder every other test file would carry.
 *
 * @param thread - The mock thread to tap.
 * @returns The same thread.
 */
function recordPrompts<T extends { runStreamed: (...args: never[]) => unknown }>(thread: T): T {
  const inner = thread.runStreamed.bind(thread);
  thread.runStreamed = ((...args: never[]) => {
    sdkPrompts.push(String(args[0]));
    return inner(...args);
  }) as T['runStreamed'];
  return thread;
}

// checkDependencies() shells out to `codex --version` / `codex login status`
// for real — mock the probe so conformance never spawns (or requires) the
// binary. The live smoke restores the real probe.
/**
 * What Codex's recorded Runs on default is, as the credits driver sets it: the
 * way a person chooses credits for Codex (ADR 261001-000811), since Codex has
 * no per-session account pick. Read by the mocked `creditsIsDefaultFor`.
 */
const codexRunsOnCredits = vi.hoisted(() => ({ value: false }));

vi.mock('../../../core/cloud/credits-defaults.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/cloud/credits-defaults.js')>()),
  creditsIsDefaultFor: (runtime: string) => runtime === 'codex' && codexRunsOnCredits.value,
}));

// The suite's computer reads as linked. A token is held only through the
// credits module's test seam, and no cloud context is ever captured, so
// nothing here can reach a real service.
vi.mock('../../../core/cloud/v1-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../core/cloud/v1-client.js')>()),
  isCloudLinked: () => true,
  captureCloudV1Context: () => null,
}));

// The credits home is never created on disk here, and no conformance thread
// lives in it: every thread this suite starts is new, so the default decides.
vi.mock('../credits-launch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../credits-launch.js')>()),
  ensureCreditsCodexHome: () => {},
  threadRunsOnCredits: async () => false,
}));

vi.mock('../check-dependencies.js', async (importOriginal) => {
  if (LIVE) return importOriginal();
  return {
    codexAppServerVersionNote: () => null,
    checkCodexDependencies: vi.fn(() => [
      {
        name: 'Codex CLI',
        description: 'The OpenAI Codex CLI powers Codex agent sessions in DorkOS.',
        status: 'satisfied',
        version: 'codex-cli 0.0.0-mock',
      },
      {
        name: 'Codex authentication',
        description:
          'A ChatGPT login or CODEX_API_KEY lets the Codex CLI reach OpenAI on your behalf.',
        status: 'satisfied',
      },
    ]),
  };
});

import { CodexRuntime } from '../codex-runtime.js';
import { __setCreditsStateForTests } from '../../../core/cloud/credits-inference.js';
import { __setCreditsCatalogForTests } from '../../../core/cloud/credits-models.js';
import { InferenceTokenSchema } from '@dork-labs/cloud-api';
// The fixture whose token serves every format: Codex speaks only `responses`.
import CREDITS_TOKEN_FIXTURE from '@dork-labs/cloud-api/fixtures/v1/inference/token-every-format.json' with { type: 'json' };
import { controlUi } from '../../../session/browser-seat/ui-control.js';
import { CodexThreadMap } from '../thread-map.js';
import { LocalSessionAttachmentStore } from '../../../session/attachments/local-session-attachment-store.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { CONFORMANCE_CREDITS_TOKEN } from '@dorkos/test-utils';
import {
  appServerCreditsTurn,
  appServerDirectoryGrantTurns,
  appServerDispositionTurn,
  appServerApprovalTurn,
  appServerMediaTurn,
  appServerSystemPromptAppendTurns,
  hangAppServerInterrupt,
  makeFailingAppServerRuntime,
  makeAppServerRuntime,
  startConformanceRelay,
  stopAppServerConformance,
  warmAppServerSession,
} from './app-server-conformance.js';

/**
 * The LIVE leg's two throwaway temp directories, or `null` when mocked.
 *
 * Both live in ONE object so the narrowing below is enough to use either
 * without a cast: `liveDirs` is the single thing that is null-or-not, rather
 * than two constants that each have to re-prove they are set.
 *
 * `projectDir` exists because a real `codex exec` turn needs an EXISTING
 * working directory. It is also the workspace-trust probe: a fresh `mkdtemp` is
 * a directory the CLI has never been told to trust, which is where a trust
 * regression would surface first.
 *
 * `configHome` exists because the real `check-dependencies.js` reads
 * `configManager.get('runtimes').codex`, and `configManager` is a `let` that
 * stays `undefined` until `initConfigManager()` runs at server startup — which
 * no test file gets for free. Mocked runs never reach that line because the
 * probe itself is mocked, so the gap stayed invisible until someone set
 * `DORKOS_CODEX_LIVE=1`, at which point every binary-resolving assertion died
 * on `Cannot read properties of undefined (reading 'get')`. A throwaway dir
 * rather than the real `~/.dork` keeps `binaryPath` unset on purpose — see the
 * module header.
 */
const liveDirs = LIVE
  ? {
      projectDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-codex-live-')),
      configHome: fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-codex-live-config-')),
    }
  : null;

if (liveDirs) {
  // Real turns spawn a subprocess and round-trip to OpenAI — well beyond the
  // default 5s test timeout.
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
  initConfigManager(liveDirs.configHome);
}

// Mocked turns never touch the filesystem, so the fixed fake path keeps them hermetic.
const projectDir = liveDirs?.projectDir ?? '/projects/conformance';

/**
 * Where the conformance runtime keeps images, in mocked mode.
 *
 * Wired only when mocked, and that asymmetry is the honest one: a live `codex`
 * binary has no MCP server configured to answer with a picture, so the LIVE
 * runtime declares `mediaOutput: 'none'` and the suite's media block takes its
 * not-declared arm rather than asserting something the run cannot show.
 *
 * A real store over a temp directory rather than a double: the gate's whole
 * claim is that the URL it announces is LIVE on arrival, and only a store that
 * actually wrote bytes can support that.
 */
const ATTACHMENT_HOME = LIVE
  ? null
  : fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-codex-conformance-media-'));

afterAll(() => {
  if (liveDirs) {
    fs.rmSync(liveDirs.projectDir, { recursive: true, force: true });
    fs.rmSync(liveDirs.configHome, { recursive: true, force: true });
  }
  if (ATTACHMENT_HOME) fs.rmSync(ATTACHMENT_HOME, { recursive: true, force: true });
});

// The half of the media declaration the conformance suite structurally cannot
// reach: it builds ONE runtime, and in mocked mode always builds it WITH a
// store. `mediaOutput` is the promise "an image your tools return is kept", and
// a runtime wired without somewhere to keep one must not make it. Without this,
// deleting the `if (!this.attachments)` guard so the adapter always claims
// 'attachments' passes everything.
describe('what codex says it does with media', () => {
  it('promises nothing when it was wired nowhere to put a picture', () => {
    const runtime = new CodexRuntime({
      threadMap: new CodexThreadMap(createTestDb()),
      resolveBinary: async () => '/bin/codex',
    });
    expect(runtime.getCapabilities().mediaOutput).toBe('none');
  });

  it('promises attachments once the composition root hands it a store', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-codex-media-decl-'));
    try {
      const runtime = new CodexRuntime({
        threadMap: new CodexThreadMap(createTestDb()),
        resolveBinary: async () => '/bin/codex',
        attachments: new LocalSessionAttachmentStore(home),
      });
      expect(runtime.getCapabilities().mediaOutput).toBe('attachments');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

runtimeConformance(
  // Fresh runtime per test over an isolated in-memory thread map; binaryPath
  // null lets the SDK resolve its own binary (vendored or PATH) in live mode.
  () =>
    new CodexRuntime({
      threadMap: new CodexThreadMap(createTestDb()),
      // LIVE runs resolve the real binary through the shared ladder (the
      // default); mocked runs never spawn anything, so any path will do.
      ...(LIVE ? {} : { resolveBinary: async () => '/bin/codex' }),
      ...(ATTACHMENT_HOME ? { attachments: new LocalSessionAttachmentStore(ATTACHMENT_HOME) } : {}),
    }),
  {
    name: LIVE
      ? 'CodexRuntime (LIVE codex binary) — AgentRuntime conformance'
      : 'CodexRuntime (mocked SDK) — AgentRuntime conformance',
    projectDir,
    // Codex is a stateless adapter: conformance drains sendMessage directly
    // (no feedProjector), so native history is [] by design — completed
    // history lives in the DorkOS-owned EventLog (ADR-0263).
    expectHistory: false,
    // DOR-189: a completed turn must survive a restart via the durable store.
    durableHistory: (runtime, sessionId, content) =>
      driveDurableTurn(runtime, sessionId, content, projectDir),
    // Presence is only assertable against a turn that really runs: drive one
    // through the same projector the trigger path feeds.
    presenceTurn: (runtime, sessionId, content, probes) =>
      drivePresenceTurn(runtime, sessionId, content, projectDir, probes),
    // **A Codex room turn's canvas command, applied exactly once** (spec
    // `canvas-agent-seat` §5). This is the acceptance the `dorkos_ui` retirement
    // turns on: Codex used to reach the table through the event-mapper, which
    // produced an UNSTAMPED `ui_command` for the room turn's tap to apply.
    // `control_ui` is a capability now — it calls the writer itself and STAMPS
    // what it wrote, so the tap skips it. Miss the stamp and every Codex canvas
    // operation lands twice.
    //
    // The document is a `json` one on purpose: it has no source key, so dedupe
    // cannot hide a second write the way it would for a file. `documents.length`
    // in the shared case is therefore a real count.
    roomCanvasTurn: () =>
      driveRoomCanvasTurn(
        new CodexRuntime({
          threadMap: new CodexThreadMap(createTestDb()),
          resolveBinary: async () => '/bin/codex',
        }),
        {
          agentPath: '/agents/ana',
          otherAgentPath: '/agents/ben',
          produce: async (sessionId) => {
            await controlUi(
              { action: 'open_canvas', content: { type: 'json', data: {}, title: 'The plan' } },
              { sessionId }
            );
          },
        }
      ),
    // C2/C3 are server-owned invariants every runtime inherits by construction
    // (feedProjector collapses a multi-result window; the server owns the queue),
    // so both drivers exercise the shared machinery rather than the codex binary —
    // safe to wire in LIVE mode too. Codex declares neither steer nor stage, so it
    // wires NO dispositionTurn: its C1 is the not-declared arm, and the declared
    // half is skipped by name.
    terminalOnce: () => driveTerminalOnce(projectDir),
    queueDurability: () => driveQueueDurability(),
    // The media gate. Codex has NO generated-image path — `ThreadItem` carries
    // no image output item at all — so an MCP tool result is the only thing
    // there is to script, and it is what the adapter now reads.
    ...(ATTACHMENT_HOME
      ? {
          mediaTurn: async () => {
            imageNextThread.value = true;
            const runtime = new CodexRuntime({
              threadMap: new CodexThreadMap(createTestDb()),
              resolveBinary: async () => '/bin/codex',
              attachments: new LocalSessionAttachmentStore(ATTACHMENT_HOME),
            });
            const sessionId = randomUUID();
            runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: projectDir });
            const events = [];
            for await (const event of runtime.sendMessage(sessionId, 'take a screenshot', {
              cwd: projectDir,
            })) {
              events.push(event);
            }
            return events;
          },
        }
      : {}),
    // BC-16: the Codex SDK exposes no thread read or listing API, so everything
    // a codex session knows about itself is what DorkOS wrote down. Its
    // in-memory registry does see each delivered message — but `recordMessage`
    // fires for relay hand-offs, scheduled runs and room turns exactly as it
    // does for something you typed, so the registry cannot tell whose message it
    // was. (Claude-code answers that from transcript markers plus the session's
    // origin; codex has neither.) And the one durable store, `codex_threads`,
    // has no column for it. Both halves would have to be built; neither is free.
    userLastMessageAtOmittedReason:
      'the Codex SDK exposes no thread read API: the in-memory registry cannot tell a person’s message from a relay, task or room one (recordMessage fires for all of them) and the durable codex_threads row has no column for it',
    // A deterministic failed turn cannot be scripted against the live binary,
    // so the turn-failure gate runs only in mocked mode: the one-shot selector
    // makes the next minted thread stream `turn.failed`.
    // The `project-rooms` §3.3 gate. Codex has no system-prompt channel at all
    // (`ThreadOptions` carries none), so `buildCodexPrompt` puts the caller's
    // append in the PROMPT — which means every turn composes it afresh and a
    // changed one cannot go stale. Proven rather than argued: the two turns run
    // on ONE session (the second resumes the same thread) and the assertion
    // reads what the SDK was handed, not what the driver passed in.
    ...(LIVE
      ? {
          // A live binary is a subprocess, and nothing in this suite can read
          // the prompt it was given. The mocked run above is where the property
          // is proven; saying so beats a case that quietly asserts nothing.
          systemPromptAppendUnprovenReason:
            'a live codex binary is a subprocess this suite hands a prompt and cannot read back, so what it received is only observable in the mocked run',
          directoryGrantsUnprovenReason:
            'a live codex binary is a subprocess this suite hands thread options and cannot read back, so which folders it was granted is only observable in the mocked run',
          creditsUnprovenReason:
            'a live codex binary is a subprocess this suite hands an environment and cannot read back, so whether a credits token reached it is only observable in the mocked run',
        }
      : {
          // ADR 261001-000811. Credits are chosen the way a person chooses
          // them for Codex: its recorded default. Everything the adapter built
          // (clients, threads, prompts) is searched for the token, so a turn on
          // the person's own sign-in must carry none of it.
          creditsTurn: async (runtime, { runsOn, heldToken }) => {
            codexRunsOnCredits.value = runsOn === 'credits';
            __setCreditsStateForTests({
              token:
                heldToken === null
                  ? null
                  : InferenceTokenSchema.parse({
                      ...CREDITS_TOKEN_FIXTURE,
                      token: heldToken,
                      expiresAt: '2999-01-01T00:00:00.000Z',
                    }),
            });
            try {
              const clientsBefore = codexClientOptions.length;
              const threadsBefore = threadOptionsSeen.length;
              const promptsBefore = sdkPrompts.length;
              const sessionId = randomUUID();
              runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: projectDir });
              const events = [];
              for await (const event of runtime.sendMessage(sessionId, 'conformance ping', {
                cwd: projectDir,
              })) {
                events.push(event);
              }
              return {
                launched: threadOptionsSeen.length > threadsBefore,
                handed: {
                  // Every client ever built, not just this turn's: a shared
                  // client built earlier is still what this turn ran on.
                  clients: codexClientOptions,
                  newClients: codexClientOptions.slice(clientsBefore),
                  threads: threadOptionsSeen.slice(threadsBefore),
                  prompts: sdkPrompts.slice(promptsBefore),
                },
                events,
              };
            } finally {
              codexRunsOnCredits.value = false;
              __setCreditsStateForTests({ token: null });
            }
          },
          // The `agent-home-desk` §4.6 gate. Codex hands a write grant as
          // `additionalDirectories` (the SDK's `--add-dir`, per run) and a read
          // grant as nothing, because its sandbox already reads everywhere —
          // so a read grant is read-open exactly when the options handed say
          // the sandbox reads (every mode codex has). Both turns on ONE thread:
          // the second resumes the first, the way a later room turn does.
          directoryGrantTurns: async (runtime, sessionId, grants) => {
            const optionsBefore = threadOptionsSeen.length;
            const mintedBefore = threadMints.length;
            for (const additionalDirectories of grants) {
              for await (const _event of runtime.sendMessage(sessionId, 'conformance ping', {
                cwd: projectDir,
                additionalDirectories,
              })) {
                // Drained: the assertion is about the SDK's input.
              }
            }
            expect(
              threadMints.slice(mintedBefore),
              'the second turn was supposed to resume the first turn’s thread'
            ).toEqual(['start', 'resume']);
            const handed = threadOptionsSeen.slice(optionsBefore);
            const handedFor = (turn: 0 | 1): HandedGrants => {
              const options = handed[turn] ?? {};
              const sandboxReads = options.sandboxMode !== undefined;
              return {
                writable: [...(options.additionalDirectories ?? [])],
                readOnly: [],
                readOpen: sandboxReads
                  ? grants[turn].filter((grant) => grant.access === 'read').map((g) => g.path)
                  : [],
              };
            };
            return [handedFor(0), handedFor(1)] as const;
          },
          systemPromptAppendTurns: async (runtime, sessionId, [first, second]) => {
            const before = sdkPrompts.length;
            const mintedBefore = threadMints.length;
            for (const systemPromptAppend of [first, second]) {
              for await (const _event of runtime.sendMessage(sessionId, 'conformance ping', {
                cwd: projectDir,
                systemPromptAppend,
              })) {
                // Drained: the assertion is about the SDK's input, not its output.
              }
            }
            // The second turn RESUMED the first one's thread. Codex holds no
            // process between turns, so this is what "a session already
            // running" means for it — and without checking, two unrelated
            // conversations would satisfy every assertion the suite makes.
            expect(
              threadMints.slice(mintedBefore),
              'the second turn was supposed to resume the first turn’s thread, not start a conversation of its own'
            ).toEqual(['start', 'resume']);
            const [firstPrompt, secondPrompt] = sdkPrompts.slice(before);
            return [firstPrompt ?? '', secondPrompt ?? ''] as const;
          },
          makeFailingRuntime: () => {
            nextTurnFailure.message = 'Simulated Codex turn failure';
            return new CodexRuntime({
              threadMap: new CodexThreadMap(createTestDb()),
              ...(LIVE ? {} : { resolveBinary: async () => '/bin/codex' }),
            });
          },
          // DOR-1656: the same one-shot selector, scripted with the CLI's own
          // words for an expired sign-in. A real revoked credential cannot be
          // arranged against the live binary, so this rides the mocked arm.
          //
          // `withErrorItem` on purpose: this is the shape a real Codex auth
          // failure takes (NOTES.md), and it is the harder one. The error ITEM
          // reaches the person first and `turn.failed` then DEDUPES itself away
          // against it, so the item's copy is the only copy anybody reads —
          // a gate driven off the bare `turn.failed` shape would go green on an
          // adapter that still leaked the CLI's words to every real user. Both
          // branches are exercised here in one turn: the item's, and the dedupe
          // that suppresses the second.
          authFailure: {
            vendorText: CODEX_VENDOR_AUTH_TEXT,
            makeRuntime: () => {
              nextTurnFailure.message = CODEX_VENDOR_AUTH_TEXT;
              nextTurnFailure.withErrorItem = true;
              return new CodexRuntime({
                threadMap: new CodexThreadMap(createTestDb()),
                ...(LIVE ? {} : { resolveBinary: async () => '/bin/codex' }),
              });
            },
            // DOR-1678, the reload half. Codex keeps no transcript of its own —
            // `getMessageHistory` IS the durable EventLog fold — so the honest
            // reload is the real trigger path feeding the store, the projector
            // dropped, and the adapter asked again. Nothing here writes an error
            // part: the mapper classified the failure once on the way in, and
            // what this reads back is that classification replayed.
            hydratedHistory: (runtime, sessionId, content) =>
              driveReloadedHistory(runtime, sessionId, content, projectDir),
          },
        }),
  }
);

// --- The app-server transport (ADR 261005-113107) ---------------------------
//
// The same gate, on the transport `runtimes.codex.transport: 'app-server'`
// selects: a long-lived `codex app-server` per home. Mocked mode runs it over
// the fake app-server (`fake-app-server.ts`), which enforces the joining trap
// and loaded-config immutability, with a real loopback credits relay. The
// live arm (DORKOS_CODEX_LIVE=1) runs it against the real vendored binary on
// the operator's own sign-in, exactly as the exec leg above does.

if (!LIVE) {
  beforeAll(startConformanceRelay);
  afterAll(stopAppServerConformance);
}

/** Install a credits scenario the way the exec leg does; returns its undo. */
function arrangeCredits(scenario: { runsOn: 'credits' | 'own-sign-in'; heldToken: string | null }) {
  codexRunsOnCredits.value = scenario.runsOn === 'credits';
  __setCreditsStateForTests({
    token:
      scenario.heldToken === null
        ? null
        : InferenceTokenSchema.parse({
            ...CREDITS_TOKEN_FIXTURE,
            token: scenario.heldToken,
            expiresAt: '2999-01-01T00:00:00.000Z',
          }),
  });
  return () => {
    codexRunsOnCredits.value = false;
    __setCreditsStateForTests({ token: null });
  };
}

runtimeConformance(
  () =>
    LIVE
      ? new CodexRuntime({ threadMap: new CodexThreadMap(createTestDb()), transport: 'app-server' })
      : makeAppServerRuntime(
          ATTACHMENT_HOME ? { attachments: new LocalSessionAttachmentStore(ATTACHMENT_HOME) } : {}
        ),
  {
    name: LIVE
      ? 'CodexRuntime on app-server (LIVE codex binary) — AgentRuntime conformance'
      : 'CodexRuntime on app-server (fake app-server) — AgentRuntime conformance',
    projectDir,
    expectHistory: false,
    durableHistory: (runtime, sessionId, content) =>
      driveDurableTurn(runtime, sessionId, content, projectDir),
    presenceTurn: (runtime, sessionId, content, probes) =>
      drivePresenceTurn(runtime, sessionId, content, projectDir, probes),
    terminalOnce: () => driveTerminalOnce(projectDir),
    queueDurability: () => driveQueueDurability(),
    // A thread stays loaded between turns, so a session is warm after one.
    warmSession: (runtime, sessionId) => warmAppServerSession(runtime, sessionId, projectDir),
    // C1: app-server declares steer (`turn/steer` into the open turn). Mocked,
    // the fake holds the turn open until it is stopped; live, the real model's
    // turn has to still be running when the steer lands.
    dispositionTurn: (runtime, sessionId, content, probes) =>
      LIVE
        ? driveDispositionTurn(runtime, sessionId, content, projectDir, probes, {
            awaitOpen: () =>
              vi.waitFor(
                async () =>
                  expect(
                    (await runtime.getSessionSnapshot({ cwd: projectDir }, sessionId)).status
                      .lifecycle
                  ).toBe('streaming'),
                { timeout: 60_000 }
              ),
            endTurn: async () => {
              await runtime.interruptQuery(sessionId);
            },
          })
        : appServerDispositionTurn(runtime, sessionId, content, projectDir, probes),
    userLastMessageAtOmittedReason:
      'codex sessions record no author for a message: the in-memory registry cannot tell a person’s message from a relay, task or room one, and the durable codex_threads row has no column for it — on either transport',
    ...(LIVE
      ? {
          systemPromptAppendUnprovenReason:
            'a live codex app-server is a subprocess this suite hands a prompt over stdin and cannot read back, so what it received is only observable in the mocked run',
          directoryGrantsUnprovenReason:
            'a live codex app-server is a subprocess this suite hands a sandbox policy and cannot read back, so which folders it was granted is only observable in the mocked run',
          creditsUnprovenReason:
            'a live run has no DorkOS credits link, so a credits turn cannot be arranged against the real binary; the mocked run proves it end to end through the real relay',
        }
      : {
          // Stop is bounded: Codex never acknowledging a `turn/interrupt` ends
          // in `unconfirmed`, never a killed process (that would end every
          // other Codex chat in the home).
          hangingInterrupt: (runtime, sessionId) =>
            hangAppServerInterrupt(runtime, sessionId, projectDir),
          // Approvals (spec §10): a card answered, denied or stopped. Live, a
          // real model cannot be made to ask on demand, so the case skips by name.
          approvalTurn: (runtime, sessionId, content, probes) =>
            appServerApprovalTurn(runtime, sessionId, content, projectDir, probes),
          creditsTurn: (runtime, scenario) =>
            appServerCreditsTurn(runtime, scenario, projectDir, arrangeCredits),
          ...(ATTACHMENT_HOME
            ? {
                mediaTurn: () =>
                  appServerMediaTurn(
                    makeAppServerRuntime({
                      attachments: new LocalSessionAttachmentStore(ATTACHMENT_HOME),
                    }),
                    projectDir
                  ),
              }
            : {}),
          directoryGrantTurns: (runtime, sessionId, grants) =>
            appServerDirectoryGrantTurns(runtime, sessionId, grants, projectDir),
          systemPromptAppendTurns: (runtime, sessionId, appends) =>
            appServerSystemPromptAppendTurns(runtime, sessionId, appends, projectDir),
          makeFailingRuntime: () => makeFailingAppServerRuntime('Simulated Codex turn failure'),
          // DOR-1656 on app-server: Codex reports a dead sign-in as
          // `codexErrorInfo: unauthorized` with the vendor's words; the person
          // must read DorkOS's sentence, the vendor's words kept in details.
          authFailure: {
            vendorText: CODEX_VENDOR_AUTH_TEXT,
            makeRuntime: () => makeFailingAppServerRuntime(CODEX_VENDOR_AUTH_TEXT, 'unauthorized'),
            hydratedHistory: (runtime, sessionId, content) =>
              driveReloadedHistory(runtime, sessionId, content, projectDir),
          },
          roomCanvasTurn: () =>
            driveRoomCanvasTurn(makeAppServerRuntime(), {
              agentPath: '/agents/ana',
              otherAgentPath: '/agents/ben',
              produce: async (sessionId) => {
                await controlUi(
                  { action: 'open_canvas', content: { type: 'json', data: {}, title: 'The plan' } },
                  { sessionId }
                );
              },
            }),
        }),
  }
);

it.skipIf(LIVE)(
  'app-server credits: the token reaches only the credits endpoint, through the relay, never Codex',
  async () => {
    const runtime = makeAppServerRuntime();
    const seen = await appServerCreditsTurn(
      runtime,
      { runsOn: 'credits', heldToken: CONFORMANCE_CREDITS_TOKEN },
      projectDir,
      arrangeCredits
    );
    const handed = seen.handed as { spawns: unknown; received: unknown; upstream: unknown[] };
    expect(JSON.stringify(handed.spawns)).not.toContain(CONFORMANCE_CREDITS_TOKEN);
    expect(JSON.stringify(handed.received)).not.toContain(CONFORMANCE_CREDITS_TOKEN);
    expect(handed.upstream).toEqual([
      expect.objectContaining({ authorization: `Bearer ${CONFORMANCE_CREDITS_TOKEN}` }),
    ]);
  }
);

it.skipIf(LIVE)(
  'doc SDK boundary: Codex runStreamed receives the fenced document on start and resume',
  async () => {
    const runtime = new CodexRuntime({
      threadMap: new CodexThreadMap(createTestDb()),
      resolveBinary: async () => '/bin/codex',
    });
    const sessionId = 'doc-sdk-boundary';
    runtime.ensureSession(sessionId, { cwd: projectDir, permissionMode: 'default' });
    const before = sdkPrompts.length,
      mintsBefore = threadMints.length;
    for (let turn = 0; turn < 2; turn++) {
      for await (const _event of runtime.sendMessage(sessionId, DOC_VISIBLE_TRIGGER, {
        cwd: projectDir,
        additionalContext: [docBoundaryEntry],
      })) {
        /* Drain actual runtime SDK request. */
      }
    }
    const sent = sdkPrompts.slice(before);
    expect(sent).toHaveLength(2);
    const nonces = sent.map((prompt) => assertDocBoundary(prompt));
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(threadMints.slice(mintsBefore)).toEqual(['start', 'resume']);
    for (const prompt of sent) expect(prompt.endsWith(DOC_VISIBLE_TRIGGER)).toBe(true);
  }
);

// DOR-2636: a Codex turn on credits runs a model credits serve in Codex's
// format, once the service says which formats its models are in; while it
// says nothing, the session's model stands.
describe.skipIf(LIVE)('the model a Codex credits turn runs (DOR-2636)', () => {
  const supports = { tools: true, promptCaching: false, streaming: true, thinking: false };
  const served = (id: string, formats: string[], recommendedOn: string[] = []) => ({
    id,
    displayName: `Name ${id}`,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    supports,
    protocols: formats,
    recommendedOn,
  });

  async function creditsTurn(model: string | undefined) {
    codexRunsOnCredits.value = true;
    __setCreditsStateForTests({
      token: InferenceTokenSchema.parse({
        ...CREDITS_TOKEN_FIXTURE,
        expiresAt: '2999-01-01T00:00:00.000Z',
      }),
    });
    try {
      const runtime = new CodexRuntime({
        threadMap: new CodexThreadMap(createTestDb()),
        resolveBinary: async () => '/bin/codex',
      });
      const sessionId = randomUUID();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: projectDir });
      if (model !== undefined) await runtime.updateSession(sessionId, { model });
      const before = threadOptionsSeen.length;
      const events = [];
      for await (const event of runtime.sendMessage(sessionId, 'ping', { cwd: projectDir })) {
        events.push(event);
      }
      return { events, threads: threadOptionsSeen.slice(before) };
    } finally {
      codexRunsOnCredits.value = false;
      __setCreditsStateForTests({ token: null });
    }
  }

  afterAll(() => __setCreditsCatalogForTests(null));

  it('runs a model credits do not serve in its format on the suggestion, and says so', async () => {
    __setCreditsCatalogForTests([
      served('claude-x', ['anthropicMessages']),
      served('gpt-pick', ['openaiResponses'], ['openaiResponses']),
    ]);
    const { events, threads } = await creditsTurn('gpt-not-served');
    expect(threads[0]).toMatchObject({ model: 'gpt-pick' });
    expect(events.filter((e) => e.type === 'model_substituted')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ from: 'gpt-not-served', to: 'gpt-pick' }),
      }),
    ]);
  });

  it('keeps a model it serves, and starts one with no model on the suggestion', async () => {
    __setCreditsCatalogForTests([served('gpt-pick', ['openaiResponses'], ['openaiResponses'])]);
    expect((await creditsTurn('gpt-pick')).threads[0]).toMatchObject({ model: 'gpt-pick' });
    expect((await creditsTurn(undefined)).threads[0]).toMatchObject({ model: 'gpt-pick' });
  });

  it('refuses plainly when the service lists formats but none in Codex’s', async () => {
    __setCreditsCatalogForTests([served('claude-x', ['anthropicMessages'])]);
    const { events, threads } = await creditsTurn('gpt-anything');
    expect(threads).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: 'error', data: { reason: 'no-models' } });
  });

  it('keeps the swap notice, named from Codex’s catalog, in the rebuilt history', async () => {
    __setCreditsCatalogForTests([served('gpt-pick', ['openaiResponses'], ['openaiResponses'])]);
    codexRunsOnCredits.value = true;
    __setCreditsStateForTests({
      token: InferenceTokenSchema.parse({
        ...CREDITS_TOKEN_FIXTURE,
        expiresAt: '2999-01-01T00:00:00.000Z',
      }),
    });
    try {
      const runtime = new CodexRuntime({
        threadMap: new CodexThreadMap(createTestDb()),
        resolveBinary: async () => '/bin/codex',
      });
      vi.spyOn(runtime, 'getSupportedModels').mockResolvedValue([
        { value: 'gpt-old', displayName: 'GPT Old', description: '' },
      ]);
      const sessionId = randomUUID();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: projectDir });
      await runtime.updateSession(sessionId, { model: 'gpt-old' });
      const history = await driveDurableTurn(runtime, sessionId, 'ping', projectDir);
      const notice = history.find((m) => m.id.startsWith('model-substituted-'));
      expect(notice?.parts).toEqual([
        expect.objectContaining({
          type: 'model_substituted',
          from: 'gpt-old',
          fromName: 'GPT Old',
          to: 'gpt-pick',
          toName: 'Name gpt-pick',
        }),
      ]);
    } finally {
      codexRunsOnCredits.value = false;
      __setCreditsStateForTests({ token: null });
    }
  });

  it('changes nothing while the service says nothing about formats', async () => {
    __setCreditsCatalogForTests([{ ...served('m', []), protocols: undefined }]);
    const { events, threads } = await creditsTurn('gpt-whatever');
    expect(threads[0]).toMatchObject({ model: 'gpt-whatever' });
    expect(events.some((e) => e.type === 'model_substituted')).toBe(false);
  });
});

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
 * Requirements: a `codex` binary on PATH (or `runtimes.codex.binaryPath`
 * configured) and a logged-in state (`codex login`). Under the flag the
 * vi.mock factories below return `importOriginal()` — the real SDK and the
 * real dependency probe — so the identical conformance assertions run against
 * live turns. `projectDir` becomes a real temp directory (the CLI spawns with
 * `workingDirectory`, which must exist) and per-test timeouts are raised.
 * Turns run in the 'default' permission mode → read-only sandbox, so a live
 * run cannot write outside its temp cwd.
 */
import { afterAll, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeConformance } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { makeMockThread, codexFailedTurn, codexSimpleTurn } from './codex-scenarios.js';
import {
  driveDurableTurn,
  drivePresenceTurn,
  driveTerminalOnce,
  driveQueueDurability,
} from '../../../session/__tests__/durable-turn-harness.js';

/** Hoisted so the (also hoisted) vi.mock factories can branch on it. */
const LIVE = vi.hoisted(() => process.env.DORKOS_CODEX_LIVE === '1');

/**
 * One-shot selector the mocked SDK reads at thread mint: when set, the next
 * minted thread streams the scripted failed turn, then the flag self-clears.
 * Matches makeFailingRuntime's "next sendMessage turn fails" contract (the
 * adapter mints exactly one thread per turn).
 */
const failNextThread = vi.hoisted(() => ({ value: false }));

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
 * How each thread the mocked SDK minted was reached: `'start'` for a new
 * conversation, `'resume'` for one that already existed.
 *
 * The §3.3 gate is about the NEXT turn of a session ALREADY RUNNING, and codex
 * has no warm process to read that off — a resumed thread is what "already
 * running" means here, so it is checked rather than assumed.
 */
const threadMints = vi.hoisted(() => [] as Array<'start' | 'resume'>);

/** Default success turn, or (one-shot) the scripted failed turn. */
function mintTurnEvents() {
  if (!failNextThread.value) return codexSimpleTurn('pong');
  failNextThread.value = false;
  return codexFailedTurn('Simulated Codex turn failure');
}

vi.mock('@openai/codex-sdk', async (importOriginal) => {
  if (LIVE) return importOriginal();
  return {
    // Per-instance vi.fn with a per-CALL implementation: makeMockThread wraps
    // ONE stream, so every runStreamed call needs a fresh thread — never
    // mockReturnValue here (a spent generator would end multi-turn tests with
    // zero events).
    Codex: class {
      startThread = vi.fn(() => {
        threadMints.push('start');
        return recordPrompts(makeMockThread(mintTurnEvents()));
      });
      resumeThread = vi.fn(() => {
        threadMints.push('resume');
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
vi.mock('../check-dependencies.js', async (importOriginal) => {
  if (LIVE) return importOriginal();
  return {
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
import { CodexThreadMap } from '../thread-map.js';

// A real `codex exec` turn needs an EXISTING working directory; mocked turns
// never touch the filesystem, so the fixed fake path keeps them hermetic.
const projectDir = LIVE
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-codex-live-'))
  : '/projects/conformance';

if (LIVE) {
  // Real turns spawn a subprocess and round-trip to OpenAI — well beyond the
  // default 5s test timeout.
  vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
}

afterAll(() => {
  if (LIVE) fs.rmSync(projectDir, { recursive: true, force: true });
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
    // C2/C3 are server-owned invariants every runtime inherits by construction
    // (feedProjector collapses a multi-result window; the server owns the queue),
    // so both drivers exercise the shared machinery rather than the codex binary —
    // safe to wire in LIVE mode too. Codex declares neither steer nor stage, so it
    // wires NO dispositionTurn: its C1 is the not-declared arm, and the declared
    // half is skipped by name.
    terminalOnce: () => driveTerminalOnce(projectDir),
    queueDurability: () => driveQueueDurability(),
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
        }
      : {
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
            failNextThread.value = true;
            return new CodexRuntime({
              threadMap: new CodexThreadMap(createTestDb()),
              ...(LIVE ? {} : { resolveBinary: async () => '/bin/codex' }),
            });
          },
        }),
  }
);

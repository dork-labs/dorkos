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
import { afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runtimeConformance } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { makeMockThread, codexFailedTurn, codexSimpleTurn } from './codex-scenarios.js';

/** Hoisted so the (also hoisted) vi.mock factories can branch on it. */
const LIVE = vi.hoisted(() => process.env.DORKOS_CODEX_LIVE === '1');

/**
 * One-shot selector the mocked SDK reads at thread mint: when set, the next
 * minted thread streams the scripted failed turn, then the flag self-clears.
 * Matches makeFailingRuntime's "next sendMessage turn fails" contract (the
 * adapter mints exactly one thread per turn).
 */
const failNextThread = vi.hoisted(() => ({ value: false }));

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
      startThread = vi.fn(() => makeMockThread(mintTurnEvents()));
      resumeThread = vi.fn(() => makeMockThread(mintTurnEvents()));
    },
  };
});

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
  () => new CodexRuntime({ threadMap: new CodexThreadMap(createTestDb()), binaryPath: null }),
  {
    name: LIVE
      ? 'CodexRuntime (LIVE codex binary) — AgentRuntime conformance'
      : 'CodexRuntime (mocked SDK) — AgentRuntime conformance',
    projectDir,
    // Codex is a stateless adapter: conformance drains sendMessage directly
    // (no feedProjector), so native history is [] by design — completed
    // history lives in the DorkOS-owned EventLog (ADR-0263).
    expectHistory: false,
    // A deterministic failed turn cannot be scripted against the live binary,
    // so the turn-failure gate runs only in mocked mode: the one-shot selector
    // makes the next minted thread stream `turn.failed`.
    ...(LIVE
      ? {}
      : {
          makeFailingRuntime: () => {
            failNextThread.value = true;
            return new CodexRuntime({
              threadMap: new CodexThreadMap(createTestDb()),
              binaryPath: null,
            });
          },
        }),
  }
);

/**
 * The wiring, not the watcher: `runEval` must ARM `unansweredPromptWatcher` for
 * a case that carries no {@link ApprovalPolicy}.
 *
 * The watcher has its own unit tests (`approval-driver.test.ts`), and they kept
 * passing while the line in `run-eval.ts` that installs it was reverted to
 * `undefined` — a guard nobody had connected. This file closes that: it drives a
 * policy-less case through the real `runEval` against a server that prompts for
 * one tool, and asserts the eval fails FAST with a message naming that tool,
 * instead of sitting out the 90-second turn guard the way the three `core` cases
 * did on 2026-09-12.
 *
 * It lives in its own file because the boot seam is mocked module-wide, and the
 * rest of `run-eval.test.ts` needs the real one.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { EvalCase } from '../../types.js';
import { BudgetTracker } from '../budget.js';

/** The tool the fake server asks permission for — the name the message must carry. */
const PROMPTED_TOOL = 'mcp__dorkos__config_patch';

let server: http.Server | undefined;

/**
 * A server that speaks the trigger-only contract and then asks for permission
 * once, and never answers itself — the shape of a real credentialed turn whose
 * case forgot its policy.
 *
 * @returns Its base URL.
 */
async function startPromptingServer(): Promise<string> {
  const live = new Map<string, http.ServerResponse>();
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const sessionId = url.pathname.split('/')[3] as string;
    if (req.method === 'GET' && url.pathname.endsWith('/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ cursor: 0 })}\n\n`);
      live.set(sessionId, res);
      return;
    }
    if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
      req.on('data', () => {});
      req.on('end', () => {
        res
          .writeHead(202, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ sessionId }));
        // The prompt, and then silence: nothing here ever answers it, and no
        // `turn_end` ever arrives.
        setTimeout(() => {
          live.get(sessionId)?.write(
            `event: approval_required\ndata: ${JSON.stringify({
              type: 'approval_required',
              seq: 1,
              id: 'toolu_probe',
              toolName: PROMPTED_TOOL,
            })}\n\n`
          );
        }, 10);
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

// The boot seam, replaced so `runEval` drives the server above instead of a real
// one. Only the in-process boot is overridden; everything else is the real
// module, so nothing this file does not care about changes behavior.
vi.mock('../harness-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../harness-server.js')>();
  return {
    ...actual,
    startInProcessServer: vi.fn(async ({ dorkHome }: { dorkHome: string }) => ({
      baseUrl: await startPromptingServer(),
      dorkHome,
      dispose: async (): Promise<void> => {
        server?.closeAllConnections?.();
        await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
        server = undefined;
      },
    })),
  };
});

const { runEval } = await import('../run-eval.js');

/** A case that drives a tool and — the whole point — declares no policy. */
const policylessCase: EvalCase = {
  id: 'unanswered-prompt-probe',
  title: 'A case that drives a tool and forgot its approvalPolicy',
  prompt: 'Change a setting for me.',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: [],
  oracles: [],
};

let runDir: string | undefined;

afterEach(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  if (runDir) await rm(runDir, { recursive: true, force: true });
  runDir = undefined;
  vi.clearAllMocks();
});

describe('runEval — a case with no approvalPolicy', () => {
  it('fails fast on the first permission prompt, naming the tool and the fix', async () => {
    runDir = await mkdtemp(path.join(tmpdir(), 'evals-nopolicy-'));
    const started = Date.now();

    const result = await runEval(policylessCase, {
      tier: 'test-mode',
      runId: 'r',
      runDir,
      tracker: new BudgetTracker({ runBudgetUsd: 1 }),
      // Generous on purpose: the assertion below is that the watcher ends this
      // LONG before the turn guard would, so the guard must not be the thing
      // that ends it.
      timeoutMs: 20_000,
    });

    expect(result.status).toBe('error');
    expect(result.error).toContain(PROMPTED_TOOL);
    expect(result.error).toContain('approvalPolicy');
    // Without the wiring this sits until the 20s guard and reports a timeout.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

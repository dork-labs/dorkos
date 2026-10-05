/**
 * @vitest-environment node
 *
 * The app-server done-when scenarios against REAL Codex on the operator's own
 * sign-in (spec `codex-app-server-transport` §17, T21). Gated by the same flag
 * as the live arm of `conformance.test.ts`, and skipped by name without it:
 *
 *   DORKOS_CODEX_LIVE=1 pnpm vitest run \
 *     src/services/runtimes/codex/__tests__/app-server-live.test.ts
 *
 * (from `apps/server`). Needs the vendored `codex` binary and `codex login`.
 * Costs ride the person's own Codex plan, as the live conformance arm's do;
 * `DORKOS_CODEX_LIVE` is not a paid flag and no turbo task passes it.
 *
 * Each scenario runs in its own fresh `mkdtemp` project:
 *
 * - (a) Ask first: asked to create a file, Codex stops on a card; approved,
 *   the file exists.
 * - (b) Steer: a message sent mid-reply lands in that reply; one turn, one done.
 * - (c) Stop mid-command: the receipt is `acked` and the turn ends with one done.
 * - (d) Background wake: a command left running finishes after the reply, and
 *   within 90 s a turn the agent starts on its own opens with
 *   `background_task_done` and a reply.
 *
 * A real model is not a script: a scenario whose PRECONDITION the model did not
 * meet (it never asked, or never backgrounded the command) fails with the
 * events it saw, so a rerun or a firmer prompt can tell model drift from a
 * DorkOS fault.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PermissionMode, StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { CodexRuntime } from '../codex-runtime.js';
import { CodexThreadMap } from '../thread-map.js';
import { initConfigManager } from '../../../core/config-manager.js';

const LIVE = process.env.DORKOS_CODEX_LIVE === '1';

const roots: string[] = [];
const runtimes: CodexRuntime[] = [];

function fresh(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

if (LIVE) {
  vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });
  // `check-dependencies` reads the config manager; a throwaway home keeps
  // `binaryPath` unset so the pinned vendored binary is the one under test.
  initConfigManager(fresh('dorkos-codex-live-config-'));
}

afterAll(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A runtime on app-server, a session in its own project at a level. */
function session(permissionMode: PermissionMode) {
  const runtime = new CodexRuntime({
    threadMap: new CodexThreadMap(createTestDb()),
    transport: 'app-server',
  });
  runtimes.push(runtime);
  const cwd = fresh('dorkos-codex-live-');
  const sessionId = randomUUID();
  runtime.ensureSession(sessionId, { permissionMode, cwd });
  return { runtime, cwd, sessionId };
}

const texts = (events: StreamEvent[]) =>
  events
    .filter((event) => event.type === 'text_delta')
    .map((event) => (event.data as { text: string }).text)
    .join('');
const dones = (events: StreamEvent[]) => events.filter((event) => event.type === 'done');

describe.skipIf(!LIVE)('Codex on app-server, live (DORKOS_CODEX_LIVE=1)', () => {
  it('(a) Ask first stops on a card before a change, and runs it once approved', async () => {
    const { runtime, cwd, sessionId } = session('default');
    const events: StreamEvent[] = [];
    for await (const event of runtime.sendMessage(
      sessionId,
      'Run exactly this shell command and nothing else: echo approved > made.txt',
      { cwd }
    )) {
      events.push(event);
      if (event.type === 'approval_required') {
        const { toolCallId } = event.data as { toolCallId: string };
        expect(fs.existsSync(path.join(cwd, 'made.txt')), 'nothing runs before a yes').toBe(false);
        expect(runtime.approveTool(sessionId, toolCallId, true)).toBe(true);
      }
    }
    expect(
      events.some((event) => event.type === 'approval_required'),
      JSON.stringify(events.map((event) => event.type))
    ).toBe(true);
    expect(fs.readFileSync(path.join(cwd, 'made.txt'), 'utf8').trim()).toBe('approved');
    expect(dones(events)).toHaveLength(1);
  });

  it('(b) a steer mid-reply lands in that reply: one turn, one done', async () => {
    const { runtime, cwd, sessionId } = session('default');
    const gen = runtime.sendMessage(
      sessionId,
      'Write the numbers from 1 to 400, one per line, and nothing else.',
      { cwd }
    );
    const events: StreamEvent[] = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === 'text_delta') break;
    }
    const receipt = await runtime.deliverIntoTurn!(
      sessionId,
      'Stop counting now. Reply with only the word STEERED.',
      { mode: 'steer', messageId: randomUUID() }
    );
    expect(receipt).toEqual({ delivered: true });
    for await (const event of gen) events.push(event);
    expect(texts(events)).toContain('STEERED');
    expect(dones(events)).toHaveLength(1);
  });

  it('(c) Stop mid-command is acknowledged and the turn ends with one done', async () => {
    const { runtime, cwd, sessionId } = session('bypassPermissions');
    const gen = runtime.sendMessage(
      sessionId,
      'Run exactly this shell command and wait for it to finish: sleep 60',
      { cwd }
    );
    const events: StreamEvent[] = [];
    for (;;) {
      const next = await gen.next();
      if (next.done) break;
      events.push(next.value);
      if (next.value.type === 'tool_call_start') break;
    }
    expect(
      events.some((event) => event.type === 'tool_call_start'),
      JSON.stringify(events.map((event) => event.type))
    ).toBe(true);
    const receipt = await runtime.interruptQuery(sessionId);
    for await (const event of gen) events.push(event);
    expect(receipt).toEqual({ outcome: 'acked', runtime: 'codex' });
    expect(dones(events)).toHaveLength(1);
    expect(runtime.getSessionWarmth!(sessionId)).not.toBe('running');
  });

  it('(d) a background command finishing after the reply wakes the chat with a turn of its own', async () => {
    const { runtime, cwd, sessionId } = session('bypassPermissions');
    const woken: Array<{ sessionId: string; events: AsyncIterable<StreamEvent> }> = [];
    runtime.onRuntimeTurn!((id, events) => woken.push({ sessionId: id, events }));
    const first: StreamEvent[] = [];
    for await (const event of runtime.sendMessage(
      sessionId,
      'Start this shell command in the background without waiting for it: ' +
        'sleep 20 && echo done-in-background. Then end your reply at once with the word STARTED.',
      { cwd }
    )) {
      first.push(event);
    }
    expect(dones(first)).toHaveLength(1);
    expect(
      first.some((event) => event.type === 'background_task_started'),
      'precondition: Codex left the command running past its reply'
    ).toBe(true);
    expect(runtime.holdsBackgroundWork!(sessionId)).toBe(true);

    await vi.waitFor(() => expect(woken).toHaveLength(1), { timeout: 90_000, interval: 500 });
    expect(woken[0]!.sessionId).toBe(sessionId);
    const wake: StreamEvent[] = [];
    for await (const event of woken[0]!.events) wake.push(event);
    expect(wake[0]).toMatchObject({ type: 'background_task_done', data: { status: 'completed' } });
    expect((wake[0]!.data as { summary?: string }).summary).toContain('done-in-background');
    expect(texts(wake).length).toBeGreaterThan(0);
    expect(dones(wake)).toHaveLength(1);
    // Exactly one wake for the one command.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(woken).toHaveLength(1);
  });
});

describe.skipIf(LIVE)('Codex on app-server, live', () => {
  it.skip('skipped: set DORKOS_CODEX_LIVE=1 to run against real Codex on your own sign-in', () => {});
});

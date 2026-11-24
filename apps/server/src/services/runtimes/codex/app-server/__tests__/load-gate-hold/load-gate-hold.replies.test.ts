/**
 * load-gate-hold: replies. Shared setup lives in `./load-gate-hold.fixtures.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { LOAD_WAIT_STATUS } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { PERSON_HOME } from '../../../__tests__/app-server-harness.js';
import {
  MINUTE,
  POLL,
  ASK,
  settings,
  settle,
  machine,
  commandItem,
  runningCommand,
  until,
  rest,
  waitWords,
  replies,
} from './load-gate-hold.fixtures.js';

describe('one slot: a command and its own ask never wait on each other (DOR-4743)', () => {
  it('a heavy command reported started, then asked about, gives its slot to its ask, so neither waits forever; another chat’s job gets in after it completes', async () => {
    // One slot, and a busy computer: the shape of a self-deadlock, if the running command kept
    // the only slot (`codex:<chat>:running`) while its own ask waited for one (`codex:<chat>:main`).
    expect(settings.slots).toBe(1);
    const { h, time, loadSource, queue, gate } = machine(20);
    let ask!: () => void;
    let finish!: () => void;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      const item = commandItem('pnpm build', 'a-1');
      // 0.154's order: the command is reported started, then asked about.
      ctx.emit('item/started', { item, startedAtMs: Date.now() });
      await new Promise<void>((resolve) => (ask = resolve));
      await ctx.serverRequest(ASK, { kind: 'command', itemId: 'a-1', command: 'pnpm build' });
      await new Promise<void>((resolve) => (finish = resolve));
      ctx.emit('item/completed', { item: { ...item, status: 'completed', exitCode: 0 } });
      ctx.complete('completed');
    });
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));

    // Reported started, not yet asked about: it holds the one slot.
    await until(ana, 'tool_call_start');
    await vi.waitFor(() => expect(typeof ask).toBe('function'));
    expect(queue.runningCount()).toBe(1);
    expect(queue.list()).toHaveLength(0);

    // Asked about: the slot goes back while the ask waits, so the ask is not waiting on itself.
    ask();
    expect(waitWords(await until(ana, ['system_status', 'approval_required']))).toBe(
      'Waiting for the computer to calm down. Next in line.'
    );
    await settle();
    expect(queue.runningCount()).toBe(0);
    expect(queue.list()).toHaveLength(1);
    await time.step(POLL);
    expect(queue.runningCount()).toBe(0);
    expect(queue.list()).toHaveLength(1);

    // The computer calms down: the one slot is free, so the ask gets its turn and its card.
    loadSource.set(4);
    await time.step(POLL);
    await until(ana, 'approval_required');
    expect(queue.runningCount()).toBe(0);
    expect(queue.list()).toHaveLength(0);

    // The computer turns busy again while the card is up. Approved, the command runs on the one
    // slot at once, without waiting in the line: a person's yes never waits behind it (DOR-4209).
    loadSource.set(20);
    h.transport.answerApproval('ana', 'a-1', true);
    await vi.waitFor(() => expect(typeof finish).toBe('function'));
    expect(queue.runningCount()).toBe(1);
    expect(queue.list()).toHaveLength(0);
    loadSource.set(4);

    // Another chat's heavy job (a Claude Code chat's build, say) waits behind it.
    const other = gate.gateIfHeavy('pnpm test', { chatId: 'bo', shareKey: 'claude-code:bo:main' });
    let otherIn = false;
    void other.then(() => (otherIn = true));
    await settle();
    await time.step(POLL);
    expect(otherIn).toBe(false);
    expect(queue.runningCount()).toBe(1);
    expect(queue.list()).toHaveLength(1);

    // It completes and the turn ends: the slot is free, and the other job gets in.
    finish();
    const after = await rest(ana);
    expect(after.find((e) => e.type === 'tool_call_end')).toMatchObject({
      data: { toolCallId: 'a-1', status: 'complete' },
    });
    expect(after.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(queue.runningCount()).toBe(0);
    await time.step(POLL);
    expect(otherIn).toBe(true);
    expect(queue.runningCount()).toBe(1);
    (await other)!.release();
    expect(queue.runningCount()).toBe(0);
    expect(queue.list()).toHaveLength(0);
    expect(replies(h)).toEqual([{ decision: 'accept' }]);
  });
});

describe('a new Codex reply waits to start on a busy computer while Codex commands run (DOR-4743)', () => {
  /** Ana's chat runs a heavy command without asking; it holds a slot until `end`. */
  async function anaRunning(m: ReturnType<typeof machine>) {
    const build = runningCommand('pnpm build', 'a-1');
    m.h.host.home(PERSON_HOME).nextTurn(build.script);
    const ana = m.h.transport.runTurn(m.h.request({ sessionId: 'ana' }));
    await until(ana, 'tool_call_start');
    expect(m.queue.runningCount()).toBe(1);
    return { ana, build, fake: m.h.host.home(PERSON_HOME).processes[0]! };
  }

  it('waits, saying so, and starts once the slot frees', async () => {
    const m = machine(20);
    const { ana, build, fake } = await anaRunning(m);
    const bo = m.h.transport.runTurn(m.h.request({ sessionId: 'bo' }));
    expect(waitWords(await until(bo, 'system_status'))).toBe(
      'Waiting for the computer to calm down before starting.'
    );
    await m.time.step(POLL);
    // Codex was never told about Bo's message.
    expect(fake.requestsOf('turn/start')).toHaveLength(1);

    build.end('completed');
    await rest(ana);
    await m.time.step(POLL);
    const after = await rest(bo);
    expect(fake.requestsOf('turn/start')).toHaveLength(2);
    expect(after.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('a Stop while it waits ends it, and Codex is never told about the message', async () => {
    const m = machine(20);
    const { ana, build, fake } = await anaRunning(m);
    const stop = new AbortController();
    const bo = m.h.transport.runTurn(m.h.request({ sessionId: 'bo', signal: stop.signal }));
    await until(bo, 'system_status');
    stop.abort();
    expect(await m.h.transport.interrupt('bo')).toMatchObject({ outcome: 'not-running' });
    expect(await rest(bo)).toEqual([{ type: 'done', data: { sessionId: 'bo' } }]);
    m.loadSource.set(4);
    await m.time.step(POLL);
    expect(fake.requestsOf('turn/start')).toHaveLength(1);
    build.end('completed');
    await rest(ana);
  });

  it('starts anyway after maxWaitMinutes on a computer kept busy, and not before', async () => {
    const m = machine(20);
    const { ana, build, fake } = await anaRunning(m);
    const bo = m.h.transport.runTurn(m.h.request({ sessionId: 'bo' }));
    const seen: StreamEvent[] = [];
    await until(bo, 'system_status', seen);
    // Read on, so Bo's turn goes ahead the moment its wait ends.
    const boDone = rest(bo, seen);
    await m.time.step(59 * MINUTE);
    expect(fake.requestsOf('turn/start')).toHaveLength(1);
    await m.time.step(MINUTE);
    await boDone;
    expect(fake.requestsOf('turn/start')).toHaveLength(2);
    expect(m.queue.runningCount()).toBe(1);
    const notices = seen.filter(
      (e) =>
        e.type === 'system_status' && (e.data as { status?: unknown }).status === LOAD_WAIT_STATUS
    );
    expect(notices.length).toBeGreaterThan(0);
    // It starts at the cap, so it never says it is still waiting or when it starts anyway.
    for (const notice of notices) {
      expect(waitWords(notice)).toBe('Waiting for the computer to calm down before starting.');
    }
    expect(m.lines).toContain('[LoadGate] Work started after waiting 60 min, the longest it waits');
    build.end('completed');
    await rest(ana);
  });
});

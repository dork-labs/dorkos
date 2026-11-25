/**
 * load-gate-hold: commands. Shared setup lives in `./load-gate-hold.fixtures.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import { PERSON_HOME } from '../../../__tests__/app-server-harness.js';
import {
  POLL,
  ASK,
  settle,
  machine,
  commandItem,
  runningCommand,
  until,
  rest,
  waitWords,
  replies,
  fullAccess,
} from './load-gate-hold.fixtures.js';

describe('a command Codex runs without asking counts in the line (DOR-4743)', () => {
  it('at Full access fills the slot, so another chat’s build waits until it completes', async () => {
    const { h, time, queue, gate } = machine(4);
    const build = runningCommand('pnpm build', 'full-1');
    h.host.home(PERSON_HOME).nextTurn(build.script);
    const full = fullAccess(h, 'full');
    try {
      const ana = h.transport.runTurn(full.request);
      await until(ana, 'tool_call_start');
      const fake = h.host.home(PERSON_HOME).processes[0]!;
      // Codex is told never to ask, so there is no ask to hold: the command is already running.
      expect(fake.requestsOf('turn/start')[0]).toMatchObject({ approvalPolicy: 'never' });
      expect(queue.runningCount()).toBe(1);

      // Any other heavy job, on any runtime, waits behind it, though the computer is calm.
      const other = gate.waitForSlot({ job: 'tsc' });
      let ran = false;
      void other.then(() => (ran = true));
      await time.step(POLL);
      expect(ran).toBe(false);
      expect(queue.list()).toHaveLength(1);

      build.end('completed');
      const after = await rest(ana);
      expect(after.some((event) => event.type === 'system_status')).toBe(false);
      expect(after.find((e) => e.type === 'tool_call_end')).toMatchObject({
        data: { toolCallId: 'full-1', status: 'complete' },
      });
      await time.step(POLL);
      expect(ran).toBe(true);
      (await other).release();
      expect(queue.runningCount()).toBe(0);
    } finally {
      full.cleanup();
    }
  });

  it('gives the slot back when the turn ends without the command’s completion', async () => {
    const { h, queue } = machine(20);
    const build = runningCommand('pnpm build', 'a-1');
    h.host.home(PERSON_HOME).nextTurn(build.script);
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'tool_call_start');
    expect(queue.runningCount()).toBe(1);
    build.end('turn-only');
    await rest(ana);
    await settle();
    expect(queue.runningCount()).toBe(0);
  });

  it('an asked command counts once: nothing while its ask waits and its card is up, one slot while it runs', async () => {
    const { h, time, loadSource, queue } = machine(20);
    let finish!: () => void;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      const item = commandItem('pnpm build', 'a-1');
      // 0.154's order: the command is reported started, then asked about.
      ctx.emit('item/started', { item, startedAtMs: Date.now() });
      await ctx.serverRequest(ASK, { kind: 'command', itemId: 'a-1', command: 'pnpm build' });
      await new Promise<void>((resolve) => (finish = resolve));
      ctx.emit('item/completed', { item: { ...item, status: 'completed', exitCode: 0 } });
      ctx.complete('completed');
    });
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    expect(waitWords(await until(ana, ['system_status', 'approval_required']))).toBe(
      'Waiting for the computer to calm down. Next in line.'
    );
    await settle();
    expect(queue.list()).toHaveLength(1);
    expect(queue.runningCount()).toBe(0);

    loadSource.set(4);
    await time.step(POLL);
    await until(ana, 'approval_required');
    expect(queue.list()).toHaveLength(0);
    expect(queue.runningCount()).toBe(0);

    h.transport.answerApproval('ana', 'a-1', true);
    await vi.waitFor(() => expect(typeof finish).toBe('function'));
    expect(queue.runningCount()).toBe(1);
    finish();
    await rest(ana);
    expect(queue.runningCount()).toBe(0);
    expect(queue.list()).toHaveLength(0);
    expect(replies(h)).toEqual([{ decision: 'accept' }]);
  });
});

describe('a card never holds a slot (DOR-4743)', () => {
  it('an ask that arrives before its item/started: the command takes no slot until the ask is answered', async () => {
    const { h, time, loadSource, queue } = machine(20);
    let started!: () => void;
    let finish!: () => void;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      const item = commandItem('pnpm build', 'a-1');
      // The other order: asked about first, reported started while the ask still waits.
      const reply = ctx.serverRequest(ASK, {
        kind: 'command',
        itemId: 'a-1',
        command: 'pnpm build',
      });
      await new Promise<void>((resolve) => (started = resolve));
      ctx.emit('item/started', { item, startedAtMs: Date.now() });
      await reply;
      await new Promise<void>((resolve) => (finish = resolve));
      ctx.emit('item/completed', { item: { ...item, status: 'completed', exitCode: 0 } });
      ctx.complete('completed');
    });
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    expect(waitWords(await until(ana, ['system_status', 'approval_required']))).toBe(
      'Waiting for the computer to calm down. Next in line.'
    );
    started();
    await until(ana, 'tool_call_start');
    await settle();
    // Reported started, but still asked about: it is not running, and holds nothing.
    expect(queue.runningCount()).toBe(0);
    expect(queue.list()).toHaveLength(1);

    loadSource.set(4);
    await time.step(POLL);
    await until(ana, 'approval_required');
    expect(queue.runningCount()).toBe(0);

    h.transport.answerApproval('ana', 'a-1', true);
    await vi.waitFor(() => expect(typeof finish).toBe('function'));
    expect(queue.runningCount()).toBe(1);
    finish();
    await rest(ana);
    expect(queue.runningCount()).toBe(0);
    expect(queue.list()).toHaveLength(0);
  });

  it('a second ask about a running command (its network access) gives the slot back while its card is up, and takes it again once answered', async () => {
    const { h, time, loadSource, queue, gate } = machine(4);
    let networkAsk!: () => void;
    let finish!: () => void;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      const item = commandItem('pnpm build', 'a-1');
      ctx.emit('item/started', { item, startedAtMs: Date.now() });
      await ctx.serverRequest(ASK, { kind: 'command', itemId: 'a-1', command: 'pnpm build' });
      // Running, it reaches for the network, and Codex asks again about the same item.
      await new Promise<void>((resolve) => (networkAsk = resolve));
      await ctx.serverRequest(ASK, {
        kind: 'command',
        itemId: 'a-1',
        approvalId: 'net-1',
        command: 'pnpm build',
        networkApprovalContext: { host: 'registry.npmjs.org', protocol: 'https' },
      });
      await new Promise<void>((resolve) => (finish = resolve));
      ctx.emit('item/completed', { item: { ...item, status: 'completed', exitCode: 0 } });
      ctx.complete('completed');
    });
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    const first = await until(ana, 'approval_required');
    h.transport.answerApproval('ana', (first.data as { toolCallId: string }).toolCallId, true);
    await vi.waitFor(() => expect(typeof networkAsk).toBe('function'));
    // Approved and running: it holds the one slot, and another chat's job waits behind it.
    expect(queue.runningCount()).toBe(1);
    const other = gate.gateIfHeavy('pnpm test', { chatId: 'bo', shareKey: 'claude-code:bo:main' });
    let otherIn = false;
    void other.then(() => (otherIn = true));
    await settle();
    await time.step(POLL);
    expect(otherIn).toBe(false);

    // The network ask's card is up: the slot goes back, and the other job gets in meanwhile.
    networkAsk();
    const second = await until(ana, 'approval_required');
    expect(queue.runningCount()).toBe(0);
    await time.step(POLL);
    expect(otherIn).toBe(true);
    expect(queue.runningCount()).toBe(1);
    (await other)!.release();
    expect(queue.runningCount()).toBe(0);

    // The computer turns busy and a third chat's job waits in line while the card is still up.
    loadSource.set(20);
    const third = gate.gateIfHeavy('tsc', { chatId: 'cy', shareKey: 'claude-code:cy:main' });
    let thirdIn = false;
    void third.then(() => (thirdIn = true));
    await settle();
    expect(queue.list()).toHaveLength(1);

    // Answered, the command runs again at once, on a slot it takes without waiting in the line
    // (a card never makes a person's yes wait behind the line, DOR-4209): the third job still waits.
    h.transport.answerApproval('ana', (second.data as { toolCallId: string }).toolCallId, true);
    await vi.waitFor(() => expect(typeof finish).toBe('function'));
    expect(queue.runningCount()).toBe(1);
    expect(queue.list()).toHaveLength(1);
    expect(thirdIn).toBe(false);
    finish();
    await rest(ana);
    expect(queue.runningCount()).toBe(0);
    expect(replies(h)).toHaveLength(2);
    loadSource.set(4);
    await time.step(POLL);
    expect(thirdIn).toBe(true);
    (await third)!.release();
    expect(queue.runningCount()).toBe(0);
  });
});

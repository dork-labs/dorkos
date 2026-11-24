/**
 * load-gate-hold: line. Shared setup lives in `./load-gate-hold.fixtures.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { PERSON_HOME } from '../../../__tests__/app-server-harness.js';
import {
  MINUTE,
  POLL,
  ASK,
  settle,
  machine,
  commandItem,
  askingTurn,
  askingThenParkedTurn,
  until,
  rest,
  waitWords,
  replies,
} from './load-gate-hold.fixtures.js';

describe('the acceptance test: two Codex chats on one busy computer', () => {
  it('holds both heavy asks in order, asks a person only once each gets its turn, and passes ls at once', async () => {
    const { h, time, loadSource, queue } = machine(20);
    const home = h.host.home(PERSON_HOME);
    home.nextTurn(askingTurn('pnpm build', 'a-1'));
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    expect(waitWords(await until(ana, 'system_status'))).toBe(
      'Waiting for the computer to calm down. Next in line.'
    );
    home.nextTurn(askingTurn('pnpm test', 'b-1'));
    const bo = h.transport.runTurn(h.request({ sessionId: 'bo' }));
    expect(waitWords(await until(bo, 'system_status'))).toBe(
      'Waiting for the computer to calm down. 2nd in line.'
    );
    expect(queue.list()).toHaveLength(2);
    // Held, never answered: nothing has been written to Codex for either ask.
    expect(replies(h)).toEqual([]);

    // A light command's ask goes straight to its card while both wait.
    home.nextTurn(askingTurn('ls -la', 'c-1'));
    const cy = h.transport.runTurn(h.request({ sessionId: 'cy' }));
    const cySeen: StreamEvent[] = [];
    await until(cy, 'approval_required', cySeen);
    expect(cySeen.some((event) => event.type === 'system_status')).toBe(false);
    h.transport.answerApproval('cy', 'c-1', true);
    await rest(cy);

    loadSource.set(4);
    await time.step(POLL);
    // Ana's turn came: her card goes up, and its slot came back as it did.
    await until(ana, 'approval_required');
    expect(queue.runningCount()).toBe(0);
    expect(queue.list()).toHaveLength(1);

    await time.step(POLL);
    await until(bo, 'approval_required');
    expect(queue.list()).toHaveLength(0);

    // The person decides each, and only the person: one yes, one no.
    h.transport.answerApproval('ana', 'a-1', true);
    h.transport.answerApproval('bo', 'b-1', false);
    const anaAfter = await rest(ana);
    const boAfter = await rest(bo);
    expect(anaAfter.find((e) => e.type === 'tool_call_end')).toMatchObject({
      data: { toolCallId: 'a-1', status: 'complete' },
    });
    expect(boAfter.find((e) => e.type === 'tool_call_end')).toMatchObject({
      data: { toolCallId: 'b-1', status: 'error' },
    });
    expect(replies(h)).toEqual([
      { decision: 'accept' },
      { decision: 'accept' },
      { decision: 'decline' },
    ]);
    expect(queue.runningCount()).toBe(0);
  });
});

describe('the hold waits and never decides', () => {
  it('a gate that breaks lets the ask through to its card, logging no command and no message', async () => {
    const { h, log } = machine(20, () => {
      throw new Error('EACCES /Users/someone/secret-project');
    });
    h.host.home(PERSON_HOME).nextTurn(askingTurn('pnpm build --filter secret-project', 'a-1'));
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'approval_required');
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { error: 'Error' });
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/secret/);
    // The person still decides: a no is a no.
    h.transport.answerApproval('ana', 'a-1', false);
    await rest(ana);
    expect(replies(h)).toEqual([{ decision: 'decline' }]);
  });
});

describe('a waiting ask leaves the line', () => {
  it('when the turn is stopped, and the next chat moves up', async () => {
    const { h, time, loadSource, queue } = machine(20);
    const home = h.host.home(PERSON_HOME);
    home.nextTurn(askingThenParkedTurn('pnpm build', 'a-1'));
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'system_status');
    home.nextTurn(askingTurn('pnpm test', 'b-1'));
    const bo = h.transport.runTurn(h.request({ sessionId: 'bo' }));
    await until(bo, 'system_status');

    const receipt = await h.transport.interrupt('ana');
    expect(receipt.outcome).toBe('acked');
    const anaAfter = await rest(ana);
    expect(anaAfter.filter((e) => e.type === 'done')).toHaveLength(1);
    await settle();
    expect(queue.list()).toHaveLength(1);
    // Her turn is over, so nobody is asked: no card, and the method's own no, never a yes.
    expect(anaAfter.some((event) => event.type === 'approval_required')).toBe(false);
    await vi.waitFor(() => expect(replies(h)).toEqual([{ decision: 'decline' }]));

    await time.step(MINUTE);
    expect(waitWords(await until(bo, 'system_status'))).toBe(
      'Waiting for the computer to calm down. Next in line.'
    );
    loadSource.set(4);
    await time.step(POLL);
    await until(bo, 'approval_required');
    h.transport.answerApproval('bo', 'b-1', true);
    await rest(bo);
    expect(queue.list()).toHaveLength(0);
  });

  it('when Codex withdraws the ask, and nobody is asked about it', async () => {
    const { h, queue } = machine(20);
    let withdraw!: () => void;
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      ctx.emit('item/started', { item: commandItem('pnpm build', 'a-1'), startedAtMs: Date.now() });
      void ctx.serverRequest(ASK, { kind: 'command', itemId: 'a-1', command: 'pnpm build' });
      await new Promise<void>((resolve) => (withdraw = resolve));
      ctx.server.send({
        method: 'serverRequest/resolved',
        params: { threadId: ctx.turn.threadId, requestId: ctx.server.lastServerRequestId },
      });
      await ctx.tick();
      ctx.agentMessage('ok');
      ctx.complete('completed');
    });
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'system_status');
    expect(queue.list()).toHaveLength(1);
    withdraw();
    const after = await rest(ana);
    await settle();
    expect(queue.list()).toHaveLength(0);
    expect(after.some((event) => event.type === 'approval_required')).toBe(false);
    // The method's own no, which Codex ignores for a request it cleared: never a yes.
    expect(replies(h)).toEqual([{ decision: 'decline' }]);
  });

  it('when the Codex process goes away', async () => {
    const { h, queue } = machine(20);
    h.host.home(PERSON_HOME).nextTurn(askingThenParkedTurn('pnpm build', 'a-1'));
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'system_status');
    expect(queue.list()).toHaveLength(1);
    h.host.home(PERSON_HOME).processes[0]!.kill('SIGKILL');
    const after = await rest(ana);
    expect(after.filter((e) => e.type === 'done')).toHaveLength(1);
    await settle();
    expect(queue.list()).toHaveLength(0);
    expect(queue.runningCount()).toBe(0);
    expect(after.some((event) => event.type === 'approval_required')).toBe(false);
  });
});

describe('a chat never waits behind itself', () => {
  it('two heavy asks of one turn share one ticket, and each gets its card when it comes', async () => {
    const { h, time, loadSource, queue } = machine(20);
    h.host.home(PERSON_HOME).nextTurn(async (ctx) => {
      const asks = (['a-1', 'a-2'] as const).map((itemId, index) => {
        const command = index === 0 ? 'pnpm typecheck' : 'pnpm lint';
        ctx.emit('item/started', { item: commandItem(command, itemId), startedAtMs: Date.now() });
        return ctx.serverRequest(ASK, { kind: 'command', itemId, command, cwd: '/project' });
      });
      await Promise.all(asks);
      for (const [itemId, command] of [
        ['a-1', 'pnpm typecheck'],
        ['a-2', 'pnpm lint'],
      ] as const) {
        ctx.emit('item/completed', {
          item: { ...commandItem(command, itemId), status: 'completed' },
        });
      }
      ctx.complete('completed');
    });
    const ana = h.transport.runTurn(h.request({ sessionId: 'ana' }));
    await until(ana, 'system_status');
    await settle();
    expect(queue.list()).toHaveLength(1);

    loadSource.set(4);
    await time.step(POLL);
    const seen: StreamEvent[] = [];
    await until(ana, 'approval_required', seen);
    await until(ana, 'approval_required', seen);
    const cards = seen.filter((event) => event.type === 'approval_required');
    expect(cards.map((card) => (card.data as { toolCallId: string }).toolCallId).sort()).toEqual([
      'a-1',
      'a-2',
    ]);
    expect(queue.list()).toHaveLength(0);
    expect(queue.runningCount()).toBe(0);
    h.transport.answerApproval('ana', 'a-1', true);
    h.transport.answerApproval('ana', 'a-2', false);
    await rest(ana);
  });
});

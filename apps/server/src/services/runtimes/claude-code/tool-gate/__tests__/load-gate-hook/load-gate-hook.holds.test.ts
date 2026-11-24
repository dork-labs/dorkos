/**
 * load-gate-hook: holds. Shared setup lives in `./load-gate-hook.fixtures.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { type PermissionModeId } from '@dorkos/shared/schemas';
import { SESSIONS } from '../../../../../../config/constants.js';
import {
  createCanUseTool,
  type ToolApprovalContext,
} from '../../../messaging/interactive-handlers.js';
import type { PendingInteraction } from '../../../messaging/interaction-wait.js';
import type { ShellChecker } from '../../../shell-guard/guard-host.js';
import { checkShellCommand, type ShellGuardRoots } from '../../../shell-guard/shell-check.js';
import {
  createShellPathGuardHook,
  SHELL_WRITE_DENY_REASON,
} from '../../../shell-guard/shell-path-guard.js';
import { releaseHeavyJobsOf } from '../../load-gate-hook.js';
import {
  MINUTE,
  POLL,
  noopLog,
  settle,
  machine,
  chat,
  hooksFor,
  BASE,
  bash,
  finished,
  call,
  track,
  said,
  expectNoDecision,
  cliSettles,
} from './load-gate-hook.fixtures.js';

describe('the gate holds a call and never decides it', () => {
  let root: string;
  let roots: ShellGuardRoots;
  let agent: string;
  /** The shell guard's own check, in this process. */
  const check: ShellChecker = async (command, where, reads) => ({
    outcome: 'checked',
    ...(await checkShellCommand(command, where, reads)),
  });

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'load-gate-guard-')));
    agent = path.join(root, 'data', 'agents', 'ana');
    fs.mkdirSync(path.join(agent, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(agent, '.claude', 'settings.json'), '{}');
    for (const folder of ['work', 'home', 'account']) {
      fs.mkdirSync(path.join(root, folder), { recursive: true });
    }
    roots = {
      cwd: path.join(root, 'work'),
      dorkHome: path.join(root, 'data'),
      home: path.join(root, 'home'),
      accounts: [path.join(root, 'account')],
      env: { HOME: path.join(root, 'home') },
      agentHomes: () => [agent],
    };
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function guardFor(session: { permissionMode: PermissionModeId }) {
    return createShellPathGuardHook(session, {
      roots: () => roots,
      check,
      recordRefusal: vi.fn(),
      log: { info: () => {}, warn: () => {} },
    });
  }

  it('a heavy command the shell guard refuses is still refused once its slot comes, and gives the slot back', async () => {
    const { gate, time, loadSource, queue } = machine(20);
    const session = { ...chat('sdk-ana'), permissionMode: 'bypassPermissions' as PermissionModeId };
    const hooks = hooksFor(session, gate, time.now);
    const command = `pnpm build && echo x > ${agent}/.claude/settings.json`;
    const settled = track(
      cliSettles([guardFor(session), hooks.wait.hooks[0]!], bash(command, 'c-1'), 'c-1')
    );
    await settle();
    // Held: the CLI waits for every hook, the gate's included.
    expect(settled.done).toBe(false);

    loadSource.set(4);
    await time.step(POLL);
    expect(settled.done).toBe(true);
    expect(settled.value).toMatchObject({ decision: 'deny', reason: SHELL_WRITE_DENY_REASON });
    expectNoDecision(settled.value!.answers[1]);
    // The refused call never runs, so no PostToolUse comes; its batch ending gives the slot back.
    expect(queue.runningCount()).toBe(1);
    await call(hooks.backstops.PostToolBatch[0]!, {
      ...BASE,
      hook_event_name: 'PostToolBatch',
      tool_calls: [{ tool_name: 'Bash', tool_input: { command }, tool_use_id: 'c-1' }],
    } as HookInput);
    expect(queue.runningCount()).toBe(0);
  });

  /**
   * A chat below Full whose heavy `git push` waits for its slot on a busy computer, then, once the
   * computer calms, goes on to the permission flow, which raises a card with the launch's own
   * `releaseCall` wired in, as `launch-resolver.ts` wires it.
   */
  async function carded(m: ReturnType<typeof machine>, cardClock: 'real' | 'fake' = 'real') {
    const session = {
      ...chat('sdk-ana'),
      permissionMode: 'acceptEdits' as PermissionModeId,
      turnPermissionCeiling: 'runtime-default' as const,
      cwd: roots.cwd,
      pendingInteractions: new Map<string, PendingInteraction>(),
    };
    const hooks = hooksFor(session, m.gate, m.time.now);
    const settled = track(
      cliSettles([guardFor(session), hooks.wait.hooks[0]!], bash('git push', 'card'), 'card')
    );
    await settle();
    expect(settled.done).toBe(false);
    m.loadSource.set(4);
    await m.time.step(POLL);
    // No hook decided, the gate least of all, so the call goes on to the permission flow.
    expect(settled.value?.decision).toBe('permission flow');
    expectNoDecision(settled.value!.answers[1]);
    expect(m.queue.runningCount()).toBe(1);
    const cancel = new AbortController();
    const context: ToolApprovalContext = { signal: cancel.signal, toolUseID: 'card' };
    // The card's own wait timers, faked only for a test that runs the card out of time.
    if (cardClock === 'fake') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const canUseTool = createCanUseTool(
      session,
      noopLog,
      undefined,
      undefined,
      undefined,
      undefined,
      hooks.releaseCall
    );
    const answer = track(canUseTool('Bash', { command: 'git push' }, context));
    await vi.waitFor(() => expect(session.pendingInteractions.has('card')).toBe(true));
    expect(session.eventQueue.map((event) => event.type)).toContain('approval_required');
    /** The person answers the card. */
    const answerCard = (yes: boolean): void => {
      const pending = session.pendingInteractions.get('card');
      if (pending?.type !== 'approval') throw new Error('no card is waiting');
      pending.resolve(yes, yes ? undefined : 'Not now.');
    };
    return { hooks, answer, answerCard, cancel };
  }

  it('a heavy command that needs a card reaches the card, gives its slot back while it waits, and runs at once on a yes', async () => {
    const m = machine(20);
    const { hooks, answer, answerCard } = await carded(m);
    // The card took the slot back: the line is free for the next heavy job.
    expect(m.queue.runningCount()).toBe(0);
    const bo = hooksFor(chat('sdk-bo'), m.gate, m.time.now);
    const boBuild = track(call(bo.wait, bash('pnpm build', 'bo-1')));
    await settle();
    expect(boBuild.done).toBe(true);
    expect(m.queue.runningCount()).toBe(1);

    // The person approves: the call runs now, outside the line, and takes no slot or ticket. At
    // most one job runs outside the line this way, the one the person said yes to.
    answerCard(true);
    await settle();
    expect(answer.value).toEqual({ behavior: 'allow', updatedInput: { command: 'git push' } });
    expect(m.queue.runningCount()).toBe(1);
    expect(m.queue.list()).toHaveLength(0);
    // Its finishing gives back nothing it does not hold: Bo's slot stays Bo's.
    expectNoDecision(await call(hooks.afterCall, finished('card', 'PostToolUse')));
    expect(m.queue.runningCount()).toBe(1);
    await call(bo.afterCall, finished('bo-1', 'PostToolUse'));
    expect(m.queue.runningCount()).toBe(0);
  });

  describe('however the card ends, the slot was freed when it was raised and nothing is retaken', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    type Card = Awaited<ReturnType<typeof carded>>;
    const ENDINGS: [string, 'allow' | 'deny', 'real' | 'fake', (card: Card) => void][] = [
      ['approved', 'allow', 'real', (card) => card.answerCard(true)],
      ['denied', 'deny', 'real', (card) => card.answerCard(false)],
      [
        'run out of time',
        'deny',
        'fake',
        // The interaction wait's own path: it parks, then expires at the ceiling.
        () => {
          vi.advanceTimersByTime(SESSIONS.INTERACTION_PARK_CEILING_MS);
        },
      ],
      ['withdrawn by the CLI', 'deny', 'real', (card) => card.cancel.abort()],
    ];

    it.each(ENDINGS)('%s', async (_ending, behavior, cardClock, end) => {
      const m = machine(20);
      const card = await carded(m, cardClock);
      // Freed the moment the card went up, before anyone answered.
      expect(m.queue.runningCount()).toBe(0);
      expect(m.queue.list()).toHaveLength(0);
      end(card);
      await settle();
      expect(card.answer.value).toMatchObject({ behavior });
      // Nothing retaken, whatever the ending, and nothing left in line.
      expect(m.queue.runningCount()).toBe(0);
      expect(m.queue.list()).toHaveLength(0);
      // Every hook the call can still meet answers nothing, and frees nothing it does not hold.
      const after: HookInput[] = [
        finished('card', behavior === 'allow' ? 'PostToolUse' : 'PostToolUseFailure'),
        {
          ...BASE,
          hook_event_name: 'PermissionDenied',
          tool_name: 'Bash',
          tool_input: {},
          tool_use_id: 'card',
          reason: 'denied',
        } as HookInput,
        { ...BASE, hook_event_name: 'Stop', stop_hook_active: false } as HookInput,
      ];
      for (const input of after) {
        expectNoDecision(await call(card.hooks.afterCall, input));
        expectNoDecision(await call(card.hooks.sweep, input));
      }
      expect(m.queue.runningCount()).toBe(0);
    });
  });

  it.each(['the CLI cancels the hook', 'the process ends'] as const)(
    'a turn stopped while its call waits in line: %s, its ticket leaves, and the next job moves up',
    async (how) => {
      const { gate, time, loadSource, queue } = machine(20);
      const ana = chat('sdk-ana');
      const bo = chat('sdk-bo');
      const anaHooks = hooksFor(ana, gate, time.now);
      const boHooks = hooksFor(bo, gate, time.now);
      const cancel = new AbortController();
      const anaBuild = track(call(anaHooks.wait, bash('pnpm build', 'ana-1'), cancel.signal));
      const boTests = track(call(boHooks.wait, bash('pnpm test', 'bo-1')));
      await settle();
      expect(said(bo)).toEqual(['Waiting for the computer to calm down. 2nd in line.']);

      // Stop pressed on Ana's chat. An interrupt runs no Stop hook, so the stop arrives either as
      // the CLI cancelling the waiting hook or as the process going away.
      if (how === 'the CLI cancels the hook') cancel.abort();
      else releaseHeavyJobsOf({ hooks: { PreToolUse: [anaHooks.wait] } });
      await settle();
      // Ana's call fails open into the normal flow (the CLI stops it there), and leaves the line.
      expectNoDecision(anaBuild.value);
      expect(queue.list()).toHaveLength(1);
      expect(anaHooks.log.warn).not.toHaveBeenCalled();

      // Bo moved up: next in line now, and first to run once the computer calms.
      bo.eventQueue.splice(0);
      await time.step(MINUTE);
      expect(said(bo)).toEqual(['Waiting for the computer to calm down. Next in line.']);
      loadSource.set(4);
      await time.step(POLL);
      expectNoDecision(boTests.value);
      expect(queue.runningCount()).toBe(1);
      await call(boHooks.afterCall, finished('bo-1', 'PostToolUse'));
      expect(queue.runningCount()).toBe(0);
    }
  );

  it('a card for a call still in line takes its ticket out, and it never runs from the line', async () => {
    const { gate, time, loadSource, queue } = machine(20);
    const hooks = hooksFor(chat('s'), gate, time.now);
    const held = track(call(hooks.wait, bash('pnpm build', 'still-waiting')));
    await settle();
    expect(queue.list()).toHaveLength(1);
    // The CLI gave up on the hook and asked a person about the call.
    hooks.releaseCall('still-waiting');
    await settle();
    expectNoDecision(held.value);
    expect(queue.list()).toHaveLength(0);
    loadSource.set(4);
    await time.step(POLL);
    expect(queue.runningCount()).toBe(0);
    expect(hooks.log.warn).not.toHaveBeenCalled();
  });
});

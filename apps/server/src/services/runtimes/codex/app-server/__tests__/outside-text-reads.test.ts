/**
 * Codex output handed to a later turn marks that turn when it read outside words (DOR-5240): a
 * background command that finishes after its turn, shown in the open turn or in the wake it
 * starts, and what the model types into a command that is still running.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marksOf } from '../../../../core/turn-power/turn-levels.js';
import {
  resetLiveOutsiderTurns,
  runningMarksOf,
} from '../../../../core/turn-power/live-outsider-turns.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { outsideTextMarker } from '../../../../audit/outside-text-stream.js';
import { markFinishedCommand } from '../../tool-turn/outside-text-reads.js';
import { createCodexEventContext } from '../../event-mapper.js';
import { CodexBackgroundWork, WAKE_COALESCE_MS, type BackgroundTask } from '../background-work.js';
import { AppServerTurnMapper } from '../notification-mapper.js';
import { NOTIFICATION_DISPOSITION } from '../notification-disposition.js';

let counter = 0;
const fresh = () => `codex-outside-reads-${(counter += 1)}`;
const marked = (sessionId: string) => marksOf(sessionId, undefined).outsider === true;

const task = (sessionId: string, label: string, cwd = '/agents/wren'): BackgroundTask => ({
  taskId: `cmd-${sessionId}`,
  kind: 'bash',
  sessionId,
  threadId: 't1',
  processKey: 'p1',
  processId: '4242',
  label,
  turnStatus: 'completed',
  context: { opts: { cwd } },
});

const commandDone = (id: string) => ({
  method: 'item/completed',
  params: {
    threadId: 't1',
    turnId: 'old-turn',
    item: {
      type: 'commandExecution',
      id,
      status: 'completed',
      exitCode: 0,
      aggregatedOutput: 'page text\n',
    },
  },
});

function tracker() {
  return new CodexBackgroundWork({ onWake: () => true, terminate: async () => true });
}

beforeEach(() => {
  vi.stubEnv('DORK_HOME', '/made-up/dork-home');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetLiveOutsiderTurns();
  clearTestHomes();
});

const AGENT = '/agents/wren';
const agentMarked = () => runningMarksOf(AGENT).some((marks) => marks.outsider === true);

describe('a background command finishing in a later turn', () => {
  it('marks the turn it is shown in when the command fetched', () => {
    const sessionId = fresh();
    const work = tracker();
    work.track([task(sessionId, 'sleep 30; curl -s https://example.com')]);
    expect(work.completionOf(commandDone(`cmd-${sessionId}`))).toBeDefined();
    expect(marked(sessionId)).toBe(true);
    work.dispose();
  });

  it('marks the wake it starts', () => {
    vi.useFakeTimers();
    const sessionId = fresh();
    const work = tracker();
    work.queue(sessionId, {
      taskId: 'cmd-late',
      kind: 'bash',
      label: 'gh issue view 12',
      status: 'completed',
      summary: 'Exit code 0.',
      wakes: true,
      context: { opts: { cwd: '/agents/wren' } },
    });
    vi.advanceTimersByTime(WAKE_COALESCE_MS);
    expect(marked(sessionId)).toBe(true);
    work.dispose();
  });

  it('reads the command where its turn stood', () => {
    const sessionId = fresh();
    const work = tracker();
    work.track([task(sessionId, 'cat page.html', '/tmp')]);
    work.completionOf(commandDone(`cmd-${sessionId}`));
    expect(marked(sessionId)).toBe(true);
    work.dispose();
  });

  it('leaves a local command unmarked', () => {
    const sessionId = fresh();
    const work = tracker();
    work.track([task(sessionId, 'pnpm test -- --run')]);
    work.completionOf(commandDone(`cmd-${sessionId}`));
    expect(marked(sessionId)).toBe(false);
    work.dispose();
  });
});

describe('typing into a running command', () => {
  const typed = (sessionId: string, stdin: string) => {
    const mapper = new AppServerTurnMapper(createCodexEventContext(sessionId));
    return mapper.map({
      method: 'item/commandExecution/terminalInteraction',
      params: { threadId: 'th', turnId: 'tu', itemId: 'c1', processId: '7', stdin },
    });
  };

  it('is a notification of the turn', () => {
    expect(NOTIFICATION_DISPOSITION['item/commandExecution/terminalInteraction']).toBe('turn');
  });

  it.each([
    'curl -s https://example.com\n',
    'gh pr list\n',
    'import urllib.request; urllib.request.urlopen(u)\n',
  ])('marks the turn for %j', (stdin) => {
    const sessionId = fresh();
    expect(typed(sessionId, stdin)).toEqual([]);
    expect(marked(sessionId)).toBe(true);
  });

  it.each(['y\n', 'ls\n', 'print(1 + 1)\n'])('leaves %j unmarked', (stdin) => {
    const sessionId = fresh();
    expect(typed(sessionId, stdin)).toEqual([]);
    expect(marked(sessionId)).toBe(false);
  });
});

describe('the agent the marked turn acts as', () => {
  beforeEach(() => {
    registerTestHomes([AGENT]);
  });

  it('typing into a running command marks the agent, for callers that name only the agent', () => {
    const sessionId = fresh();
    outsideTextMarker('codex', sessionId, { cwd: AGENT });
    new AppServerTurnMapper(createCodexEventContext(sessionId)).map({
      method: 'item/commandExecution/terminalInteraction',
      params: { threadId: 'th', turnId: 'tu', itemId: 'c1', processId: '7', stdin: 'gh pr list\n' },
    });
    expect(agentMarked()).toBe(true);
  });

  it('a turn that ended no longer names the agent, and a running one is kept', () => {
    const ended = fresh();
    outsideTextMarker('codex', ended, { cwd: AGENT }).end();
    const running = fresh();
    outsideTextMarker('codex', running, { cwd: AGENT });
    for (let at = 0; at < 1_500; at += 1) outsideTextMarker('codex', fresh(), { cwd: AGENT });
    const type = (sessionId: string) =>
      new AppServerTurnMapper(createCodexEventContext(sessionId)).map({
        method: 'item/commandExecution/terminalInteraction',
        params: {
          threadId: 'th',
          turnId: 'tu',
          itemId: 'c1',
          processId: '7',
          stdin: 'gh pr list\n',
        },
      });
    type(ended);
    expect(marked(ended)).toBe(true);
    expect(agentMarked()).toBe(false);
    type(running);
    expect(agentMarked()).toBe(true);
  });

  it('a mark with no agent takes the agent a later mark in the turn names', () => {
    const sessionId = fresh();
    new AppServerTurnMapper(createCodexEventContext(sessionId)).map({
      method: 'item/commandExecution/terminalInteraction',
      params: { threadId: 'th', turnId: 'tu', itemId: 'c1', processId: '7', stdin: 'gh pr list\n' },
    });
    expect(marked(sessionId)).toBe(true);
    outsideTextMarker('codex', sessionId, { cwd: AGENT })({
      type: 'tool_call_start',
      data: { toolCallId: 'w1', toolName: 'WebSearch', input: '{}' },
    } as never);
    expect(agentMarked()).toBe(true);
  });

  it('a finished background command marks the agent its turn ran as', () => {
    const sessionId = fresh();
    const work = tracker();
    work.track([task(sessionId, 'curl -s https://example.com', AGENT)]);
    work.completionOf(commandDone(`cmd-${sessionId}`));
    expect(agentMarked()).toBe(true);
    work.dispose();
  });

  it('a command that cannot be judged marks', () => {
    const sessionId = fresh();
    markFinishedCommand(sessionId, { kind: 'bash', label: undefined as unknown as string });
    expect(marked(sessionId)).toBe(true);
  });
});

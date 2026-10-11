/**
 * What the `heartbeat` suite promises about ITSELF (DOR-2788), without a
 * model: which four cases exist, that none can gate or run on a free tier,
 * that none is swept into `core` (so `pnpm evals:local` never spends on them),
 * that each prompt is the real beat prompt, and that every oracle has a real
 * PASS and a real FAIL, so an always-pass oracle is caught.
 */
import { describe, expect, it } from 'vitest';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import { emptyApprovalLog, type OracleContext } from '../../types.js';
import { selectSuite } from '../index.js';
import {
  didNotAskToDoItsJob,
  endedTheBeat,
  firstEndBeat,
  heartbeatCases,
  nothingUrgent,
  stayedQuiet,
} from '../heartbeat.js';

/** An oracle context over some frames. */
function ctx(frames: SseFrame[]): OracleContext {
  return {
    sandbox: { projectCwd: '/unused', dorkHome: '/unused' },
    baseUrl: 'http://unused',
    sessionId: 's',
    frames,
    approvals: emptyApprovalLog(),
  } as OracleContext;
}

let ids = 0;

/** One tool call frame. */
function call(toolName: string, input: unknown): SseFrame {
  ids += 1;
  return {
    event: 'tool_call',
    data: { type: 'tool_call', toolCallId: `t${ids}`, toolName, input: JSON.stringify(input) },
  } as SseFrame;
}

const QUIET_END = call('mcp__dorkos__end_beat', { summary: 'Checked 2 things. Nothing new.' });
const ROUTINE_RAISE = call('mcp__dorkos__end_beat', {
  summary: 'Found 3 broken links.',
  raises: [{ text: 'Three broken links on the docs site.', rung: 'report' }],
});
const URGENT_RAISE = call('mcp__dorkos__end_beat', {
  summary: 'Found 3 broken links.',
  raises: [{ text: 'Broken links!', rung: 'dm', urgent: true }],
});
const NOTE_RAISE = call('mcp__dorkos__end_beat', {
  summary: 'Found 3 broken links.',
  raises: [{ text: 'Broken links.', rung: 'note' }],
});

describe('the heartbeat suite registry', () => {
  it('is reachable as `--suite heartbeat`, and holds canon §6.3’s four situations', () => {
    expect(selectSuite('heartbeat').map((c) => c.id)).toEqual([
      'heartbeat-nothing-changed',
      'heartbeat-overdue-invoice',
      'heartbeat-someone-elses-question',
      'heartbeat-late-night-finding',
    ]);
    for (const evalCase of heartbeatCases) {
      expect(selectSuite(evalCase.id).map((c) => c.id)).toEqual([evalCase.id]);
    }
  });

  it('is credentialed and quarantined, and never in `core`, so no default run spends on it', () => {
    const coreIds = selectSuite('core').map((c) => c.id);
    for (const evalCase of heartbeatCases) {
      expect(evalCase.runtimeTier, evalCase.id).toBe('claude-code-cheap');
      expect(evalCase.quarantined, evalCase.id).toBe(true);
      expect(evalCase.tags, evalCase.id).toEqual(['heartbeat']);
      expect(coreIds).not.toContain(evalCase.id);
    }
  });

  it('hands the model the real beat prompt, ending with end_beat', () => {
    for (const evalCase of heartbeatCases) {
      expect(evalCase.prompt, evalCase.id).toContain(
        'This is a heartbeat, not a message from a person.'
      );
      expect(evalCase.prompt, evalCase.id).toContain('`end_beat`');
      expect(evalCase.seed, evalCase.id).toBeTypeOf('function');
    }
  });
});

describe('the heartbeat oracles', () => {
  it('reads the first end_beat call and only the calls before it', () => {
    const frames = [
      call('mcp__dorkos__post_to_room', { roomId: 'r', text: 'hi' }),
      QUIET_END,
      call('mcp__dorkos__relay_notify_user', { message: 'after the refusal' }),
      ROUTINE_RAISE,
    ];
    const ended = firstEndBeat(frames)!;
    expect(ended.raises).toEqual([]);
    expect(ended.before.map((c) => c.toolName)).toEqual(['mcp__dorkos__post_to_room']);
    expect(firstEndBeat([call('mcp__dorkos__Read', {})])).toBeNull();
  });

  it('endedTheBeat passes on a summary and fails with none', async () => {
    expect((await endedTheBeat(ctx([QUIET_END]))).passed).toBe(true);
    expect((await endedTheBeat(ctx([]))).passed).toBe(false);
    expect((await endedTheBeat(ctx([call('end_beat', { raises: [] })]))).passed).toBe(false);
  });

  it('stayedQuiet fails on a raise or a post before the end, and ignores what follows a refusal', async () => {
    expect((await stayedQuiet(ctx([QUIET_END]))).passed).toBe(true);
    expect((await stayedQuiet(ctx([ROUTINE_RAISE]))).passed).toBe(false);
    expect(
      (await stayedQuiet(ctx([call('mcp__dorkos__post_to_room', { text: 'x' }), QUIET_END]))).passed
    ).toBe(false);
    expect(
      (await stayedQuiet(ctx([QUIET_END, call('mcp__dorkos__relay_notify_user', {})]))).passed
    ).toBe(true);
    expect((await stayedQuiet(ctx([]))).passed).toBe(false);
  });

  it('nothingUrgent passes a routine raise and fails an urgent one or a note', async () => {
    expect((await nothingUrgent(ctx([ROUTINE_RAISE]))).passed).toBe(true);
    expect((await nothingUrgent(ctx([QUIET_END]))).passed).toBe(true);
    expect((await nothingUrgent(ctx([URGENT_RAISE]))).passed).toBe(false);
    expect((await nothingUrgent(ctx([NOTE_RAISE]))).passed).toBe(false);
    expect((await nothingUrgent(ctx([]))).passed).toBe(false);
  });

  it('keeps the complete end_beat call when its arguments arrive in more than one frame', () => {
    const partial = {
      event: 'tool_call',
      data: { type: 'tool_call', toolCallId: 'tx', toolName: 'end_beat', input: '{"summ' },
    } as SseFrame;
    const early = {
      event: 'tool_call',
      data: {
        type: 'tool_call',
        toolCallId: 'tx',
        toolName: 'end_beat',
        input: JSON.stringify({ summary: 'Found it.' }),
      },
    } as SseFrame;
    const complete = {
      event: 'tool_call',
      data: {
        type: 'tool_call',
        toolCallId: 'tx',
        toolName: 'end_beat',
        input: JSON.stringify({ summary: 'Found it.', raises: [{ text: 'x', rung: 'dm' }] }),
      },
    } as SseFrame;
    expect(firstEndBeat([partial, early, complete])!.raises).toHaveLength(1);
  });

  it('didNotAskToDoItsJob fails a raise that asks permission, and passes a report of work', async () => {
    const raise = (text: string) =>
      call('end_beat', { summary: 'Sent it.', raises: [{ text, rung: 'report' }] });
    expect(
      (await didNotAskToDoItsJob(ctx([raise('Sent Acme the second reminder for #1042.')]))).passed
    ).toBe(true);
    expect((await didNotAskToDoItsJob(ctx([QUIET_END]))).passed).toBe(true);
    expect(
      (await didNotAskToDoItsJob(ctx([raise('Should I send Acme the second reminder?')]))).passed
    ).toBe(false);
    expect(
      (await didNotAskToDoItsJob(ctx([raise('Want me to chase Acme for #1042')]))).passed
    ).toBe(false);
    expect((await didNotAskToDoItsJob(ctx([raise('Send the reminder now?')]))).passed).toBe(false);
    expect((await didNotAskToDoItsJob(ctx([]))).passed).toBe(false);
  });

  it('puts the ask oracle on the overdue-invoice case', () => {
    const overdue = heartbeatCases.find((c) => c.id === 'heartbeat-overdue-invoice')!;
    expect(overdue.oracles).toContain(didNotAskToDoItsJob);
  });
});

/**
 * Tests for `dorkos debug` (`commands/debug.ts`).
 *
 * Argument parsing (including the subjects that need an id), the path each
 * subject reads, `--json` stdout purity so it pipes into `jq`, and the error
 * path — with the api-client mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api-client.js', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public body: { error?: string }
    ) {
      super(body.error ?? `HTTP ${status}`);
    }
  }
  return { ApiError, apiCall: vi.fn() };
});

import { ApiError, apiCall } from '../../lib/api-client.js';
import { parseDebugArgs, runDebug } from '../debug.js';

const apiCallMock = vi.mocked(apiCall);

let out: string[];
let errOut: string[];
/** Raw stdout writes — `printJson` goes straight there, not through console. */
let stdout: string[];

beforeEach(() => {
  out = [];
  errOut = [];
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errOut.push(args.map(String).join(' '));
  });
  apiCallMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseDebugArgs', () => {
  it('accepts the subjects that stand alone', () => {
    expect(parseDebugArgs(['dispatches'])).toEqual({ subject: 'dispatches', json: false });
    expect(parseDebugArgs(['projectors', '--json'])).toEqual({
      subject: 'projectors',
      json: true,
    });
  });

  it('accepts an id for the subjects that need one', () => {
    expect(parseDebugArgs(['session', 'abc'])).toEqual({
      subject: 'session',
      id: 'abc',
      json: false,
    });
  });

  it('refuses a subject that needs an id and was given none', () => {
    // Without this, `dorkos debug session` would request `/api/debug/sessions/`
    // and report an unhelpful 404 from three layers away.
    for (const subject of ['session', 'room', 'trace']) {
      expect(() => parseDebugArgs([subject])).toThrow(/needs an id/);
    }
  });

  it('refuses an unknown subject, an unknown option, and a bad limit', () => {
    expect(() => parseDebugArgs([])).toThrow(/needs a subject/);
    expect(() => parseDebugArgs(['everything'])).toThrow(/Unknown subject/);
    expect(() => parseDebugArgs(['dispatches', '--verbose'])).toThrow(/Unknown option/);
    expect(() => parseDebugArgs(['dispatches', '--limit', 'lots'])).toThrow(/positive number/);
    expect(() => parseDebugArgs(['dispatches', '--limit', '0'])).toThrow(/positive number/);
  });

  it('reads --limit as a number', () => {
    expect(parseDebugArgs(['refusals', '--limit', '20'])).toEqual({
      subject: 'refusals',
      limit: 20,
      json: false,
    });
  });
});

describe('runDebug', () => {
  it('reads the right path for each subject', async () => {
    const cases: Array<[string[], string]> = [
      [['dispatches'], '/api/debug/dispatches'],
      [['dispatches', '--limit', '5'], '/api/debug/dispatches?limit=5'],
      [['refusals', '--limit', '5'], '/api/debug/refusals?limit=5'],
      [['projectors'], '/api/debug/projectors'],
      [['phantoms'], '/api/debug/phantom-cancellations'],
      [['phantoms', '--limit', '5'], '/api/debug/phantom-cancellations?limit=5'],
      [['session', 's-1'], '/api/debug/sessions/s-1'],
      [['room', 'r-1'], '/api/debug/rooms/r-1/bindings'],
      [['trace', 'dsp_X'], '/api/debug/relay/traces/dsp_X'],
    ];
    for (const [argv, expected] of cases) {
      apiCallMock.mockResolvedValueOnce({});
      await runDebug(parseDebugArgs(argv));
      expect(apiCallMock).toHaveBeenLastCalledWith('GET', expected);
    }
  });

  it('escapes an id rather than pasting it into the path', async () => {
    apiCallMock.mockResolvedValueOnce({});
    await runDebug(parseDebugArgs(['room', 'a/../../etc/passwd']));
    expect(apiCallMock).toHaveBeenLastCalledWith(
      'GET',
      '/api/debug/rooms/a%2F..%2F..%2Fetc%2Fpasswd/bindings'
    );
  });

  it('prints a table of live claims and recent dispatches', async () => {
    apiCallMock.mockResolvedValueOnce({
      claims: [
        {
          roomId: 'room-1',
          authorId: 'ana',
          entryId: 'e1',
          dispatchId: 'dsp_A',
          claimedAt: '2026-08-01T00:00:00.000Z',
          heldMs: 125_000,
          pastDeadline: true,
        },
      ],
      recent: [
        {
          dispatchId: 'dsp_A',
          origin: 'room',
          startedAt: '2026-08-01T00:00:00.000Z',
          endedAt: null,
          outcome: null,
        },
      ],
    });
    expect(await runDebug(parseDebugArgs(['dispatches']))).toBe(0);
    const printed = out.join('\n');
    expect(printed).toContain('ana');
    expect(printed).toContain('dsp_A');
    expect(printed).toContain('late');
    // A dispatch with no outcome yet reads as running, not as an empty cell.
    expect(printed).toContain('running');
  });

  it('says so in plain words when there is nothing to show', async () => {
    apiCallMock.mockResolvedValueOnce({ claims: [], recent: [] });
    await runDebug(parseDebugArgs(['dispatches']));
    expect(out.join('\n')).toContain('No agent is mid-turn right now.');
  });

  /** The tripwire payload, as the server's stats reader shapes it. */
  const phantomPayload = {
    total: 3,
    batches: 2,
    byPath: { turn: 1, pump: 2 },
    mainThread: 1,
    subagent: 2,
    steered: 1,
    sessions: 2,
    since: '2026-08-17T01:00:00.000Z',
    recent: [
      {
        at: '2026-08-17T01:02:00.000Z',
        sessionId: 'sess-b',
        path: 'pump',
        toolUseIds: ['toolu_1', 'toolu_2'],
        mainThread: false,
        parentToolUseId: 'toolu_task_9',
        steered: false,
      },
      {
        at: '2026-08-17T01:01:00.000Z',
        sessionId: 'sess-a',
        path: 'turn',
        toolUseIds: ['toolu_0'],
        mainThread: true,
        parentToolUseId: null,
        steered: true,
      },
    ],
  };

  it('summarises phantoms by path and tables the recent batches', async () => {
    apiCallMock.mockResolvedValueOnce(phantomPayload);
    expect(await runDebug(parseDebugArgs(['phantoms']))).toBe(0);
    const printed = out.join('\n');

    // The two-line summary: the totals, then the split that IS the measurement.
    expect(printed).toContain('3 tool calls cut short in 2 batches, 2 sessions');
    expect(printed).toContain('since 2026-08-17T01:00:00.000Z');
    expect(printed).toContain('turn 1 · pump 2 · main thread 1 · inside helpers 2 · 1 corrected');

    // The table: one row per batch, counting CALLS rather than listing ids.
    expect(printed).toContain('WHEN');
    expect(printed).toContain('CALLS');
    expect(printed).toMatch(/2026-08-17T01:02:00\.000Z\s+pump\s+2\s+toolu_task_9\s+no\s+sess-b/);
    // A main-thread batch names the thread, not a parent task it does not have.
    expect(printed).toMatch(/2026-08-17T01:01:00\.000Z\s+turn\s+1\s+main\s+yes\s+sess-a/);
  });

  it('says so in plain words when the tripwire has never fired', async () => {
    apiCallMock.mockResolvedValueOnce({
      ...phantomPayload,
      total: 0,
      batches: 0,
      byPath: { turn: 0, pump: 0 },
      recent: [],
    });
    await runDebug(parseDebugArgs(['phantoms']));
    const printed = out.join('\n');
    expect(printed).toContain('No work has been cut short since 2026-08-17T01:00:00.000Z.');
    // Zero is the expected reading, so it must not arrive as a table of zeros.
    expect(printed).not.toContain('WHEN');
  });

  it('keeps --json raw for phantoms, so it pipes into jq', async () => {
    apiCallMock.mockResolvedValueOnce(phantomPayload);
    expect(await runDebug(parseDebugArgs(['phantoms', '--json']))).toBe(0);
    expect(out).toHaveLength(0);
    expect(JSON.parse(stdout[0])).toEqual(phantomPayload);
  });

  it('prints only JSON with --json, so it pipes into jq', async () => {
    const payload = { refusals: [{ at: 'now', reason: 'agent_busy', visibility: 'damped' }] };
    apiCallMock.mockResolvedValueOnce(payload);
    expect(await runDebug(parseDebugArgs(['refusals', '--json']))).toBe(0);
    // Nothing on `console.log`: a stray human line would break `| jq`.
    expect(out).toHaveLength(0);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0])).toEqual(payload);
  });

  it('reports a failure on stderr and exits non-zero', async () => {
    apiCallMock.mockRejectedValueOnce(new ApiError(404, { error: 'Not found' }));
    expect(await runDebug(parseDebugArgs(['session', 'nope']))).toBe(1);
    expect(errOut.join('\n')).toContain('Not found');
    expect(out).toHaveLength(0);
  });
});

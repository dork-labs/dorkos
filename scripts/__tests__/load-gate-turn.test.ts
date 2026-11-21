/**
 * The pure parts of the repo's turn in the app's line (DOR-4209,
 * `scripts/load-gate/turn.ts`): what a ticket is labelled, which settings win,
 * how ancestry is read, and what runs. The line itself, over the server's real
 * queue, is `scripts/test-load-gate-turn.sh`.
 */
import { describe, expect, it } from 'vitest';
import {
  ancestorsFrom,
  configPath,
  invocation,
  parentMap,
  programWord,
  turnSettings,
  type ParsedLoadGate,
} from '../load-gate/turn.ts';

const SHIPPED: ParsedLoadGate = {
  enabled: true,
  slots: 1,
  maxLoad: 16,
  maxWaitMinutes: 60,
  hardCapMinutes: 240,
};

describe('programWord', () => {
  it('labels a dotenv-wrapped run by the program after its --', () => {
    expect(programWord(['dotenv', '--', 'turbo', 'build'])).toBe('turbo');
    expect(programWord(['dotenv', '-e', '.env.local', '--', 'pnpm', 'test'])).toBe('pnpm');
  });

  it('skips env and leading assignments, never labelling by what they say', () => {
    expect(programWord(['env', 'SECRET=/private/branch', 'sleep', '1'])).toBe('sleep');
    expect(programWord(['NODE_OPTIONS=--max-old-space-size=8192', 'turbo', 'run'])).toBe('turbo');
  });

  it('keeps a plain program, and a lone word even if it looks like an assignment', () => {
    expect(programWord(['tsc', '--noEmit'])).toBe('tsc');
    expect(programWord(['A=1'])).toBe('A=1');
    expect(programWord(['dotenv', 'turbo'])).toBe('dotenv');
  });
});

describe('turnSettings', () => {
  it('takes the app settings as they are', () => {
    expect(turnSettings(SHIPPED, {})).toEqual({
      enabled: true,
      slots: 1,
      maxLoad: 16,
      hardCapMs: 240 * 60_000,
    });
  });

  it('reads a hard cap below the notice as the notice, like the server', () => {
    expect(turnSettings({ ...SHIPPED, hardCapMinutes: 5 }, {}).hardCapMs).toBe(60 * 60_000);
  });

  it('lets this run override slots, a decimal max load and the cap as given', () => {
    const settings = turnSettings(SHIPPED, {
      DORKOS_LOAD_GATE_SLOTS: '3',
      DORKOS_LOAD_GATE_MAX_LOAD: '12.5',
      DORKOS_LOAD_GATE_HARD_CAP_MINUTES: '1',
    });
    expect(settings).toMatchObject({ slots: 3, maxLoad: 12.5, hardCapMs: 60_000 });
  });

  it('ignores overrides that are not positive numbers', () => {
    const settings = turnSettings(SHIPPED, {
      DORKOS_LOAD_GATE_SLOTS: '0',
      DORKOS_LOAD_GATE_MAX_LOAD: 'busy',
      DORKOS_LOAD_GATE_HARD_CAP_MINUTES: '-4',
    });
    expect(settings).toMatchObject({ slots: 1, maxLoad: 16, hardCapMs: 240 * 60_000 });
  });
});

describe('configPath', () => {
  it('reads DORK_HOME first, else the installed app’s folder', () => {
    expect(configPath({ DORK_HOME: '/data/dork' })).toBe('/data/dork/config.json');
    expect(configPath({})).toMatch(/[/\\]\.dork[/\\]config\.json$/);
  });
});

describe('ancestry', () => {
  const parents = parentMap(' 1     0\n  40    1\n 300   40\n4000  300\nnot a line\n');

  it('follows the chain to the top', () => {
    expect([...ancestorsFrom(4000, parents)!]).toEqual([4000, 300, 40]);
  });

  it('is unknown when a pid on the way is not listed', () => {
    expect(ancestorsFrom(5000, parents)).toBeNull();
  });

  it('is unknown when the chain loops', () => {
    expect(
      ancestorsFrom(
        7,
        new Map([
          [7, 8],
          [8, 7],
        ])
      )
    ).toBeNull();
  });
});

describe('invocation', () => {
  it('runs the wrapper again inside the turn, labelled by the job', () => {
    const call = invocation(
      [
        '--wrap',
        '/repo/scripts/heavy-run-lock.sh',
        '--tests',
        '--',
        'dotenv',
        '--',
        'turbo',
        'test',
      ],
      { DORKOS_LOAD_GATE_TURN_FILE: '/tmp/turn', KEEP: 'yes' }
    )!;
    expect(call.command).toEqual(['dotenv', '--', 'turbo', 'test']);
    expect(call.run).toEqual([
      'bash',
      '/repo/scripts/heavy-run-lock.sh',
      '--tests',
      'dotenv',
      '--',
      'turbo',
      'test',
    ]);
    expect(call.env.DORKOS_LOAD_GATE_IN_TURN).toBe('1');
    // The inner copy must take the repo's slot, so it is not told one is held.
    expect(call.env.DORKOS_HEAVY_SLOT_HELD).toBeUndefined();
    expect(call.env.DORKOS_LOAD_GATE_TURN_FILE).toBeUndefined();
    expect(call.env.KEEP).toBe('yes');
  });

  it('runs a bare command as holding the slot', () => {
    const call = invocation(['--', 'sleep', '1'], { DORKOS_LOAD_GATE_TURN_FILE: '/tmp/turn' })!;
    expect(call.run).toEqual(['sleep', '1']);
    expect(call.env.DORKOS_HEAVY_SLOT_HELD).toBe('1');
    expect(call.env.DORKOS_LOAD_GATE_TURN_FILE).toBeUndefined();
  });

  it('refuses no command', () => {
    expect(invocation(['--'], {})).toBeNull();
  });
});

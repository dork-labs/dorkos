import { describe, expect, it, vi } from 'vitest';
import {
  confirmAnchor,
  createAnchorPolicy,
  createControlReader,
  createControlWriter,
  observeClosedGroup,
  observeLinuxIdentity,
} from '../run-custody/posix/index.mjs';

const secret = '12'.repeat(32);
const channel = '34'.repeat(16);
const direction = 'guardian-to-anchor' as const;

describe('private POSIX anchor protocol', () => {
  it('authenticates ordered segmented messages and rejects replay and wrong direction', () => {
    const writer = createControlWriter(secret, channel, direction);
    const delivered = vi.fn();
    const reader = createControlReader(secret, channel, direction, delivered);
    const first = writer('start', { env: { TOKEN: 'synthetic' } });
    reader.push(first.subarray(0, 3));
    reader.push(first.subarray(3, 38));
    expect(delivered).not.toHaveBeenCalled();
    reader.push(first.subarray(38));
    reader.push(writer('stop', { deadline: 100 }));
    expect(delivered.mock.calls).toEqual([
      ['start', { env: { TOKEN: 'synthetic' } }],
      ['stop', { deadline: 100 }],
    ]);
    expect(() => reader.push(first)).toThrow(/Invalid private POSIX control frame/);
    const wrongDirection = createControlReader(secret, channel, 'anchor-to-guardian', delivered);
    expect(() => wrongDirection.push(first)).toThrow(/Invalid private POSIX control frame/);
    const truncated = createControlReader(secret, channel, direction, delivered);
    truncated.push(first.subarray(0, -1));
    expect(() => truncated.end()).toThrow(/Invalid private POSIX control frame/);
    expect(delivered).toHaveBeenCalledTimes(2);
  });

  it('keeps cleanup bounded to fixed grace and only signals via the current-group handle', async () => {
    const signalCurrentGroup = vi.fn();
    const leave = vi.fn();
    let at!: () => void;
    const schedule = vi.fn((_: number, callback: () => void) => {
      at = callback;
      return vi.fn();
    });
    const policy = createAnchorPolicy({
      now: () => 100,
      schedule,
      signalCurrentGroup,
      leave,
      observeMembers: () => 'members-or-unknown',
    });
    expect(policy.authorize()).toBe(true);
    expect(policy.stop({ graceMs: 3_000, deadline: 200 })).toBe(true);
    expect(policy.stop({ graceMs: 3_000, deadline: 500 })).toBe(false);
    expect(schedule).toHaveBeenCalledExactlyOnceWith(200, expect.any(Function));
    expect(signalCurrentGroup.mock.calls).toEqual([['SIGTERM']]);
    at();
    at();
    expect(signalCurrentGroup.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(leave).not.toHaveBeenCalled();
  });

  it('does not signal before authorization and allows only a positive anchor-alone result to end grace', async () => {
    const signal = vi.fn();
    const leave = vi.fn();
    const cancel = vi.fn();
    const schedule = vi.fn((_deadline: number, _callback: () => void) => cancel);
    const options = {
      now: () => 100,
      schedule,
      signalCurrentGroup: signal,
      leave,
      observeMembers: () => 'anchor-alone' as const,
    };
    const earlyLoss = createAnchorPolicy(options);
    expect(earlyLoss.stop({ graceMs: 3_000, deadline: 1_000 })).toBe(true);
    expect(earlyLoss.authorize()).toBe(false);
    expect(signal).not.toHaveBeenCalled();
    expect(leave).toHaveBeenCalledWith('never-started');
    const running = createAnchorPolicy(options);
    expect(running.authorize()).toBe(true);
    expect(running.stop({ graceMs: 3_000, deadline: 4_000 })).toBe(true);
    await vi.waitFor(() => expect(leave).toHaveBeenCalledWith('drained'));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(signal.mock.calls).toEqual([['SIGTERM']]);
  });

  it('does not fabricate command image identity or confirm reused/unknown groups', async () => {
    const stat = (birth: string) => {
      const fields = ['S', '11', '22', '22', ...Array(15).fill('0'), birth];
      return `22 (requested wrapper) ${fields.join(' ')}`;
    };
    const read = vi
      .fn<NonNullable<Parameters<typeof observeLinuxIdentity>[1]>>()
      .mockResolvedValue(stat('911'));
    const image = vi.fn(async (_path: string) => '/fixture/actual-image');
    const actual = await observeLinuxIdentity(22, read, image);
    expect(actual).toEqual({
      pid: 22,
      parent: 11,
      group: 22,
      session: 22,
      birth: '911',
      executable: '/fixture/actual-image',
    });
    expect(image).toHaveBeenCalledExactlyOnceWith('/proc/22/exe');
    read.mockResolvedValueOnce(stat('911')).mockResolvedValueOnce(stat('912'));
    expect(await observeLinuxIdentity(22, read, image)).toBeUndefined();

    const anchor = confirmAnchor(actual, 22, 11);
    expect(anchor).toEqual({ pid: 22, group: 22, birth: '911' });
    const query = vi.fn<Parameters<typeof observeClosedGroup>[2]>().mockReturnValue('absent');
    expect(observeClosedGroup(anchor, false, query)).toBe('cleanup-uncertain');
    expect(observeClosedGroup(confirmAnchor(actual, 22, 16), true, query)).toBe(
      'cleanup-uncertain'
    );
    expect(query).not.toHaveBeenCalled();
    expect(observeClosedGroup(anchor, true, query)).toBe('cleaned-owned');
    query.mockReturnValue('present');
    expect(observeClosedGroup(anchor, true, query)).toBe('cleanup-uncertain');
  });
});

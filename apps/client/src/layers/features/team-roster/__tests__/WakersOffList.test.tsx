/**
 * @vitest-environment jsdom
 *
 * The team page's line for every schedule and heartbeat that is switched off or
 * waiting (DOR-3641): "off since {time}, waiting on {person}".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { WakerOff } from '@dorkos/shared/waker-schemas';
import { WakersOffList, sinceWords, wakerStatus } from '../ui/WakersOffList';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function waker(overrides: Partial<WakerOff> = {}): WakerOff {
  return {
    kind: 'schedule',
    id: 'task-1',
    name: 'Nightly sweep',
    agentId: 'agent-1',
    state: 'off',
    offSince: null,
    waitingOn: { accountId: 'owner', name: 'Dorian' },
    ...overrides,
  };
}

describe('WakersOffList', () => {
  it('draws nothing while every waker is on', () => {
    const { container } = render(<WakersOffList wakers={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('gives each waker one line: what it is, since when, and who it waits on', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 15, 12, 0));
    render(
      <WakersOffList
        wakers={[
          waker({ offSince: new Date(2026, 10, 2, 9, 0).toISOString() }),
          waker({
            kind: 'heartbeat',
            id: 'agent-2',
            name: 'Scout',
            agentId: 'agent-2',
            waitingOn: { accountId: 'p2', name: null },
          }),
        ]}
      />
    );

    const lines = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(lines[0]).toHaveTextContent('Nightly sweepOff since Nov 2, 9:00 am, waiting on Dorian.');
    expect(lines[1]).toHaveTextContent('Scout’s heartbeatOff, waiting on a person.');
    expect(screen.getByRole('heading', { name: 'Off or waiting' })).toBeInTheDocument();
  });

  it('names a paused agent as an agent, not as a schedule', () => {
    render(
      <WakersOffList
        wakers={[
          waker({ kind: 'heartbeat', id: 'a', name: 'Atlas', agentId: 'a', state: 'paused' }),
        ]}
      />
    );
    expect(screen.getByRole('listitem')).toHaveTextContent(
      'Atlas (agent)Paused, waiting on Dorian.'
    );
  });

  it('says why after the time, so a later park never relabels when it stopped', () => {
    // Switched off Nov 2, parked for approval Nov 9: off_since keeps Nov 2.
    const since = new Date(2026, 10, 2, 9, 0).toISOString();
    expect(wakerStatus(waker({ state: 'waiting', offSince: since }))).toBe(
      'Off since Nov 2, 9:00 am, needs approval from Dorian.'
    );
    expect(wakerStatus(waker({ state: 'paused' }))).toBe(
      'Off, its file is missing, waiting on Dorian.'
    );
    expect(wakerStatus(waker({ kind: 'heartbeat', state: 'paused', offSince: since }))).toBe(
      'Paused since Nov 2, 9:00 am, waiting on Dorian.'
    );
  });

  it('writes one absolute date and time, even just after midnight', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // 2:00 am, three hours after the waker stopped late the day before.
    vi.setSystemTime(new Date(2026, 10, 15, 2, 0));
    expect(sinceWords(new Date(2026, 10, 14, 23, 40).toISOString())).toBe('Nov 14, 11:40 pm');
    // Earlier today reads the same way, never "3h ago".
    vi.setSystemTime(new Date(2026, 10, 14, 23, 59));
    expect(sinceWords(new Date(2026, 10, 14, 20, 5).toISOString())).toBe('Nov 14, 8:05 pm');
  });
});

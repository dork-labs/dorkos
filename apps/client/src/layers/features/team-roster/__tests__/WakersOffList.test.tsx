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
import { WakersOffList, wakerStatus } from '../ui/WakersOffList';

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
    expect(lines[0]).toHaveTextContent('Nightly sweepOff since Nov 2, 9 am, waiting on Dorian.');
    expect(lines[1]).toHaveTextContent('Scout’s heartbeatOff, waiting on a person.');
    expect(screen.getByRole('heading', { name: 'Off or waiting' })).toBeInTheDocument();
  });

  it('says why: waiting for approval, or paused', () => {
    expect(wakerStatus(waker({ state: 'waiting' }))).toBe('Needs approval, waiting on Dorian.');
    expect(wakerStatus(waker({ state: 'paused' }))).toBe('Paused, waiting on Dorian.');
  });
});

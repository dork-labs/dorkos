/**
 * @vitest-environment jsdom
 */
/**
 * The Heartbeat page's measures (spec `heartbeats` §13, §10 PR 6: "the page
 * renders every state, including no beats yet"): no checks yet, checks with
 * nothing to count, real numbers beside their targets, and the supporting
 * measures behind "Supporting measures".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyHeartbeatMeasures } from '@dorkos/test-utils';
import type { HeartbeatMeasures as Measures } from '@dorkos/shared/heartbeat-schemas';
import { HeartbeatMeasures } from '../ui/heartbeat/HeartbeatMeasures';

afterEach(cleanup);

/** Measures with some beats and the given overrides. */
function measured(overrides: Partial<Measures> = {}): Measures {
  const base = emptyHeartbeatMeasures();
  return { ...base, supporting: { ...base.supporting, beats: 20 }, ...overrides };
}

/** One measure row by its label. */
function row(label: string): HTMLElement {
  return screen.getByText(label).closest('[data-slot="heartbeat-measure"]') as HTMLElement;
}

describe('HeartbeatMeasures', () => {
  it('says there is nothing to measure before the first check', () => {
    render(<HeartbeatMeasures measures={emptyHeartbeatMeasures()} />);
    expect(screen.getByText('No checks yet. Measures start after the first.')).toBeInTheDocument();
    expect(screen.queryByText('Work that stuck')).not.toBeInTheDocument();
  });

  it('says a rate has nothing to count yet rather than showing 0%', () => {
    render(<HeartbeatMeasures measures={measured()} />);
    expect(within(row('Work that stuck')).getByText('Nothing to count yet')).toBeInTheDocument();
    expect(within(row('Useful messages')).getByText('Nothing to count yet')).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(within(row('Surprises')).getByText('Not measured yet')).toBeInTheDocument();
    expect(
      screen.getByText('Last 7 days. Targets are starting points, not grades.')
    ).toBeInTheDocument();
  });

  it('shows each number with how it was counted, its target and its source', () => {
    const base = emptyHeartbeatMeasures();
    render(
      <HeartbeatMeasures
        measures={measured({
          keptRate: {
            ...base.keptRate,
            value: 11 / 12,
            part: 11,
            whole: 12,
            source: 'From stops.',
          },
          usefulRaiseRate: { ...base.usefulRaiseRate, value: 0.75, part: 3, whole: 4 },
          interruptions: { ...base.interruptions, value: 0.4285, messages: 6, usefulOutcomes: 14 },
          mutesAndPauses: { ...base.mutesAndPauses, total: 3, pauses: 1, wakeOff: 0, mutes: 2 },
        })}
      />
    );
    const kept = row('Work that stuck');
    expect(within(kept).getByText('92%')).toBeInTheDocument();
    expect(within(kept).getByText('11 of 12')).toBeInTheDocument();
    expect(within(kept).getByText('Target 95% or more')).toBeInTheDocument();
    expect(within(kept).getByText('From stops.')).toBeInTheDocument();
    expect(within(row('Useful messages')).getByText('75%')).toBeInTheDocument();
    const interruptions = row('Interruptions per useful outcome');
    expect(within(interruptions).getByText('0.4')).toBeInTheDocument();
    expect(within(interruptions).getByText('6 sent, 14 useful')).toBeInTheDocument();
    expect(within(interruptions).getByText('Target 1 or less')).toBeInTheDocument();
    const mutes = row('Mutes and pauses');
    expect(within(mutes).getByText('3')).toBeInTheDocument();
    expect(within(mutes).getByText('1 pause, 2 mutes')).toBeInTheDocument();
    expect(within(mutes).getByText('Target trending to 0')).toBeInTheDocument();
  });

  it('keeps the supporting measures behind one disclosure', async () => {
    const base = emptyHeartbeatMeasures();
    render(
      <HeartbeatMeasures
        measures={measured({
          supporting: {
            ...base.supporting,
            beats: 20,
            quietBeats: { ...base.supporting.quietBeats, value: 0.85, part: 17, whole: 20 },
            noEndBeat: 1,
            triage: { checks: 41, tokens: 18_400 },
            turns: { count: 3, tokensPerTurn: 2_000 },
            bypass: 2,
            held: 1,
          },
        })}
      />
    );
    expect(screen.queryByText('Quiet checks: 85%, 17 of 20.')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Supporting measures' }));
    const list = screen.getByRole('list', { name: 'Supporting measures' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      'Quiet checks: 85%, 17 of 20.',
      'No promises came due.',
      'Ended without a summary: 1.',
      'Cheap checks: 41, 18,400 tokens.',
      'Full runs: 3, about 2,000 tokens each.',
      'Posted outside a check’s summary: 2.',
      'Held for people’s hours: 1.',
    ]);
  });
});

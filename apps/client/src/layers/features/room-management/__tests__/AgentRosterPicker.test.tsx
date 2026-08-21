// @vitest-environment jsdom
/**
 * Three states, three different things on screen.
 *
 * The defect this exists against: a failed mesh read left `candidates` empty,
 * and an empty list was rendered as "You have not added any agents yet" — to
 * somebody with three agents, beside a roster drawing their faces, with nothing
 * to press. An error state that asserts something false about the person's own
 * account is worse than a spinner, because a spinner is at least honest about
 * not knowing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AgentPickerCandidate, AgentRoster } from '@/layers/entities/agent';
import { AgentRosterPicker } from '../ui/AgentRosterPicker';

afterEach(cleanup);

const ANA: AgentPickerCandidate = {
  agentPath: '/w/ana',
  displayName: 'Ana',
  visual: null,
  description: null,
};
const KAI: AgentPickerCandidate = {
  agentPath: '/w/kai',
  displayName: 'Kai',
  visual: null,
  description: null,
};

/** The copy the picker shows a person who genuinely has no agents. */
const EMPTY_COPY = 'You have not added any agents yet.';

function renderPicker(
  roster: AgentRoster,
  extra: { exclude?: (c: AgentPickerCandidate) => boolean } = {}
) {
  const onSubmit = vi.fn();
  render(
    <AgentRosterPicker
      roster={roster}
      onSubmit={onSubmit}
      submitLabel={(chosen) => `Commit ${chosen.length}`}
      emptyRosterMessage={EMPTY_COPY}
      allChosenMessage="All chosen."
      {...extra}
    />
  );
  return onSubmit;
}

describe('AgentRosterPicker states', () => {
  it('offers the agents once the roster has actually been read', () => {
    renderPicker({ candidates: [ANA, KAI], isLoading: false, isError: false, retry: vi.fn() });

    expect(screen.getByLabelText('Search agents')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Ana' })).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says nothing about the account while it is still reading it', () => {
    const { container } = render(
      <AgentRosterPicker
        roster={{ candidates: [], isLoading: true, isError: false, retry: vi.fn() }}
        onSubmit={vi.fn()}
        submitLabel={(chosen) => `Commit ${chosen.length}`}
        emptyRosterMessage={EMPTY_COPY}
        allChosenMessage="All chosen."
      />
    );

    // The claim a reader would have to un-believe a moment later.
    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();
    // And no field to type a question into that nothing can answer yet.
    expect(screen.queryByLabelText('Search agents')).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy]')).not.toBeNull();
    expect(screen.getByText('Reading your agents…')).toHaveClass('sr-only');
  });

  it('says the read FAILED, never that the account is empty, and offers a way on', () => {
    // The whole finding, in one assertion pair: this person has agents. The
    // roster could not be read. Those are different sentences.
    const retry = vi.fn();
    renderPicker({ candidates: [], isLoading: false, isError: true, retry });

    expect(screen.queryByText(EMPTY_COPY)).not.toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/Couldn't read your agents/i);
    expect(alert).toHaveTextContent(/still there/i);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('is the ONLY state that says the account is empty', () => {
    renderPicker({ candidates: [], isLoading: false, isError: false, retry: vi.fn() });

    expect(screen.getByText(EMPTY_COPY)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leaves out whoever is already in the room, without calling that a failure', () => {
    renderPicker(
      { candidates: [ANA, KAI], isLoading: false, isError: false, retry: vi.fn() },
      { exclude: (c) => c.agentPath === ANA.agentPath }
    );

    expect(screen.getByRole('option', { name: 'Kai' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Ana' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

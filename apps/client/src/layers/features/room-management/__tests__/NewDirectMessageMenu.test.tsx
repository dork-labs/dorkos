// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useAgentCreationStore } from '@/layers/shared/model';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import { NewDirectMessageMenu } from '../ui/NewDirectMessageMenu';

/**
 * The fleet this panel reads for itself, mocked at the hook.
 *
 * The hook's own three-state behaviour is asserted in
 * `use-agent-picker-candidates.test.tsx`; what is under test here is what this
 * panel does with each answer.
 */
const { mockRosterRef } = vi.hoisted(() => ({ mockRosterRef: { current: null as unknown } }));
vi.mock('../model/use-agent-picker-candidates', () => ({
  useAgentPickerCandidates: () => mockRosterRef.current,
}));

/**
 * Stateful stand-in for the section that owns the picker's open state, which
 * the panel no longer holds itself — the section header's "New message…" opens
 * the same panel, so there is one owner and two ways in (spec `rooms` §14.1).
 */
function Harness({
  onStart,
  hideTrigger = false,
}: {
  onStart: (chosen: AgentPickerCandidate[]) => void;
  hideTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <NewDirectMessageMenu
      open={open}
      onOpenChange={setOpen}
      onStart={onStart}
      hideTrigger={hideTrigger}
    />
  );
}

function renderMenu(candidates: AgentPickerCandidate[]) {
  mockRosterRef.current = { candidates, isLoading: false, isError: false, retry: vi.fn() };
  const onStart = vi.fn();
  render(<Harness onStart={onStart} />);
  fireEvent.click(screen.getByRole('button', { name: 'New message' }));
  return { onStart };
}

// Radix drives its own pointer capture and scrolls things into view — both
// browser APIs jsdom does not implement, and without them nothing opens.
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  // A real store, shared by the whole module graph — left open it would leak
  // into the next test's assertion about it.
  useAgentCreationStore.setState({ isOpen: false, seed: null, onCreated: null });
});
afterEach(cleanup);

describe('NewDirectMessageMenu', () => {
  it('offers the agents there are', () => {
    renderMenu([{ agentPath: '/w/ana', displayName: 'Ana', visual: null, description: null }]);

    expect(screen.getByRole('option', { name: 'Ana' })).toBeInTheDocument();
  });

  it('answers an empty fleet with the button rather than with an instruction', () => {
    // "Add one to start a direct message with it" is a next step made out of a
    // person: it names something to go and find, and then leaves. The room
    // sheet stopped doing that and this panel did not — same defect, same
    // picker. Red if the way out goes, or if the sentence goes back to telling
    // somebody to do it themselves.
    renderMenu([]);

    expect(screen.getByText('You have not added any agents yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Add one to start/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create agent' })).toBeInTheDocument();
  });

  it('closes itself before opening the place agents are made', () => {
    // It is a modal popover, so it holds the focus scope; raising a dialog
    // inside one leaves two things claiming the keyboard. Red if the panel is
    // left open behind the creation dialog.
    renderMenu([]);

    fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));

    expect(useAgentCreationStore.getState().isOpen).toBe(true);
    expect(screen.queryByRole('button', { name: 'Create agent' })).not.toBeInTheDocument();
  });
});

describe('NewDirectMessageMenu as somebody else’s panel (hideTrigger)', () => {
  it('leaves no control behind — not a visible one, and not one only a reader meets', () => {
    // The sidebar's Agents header opens this panel from its own "+" menu while
    // BC-32 withholds the Direct messages section, so the panel needs an anchor
    // and not a second button. `sr-only` alone would have hidden it from SIGHT
    // and left it announced and focusable: a phantom "New message" offered to
    // exactly the readers who cannot see that it is a phantom.
    mockRosterRef.current = { candidates: [], isLoading: false, isError: false, retry: vi.fn() };
    render(<Harness onStart={vi.fn()} hideTrigger />);

    expect(screen.queryByRole('button', { name: 'New message' })).not.toBeInTheDocument();

    const anchor = document.querySelector('[data-sidebar="group-action"]');
    expect(anchor, 'the popover still needs something to hang off').not.toBeNull();
    expect(anchor).toHaveAttribute('aria-hidden', 'true');
    // Out of the tab order on its own account, rather than because the sidebar's
    // roving-focus hook happened to stamp it — this component does not know
    // whether it is inside one.
    expect(anchor).toHaveAttribute('tabindex', '-1');
  });

  it('is a real, named control when it owns its own "+"', () => {
    // The other half: the default must not quietly become unreachable.
    mockRosterRef.current = { candidates: [], isLoading: false, isError: false, retry: vi.fn() };
    render(<Harness onStart={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: 'New message' });
    expect(trigger).not.toHaveAttribute('aria-hidden');
    expect(trigger).not.toHaveAttribute('tabindex', '-1');
  });
});

/**
 * The one short row that asks (spec `flow-multiproject` V1, V8; DOR-2517):
 * three named icon buttons in a fixed order, an ⓘ that grows the row in place,
 * and the same row answered as history.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { Puzzle } from 'lucide-react';
import { InboxDecisionRow, type InboxDecisionRowProps } from '../ui/InboxDecisionRow';

const WHY = 'You installed the flow plugin. This adds a Flow tab. It runs as you.';

/** Render an approval-shaped row, overriding only what a case cares about. */
function renderRow(overrides: Partial<InboxDecisionRowProps> = {}) {
  const onApprove = vi.fn();
  const onReject = vi.fn();
  const utils = render(
    <InboxDecisionRow
      icon={Puzzle}
      title="Turn on Flow?"
      why={WHY}
      sourceLine="flow plugin · dork-labs/marketplace"
      more={<p>None of it has run yet.</p>}
      actions={{
        kind: 'yes-no',
        approveLabel: 'Turn it on',
        rejectLabel: 'Not now',
        onApprove,
        onReject,
      }}
      {...overrides}
    />
  );
  return { ...utils, onApprove, onReject };
}

afterEach(() => {
  cleanup();
});

describe('InboxDecisionRow', () => {
  it('says what it asks and why, and where it came from', () => {
    renderRow();

    expect(screen.getByText('Turn on Flow?')).toBeInTheDocument();
    expect(screen.getByText(WHY)).toBeInTheDocument();
    expect(screen.getByText('flow plugin · dork-labs/marketplace')).toBeInTheDocument();
  });

  it('names its three buttons as outcomes, in the order ⓘ, 👎, 👍', () => {
    renderRow();

    const names = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(names).toEqual(['More about this', 'Not now', 'Turn it on']);
  });

  it('grows in place when ⓘ is pressed, and keeps focus on ⓘ', async () => {
    const user = userEvent.setup();
    renderRow();
    const info = screen.getByRole('button', { name: 'More about this' });

    expect(info).toHaveAttribute('aria-expanded', 'false');
    expect(info).toHaveAttribute('aria-pressed', 'false');
    // It points at the panel only while there is one to point at.
    expect(info).not.toHaveAttribute('aria-controls');
    expect(screen.queryByText('None of it has run yet.')).not.toBeInTheDocument();

    await user.click(info);

    expect(info).toHaveAttribute('aria-expanded', 'true');
    expect(info).toHaveAttribute('aria-pressed', 'true');
    const panel = document.getElementById(info.getAttribute('aria-controls') ?? '');
    expect(panel).not.toBeNull();
    // In the row, not a popover: the panel lives inside the row itself.
    const row = info.closest('[data-slot="inbox-decision-row"]') as HTMLElement;
    expect(row.contains(panel)).toBe(true);
    expect(within(panel as HTMLElement).getByText('None of it has run yet.')).toBeInTheDocument();
    expect(info).toHaveFocus();

    await user.click(info);
    expect(info).toHaveAttribute('aria-expanded', 'false');
  });

  it('draws no ⓘ when there is nothing more to say', () => {
    renderRow({ more: undefined });
    expect(screen.queryByRole('button', { name: 'More about this' })).not.toBeInTheDocument();
  });

  it('calls approve for 👍 and reject for 👎, and nothing else', async () => {
    const user = userEvent.setup();
    const { onApprove, onReject } = renderRow();

    await user.click(screen.getByRole('button', { name: 'Turn it on' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('waits on an answer in flight', () => {
    renderRow({ pending: 'approve' });
    expect(screen.getByRole('button', { name: 'Turn it on' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeDisabled();
    // ⓘ still works: reading more is not an answer.
    expect(screen.getByRole('button', { name: 'More about this' })).toBeEnabled();
  });

  it('draws one small text button for a word answer', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderRow({ actions: { kind: 'word', label: 'Reconnect', onClick }, more: undefined });

    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('draws an answered row compactly, with its trail and no buttons', () => {
    render(
      <InboxDecisionRow
        icon={Puzzle}
        title="You turned on Flow"
        trail={['2:14pm', 'Flow tab added']}
      />
    );

    const row = document.querySelector('[data-slot="inbox-decision-row"]');
    expect(row).toHaveAttribute('data-history', 'true');
    expect(row).toHaveTextContent('You turned on Flow · 2:14pm · Flow tab added');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

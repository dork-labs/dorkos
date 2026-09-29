/**
 * The one short row that asks (spec `flow-multiproject` V1, V8; DOR-2517):
 * three named icon buttons in a fixed order, an ⓘ that grows the row in place,
 * and the same row answered as history.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, waitFor } from '@testing-library/react';
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
    // One state, said once: an expander is expanded, not pressed.
    expect(info).not.toHaveAttribute('aria-pressed');
    // It points at the panel only while there is one to point at.
    expect(info).not.toHaveAttribute('aria-controls');
    expect(screen.queryByText('None of it has run yet.')).not.toBeInTheDocument();

    await user.click(info);

    expect(info).toHaveAttribute('aria-expanded', 'true');
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

describe('InboxDecisionRow, phase 2 answers (spec flow-multiproject §7.5)', () => {
  it('opens a note field on 👎 when the decision asks for one, and sends the note', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { onReject } = renderRow({
      actions: {
        kind: 'yes-no',
        approveLabel: 'Looks good',
        rejectLabel: 'Needs changes',
        onApprove: vi.fn(),
        onReject: vi.fn(),
        rejectNote: { onSubmit },
      },
    });
    await user.click(screen.getByLabelText('Needs changes'));
    expect(onReject).not.toHaveBeenCalled();
    const field = screen.getByLabelText('What needs to change?');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(field, '  Use the calmer red.  ');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledWith('Use the calmer red.');
  });

  it('shows a counter near the note’s limit and cancels without sending', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderRow({
      actions: {
        kind: 'word',
        label: 'Answer',
        onClick: vi.fn(),
        input: { placeholder: 'Your answer', maxLength: 10, onSubmit },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    await user.type(screen.getByLabelText('Answer'), 'abcdefghijKL');
    expect(screen.getByText('10/10')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Answer', { selector: 'textarea' })).not.toBeInTheDocument();
  });

  it('draws a question’s chips with the agent’s pick marked, its deadline, and "Reply…"', async () => {
    const user = userEvent.setup();
    const onChoose = vi.fn();
    const onReply = vi.fn();
    renderRow({
      title: 'Should the old API keep working?',
      more: undefined,
      actions: {
        kind: 'choice',
        choices: [
          { id: 'keep', label: 'Keep it' },
          { id: 'remove', label: 'Remove it' },
        ],
        defaultChoiceId: 'keep',
        deadlineLine: 'If you don’t answer by 5pm, the agent picks “Keep it”.',
        allowReply: true,
        onChoose,
        onReply,
      },
    });
    expect(screen.getByRole('button', { name: /Keep it.*agent’s pick/ })).toBeInTheDocument();
    expect(
      screen.getByText('If you don’t answer by 5pm, the agent picks “Keep it”.')
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove it' }));
    expect(onChoose).toHaveBeenCalledWith('remove');
    await user.click(screen.getByRole('button', { name: 'Reply…' }));
    await user.type(screen.getByLabelText('Your reply'), 'Keep it until Friday.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onReply).toHaveBeenCalledWith('Keep it until Friday.');
  });

  it('draws the one-time follow-up offer as a line with Yes and a quiet no', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    const onDismiss = vi.fn();
    render(
      <InboxDecisionRow
        icon={Puzzle}
        title="Ship the banner?"
        trail={['Ship it · you at 2:14pm']}
        followUp={{ text: 'Shipped. Next time, ship on its own?', onAccept, onDismiss }}
        watch={{ label: 'Sorting 12 ideas…', onWatch: vi.fn() }}
      />
    );
    expect(screen.getByText('Shipped. Next time, ship on its own?')).toBeInTheDocument();
    expect(screen.getByText(/Sorting 12 ideas…/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'No thanks' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('marks an unseen history row', () => {
    render(<InboxDecisionRow icon={Puzzle} title="Shipped the calmer red" unread />);
    expect(screen.getByText('Unread.')).toBeInTheDocument();
  });
});

describe('InboxDecisionRow, answers that must go through (client review 3, 6)', () => {
  it('keeps the note and its text open when sending fails, and closes it when it works', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    renderRow({
      actions: {
        kind: 'yes-no',
        approveLabel: 'Looks good',
        rejectLabel: 'Needs changes',
        onApprove: vi.fn(),
        onReject: vi.fn(),
        rejectNote: { onSubmit },
      },
    });
    await user.click(screen.getByLabelText('Needs changes'));
    await user.type(screen.getByLabelText('What needs to change?'), 'Use the calmer red.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/didn’t go through/);
    expect(screen.getByLabelText('What needs to change?')).toHaveValue('Use the calmer red.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText('What needs to change?')).not.toBeInTheDocument();
  });

  it('sends focus back to 👎 on Cancel', async () => {
    const user = userEvent.setup();
    renderRow({
      actions: {
        kind: 'yes-no',
        approveLabel: 'Looks good',
        rejectLabel: 'Needs changes',
        onApprove: vi.fn(),
        onReject: vi.fn(),
        rejectNote: { onSubmit: vi.fn() },
      },
    });
    await user.click(screen.getByLabelText('Needs changes'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByLabelText('Needs changes')).toHaveFocus());
  });

  it('keeps a draft when the row is drawn again', async () => {
    const user = userEvent.setup();
    const actions = {
      kind: 'word' as const,
      label: 'Answer',
      onClick: vi.fn(),
      input: { placeholder: 'Why?', maxLength: 200, onSubmit: vi.fn() },
    };
    const first = render(
      <InboxDecisionRow icon={Puzzle} title="Why?" draftKey="d-1" actions={actions} />
    );
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    await user.type(screen.getByLabelText('Answer', { selector: 'textarea' }), 'Half done');
    first.unmount();
    render(<InboxDecisionRow icon={Puzzle} title="Why?" draftKey="d-1" actions={actions} />);
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    expect(screen.getByLabelText('Answer', { selector: 'textarea' })).toHaveValue('Half done');
  });

  it('forgets a draft on Cancel', async () => {
    const user = userEvent.setup();
    const actions = {
      kind: 'word' as const,
      label: 'Answer',
      onClick: vi.fn(),
      input: { placeholder: 'Why?', maxLength: 200, onSubmit: vi.fn() },
    };
    render(<InboxDecisionRow icon={Puzzle} title="Why?" draftKey="d-cancel" actions={actions} />);
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    await user.type(screen.getByLabelText('Answer', { selector: 'textarea' }), 'Never mind');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Answer' }));
    expect(screen.getByLabelText('Answer', { selector: 'textarea' })).toHaveValue('');
  });
});

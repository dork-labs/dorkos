/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ReadOnlyAccessDialogShowcase,
  ReadOnlyAgentRequestShowcase,
  ReadOnlyPageDemo,
} from '../showcases/ReadOnlyAccessShowcases';

afterEach(cleanup);

describe('read-only connection showcases', () => {
  it('renders the real page card from the no-change catalog', async () => {
    render(<ReadOnlyPageDemo />);
    expect(
      await screen.findByText(
        'Only Read is available for Linear. DorkOS can’t make changes there yet.'
      )
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Now: Read')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('opens the real dialog with the disabled write choice and unchanged Read selection', async () => {
    const user = userEvent.setup();
    render(<ReadOnlyAccessDialogShowcase />);
    await user.click(screen.getByRole('button', { name: 'Choose Scout’s access' }));
    const write = await screen.findByRole('button', { name: 'Read + write' });
    expect(write).toBeDisabled();
    expect(write).toHaveAccessibleDescription('Not available for Linear yet.');
    await user.click(write);
    expect(screen.getByRole('button', { name: 'Read' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Save access' })).toBeDisabled();
  });

  it('renders Scout’s real request card with the Read-only warning', async () => {
    render(<ReadOnlyAgentRequestShowcase />);
    expect(await screen.findByTestId('requested-write-missing')).toHaveTextContent(
      'Allow gives Read only. DorkOS can’t make changes in Linear yet.'
    );
    expect(screen.getByRole('button', { name: 'Allow' })).toBeEnabled();
  });
});

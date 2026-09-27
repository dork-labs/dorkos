/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AccountDot } from '../account-dot';
import { TooltipProvider } from '../tooltip';

afterEach(cleanup);

function renderDot() {
  return render(
    <TooltipProvider>
      <AccountDot color="#1d8a4a" name="Acct 2" />
    </TooltipProvider>
  );
}

describe('AccountDot', () => {
  it('is an image named for its account', () => {
    renderDot();
    expect(screen.getByRole('img', { name: 'Acct 2' })).toBeInTheDocument();
  });

  it('names the account in a tooltip on hover', async () => {
    renderDot();
    await userEvent.hover(screen.getByRole('img', { name: 'Acct 2' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Acct 2');
  });

  it('is not a tab stop: the name is read in place', async () => {
    renderDot();
    const dot = screen.getByRole('img', { name: 'Acct 2' });
    expect(dot).not.toHaveAttribute('tabindex');
    expect(dot).toHaveAttribute('aria-label', 'Acct 2');
    await userEvent.tab();
    expect(dot).not.toHaveFocus();
  });
});

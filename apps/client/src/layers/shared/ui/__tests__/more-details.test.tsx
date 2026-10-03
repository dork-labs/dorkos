/**
 * @vitest-environment jsdom
 *
 * MoreDetails is the overflow ladder's in-flow rung: hidden until asked, a
 * toggle whose text and `aria-expanded` say which way it will go.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { MoreDetails } from '../more-details';

afterEach(cleanup);

const BODY = 'Approve or deny from the chat itself.';

describe('MoreDetails', () => {
  it('starts collapsed, labelled "More details"', () => {
    render(
      <MoreDetails>
        <p>{BODY}</p>
      </MoreDetails>
    );
    const toggle = screen.getByRole('button', { name: 'More details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(BODY)).toBeNull();
  });

  it('opens and closes on click, swapping its label', async () => {
    const user = userEvent.setup();
    render(
      <MoreDetails>
        <p>{BODY}</p>
      </MoreDetails>
    );

    await user.click(screen.getByRole('button', { name: 'More details' }));
    const open = screen.getByRole('button', { name: 'Fewer details' });
    expect(open).toHaveAttribute('aria-expanded', 'true');
    expect(open).toHaveAttribute('aria-controls');
    expect(screen.getByText(BODY)).toBeVisible();

    await user.click(open);
    expect(screen.getByRole('button', { name: 'More details' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('toggles from the keyboard with Enter and Space', async () => {
    const user = userEvent.setup();
    render(
      <MoreDetails>
        <p>{BODY}</p>
      </MoreDetails>
    );

    await user.tab();
    expect(screen.getByRole('button', { name: 'More details' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByText(BODY)).toBeVisible();
    await user.keyboard(' ');
    expect(screen.getByRole('button', { name: 'More details' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('takes custom labels and can start open', () => {
    render(
      <MoreDetails label="Show routing" openLabel="Hide routing" defaultOpen>
        <p>{BODY}</p>
      </MoreDetails>
    );
    expect(screen.getByRole('button', { name: 'Hide routing' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByText(BODY)).toBeVisible();
  });

  it('keeps the chevron still under reduced motion', () => {
    const { container } = render(
      <MoreDetails>
        <p>{BODY}</p>
      </MoreDetails>
    );
    const chevron = container.querySelector('svg');
    expect(chevron?.getAttribute('class')).toContain('motion-safe:transition-transform');
    expect(chevron?.getAttribute('class')).not.toMatch(/(^|\s)transition-transform/);
  });
});

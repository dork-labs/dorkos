/**
 * @vitest-environment jsdom
 *
 * InfoTip is the overflow ladder's popover rung, so the properties that matter
 * are the ones a Tooltip lacks: it opens on click and from the keyboard, never
 * needs hover, and has a name a screen reader can announce.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { InfoTip } from '../info-tip';

const mockUseIsMobile = vi.fn(() => false);
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIsMobile: () => mockUseIsMobile(),
}));

beforeEach(() => mockUseIsMobile.mockReturnValue(false));
afterEach(cleanup);

function renderTip(props: Partial<React.ComponentProps<typeof InfoTip>> = {}) {
  return render(
    <InfoTip label="About background agents" {...props}>
      <p>They keep working after you close the app.</p>
    </InfoTip>
  );
}

describe('InfoTip', () => {
  it('is a button named by its label, closed until asked', () => {
    renderTip();
    const trigger = screen.getByRole('button', { name: 'About background agents' });
    expect(trigger).toHaveAttribute('type', 'button');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('They keep working after you close the app.')).toBeNull();
  });

  it('opens on click and closes on a second click', async () => {
    const user = userEvent.setup();
    renderTip();
    const trigger = screen.getByRole('button', { name: 'About background agents' });

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('They keep working after you close the app.')).toBeVisible();

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('They keep working after you close the app.')).toBeNull();
  });

  it('opens from the keyboard and closes on Escape', async () => {
    const user = userEvent.setup();
    renderTip();
    const trigger = screen.getByRole('button', { name: 'About background agents' });

    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('They keep working after you close the app.')).toBeVisible();

    await user.keyboard('{Escape}');
    expect(screen.queryByText('They keep working after you close the app.')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('does not open on hover', async () => {
    const user = userEvent.setup();
    renderTip();
    await user.hover(screen.getByRole('button', { name: 'About background agents' }));
    expect(screen.queryByText('They keep working after you close the app.')).toBeNull();
  });

  it('names the open panel, and shows a heading only when given a title', async () => {
    const user = userEvent.setup();
    const { unmount } = renderTip();
    await user.click(screen.getByRole('button', { name: 'About background agents' }));
    expect(screen.getByRole('dialog', { name: 'About background agents' })).toBeInTheDocument();
    unmount();

    renderTip({ title: 'Background agents' });
    await user.click(screen.getByRole('button', { name: 'About background agents' }));
    expect(screen.getByText('Background agents')).toBeVisible();
  });

  it('carries a keyboard-only focus ring', () => {
    renderTip();
    expect(screen.getByRole('button', { name: 'About background agents' }).className).toContain(
      'focus-ring'
    );
  });

  it('opens as a titled drawer on a phone', async () => {
    mockUseIsMobile.mockReturnValue(true);
    const user = userEvent.setup();
    renderTip();
    await user.click(screen.getByRole('button', { name: 'About background agents' }));
    expect(await screen.findByText('They keep working after you close the app.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'About background agents' })).toBeInTheDocument();
  });
});

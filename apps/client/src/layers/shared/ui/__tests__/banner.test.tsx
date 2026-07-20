/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { Banner } from '../banner';

afterEach(cleanup);

describe('Banner', () => {
  it('announces critical banners assertively via role="alert"', () => {
    render(<Banner variant="critical">Something broke</Banner>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something broke');
    expect(alert).toHaveAttribute('data-variant', 'critical');
  });

  it.each(['warning', 'info', 'neutral'] as const)(
    'announces %s banners politely via role="status"',
    (variant) => {
      render(<Banner variant={variant}>Heads up</Banner>);
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('Heads up');
      expect(status).toHaveAttribute('data-variant', variant);
    }
  );

  it('defaults to the neutral variant', () => {
    render(<Banner>Announcement</Banner>);
    expect(screen.getByRole('status')).toHaveAttribute('data-variant', 'neutral');
  });

  it('renders a dismiss button only when onDismiss is provided', () => {
    const { rerender } = render(<Banner variant="info">No dismiss</Banner>);
    expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();

    rerender(
      <Banner variant="info" onDismiss={vi.fn()}>
        Dismissible
      </Banner>
    );
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('calls onDismiss when the dismiss button is clicked', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    render(
      <Banner variant="warning" onDismiss={onDismiss} dismissLabel="Close banner">
        Bye
      </Banner>
    );
    await user.click(screen.getByRole('button', { name: /close banner/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('reveals the details region only while detailsOpen is true', () => {
    const details = <div>secret payload</div>;
    const { rerender } = render(
      <Banner variant="neutral" details={details} detailsOpen={false}>
        Message
      </Banner>
    );
    expect(screen.queryByText('secret payload')).not.toBeInTheDocument();

    rerender(
      <Banner variant="neutral" details={details} detailsOpen>
        Message
      </Banner>
    );
    expect(screen.getByText('secret payload')).toBeInTheDocument();
  });
});

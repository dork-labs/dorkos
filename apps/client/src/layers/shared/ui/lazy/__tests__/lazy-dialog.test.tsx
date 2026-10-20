// @vitest-environment jsdom
/**
 * A dialog fetched the first time it is wanted (DOR-2901).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { lazyDialog } from '../lazy-dialog';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.mocked(toast.error).mockClear();
});

interface Props {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  label: string;
}

function RealDialog({ open, label }: Props) {
  return <div data-testid="real">{open ? `${label} open` : `${label} closed`}</div>;
}

describe('lazyDialog', () => {
  it('fetches nothing and draws nothing until it is first opened', async () => {
    const load = vi.fn(async () => RealDialog);
    const Dialog = lazyDialog('Real', load);
    const { rerender } = render(<Dialog open={false} label="Settings" />);
    expect(load).not.toHaveBeenCalled();
    expect(screen.queryByTestId('real')).toBeNull();

    rerender(<Dialog open label="Settings" />);
    expect(await screen.findByText('Settings open')).toBeTruthy();
    expect(load).toHaveBeenCalled();
  });

  it('stays mounted once opened, so closing can animate and state survives', async () => {
    const Dialog = lazyDialog('Real', async () => RealDialog);
    const { rerender } = render(<Dialog open label="Profile" />);
    await screen.findByText('Profile open');
    rerender(<Dialog open={false} label="Profile" />);
    expect(screen.getByText('Profile closed')).toBeTruthy();
  });

  it('fetches the real dialog once the app is idle, before anyone opens it', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => RealDialog);
    const Dialog = lazyDialog('Real', load);
    render(<Dialog open={false} label="Tasks" />);
    expect(load).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('real')).toBeNull();
  });

  it('closes and says so when the download fails, then tries again on the next open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const load = vi
      .fn<() => Promise<typeof RealDialog>>()
      .mockRejectedValueOnce(
        new Error('Failed to fetch dynamically imported module: /assets/Real.js')
      )
      .mockResolvedValue(RealDialog);
    const Dialog = lazyDialog('Real', load);
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <p>the app</p>
          <button onClick={() => setOpen(true)}>reopen</button>
          {/* Closed a moment later, as a router-driven close lands. */}
          <Dialog
            open={open}
            onOpenChange={(next) => setTimeout(() => setOpen(next), 10)}
            label="Settings"
          />
        </div>
      );
    }
    render(<Host />);
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'DorkOS may have updated. Reload to open this.',
        expect.objectContaining({ id: 'lazy-dialog-Real' })
      )
    );
    // Closed, the rest of the app still there, and no second try on its own.
    expect(screen.getByText('the app')).toBeTruthy();
    expect(screen.queryByTestId('real')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(load).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText('reopen'));
    expect(await screen.findByText('Settings open')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('skips the idle fetch once the dialog has already loaded', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const load = vi.fn(async () => RealDialog);
    const Dialog = lazyDialog('Real', load);
    const first = render(<Dialog open label="Tasks" />);
    await screen.findByText('Tasks open');
    first.unmount();
    load.mockClear();
    render(<Dialog open={false} label="Tasks" />);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(load).not.toHaveBeenCalled();
  });
});

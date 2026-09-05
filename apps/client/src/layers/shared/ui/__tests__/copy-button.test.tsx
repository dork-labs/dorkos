// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CopyButton } from '../copy-button';

/** Stub `navigator.clipboard.writeText` to resolve or reject on demand. */
function stubClipboard(behavior: 'resolve' | 'reject') {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText:
        behavior === 'resolve'
          ? vi.fn().mockResolvedValue(undefined)
          : vi.fn().mockRejectedValue(new Error('denied')),
    },
  });
}

afterEach(() => cleanup());

describe('CopyButton', () => {
  it('starts idle: the Copy icon, the default label', () => {
    stubClipboard('resolve');
    render(<CopyButton value="dorkos.ai" />);

    const button = screen.getByRole('button', { name: 'Copy to clipboard' });
    expect(button.querySelector('.lucide-copy')).not.toBeNull();
    expect(button.querySelector('.lucide-check')).toBeNull();
    expect(button.querySelector('.lucide-x')).toBeNull();
  });

  it('honors a custom label while idle', () => {
    stubClipboard('resolve');
    render(<CopyButton value="dorkos.ai" label="Copy site URL" />);

    expect(screen.getByRole('button', { name: 'Copy site URL' })).toBeInTheDocument();
  });

  it('morphs to a check mark on a successful copy', async () => {
    stubClipboard('resolve');
    render(<CopyButton value="dorkos.ai" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));

    await waitFor(() => {
      expect(screen.getByRole('button').querySelector('.lucide-check')).not.toBeNull();
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('dorkos.ai');
    // The accessible name stays the idle label on success — only a failure
    // changes it.
    expect(screen.getByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument();
  });

  it('morphs to an X and an updated aria-label when the clipboard refuses', async () => {
    stubClipboard('reject');
    render(<CopyButton value="dorkos.ai" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));

    const button = await screen.findByRole('button', { name: "Couldn't copy. Try again" });
    expect(button.querySelector('.lucide-x')).not.toBeNull();
    expect(button.querySelector('.lucide-check')).toBeNull();
    expect(button.querySelector('.lucide-copy')).toBeNull();
  });

  it('reverts to idle after the feedback window elapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubClipboard('resolve');
    render(<CopyButton value="dorkos.ai" />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    await waitFor(() => {
      expect(screen.getByRole('button').querySelector('.lucide-check')).not.toBeNull();
    });

    vi.advanceTimersByTime(1200);
    await waitFor(() => {
      expect(screen.getByRole('button').querySelector('.lucide-copy')).not.toBeNull();
    });

    vi.useRealTimers();
  });
});

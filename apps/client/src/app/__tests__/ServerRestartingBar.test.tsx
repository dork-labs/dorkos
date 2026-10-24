/**
 * @vitest-environment jsdom
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerRestartingBar } from '../ServerRestartingBar';

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe('ServerRestartingBar', () => {
  it('renders nothing outside the desktop app', () => {
    const { container } = render(<ServerRestartingBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows while the desktop app says it is restarting, and hides after', () => {
    let push: (restarting: boolean) => void = () => undefined;
    const unsubscribe = vi.fn();
    window.electronAPI = {
      onServerRestarting: vi.fn((cb: (restarting: boolean) => void) => {
        push = cb;
        return unsubscribe;
      }),
    } as unknown as Window['electronAPI'];

    const { unmount } = render(<ServerRestartingBar />);
    expect(screen.queryByRole('status')).toBeNull();

    act(() => push(true));
    expect(screen.getByRole('status')).toHaveTextContent('Restarting DorkOS…');

    act(() => push(false));
    expect(screen.queryByRole('status')).toBeNull();

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

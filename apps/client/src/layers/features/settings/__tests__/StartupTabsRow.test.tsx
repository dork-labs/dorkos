/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { StartupTabsRow } from '../ui/tabs/StartupTabsRow';

beforeAll(() => {
  // Radix Select needs DOM APIs jsdom lacks to open its listbox under userEvent.
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  if (!proto.scrollIntoView) proto.scrollIntoView = vi.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

function installBridge(mode: DesktopStartupMode) {
  const setStartupMode = vi.fn((next: DesktopStartupMode) => Promise.resolve(next));
  window.electronAPI = {
    tabSession: { getStartupMode: () => Promise.resolve(mode), setStartupMode },
  } as unknown as ElectronAPI;
  return setStartupMode;
}

describe('StartupTabsRow', () => {
  it('shows the saved choice, and saves a new one to the desktop app', async () => {
    const setStartupMode = installBridge('reopen');
    render(<StartupTabsRow />);

    const trigger = await screen.findByRole('combobox', { name: 'When DorkOS opens' });
    expect(trigger).toHaveTextContent('Reopen your tabs');

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('option', { name: 'Start fresh' }));

    expect(setStartupMode).toHaveBeenCalledWith('fresh');
    expect(trigger).toHaveTextContent('Start fresh');
  });

  it('renders nothing outside the desktop app', () => {
    const { container } = render(<StartupTabsRow />);
    expect(container).toBeEmptyDOMElement();
  });
});

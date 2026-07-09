/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';

// xterm touches canvas/WebGL, which jsdom cannot provide — stub the terminal,
// its fit addon, the WebGL renderer, and the CSS side-effect import so the
// panel mounts headless.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData() {}
    write() {}
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import { TerminalPanel } from '../ui/TerminalPanel';

const CWD = '/repo';

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ selectedCwd: CWD });
});

afterEach(() => cleanup());

function renderTerminal(transport = createMockTransport({ supportsTerminal: true })) {
  return render(
    <TransportProvider transport={transport}>
      <TerminalPanel />
    </TransportProvider>
  );
}

describe('TerminalPanel', () => {
  it('mounts a full-height xterm container as content only — the container owns the header', () => {
    const transport = createMockTransport({ supportsTerminal: true });
    const openTerminal = vi.fn(async () => ({ id: 't', output: (async function* () {})() }));
    transport.openTerminal = openTerminal;

    const { container } = renderTerminal(transport);

    // The panel is a bare full-height xterm mount so the FitAddon can measure it
    // (the container's flex-1 content slot gives it real height).
    const mount = container.querySelector('.bg-sidebar.h-full');
    expect(mount).toBeInTheDocument();
    // The panel renders no header of its own — that is the container's job.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close panel' })).not.toBeInTheDocument();
  });

  it('shows the empty state when no working directory is selected', () => {
    useAppStore.setState({ selectedCwd: null });
    renderTerminal();

    expect(screen.getByText('Select a working directory to open a terminal.')).toBeInTheDocument();
  });
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { TerminalHandle } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { readTerminalId, writeTerminalId } from '../lib/terminal-id-store';

// Shared, hoist-safe capture of everything written to the stubbed xterm, so
// tests can assert the `[reconnected]` restoration cue.
const xterm = vi.hoisted(() => ({ writes: [] as string[] }));

// xterm touches canvas/WebGL, which jsdom cannot provide — stub the terminal,
// its fit addon, the WebGL renderer, and the CSS side-effect import so the
// panel mounts headless. `write` records into the shared capture.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData() {}
    write(data: string | Uint8Array) {
      xterm.writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    }
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
  xterm.writes.length = 0;
  sessionStorage.clear();
  useAppStore.setState({ selectedCwd: CWD, sessionId: null });
});

afterEach(() => cleanup());

/** An output stream that stays open until its `signal` aborts — models a live shell. */
function liveOutput(signal: AbortSignal): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      if (signal.aborted) return;
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      );
    },
  };
}

/** An output stream that ends immediately — models the shell exiting / PTY closing. */
async function* exitedOutput(): AsyncIterable<Uint8Array> {}

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

  it('re-attaches to a stored PTY, prints the reconnected cue, and keeps the id', async () => {
    writeTerminalId(null, CWD, 'pty-1');
    const transport = createMockTransport({ supportsTerminal: true });
    const attachTerminal = vi.fn(
      async (id: string, signal?: AbortSignal): Promise<TerminalHandle> => ({
        id,
        output: liveOutput(signal!),
      })
    );
    const openTerminal = vi.fn();
    transport.attachTerminal = attachTerminal;
    transport.openTerminal = openTerminal;

    renderTerminal(transport);

    await waitFor(() =>
      expect(attachTerminal).toHaveBeenCalledWith('pty-1', expect.any(AbortSignal))
    );
    // The re-attach path is used — no fresh PTY is created.
    expect(openTerminal).not.toHaveBeenCalled();
    // The subtle restoration cue is written.
    expect(xterm.writes.join('')).toContain('[reconnected]');
    // The id is still persisted for the next refresh.
    expect(readTerminalId(null, CWD)).toBe('pty-1');
  });

  it('falls back to a fresh create when the stored PTY is gone, without the cue', async () => {
    writeTerminalId(null, CWD, 'gone');
    const transport = createMockTransport({ supportsTerminal: true });
    const attachTerminal = vi.fn(async () => {
      throw new Error('terminal socket failed to open');
    });
    const openTerminal = vi.fn(
      async (_cwd: string, signal?: AbortSignal): Promise<TerminalHandle> => ({
        id: 'fresh-pty',
        output: liveOutput(signal!),
      })
    );
    transport.attachTerminal = attachTerminal;
    transport.openTerminal = openTerminal;

    renderTerminal(transport);

    await waitFor(() => expect(openTerminal).toHaveBeenCalledWith(CWD, expect.any(AbortSignal)));
    expect(attachTerminal).toHaveBeenCalledWith('gone', expect.any(AbortSignal));
    // A fresh create shows no reconnected cue…
    expect(xterm.writes.join('')).not.toContain('[reconnected]');
    // …and the new id replaces the stale one.
    await waitFor(() => expect(readTerminalId(null, CWD)).toBe('fresh-pty'));
  });

  it('clears the stored id when the PTY exits (stream ends without teardown)', async () => {
    const transport = createMockTransport({ supportsTerminal: true });
    transport.openTerminal = vi.fn(
      async (): Promise<TerminalHandle> => ({ id: 'fresh-pty', output: exitedOutput() })
    );

    renderTerminal(transport);

    // The stream ends on its own (shell exit) → the id must not linger.
    await waitFor(() => expect(readTerminalId(null, CWD)).toBeNull());
  });
});

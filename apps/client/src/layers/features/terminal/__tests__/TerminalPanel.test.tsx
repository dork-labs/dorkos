/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { TerminalHandle } from '@dorkos/shared/transport';
import { TERMINAL_CLOSE_SUPERSEDED } from '@dorkos/shared/terminal-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { readTerminalTabs, writeTerminalTabs } from '../lib/terminal-id-store';

// Shared, hoist-safe capture of everything written to the stubbed xterm, so
// tests can assert the `[reconnected]` cue and the TERMINAL_LIMIT copy.
const xterm = vi.hoisted(() => ({ writes: [] as string[] }));

// xterm touches canvas/WebGL, which jsdom cannot provide — stub the terminal,
// its fit addon, the WebGL renderer, and the CSS side-effect import so instances
// mount headless. `write` records into the shared capture.
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon() {}
    open() {}
    onData() {}
    focus() {}
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

/**
 * Live ResizeObserver callbacks, capture-ordered, so tests can drive resize
 * notifications — e.g. the 0×0 entry the browser fires when a tab is hidden
 * via `display:none` on switch.
 */
const resizeCallbacks: ResizeObserverCallback[] = [];

/** Fire every live observer with a single entry of the given content size. */
function fireResize(width: number, height: number): void {
  const entry = { contentRect: { width, height } } as ResizeObserverEntry;
  for (const cb of resizeCallbacks) cb([entry], undefined as unknown as ResizeObserver);
}

beforeAll(() => {
  global.ResizeObserver = class {
    constructor(cb: ResizeObserverCallback) {
      resizeCallbacks.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  xterm.writes.length = 0;
  resizeCallbacks.length = 0;
  sessionStorage.clear();
  useAppStore.setState({ selectedCwd: CWD, sessionId: null });
});

afterEach(() => cleanup());

/**
 * An output stream that emits nothing and stays open until its `signal` aborts —
 * models a silent live shell. A manual iterator (not a generator) because it
 * never yields.
 */
function liveOutput(signal: AbortSignal): AsyncIterable<Uint8Array> {
  const done = (): IteratorResult<Uint8Array> => ({ done: true, value: undefined });
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<Uint8Array>>((resolve) => {
          if (signal.aborted) return resolve(done());
          signal.addEventListener('abort', () => resolve(done()), { once: true });
        }),
    }),
  };
}

/** An output stream that ends immediately — models the shell exiting / PTY closing. */
async function* exitedOutput(): AsyncIterable<Uint8Array> {}

/**
 * A create that stays in flight until the test resolves it — models the window
 * where the server has spawned (or is spawning) a PTY but the client response
 * hasn't landed yet (the late-spawn leak windows, #173 review).
 */
function deferredCreate() {
  let resolve!: (handle: TerminalHandle) => void;
  const promise = new Promise<TerminalHandle>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A mock transport whose openTerminal spawns a live shell with a caller-chosen id. */
function liveTransport() {
  const transport = createMockTransport({ supportsTerminal: true });
  let n = 0;
  transport.openTerminal = vi.fn(
    async (_cwd: string, signal?: AbortSignal): Promise<TerminalHandle> => ({
      id: `pty-${(n += 1)}`,
      output: liveOutput(signal!),
    })
  );
  return transport;
}

function renderTerminal(transport = createMockTransport({ supportsTerminal: true })) {
  return render(
    <TransportProvider transport={transport}>
      <TerminalPanel />
    </TransportProvider>
  );
}

/** Count the mounted xterm instance containers (one per tab, hidden or visible). */
function instanceCount(container: HTMLElement): number {
  return container.querySelectorAll('.bg-sidebar.h-full').length;
}

describe('TerminalPanel', () => {
  it('renders content + its own tab strip, but never the container-owned close button', () => {
    renderTerminal(liveTransport());
    // The panel owns an in-panel tab strip (mirrors the Canvas document tabs)…
    expect(screen.getByRole('tablist', { name: 'Open terminals' })).toBeInTheDocument();
    // …but never the container-owned header close button.
    expect(screen.queryByRole('button', { name: 'Close panel' })).not.toBeInTheDocument();
  });

  it('shows the empty state when no working directory is selected', () => {
    useAppStore.setState({ selectedCwd: null });
    renderTerminal();
    expect(screen.getByText('Select a working directory to open a terminal.')).toBeInTheDocument();
  });

  it('seeds one terminal on first open so the panel is never empty', async () => {
    const transport = liveTransport();
    const { container } = renderTerminal(transport);

    await waitFor(() => expect(transport.openTerminal).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('tab', { name: /Terminal 1/ })).toBeInTheDocument();
    expect(instanceCount(container)).toBe(1);
  });

  it('creates a new tab that is appended and activated on "+"', async () => {
    const user = userEvent.setup();
    const transport = liveTransport();
    const { container } = renderTerminal(transport);

    await waitFor(() => expect(transport.openTerminal).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'New terminal' }));

    await waitFor(() => expect(transport.openTerminal).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('tab', { name: /Terminal 2/, selected: true })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Terminal 1/, selected: false })).toBeInTheDocument();
    expect(instanceCount(container)).toBe(2);
  });

  it('switches tabs without re-creating PTYs and keeps both instances mounted', async () => {
    const user = userEvent.setup();
    const transport = liveTransport();
    const { container } = renderTerminal(transport);

    await waitFor(() => expect(transport.openTerminal).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(transport.openTerminal).toHaveBeenCalledTimes(2));

    // Switch back to the first tab — no new PTY is created, both stay mounted.
    await user.click(screen.getByRole('tab', { name: /Terminal 1/ }).querySelector('button')!);
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Terminal 1/, selected: true })).toBeInTheDocument()
    );
    expect(transport.openTerminal).toHaveBeenCalledTimes(2);
    expect(instanceCount(container)).toBe(2);
  });

  it('ignores the zero-size observer entry a hidden tab fires — no bogus PTY resize', async () => {
    const user = userEvent.setup();
    const transport = liveTransport();
    renderTerminal(transport);

    await waitFor(() => expect(transport.openTerminal).toHaveBeenCalledTimes(1));
    // Open a second tab, hiding the first (display:none fires its observer with 0×0).
    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(transport.openTerminal).toHaveBeenCalledTimes(2));

    const callsBefore = vi.mocked(transport.resizeTerminal).mock.calls.length;
    // The hide-transition notification: zero-size, must NOT reach the PTY.
    fireResize(0, 0);
    expect(vi.mocked(transport.resizeTerminal).mock.calls.length).toBe(callsBefore);

    // A real resize still flows through.
    fireResize(640, 480);
    expect(vi.mocked(transport.resizeTerminal).mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('closes a tab: destroys its PTY via closeTerminal and removes it', async () => {
    const user = userEvent.setup();
    const transport = liveTransport();
    renderTerminal(transport);

    // Wait until the seeded shell has an id persisted (created + flushed).
    await waitFor(() => expect(readTerminalTabs(null, CWD).ids).toEqual(['pty-1']));

    const tab = screen.getByRole('tab', { name: /Terminal 1/ });
    await user.click(within(tab).getByRole('button', { name: 'Close Terminal 1' }));

    await waitFor(() => expect(transport.closeTerminal).toHaveBeenCalledWith('pty-1'));
    // Last tab closed → empty state, panel stays open.
    expect(screen.getByText('No terminals open.')).toBeInTheDocument();
    expect(readTerminalTabs(null, CWD).ids).toEqual([]);
  });

  it('destroys a PTY whose create resolves after its tab was closed — never persisted, never leaked', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({ supportsTerminal: true });
    const create = deferredCreate();
    transport.openTerminal = vi.fn(() => create.promise);

    renderTerminal(transport);

    // The seeded tab is still spawning — close it. No id yet, so nothing to
    // destroy at click time.
    const tab = await screen.findByRole('tab', { name: /Terminal 1/ });
    await user.click(within(tab).getByRole('button', { name: 'Close Terminal 1' }));
    expect(transport.closeTerminal).not.toHaveBeenCalled();
    await screen.findByText('No terminals open.');

    // The in-flight create resolves, holding the only reference to a live PTY:
    // the closed tab's key routes it straight to destruction.
    create.resolve({ id: 'late-pty', output: exitedOutput() });
    await waitFor(() => expect(transport.closeTerminal).toHaveBeenCalledWith('late-pty'));
    // Never persisted, no tab re-appears.
    expect(readTerminalTabs(null, CWD).ids).toEqual([]);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('destroys a PTY whose create resolves in the same tick as the close click (commit gap)', async () => {
    const transport = createMockTransport({ supportsTerminal: true });
    const create = deferredCreate();
    transport.openTerminal = vi.fn(() => create.promise);

    renderTerminal(transport);
    const tab = await screen.findByRole('tab', { name: /Terminal 1/ });

    // Close and resolve back-to-back in the SAME tick — no interim flush. The
    // create's continuation can then run in the gap where removeTab has
    // committed but the instance's deferred effect cleanup hasn't flipped
    // `cancelled` yet, so the id arrives via onCreated for a tab that no
    // longer exists. closedPendingKeys (mutated synchronously in closeTab) is
    // what routes it to destruction regardless of which path fires.
    fireEvent.click(within(tab).getByRole('button', { name: 'Close Terminal 1' }));
    create.resolve({ id: 'late-pty', output: exitedOutput() });

    await waitFor(() => expect(transport.closeTerminal).toHaveBeenCalledWith('late-pty'));
    // Never persisted, never adopted back into a tab.
    expect(readTerminalTabs(null, CWD).ids).toEqual([]);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('persists a PTY whose create resolves after unmount, so remount re-attaches to it', async () => {
    const transport = createMockTransport({ supportsTerminal: true });
    const create = deferredCreate();
    transport.openTerminal = vi.fn(() => create.promise);

    const { unmount } = renderTerminal(transport);
    await waitFor(() => expect(transport.openTerminal).toHaveBeenCalledTimes(1));

    // Unmount mid-spawn (tab switch / leaving /session): shells must survive.
    unmount();
    expect(readTerminalTabs(null, CWD).ids).toEqual([]);

    // The create resolves post-unmount — the id is persisted (not destroyed) so
    // the shell is re-attachable.
    create.resolve({ id: 'late-pty', output: exitedOutput() });
    await waitFor(() => expect(readTerminalTabs(null, CWD).ids).toEqual(['late-pty']));
    expect(transport.closeTerminal).not.toHaveBeenCalled();

    // Remount: the persisted tab is restored and re-attached, not re-created.
    const attachTerminal = vi.fn(
      async (id: string, signal?: AbortSignal): Promise<TerminalHandle> => ({
        id,
        output: liveOutput(signal!),
      })
    );
    transport.attachTerminal = attachTerminal;
    renderTerminal(transport);
    await waitFor(() =>
      expect(attachTerminal).toHaveBeenCalledWith('late-pty', expect.any(AbortSignal))
    );
    expect(screen.getByRole('tab', { name: /Terminal 1/ })).toBeInTheDocument();
  });

  it('offers a create affordance from the empty state', async () => {
    const user = userEvent.setup();
    const transport = liveTransport();
    renderTerminal(transport);

    await waitFor(() => expect(readTerminalTabs(null, CWD).ids).toEqual(['pty-1']));
    const tab = screen.getByRole('tab', { name: /Terminal 1/ });
    await user.click(within(tab).getByRole('button', { name: 'Close Terminal 1' }));
    const emptyState = (await screen.findByText('No terminals open.')).parentElement!;

    // The empty state carries its own create button (besides the strip's "+").
    await user.click(within(emptyState).getByRole('button', { name: 'New terminal' }));
    await waitFor(() => expect(transport.openTerminal).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('tab', { name: /Terminal/ })).toBeInTheDocument();
  });

  it('restores every live tab on refresh, re-attaching each with the stored active tab', async () => {
    writeTerminalTabs(null, CWD, { ids: ['a', 'b'], activeIndex: 1 });
    const transport = createMockTransport({ supportsTerminal: true });
    const attachTerminal = vi.fn(
      async (id: string, signal?: AbortSignal): Promise<TerminalHandle> => ({
        id,
        output: liveOutput(signal!),
      })
    );
    transport.attachTerminal = attachTerminal;
    const openTerminal = vi.fn();
    transport.openTerminal = openTerminal;

    const { container } = renderTerminal(transport);

    await waitFor(() => expect(attachTerminal).toHaveBeenCalledWith('a', expect.any(AbortSignal)));
    expect(attachTerminal).toHaveBeenCalledWith('b', expect.any(AbortSignal));
    // Re-attach only — no fresh PTYs spawned.
    expect(openTerminal).not.toHaveBeenCalled();
    expect(instanceCount(container)).toBe(2);
    // The stored active index (1) restores the second tab as active.
    expect(screen.getByRole('tab', { name: /Terminal 2/, selected: true })).toBeInTheDocument();
    // The restoration cue is written for a re-attach.
    await waitFor(() => expect(xterm.writes.join('')).toContain('[reconnected]'));
  });

  it('prunes a dead tab whose stored PTY is gone on refresh', async () => {
    writeTerminalTabs(null, CWD, { ids: ['a', 'gone'], activeIndex: 0 });
    const transport = createMockTransport({ supportsTerminal: true });
    transport.attachTerminal = vi.fn(
      async (id: string, signal?: AbortSignal): Promise<TerminalHandle> => {
        if (id === 'gone') throw new Error('terminal socket failed to open');
        return { id, output: liveOutput(signal!) };
      }
    );
    const openTerminal = vi.fn();
    transport.openTerminal = openTerminal;

    renderTerminal(transport);

    // The dead id is silently pruned — never resurrected as a fresh shell.
    await waitFor(() => expect(readTerminalTabs(null, CWD).ids).toEqual(['a']));
    expect(openTerminal).not.toHaveBeenCalled();
    expect(screen.queryByRole('tab', { name: /Terminal 2/ })).not.toBeInTheDocument();
  });

  it('clears an id from the list when its shell exits', async () => {
    const transport = createMockTransport({ supportsTerminal: true });
    transport.openTerminal = vi.fn(
      async (): Promise<TerminalHandle> => ({ id: 'fresh-pty', output: exitedOutput() })
    );

    renderTerminal(transport);

    // The stream ends on its own (shell exit) → the tab is pruned and the id
    // must not linger in storage.
    await waitFor(() => expect(readTerminalTabs(null, CWD).ids).toEqual([]));
    await screen.findByText('No terminals open.');
  });

  it('keeps the tab and stored ids on a takeover close (session moved to another window)', async () => {
    // A duplicated tab re-attaches to the same PTY id; the server closes THIS
    // socket with TERMINAL_CLOSE_SUPERSEDED. The tab must survive with a notice —
    // not be pruned like an exit — and the stored ids must stay untouched so the
    // window that took over keeps restoring them.
    writeTerminalTabs(null, CWD, { ids: ['stolen'], activeIndex: 0 });
    const transport = createMockTransport({ supportsTerminal: true });
    transport.attachTerminal = vi.fn(
      async (id: string): Promise<TerminalHandle> => ({
        id,
        output: exitedOutput(),
        closeInfo: { code: TERMINAL_CLOSE_SUPERSEDED, reason: 'superseded' },
      })
    );
    const openTerminal = vi.fn();
    transport.openTerminal = openTerminal;

    renderTerminal(transport);

    await waitFor(() =>
      expect(xterm.writes.join('')).toContain('[opened in another window — session moved]')
    );
    // Tab kept (dead but labeled), no fresh shell spawned to replace it.
    expect(screen.getByRole('tab', { name: /Terminal 1/ })).toBeInTheDocument();
    expect(openTerminal).not.toHaveBeenCalled();
    // Stored ids left intact — the takeover window is the one that owns them now.
    expect(readTerminalTabs(null, CWD).ids).toEqual(['stolen']);
  });

  it('renders the truncation cue in order: [reconnected] → cue → replay', async () => {
    // The server leads a re-attach replay with the dim truncation cue (it alone
    // knows the detached buffer overflowed), then the surviving scrollback. The
    // client writes them straight through, after its own [reconnected] cue.
    writeTerminalTabs(null, CWD, { ids: ['t1'], activeIndex: 0 });
    const transport = createMockTransport({ supportsTerminal: true });
    transport.attachTerminal = vi.fn(
      async (id: string): Promise<TerminalHandle> => ({
        id,
        output: (async function* () {
          yield new TextEncoder().encode(
            '\x1b[2m[some output was lost while disconnected]\x1b[0m\r\n'
          );
          yield new TextEncoder().encode('surviving scrollback\r\n');
        })(),
      })
    );

    renderTerminal(transport);

    await waitFor(() => expect(xterm.writes.join('')).toContain('surviving scrollback'));
    const joined = xterm.writes.join('');
    expect(joined.indexOf('[reconnected]')).toBeGreaterThanOrEqual(0);
    expect(joined.indexOf('[reconnected]')).toBeLessThan(joined.indexOf('some output was lost'));
    expect(joined.indexOf('some output was lost')).toBeLessThan(
      joined.indexOf('surviving scrollback')
    );
  });

  it('shows human copy when a create hits the live-terminal cap (TERMINAL_LIMIT)', async () => {
    const transport = createMockTransport({ supportsTerminal: true });
    transport.openTerminal = vi.fn(async () => {
      throw Object.assign(new Error('Terminal limit reached (24 live terminals)'), {
        code: 'TERMINAL_LIMIT',
      });
    });

    renderTerminal(transport);

    await waitFor(() =>
      expect(xterm.writes.join('')).toContain(
        'Too many terminals open — close some or wait a few minutes.'
      )
    );
    // The raw server string is replaced, not appended.
    expect(xterm.writes.join('')).not.toContain('Terminal limit reached');
  });
});

/**
 * @vitest-environment jsdom
 *
 * The Agent browser's keys (DOR-4432, spec §13): each chord does its one thing
 * while focus is in the panel, the same chords forwarded from the native page
 * do the same, and outside the panel the app's own Back and Forward keys keep
 * their chords.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { isMac } from '@/layers/shared/lib';
import { BrowserChrome } from '@/layers/shared/ui';
import { useBrowserKeys, type BrowserKeyActions, type BrowserShortcut } from '../use-browser-keys';

// Every chord is pressed with the platform's own modifier: ⌘ on a Mac, Ctrl elsewhere.
const MOD = isMac ? { metaKey: true } : { ctrlKey: true };

function actions(): Required<
  Pick<
    BrowserKeyActions,
    'onFocusAddress' | 'onReload' | 'onBack' | 'onForward' | 'onStop' | 'onCopyAddress'
  >
> {
  // Each action did something unless a test says otherwise.
  return {
    onFocusAddress: vi.fn(() => true),
    onReload: vi.fn(() => true),
    onBack: vi.fn(() => true),
    onForward: vi.fn(() => true),
    onStop: vi.fn(() => true),
    onCopyAddress: vi.fn(() => true),
  };
}

function Harness({
  handlers,
  loading = false,
  connectionId = 'owned',
}: {
  handlers: ReturnType<typeof actions>;
  loading?: boolean;
  connectionId?: string | null;
}) {
  const onKeyDown = useBrowserKeys({ connectionId, loading, ...handlers });
  return (
    <div>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- mirrors the panel root */}
      <div onKeyDown={onKeyDown} data-testid="panel">
        <button type="button">Back</button>
        <input aria-label="Address" />
        {/* Something in the panel that uses Esc itself, the way a menu closes on it. */}
        <button
          type="button"
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.preventDefault();
          }}
        >
          Menu
        </button>
      </div>
      <button type="button">Somewhere else</button>
    </div>
  );
}

/** Press a key at `target` the way a keyboard would; answers whether anything took it. */
function press(target: Element, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/** A fake desktop bridge that can forward a chord from the native page. */
function installBridge() {
  const listeners = new Set<(input: { connectionId: string; shortcut: BrowserShortcut }) => void>();
  window.electronAPI = {
    getServerPort: () => 4242,
    localBrowser: {
      setBounds: vi.fn(async () => undefined),
      onShortcut: (cb: (input: { connectionId: string; shortcut: BrowserShortcut }) => void) => {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
    },
  } as unknown as ElectronAPI;
  return {
    forward: (connectionId: string, shortcut: BrowserShortcut) =>
      listeners.forEach((cb) => cb({ connectionId, shortcut })),
    listeners,
  };
}

afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

describe('useBrowserKeys: focus in the panel', () => {
  it('⌘L focuses the address field', () => {
    const handlers = actions();
    render(<Harness handlers={handlers} />);
    expect(
      press(screen.getByRole('button', { name: 'Back' }), { ...MOD, key: 'l', code: 'KeyL' })
    ).toBe(true);
    expect(handlers.onFocusAddress).toHaveBeenCalledOnce();
  });

  it('⌘R and F5 reload', () => {
    const handlers = actions();
    render(<Harness handlers={handlers} />);
    const button = screen.getByRole('button', { name: 'Back' });
    expect(press(button, { ...MOD, key: 'r', code: 'KeyR' })).toBe(true);
    expect(press(button, { key: 'F5', code: 'F5' })).toBe(true);
    expect(handlers.onReload).toHaveBeenCalledTimes(2);
  });

  it('⌘[ and ⌘] go back and forward in the page', () => {
    const handlers = actions();
    render(<Harness handlers={handlers} />);
    const button = screen.getByRole('button', { name: 'Back' });
    expect(press(button, { ...MOD, key: '[', code: 'BracketLeft' })).toBe(true);
    expect(press(button, { ...MOD, key: ']', code: 'BracketRight' })).toBe(true);
    expect(handlers.onBack).toHaveBeenCalledOnce();
    expect(handlers.onForward).toHaveBeenCalledOnce();
  });

  it.skipIf(isMac)('Alt+← and Alt+→ go back and forward, but not from a text field', () => {
    const handlers = actions();
    render(<Harness handlers={handlers} />);
    const button = screen.getByRole('button', { name: 'Back' });
    expect(press(button, { altKey: true, key: 'ArrowLeft', code: 'ArrowLeft' })).toBe(true);
    expect(press(button, { altKey: true, key: 'ArrowRight', code: 'ArrowRight' })).toBe(true);
    expect(handlers.onBack).toHaveBeenCalledOnce();
    expect(handlers.onForward).toHaveBeenCalledOnce();
    const field = screen.getByRole('textbox', { name: 'Address' });
    expect(press(field, { altKey: true, key: 'ArrowLeft', code: 'ArrowLeft' })).toBe(false);
    expect(handlers.onBack).toHaveBeenCalledOnce();
  });

  it('⌘⇧C copies the address', () => {
    const handlers = actions();
    render(<Harness handlers={handlers} />);
    expect(
      press(screen.getByRole('button', { name: 'Back' }), {
        ...MOD,
        shiftKey: true,
        key: 'C',
        code: 'KeyC',
      })
    ).toBe(true);
    expect(handlers.onCopyAddress).toHaveBeenCalledOnce();
  });

  it('Esc stops a load, and does nothing when nothing is loading', () => {
    const handlers = actions();
    const { rerender } = render(<Harness handlers={handlers} />);
    const button = screen.getByRole('button', { name: 'Back' });
    expect(press(button, { key: 'Escape', code: 'Escape' })).toBe(false);
    expect(handlers.onStop).not.toHaveBeenCalled();
    rerender(<Harness handlers={handlers} loading />);
    expect(press(button, { key: 'Escape', code: 'Escape' })).toBe(true);
    expect(handlers.onStop).toHaveBeenCalledOnce();
  });

  it('Esc in the address field only reverts it, even while loading', () => {
    const handlers = actions();
    render(<Harness handlers={handlers} loading />);
    press(screen.getByRole('textbox', { name: 'Address' }), { key: 'Escape', code: 'Escape' });
    expect(handlers.onStop).not.toHaveBeenCalled();
  });

  it('leaves a key something inside the panel already handled', () => {
    const handlers = actions();
    render(<Harness handlers={handlers} loading />);
    // The same Esc on a plain button stops the load, so only the handling decides it.
    press(screen.getByRole('button', { name: 'Menu' }), { key: 'Escape', code: 'Escape' });
    expect(handlers.onStop).not.toHaveBeenCalled();
    press(screen.getByRole('button', { name: 'Back' }), { key: 'Escape', code: 'Escape' });
    expect(handlers.onStop).toHaveBeenCalledOnce();
  });

  it('a key whose action had nothing to do is left for the app', () => {
    const handlers = actions();
    handlers.onBack.mockReturnValue(false);
    render(<Harness handlers={handlers} />);
    // No page behind: ⌘[ falls through to the app's own tab history.
    expect(
      press(screen.getByRole('button', { name: 'Back' }), {
        ...MOD,
        key: '[',
        code: 'BracketLeft',
      })
    ).toBe(false);
    expect(handlers.onBack).toHaveBeenCalledOnce();
  });

  it('plain typing and other chords pass through', () => {
    const handlers = actions();
    render(<Harness handlers={handlers} />);
    const field = screen.getByRole('textbox', { name: 'Address' });
    expect(press(field, { key: 'l', code: 'KeyL' })).toBe(false);
    expect(press(field, { ...MOD, key: 'c', code: 'KeyC' })).toBe(false);
    expect(press(field, { ...MOD, key: 'a', code: 'KeyA' })).toBe(false);
    for (const spy of Object.values(handlers)) expect(spy).not.toHaveBeenCalled();
  });
});

/** The panel with the real browser row in it, the way the Agent browser draws it. */
function RowHarness({
  handlers,
  loading = false,
}: {
  handlers: ReturnType<typeof actions>;
  loading?: boolean;
}) {
  const onKeyDown = useBrowserKeys({ connectionId: 'owned', loading, ...handlers });
  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- mirrors the panel root
    <div onKeyDown={onKeyDown}>
      <BrowserChrome
        url="https://northwind.example/pricing"
        canBack
        canForward
        onBack={vi.fn()}
        onForward={vi.fn()}
        onReload={vi.fn()}
        loading={loading}
        onStop={vi.fn()}
        onSubmit={vi.fn()}
      />
    </div>
  );
}

describe('useBrowserKeys: focus in the browser row (spec §13)', () => {
  it('every key works from a row button', () => {
    const handlers = actions();
    render(<RowHarness handlers={handlers} loading />);
    const reload = screen.getByRole('button', { name: 'Stop' });
    expect(press(reload, { ...MOD, key: 'l', code: 'KeyL' })).toBe(true);
    expect(press(reload, { ...MOD, key: 'r', code: 'KeyR' })).toBe(true);
    expect(press(reload, { ...MOD, key: '[', code: 'BracketLeft' })).toBe(true);
    expect(press(reload, { ...MOD, key: ']', code: 'BracketRight' })).toBe(true);
    expect(press(reload, { key: 'Escape', code: 'Escape' })).toBe(true);
    expect(press(reload, { ...MOD, shiftKey: true, key: 'C', code: 'KeyC' })).toBe(true);
    expect(handlers.onFocusAddress).toHaveBeenCalledOnce();
    expect(handlers.onReload).toHaveBeenCalledOnce();
    expect(handlers.onBack).toHaveBeenCalledOnce();
    expect(handlers.onForward).toHaveBeenCalledOnce();
    expect(handlers.onStop).toHaveBeenCalledOnce();
    expect(handlers.onCopyAddress).toHaveBeenCalledOnce();
  });

  it.skipIf(isMac)('Alt+← and Alt+→ work from a row button', () => {
    const handlers = actions();
    render(<RowHarness handlers={handlers} />);
    const reload = screen.getByRole('button', { name: 'Reload' });
    expect(press(reload, { altKey: true, key: 'ArrowLeft', code: 'ArrowLeft' })).toBe(true);
    expect(press(reload, { altKey: true, key: 'ArrowRight', code: 'ArrowRight' })).toBe(true);
    expect(handlers.onBack).toHaveBeenCalledOnce();
    expect(handlers.onForward).toHaveBeenCalledOnce();
  });

  it('in the address field: ⌘L, ⌘R, ⌘[ ⌘] and ⌘⇧C work, and Esc reverts rather than stops', () => {
    const handlers = actions();
    render(<RowHarness handlers={handlers} loading />);
    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    const field = screen.getByRole('textbox', { name: 'Address' });
    expect(press(field, { ...MOD, key: 'l', code: 'KeyL' })).toBe(true);
    expect(press(field, { ...MOD, key: 'r', code: 'KeyR' })).toBe(true);
    expect(press(field, { ...MOD, key: '[', code: 'BracketLeft' })).toBe(true);
    expect(press(field, { ...MOD, key: ']', code: 'BracketRight' })).toBe(true);
    expect(press(field, { ...MOD, shiftKey: true, key: 'C', code: 'KeyC' })).toBe(true);
    expect(handlers.onFocusAddress).toHaveBeenCalledOnce();
    expect(handlers.onReload).toHaveBeenCalledOnce();
    expect(handlers.onBack).toHaveBeenCalledOnce();
    expect(handlers.onForward).toHaveBeenCalledOnce();
    expect(handlers.onCopyAddress).toHaveBeenCalledOnce();
    // Esc while loading: the field puts the address back, and the load goes on.
    act(() => {
      press(field, { key: 'Escape', code: 'Escape' });
    });
    expect(handlers.onStop).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Address' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Address:/ })).toBeInTheDocument();
  });
});

describe('useBrowserKeys: outside the panel', () => {
  it('never takes a key, so the app’s own Back and Forward keep their chords', () => {
    const handlers = actions();
    render(<Harness handlers={handlers} />);
    const elsewhere = screen.getByRole('button', { name: 'Somewhere else' });
    expect(press(elsewhere, { ...MOD, key: '[', code: 'BracketLeft' })).toBe(false);
    expect(press(elsewhere, { ...MOD, key: ']', code: 'BracketRight' })).toBe(false);
    expect(press(elsewhere, { ...MOD, key: 'r', code: 'KeyR' })).toBe(false);
    expect(press(elsewhere, { ...MOD, key: 'l', code: 'KeyL' })).toBe(false);
    for (const spy of Object.values(handlers)) expect(spy).not.toHaveBeenCalled();
  });
});

describe('useBrowserKeys: chords forwarded from the native page', () => {
  it('does what the chord says for this page', () => {
    const bridge = installBridge();
    const handlers = actions();
    render(<Harness handlers={handlers} />);
    bridge.forward('owned', 'focus-address');
    bridge.forward('owned', 'reload');
    bridge.forward('owned', 'copy-address');
    expect(handlers.onFocusAddress).toHaveBeenCalledOnce();
    expect(handlers.onReload).toHaveBeenCalledOnce();
    // Copied by the app from the address it shows, the same as ⌘⇧C in the panel.
    expect(handlers.onCopyAddress).toHaveBeenCalledOnce();
  });

  it('ignores a chord from another page', () => {
    const bridge = installBridge();
    const handlers = actions();
    render(<Harness handlers={handlers} />);
    bridge.forward('another', 'reload');
    expect(handlers.onReload).not.toHaveBeenCalled();
  });

  it('listens only while a page is open, and stops listening on unmount', () => {
    const bridge = installBridge();
    const handlers = actions();
    const { rerender, unmount } = render(<Harness handlers={handlers} connectionId={null} />);
    expect(bridge.listeners.size).toBe(0);
    rerender(<Harness handlers={handlers} />);
    expect(bridge.listeners.size).toBe(1);
    unmount();
    expect(bridge.listeners.size).toBe(0);
  });
});

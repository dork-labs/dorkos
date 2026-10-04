// @vitest-environment jsdom
/**
 * An extension dialog end to end: `api.registerDialog` through the real API
 * factory and the real extension registry into the real `DialogHost` (DOR-2576).
 * Only the URL deep-link hooks are stubbed, since they need a router and an
 * extension dialog never has a `urlParam`.
 */
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ExtensionDialogProps } from '@dorkos/extension-api';
import { createInitialSlots, useExtensionRegistry } from '@/layers/shared/model';
import { createExtensionAPI } from '@/layers/features/extensions/model/extension-api-factory';
import type { ExtensionAPIDeps } from '@/layers/features/extensions/model/types';
import { DialogHost } from '../ui/DialogHost';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  const inertDeepLink = () => ({ isOpen: false, close: () => {}, open: () => {} });
  return {
    ...actual,
    useSettingsDeepLink: inertDeepLink,
    useTasksDeepLink: inertDeepLink,
    useProfileDeepLink: () => ({ ...inertDeepLink(), memberId: null }),
  };
});

/** Factory deps wired to the real registry; the rest is inert. */
function makeDeps(): ExtensionAPIDeps {
  const registry = useExtensionRegistry.getState();
  return {
    registry: {
      register: (slotId, contribution) =>
        registry.register(slotId as 'dialog', contribution as never),
      getContributions: (slotId) => registry.getContributions(slotId as 'dialog'),
      setTabMarker: vi.fn(),
      clearTabMarkers: vi.fn(),
    },
    eventBridge: { subscribe: vi.fn().mockReturnValue(() => {}) },
    dispatcherContext: {
      getStore: () => ({}) as ReturnType<ExtensionAPIDeps['dispatcherContext']['getStore']>,
      setTheme: vi.fn(),
    },
    navigate: vi.fn(),
    appStore: { getState: () => ({}), subscribe: () => () => {} },
    availableSlots: new Set(['dialog'] as const),
    registerCommandHandler: vi.fn(),
    unregisterCommandHandler: vi.fn(),
  } as ExtensionAPIDeps;
}

/** How many times the dialog below has mounted. */
let mounts = 0;

/**
 * A dialog the way an extension draws one, which cannot import the host's UI:
 * its own backdrop, frame, Escape handling and close button.
 */
function PauseDialog({ onOpenChange }: ExtensionDialogProps) {
  useEffect(() => {
    mounts += 1;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onOpenChange]);
  return (
    <div
      data-testid="backdrop"
      role="presentation"
      onClick={(e) => e.target === e.currentTarget && onOpenChange(false)}
    >
      <div role="dialog" aria-label="Pause">
        <button type="button" onClick={() => onOpenChange(false)}>
          Close
        </button>
      </div>
    </div>
  );
}

/** A dialog that ignores `open` and always draws itself. */
function CarelessDialog() {
  return <div role="dialog" aria-label="Careless" />;
}

beforeEach(() => {
  mounts = 0;
  useExtensionRegistry.setState({ slots: createInitialSlots() });
});

afterEach(() => {
  cleanup();
});

describe('extension dialogs (registerDialog → DialogHost)', () => {
  it('stays closed until open() is called', () => {
    const { api } = createExtensionAPI('flow', makeDeps());
    api.registerDialog('pause', PauseDialog);
    render(<DialogHost />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mounts).toBe(0);
  });

  it('opens on open(), closes on close(), and reopens', () => {
    const { api } = createExtensionAPI('flow', makeDeps());
    const dialog = api.registerDialog('pause', PauseDialog);
    render(<DialogHost />);

    act(() => dialog.open());
    expect(screen.getByRole('dialog', { name: 'Pause' })).toBeInTheDocument();

    act(() => dialog.close());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => dialog.open());
    expect(screen.getByRole('dialog', { name: 'Pause' })).toBeInTheDocument();
    // Unmounted while closed, so each opening starts fresh.
    expect(mounts).toBe(2);
  });

  it('opens when open() is called before the host renders', () => {
    const { api } = createExtensionAPI('flow', makeDeps());
    api.registerDialog('pause', PauseDialog).open();
    render(<DialogHost />);

    expect(screen.getByRole('dialog', { name: 'Pause' })).toBeInTheDocument();
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['a click outside', () => fireEvent.click(screen.getByTestId('backdrop'))],
    ['its own close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
  ])('closes on %s through onOpenChange, and reopens after', (_how, closeIt) => {
    const { api } = createExtensionAPI('flow', makeDeps());
    const dialog = api.registerDialog('pause', PauseDialog);
    render(<DialogHost />);

    act(() => dialog.open());
    act(() => closeIt());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => dialog.open());
    expect(screen.getByRole('dialog', { name: 'Pause' })).toBeInTheDocument();
  });

  it('hides a dialog that ignores its open prop', () => {
    const { api } = createExtensionAPI('flow', makeDeps());
    const dialog = api.registerDialog('careless', CarelessDialog);
    render(<DialogHost />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => dialog.open());
    expect(screen.getByRole('dialog', { name: 'Careless' })).toBeInTheDocument();
    act(() => dialog.close());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never throws from onOpenChange, even after the dialog closed or the extension left', () => {
    let captured: ExtensionDialogProps['onOpenChange'] | null = null;
    function Capturing({ onOpenChange }: ExtensionDialogProps) {
      useEffect(() => {
        captured = onOpenChange;
      }, [onOpenChange]);
      return <div role="dialog" aria-label="Capturing" />;
    }
    const { api, cleanups } = createExtensionAPI('flow', makeDeps());
    const dialog = api.registerDialog('capturing', Capturing);
    render(<DialogHost />);
    act(() => dialog.open());
    const onOpenChange = captured!;

    act(() => expect(() => onOpenChange(false)).not.toThrow());
    act(() => expect(() => onOpenChange(false)).not.toThrow());
    act(() => {
      for (const fn of cleanups) fn();
    });
    expect(() => onOpenChange(true)).not.toThrow();
    expect(() => dialog.open()).not.toThrow();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps one extension dialog open at a time, across extensions', () => {
    const flow = createExtensionAPI('flow', makeDeps()).api;
    const other = createExtensionAPI('other', makeDeps()).api;
    const pause = flow.registerDialog('pause', PauseDialog);
    const careless = other.registerDialog('careless', CarelessDialog);
    render(<DialogHost />);

    act(() => pause.open());
    expect(screen.getByRole('dialog', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Careless' })).not.toBeInTheDocument();

    act(() => careless.open());
    expect(screen.getByRole('dialog', { name: 'Careless' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Pause' })).not.toBeInTheDocument();
  });

  it('closes a dialog that throws, leaving the host and other dialogs working', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('boom');
    }
    const { api } = createExtensionAPI('flow', makeDeps());
    const broken = api.registerDialog('broken', Broken);
    const pause = api.registerDialog('pause', PauseDialog);
    render(<DialogHost />);

    act(() => broken.open());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('flow:broken crashed and was closed'),
      expect.any(Error)
    );

    act(() => pause.open());
    expect(screen.getByRole('dialog', { name: 'Pause' })).toBeInTheDocument();

    // Reopening mounts it fresh behind a new boundary: it renders, throws and is
    // closed again, rather than staying stuck in the old boundary's fallback.
    const crashLogs = () =>
      errors.mock.calls.filter(([msg]) => String(msg).includes('flow:broken crashed')).length;
    expect(crashLogs()).toBe(1);
    act(() => broken.open());
    expect(crashLogs()).toBe(2);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    errors.mockRestore();
  });
});

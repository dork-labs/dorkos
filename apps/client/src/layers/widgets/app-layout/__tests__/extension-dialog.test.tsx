// @vitest-environment jsdom
/**
 * An extension dialog end to end: `api.registerDialog` through the real API
 * factory and the real extension registry into the real `DialogHost` (DOR-2576).
 * Only the URL deep-link hooks are stubbed, since they need a router and an
 * extension dialog never has a `urlParam`.
 */
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ExtensionDialogProps } from '@dorkos/extension-api';
import {
  createDialogOpenState,
  createInitialSlots,
  useExtensionRegistry,
} from '@/layers/shared/model';
import { setExtensionNames } from '@/layers/shared/lib/extension-names';
import { createExtensionAPI } from '@/layers/features/extensions/model/extension-api-factory';
import type { ExtensionAPIDeps } from '@/layers/features/extensions/model/types';
import { DialogHost } from '../ui/DialogHost';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/layers/shared/ui';
import { EXTENSION_CONTRIBUTION_KEYS } from '@dorkos/extension-api';

/** Every place declared, for tests of what a registration does once it is allowed. */
const DECLARES_ALL = {
  contributions: Object.fromEntries(EXTENSION_CONTRIBUTION_KEYS.map((key) => [key, true])),
  // And a person allowed every one (DOR-4282).
  allowedSlots: [...EXTENSION_CONTRIBUTION_KEYS],
};

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
      setPageBadge: vi.fn(),
      clearPageBadges: vi.fn(),
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

/**
 * Render the host with DorkOS's app names already listed (the loader fills
 * them before any app activates), so the strip over an app's dialog has the
 * names to draw.
 */
function renderHost(names: Record<string, string> = {}) {
  setExtensionNames(names);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DialogHost />
    </QueryClientProvider>
  );
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
    const { api } = createExtensionAPI('flow', makeDeps(), [], DECLARES_ALL);
    api.registerDialog('pause', PauseDialog);
    renderHost();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mounts).toBe(0);
  });

  it('opens on open(), closes on close(), and reopens', () => {
    const { api } = createExtensionAPI('flow', makeDeps(), [], DECLARES_ALL);
    const dialog = api.registerDialog('pause', PauseDialog);
    renderHost();

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
    const { api } = createExtensionAPI('flow', makeDeps(), [], DECLARES_ALL);
    api.registerDialog('pause', PauseDialog).open();
    renderHost();

    expect(screen.getByRole('dialog', { name: 'Pause' })).toBeInTheDocument();
  });

  it.each([
    ['Escape', () => fireEvent.keyDown(window, { key: 'Escape' })],
    ['a click outside', () => fireEvent.click(screen.getByTestId('backdrop'))],
    ['its own close button', () => fireEvent.click(screen.getByRole('button', { name: 'Close' }))],
  ])('closes on %s through onOpenChange, and reopens after', (_how, closeIt) => {
    const { api } = createExtensionAPI('flow', makeDeps(), [], DECLARES_ALL);
    const dialog = api.registerDialog('pause', PauseDialog);
    renderHost();

    act(() => dialog.open());
    act(() => closeIt());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => dialog.open());
    expect(screen.getByRole('dialog', { name: 'Pause' })).toBeInTheDocument();
  });

  it('hides a dialog that ignores its open prop', () => {
    const { api } = createExtensionAPI('flow', makeDeps(), [], DECLARES_ALL);
    const dialog = api.registerDialog('careless', CarelessDialog);
    renderHost();

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
    const { api, cleanups } = createExtensionAPI('flow', makeDeps(), [], DECLARES_ALL);
    const dialog = api.registerDialog('capturing', Capturing);
    renderHost();
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
    const flow = createExtensionAPI('flow', makeDeps(), [], DECLARES_ALL).api;
    const other = createExtensionAPI('other', makeDeps(), [], DECLARES_ALL).api;
    const pause = flow.registerDialog('pause', PauseDialog);
    const careless = other.registerDialog('careless', CarelessDialog);
    renderHost();

    act(() => pause.open());
    expect(screen.getByRole('dialog', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Careless' })).not.toBeInTheDocument();

    act(() => careless.open());
    expect(screen.getByRole('dialog', { name: 'Careless' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Pause' })).not.toBeInTheDocument();
  });

  describe('the strip DorkOS draws over an app’s dialog (DOR-4282)', () => {
    /** An app dialog whose own text names DorkOS, so the strip's name can only come from the record. */
    function NamedNotice() {
      return (
        <div role="dialog" aria-label="Notice">
          <p>DorkOS</p>
          <p>From DorkOS</p>
        </div>
      );
    }

    it('names the app from DorkOS’s record, outside the app’s own dialog', () => {
      const { api } = createExtensionAPI('planner', makeDeps(), [], DECLARES_ALL);
      api.registerDialog('notice', NamedNotice).open();
      renderHost({ planner: 'Planner', other: 'Other' });

      const strip = screen.getByText('From Planner');
      expect(strip.closest('[data-slot="extension-dialog-origin"]')).toBeInTheDocument();
      const dialog = screen.getByRole('dialog', { name: 'Notice' });
      expect(dialog).not.toContainElement(strip);
      expect(within(dialog).queryByText('From Planner')).not.toBeInTheDocument();
    });

    it('draws nothing, never the id, while the name is not known', () => {
      const { api } = createExtensionAPI('planner', makeDeps(), [], DECLARES_ALL);
      api.registerDialog('notice', NamedNotice).open();
      renderHost();

      expect(screen.getByRole('dialog', { name: 'Notice' })).toBeInTheDocument();
      expect(document.querySelector('[data-slot="extension-dialog-origin"]')).toBeNull();
      expect(screen.queryByText(/From planner/)).not.toBeInTheDocument();
    });

    it('takes no clicks and stays out of what a modal hides from screen readers', () => {
      const { api } = createExtensionAPI('planner', makeDeps(), [], DECLARES_ALL);
      api.registerDialog('notice', NamedNotice).open();
      renderHost({ planner: 'Planner' });

      const band = screen.getByText('From Planner').closest('[role="status"]');
      expect(band).toHaveAttribute('aria-live', 'polite');
      expect(band).toHaveClass('pointer-events-none');
      // Nothing inside opts back into clicks.
      expect(band?.querySelector('.pointer-events-auto')).toBeNull();
    });

    it('stays readable beside a modal Radix dialog, which hides the rest of the page', () => {
      function ModalDialog({ onOpenChange }: ExtensionDialogProps) {
        return (
          <Dialog open onOpenChange={onOpenChange}>
            <DialogContent>
              <DialogTitle>Modal</DialogTitle>
              <DialogDescription>An app dialog.</DialogDescription>
            </DialogContent>
          </Dialog>
        );
      }
      const { api } = createExtensionAPI('planner', makeDeps(), [], DECLARES_ALL);
      api.registerDialog('modal', ModalDialog).open();
      const { container } = renderHost({ planner: 'Planner' });

      expect(screen.getByRole('dialog', { name: 'Modal' })).toBeInTheDocument();
      // The modal did hide the rest of the page…
      expect(container.closest('[aria-hidden="true"]')).not.toBeNull();
      // …but not the strip.
      expect(screen.getByText('From Planner').closest('[aria-hidden="true"]')).toBeNull();
    });

    it('goes when the dialog closes', () => {
      const { api } = createExtensionAPI('planner', makeDeps(), [], DECLARES_ALL);
      const dialog = api.registerDialog('notice', NamedNotice);
      renderHost({ planner: 'Planner' });

      act(() => dialog.open());
      expect(screen.getByText('From Planner')).toBeInTheDocument();
      act(() => dialog.close());
      expect(screen.queryByText('From Planner')).not.toBeInTheDocument();
    });

    it('is not drawn over DorkOS’s own dialogs', () => {
      const openState = createDialogOpenState();
      useExtensionRegistry
        .getState()
        .register('dialog', { id: 'make-todo', component: CarelessDialog, openState });
      openState.set(true);
      renderHost({ planner: 'Planner' });

      expect(screen.getByRole('dialog', { name: 'Careless' })).toBeInTheDocument();
      expect(document.querySelector('[data-slot="extension-dialog-origin"]')).toBeNull();
    });
  });

  it('closes a dialog that throws, leaving the host and other dialogs working', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): never {
      throw new Error('boom');
    }
    const { api } = createExtensionAPI('flow', makeDeps(), [], DECLARES_ALL);
    const broken = api.registerDialog('broken', Broken);
    const pause = api.registerDialog('pause', PauseDialog);
    renderHost();

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

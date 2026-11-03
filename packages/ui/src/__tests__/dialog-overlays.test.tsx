/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { createRef } from 'react';
import { UiProvider } from '../ui-provider.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from '../dialog.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../alert-dialog.js';

const hosts: HTMLElement[] = [];
afterEach(() => {
  cleanup();
  for (const host of hosts) host.remove();
  hosts.length = 0;
});

function host() {
  const element = document.createElement('div');
  document.body.append(element);
  hosts.push(element);
  return element;
}

describe('Dialog portable behavior', () => {
  it('opens from a trigger, focuses the panel, and restores trigger focus after Escape', async () => {
    render(
      <Dialog>
        <DialogTrigger>Open details</DialogTrigger>
        <DialogContent>
          <DialogTitle>Details</DialogTitle>
          <DialogDescription>Room details.</DialogDescription>
        </DialogContent>
      </Dialog>
    );
    const trigger = screen.getByRole('button', { name: 'Open details' });
    trigger.focus();
    fireEvent.click(trigger);
    const panel = await screen.findByRole('dialog');
    expect(panel).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement ?? panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('keeps the custom close control, phone card bounds, and package motion rules', async () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Details</DialogTitle>
          <DialogDescription>Room details.</DialogDescription>
        </DialogContent>
      </Dialog>
    );
    const panel = await screen.findByRole('dialog');
    expect(panel).toHaveClass(
      'w-[calc(100%-2rem)]',
      'max-h-[calc(100dvh-2rem)]',
      'overflow-y-auto'
    );
    expect(panel).toHaveClass('motion-reduce:animate-none!');
    // A duration can still imply a transition even when animation is removed.
    expect(panel).toHaveClass('motion-reduce:transition-none!');
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass(
      'absolute',
      'top-4',
      'right-4'
    );
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass(
      'motion-reduce:animate-none!'
    );
  });

  it('uses the nearest provider for content and explicit Portal container for handmade content', async () => {
    const provided = host();
    const explicit = host();
    render(
      <UiProvider portalContainer={provided}>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Provided</DialogTitle>
            <DialogDescription>In provider host.</DialogDescription>
          </DialogContent>
        </Dialog>
        <Dialog open>
          <DialogPortal container={explicit}>
            <div data-testid="explicit-dialog-portal">Explicit</div>
          </DialogPortal>
        </Dialog>
      </UiProvider>
    );
    expect(provided).toContainElement(await screen.findByRole('dialog'));
    expect(explicit).toContainElement(await screen.findByTestId('explicit-dialog-portal'));
    expect(provided).not.toContainElement(screen.getByTestId('explicit-dialog-portal'));
  });

  it('lets an explicit null DialogPortal container bypass the provider back to body', async () => {
    const provided = host();
    render(
      <UiProvider portalContainer={provided}>
        <Dialog open>
          <DialogPortal container={null}>
            <div data-testid="body-dialog-portal">Body</div>
          </DialogPortal>
        </Dialog>
      </UiProvider>
    );
    const portal = await screen.findByTestId('body-dialog-portal');
    expect(portal.parentElement).toBe(document.body);
    expect(provided).not.toContainElement(portal);
  });

  it('passes content refs and escape callbacks through to Radix', async () => {
    const ref = createRef<HTMLDivElement>();
    const onEscapeKeyDown = vi.fn();
    render(
      <Dialog open>
        <DialogContent ref={ref} onEscapeKeyDown={onEscapeKeyDown}>
          <DialogTitle>Details</DialogTitle>
          <DialogDescription>Room details.</DialogDescription>
        </DialogContent>
      </Dialog>
    );
    const panel = await screen.findByRole('dialog');
    expect(ref.current).toBe(panel);
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onEscapeKeyDown).toHaveBeenCalledOnce();
  });
});

describe('Where a dialog opens', () => {
  const opened = async (children: React.ReactNode) => {
    render(
      <Dialog defaultOpen>
        <DialogContent>
          <DialogTitle>Details</DialogTitle>
          <DialogDescription>Room details.</DialogDescription>
          {children}
        </DialogContent>
      </Dialog>
    );
    return screen.findByRole('dialog');
  };

  it('opens on the panel when it has no field, never on the close button', async () => {
    const panel = await opened(null);
    await waitFor(() => expect(panel).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
  });

  it('skips a destructive button at the top of the dialog', async () => {
    const panel = await opened(<button>Delete everything</button>);
    await waitFor(() => expect(panel).toHaveFocus());
    expect(screen.getByRole('button', { name: 'Delete everything' })).not.toHaveFocus();
  });

  it('opens on the first field, past a button and a disabled field', async () => {
    await opened(
      <>
        <button>Reset</button>
        <input aria-label="Off" disabled />
        <input aria-label="Name" />
      </>
    );
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
  });

  it('leaves the choice to a caller that makes its own', async () => {
    render(
      <Dialog defaultOpen>
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById('chosen')?.focus();
          }}
        >
          <DialogTitle>Details</DialogTitle>
          <DialogDescription>Room details.</DialogDescription>
          <input aria-label="Name" />
          <button id="chosen">Chosen</button>
        </DialogContent>
      </Dialog>
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Chosen' })).toHaveFocus());
  });

  it('draws a dialog with no border, on the same surface as a popover', async () => {
    const panel = await opened(null);
    expect(panel).toHaveClass('bg-dui-popover', 'rounded-xl', 'shadow-xl');
    expect(panel.className).not.toMatch(/(?<![\w:-])border(?![\w-])/);
  });
});

describe('AlertDialog portable behavior', () => {
  it('opens on Cancel, not on the action', async () => {
    render(
      <AlertDialog defaultOpen>
        <AlertDialogContent>
          <AlertDialogTitle>Delete room?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          <AlertDialogAction variant="destructive">Delete</AlertDialogAction>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
  });

  it('requires its explicit actions and retains phone-sized exits', async () => {
    render(
      <AlertDialog>
        <AlertDialogTrigger>Ask</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>Delete room?</AlertDialogTitle>
          <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction>Delete</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    const panel = await screen.findByRole('alertdialog');
    expect(panel).toHaveClass('w-[calc(100%-2rem)]', 'max-h-[calc(100dvh-2rem)]');
    expect(panel).toHaveClass('motion-reduce:animate-none!');
    expect(panel).toHaveClass('motion-reduce:transition-none!');
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    for (const name of ['Cancel', 'Delete'])
      expect(screen.getByRole('button', { name })).toHaveClass('h-11', 'md:h-9');
    // Radix's current AlertDialog closes on Escape; preserve its actual default.
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Ask' })).toHaveFocus();
  });

  it('routes implicit and explicit portals independently', async () => {
    const provided = host();
    const explicit = host();
    render(
      <UiProvider portalContainer={provided}>
        <AlertDialog open>
          <AlertDialogContent>
            <AlertDialogTitle>Confirm</AlertDialogTitle>
            <AlertDialogDescription>Proceed?</AlertDialogDescription>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open>
          <AlertDialogPortal container={explicit}>
            <div data-testid="explicit-alert-portal">Explicit</div>
          </AlertDialogPortal>
        </AlertDialog>
      </UiProvider>
    );
    expect(provided).toContainElement(await screen.findByRole('alertdialog'));
    expect(explicit).toContainElement(await screen.findByTestId('explicit-alert-portal'));
  });
});

/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { UiProvider } from '../ui-provider.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
} from '../sheet.js';

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

describe('Sheet portable behavior', () => {
  it('opens from a trigger, keeps its side sizing and close control, and restores focus', async () => {
    render(
      <Sheet>
        <SheetTrigger>Show panel</SheetTrigger>
        <SheetContent side="left">
          <SheetTitle>Panel</SheetTitle>
          <SheetDescription>Details</SheetDescription>
        </SheetContent>
      </Sheet>
    );
    const trigger = screen.getByRole('button', { name: 'Show panel' });
    trigger.focus();
    fireEvent.click(trigger);
    const panel = await screen.findByRole('dialog');
    expect(panel).toHaveClass('w-3/4', 'sm:max-w-sm', 'motion-reduce:animate-none!');
    expect(panel).toHaveClass('data-[state=open]:slide-in-from-left');
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toHaveClass(
      'motion-reduce:animate-none!'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('passes its content ref and allows callers to remove the built-in close button', async () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <Sheet open>
        <SheetContent side="bottom" showCloseButton={false} ref={ref}>
          <SheetTitle>Bottom panel</SheetTitle>
          <SheetDescription>Details</SheetDescription>
        </SheetContent>
      </Sheet>
    );
    const panel = await screen.findByRole('dialog');
    expect(ref.current).toBe(panel);
    expect(panel).toHaveClass('data-[state=open]:slide-in-from-bottom');
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('routes implicit content to the provider and an explicit Portal container separately', async () => {
    const provided = host();
    const explicit = host();
    render(
      <UiProvider portalContainer={provided}>
        <Sheet open>
          <SheetContent>
            <SheetTitle>Provided panel</SheetTitle>
            <SheetDescription>Details</SheetDescription>
          </SheetContent>
        </Sheet>
        <Sheet open>
          <SheetPortal container={explicit}>
            <div data-testid="explicit-sheet-portal">Explicit</div>
          </SheetPortal>
        </Sheet>
      </UiProvider>
    );
    expect(provided).toContainElement(await screen.findByRole('dialog'));
    expect(explicit).toContainElement(await screen.findByTestId('explicit-sheet-portal'));
  });
});

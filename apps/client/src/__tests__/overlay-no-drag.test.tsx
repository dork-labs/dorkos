// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/layers/shared/ui';

/**
 * Surfaces that portal over the Mac window's header must opt out of the
 * window drag, or their buttons stop taking clicks there.
 *
 * `index.css` makes `.app-drag-region` a window drag area, and its blanket
 * no-drag rule only reaches descendants. Dialogs, sheets, drawers, popovers
 * and menus portal to `<body>`, so they need a rule of their own. jsdom does
 * not know `-webkit-app-region`, so this reads the real selector out of the
 * stylesheet and checks it against the real components' DOM: a renamed
 * `data-slot` or role fails here instead of on someone's Mac.
 */
const indexCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../index.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

/** Selectors of every rule in the stylesheet that sets `-webkit-app-region: no-drag`. */
function noDragSelectors(): string[] {
  const rules = /([^{}]+)\{([^{}]*)\}/g;
  const selectors: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = rules.exec(indexCss)) !== null) {
    if (/-webkit-app-region:\s*no-drag/.test(match[2])) {
      selectors.push(match[1].trim().replace(/\s+/g, ' '));
    }
  }
  return selectors;
}

/** The no-drag rule for floating surfaces: the one not scoped under a drag region. */
const overlaySelector = noDragSelectors().find((s) => !s.includes('.app-drag-region'));

/** Whether an element, or something it sits inside, is carved out of the drag area. */
function isNoDrag(el: Element): boolean {
  return el.closest(overlaySelector!) !== null;
}

beforeEach(() => {
  document.documentElement.classList.add('desktop-darwin');
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove('desktop-darwin');
});

describe('floating surfaces opt out of the macOS window drag (index.css)', () => {
  it('has a no-drag rule for floating surfaces, gated on desktop-darwin', () => {
    expect(overlaySelector).toBeDefined();
    expect(overlaySelector!.startsWith('.desktop-darwin ')).toBe(true);
  });

  it('leaves the header itself draggable', () => {
    render(<header className="app-drag-region" data-testid="header" />);
    expect(isNoDrag(screen.getByTestId('header'))).toBe(false);
  });

  it('covers a dialog', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Details</DialogDescription>
          <button type="button">Inside</button>
        </DialogContent>
      </Dialog>
    );
    expect(isNoDrag(screen.getByText('Inside'))).toBe(true);
  });

  it('covers a sheet', () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Panel</SheetTitle>
          <SheetDescription>Details</SheetDescription>
          <button type="button">Inside</button>
        </SheetContent>
      </Sheet>
    );
    expect(isNoDrag(screen.getByText('Inside'))).toBe(true);
  });

  it('covers a drawer, the shape the settings dialog takes in a narrow window', () => {
    render(
      <Drawer open>
        <DrawerContent>
          <DrawerTitle>Settings</DrawerTitle>
          <DrawerDescription>Details</DrawerDescription>
          <button type="button">Close</button>
        </DrawerContent>
      </Drawer>
    );
    expect(isNoDrag(screen.getByText('Close'))).toBe(true);
  });

  it('covers a popover', () => {
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>
          <button type="button">Inside</button>
        </PopoverContent>
      </Popover>
    );
    expect(isNoDrag(screen.getByText('Inside'))).toBe(true);
  });

  it('covers a dropdown menu', () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Inside</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
    expect(isNoDrag(screen.getByText('Inside'))).toBe(true);
  });
});

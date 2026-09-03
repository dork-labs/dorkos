// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../dialog';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
} from '../alert-dialog';

afterEach(cleanup);

function openDialog() {
  render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>Rename this room</DialogTitle>
        <DialogDescription>Pick a new name.</DialogDescription>
      </DialogContent>
    </Dialog>
  );
  return screen.getByRole('dialog');
}

function openAlertDialog() {
  render(
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogTitle>Delete this room?</AlertDialogTitle>
        <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
      </AlertDialogContent>
    </AlertDialog>
  );
  return screen.getByRole('alertdialog');
}

// jsdom lays nothing out, so these read the rules rather than the pixels. What
// they pin is that a dialog stays a CARD on a phone: it was `w-full` on a fixed,
// viewport-centred box — no side gutter at all below 512px — with `sm:rounded-lg`
// squaring its corners on the exact screens where it filled the whole width.
describe('a dialog is a card at every width', () => {
  it('leaves a gutter down each side of a plain Dialog', () => {
    const panel = openDialog();
    expect(panel).toHaveClass('w-[calc(100%-2rem)]');
    expect(panel).not.toHaveClass('w-full');
  });

  it('keeps the plain Dialog’s corners rounded below 640px', () => {
    const panel = openDialog();
    expect(panel).toHaveClass('rounded-lg');
    expect(panel.className).not.toContain('sm:rounded-lg');
  });

  it('never lets its own content decide how wide or how tall it is', () => {
    // The box is a grid, and a grid's default `auto` track is sized by its
    // content — so one wide child widened the column past the dialog and every
    // sibling stretched out with it, over the page beside it. Pinning the track
    // to the box fixes that, and then the same text wraps to more lines, which
    // is when a centred box with no height cap starts hanging off both ends of
    // the screen at once.
    const panel = openDialog();
    expect(panel).toHaveClass(
      'grid-cols-[minmax(0,1fr)]',
      'max-h-[calc(100dvh-2rem)]',
      'overflow-y-auto'
    );
  });

  it('gives a confirmation every one of those rules too', () => {
    const panel = openAlertDialog();
    expect(panel).toHaveClass(
      'w-[calc(100%-2rem)]',
      'rounded-lg',
      'grid-cols-[minmax(0,1fr)]',
      'max-h-[calc(100dvh-2rem)]',
      'overflow-y-auto'
    );
    expect(panel).not.toHaveClass('w-full');
    expect(panel.className).not.toContain('sm:rounded-lg');
  });
});

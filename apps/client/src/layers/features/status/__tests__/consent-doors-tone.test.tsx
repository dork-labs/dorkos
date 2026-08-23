/**
 * @vitest-environment jsdom
 */
/**
 * The two consent doors, read as a pair.
 *
 * There are exactly two dialogs in the product that ask a person to confirm a
 * mode which will not stop to ask — one for a session somebody is sitting in
 * front of (`AutonomyConfirmDialog`), one for a surface nobody is watching
 * (`UnattendedAutonomyDialog`) — and they must agree about tone or the same
 * question looks like two different questions. This file is the pair test: what
 * colour they open in, what their confirm button looks like, and which sentence
 * survives the restyle untouched.
 *
 * They live in different layers and cannot share a home, which is exactly why
 * one file has to hold both. Everything about the dialogs' *shape* is covered
 * where each one lives.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';

import { UnattendedAutonomyDialog } from '@/layers/shared/ui';
import { AutonomyConfirmDialog } from '../ui/AutonomyConfirmDialog';

afterEach(cleanup);

/** Claude Code's top stop, as its runtime declares it. */
const AUTONOMY: PermissionModeDescriptor = {
  id: 'bypassPermissions',
  label: 'Bypass permissions',
  stop: 'autonomy',
  asks: 'never',
  reach: 'everything',
  promise: 'Runs everything without asking, including outside this project.',
};

/** Codex's middle stop — through the same door, and the one that bends a promise. */
const WORKSPACE_WRITE: PermissionModeDescriptor = {
  id: 'acceptEdits',
  label: 'Workspace write',
  stop: 'act',
  asks: 'never',
  reach: 'edit',
  promise: "Edits and runs commands in this project. Codex can't pause to ask.",
};

/** Render each door at one mode, so a rule can be asserted against both at once. */
function bothDoors(descriptor: PermissionModeDescriptor): Array<[string, () => void]> {
  return [
    [
      'the session door',
      () =>
        render(
          <AutonomyConfirmDialog
            descriptor={descriptor}
            onCancel={vi.fn()}
            onConfirm={vi.fn()}
            canRemember
          />
        ),
    ],
    [
      'the unattended door',
      () =>
        render(
          <UnattendedAutonomyDialog
            descriptor={descriptor}
            consequence="Runs on its schedule without waiting for you."
            onCancel={vi.fn()}
            onConfirm={vi.fn()}
          />
        ),
    ],
  ];
}

/**
 * The confirm button — the only button whose label repeats the dialog's title.
 * (The title itself is a heading, so the name is unambiguous.)
 */
function confirmButton(descriptor: PermissionModeDescriptor): HTMLElement {
  const stopWord = descriptor.stop === 'autonomy' ? 'Full autonomy' : 'Act';
  return screen.getByRole('button', { name: `Turn on ${stopWord}` });
}

/** The classes on the glyph beside the dialog's title — lucide names the shape. */
function titleIcon(): string {
  const heading = document.querySelector('[role="alertdialog"] h2');
  const svg = heading?.querySelector('svg');
  if (!svg) throw new Error('the dialog title has no icon');
  return svg.getAttribute('class') ?? '';
}

describe('what the consent doors look like', () => {
  for (const descriptor of [AUTONOMY, WORKSPACE_WRITE]) {
    for (const [name, open] of bothDoors(descriptor)) {
      it(`${name} confirms with the plain primary button at ${descriptor.stop} — no red`, () => {
        open();
        expect(confirmButton(descriptor).className).not.toMatch(/bg-red-/);
      });

      it(`${name} spends no red anywhere at ${descriptor.stop}`, () => {
        open();
        // Red is reserved for genuine alarms — quarantine, unreadable rules,
        // errors. A door a person walked up to deliberately is not one
        // (spec `full-power-defaults`, D8).
        expect(document.body.innerHTML).not.toMatch(/(text|bg|border|ring)-red-/);
      });
    }
  }

  it('opens green at full power, on both doors', () => {
    for (const [, open] of bothDoors(AUTONOMY)) {
      open();
      expect(document.querySelector('.text-status-success')).not.toBeNull();
      cleanup();
    }
  });

  it('draws the icon of the stop being turned on, not a fixed one', () => {
    // The door opens for the middle stop too. A title reading "Turn on Act"
    // beside the full-autonomy bolt claims a position the person is not taking
    // — the same positional lie `STOP_ICONS` exists to prevent, and it shipped
    // once because nothing here asserted which icon was drawn.
    for (const [name, open] of bothDoors(AUTONOMY)) {
      open();
      expect(titleIcon(), `${name} at the autonomy stop`).toMatch(/lucide-zap/);
      cleanup();
    }
    for (const [name, open] of bothDoors(WORKSPACE_WRITE)) {
      open();
      const icon = titleIcon();
      expect(icon, `${name} at the act stop`).toMatch(/lucide-sparkles/);
      expect(icon, `${name} must not borrow the autonomy bolt`).not.toMatch(/lucide-zap/);
      cleanup();
    }
  });

  it('keeps the honest fact line word for word', () => {
    // The restyle changed the colour, never the claim. This sentence is the one
    // thing standing between "Act" and a runtime that cannot pause to ask.
    for (const [, open] of bothDoors(WORKSPACE_WRITE)) {
      open();
      expect(screen.getByTestId('consent-asks-note')).toHaveTextContent(
        'This stop never pauses to ask. Whatever it decides to do, it does.'
      );
      cleanup();
    }
  });
});

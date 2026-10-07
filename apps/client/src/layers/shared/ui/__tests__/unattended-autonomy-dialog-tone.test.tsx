/**
 * @vitest-environment jsdom
 */
/**
 * The unattended door's tone: what colour it opens in, what its confirm button
 * looks like, and which sentence survives the restyle untouched.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';

import { UnattendedAutonomyDialog } from '../unattended-autonomy-dialog';

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
  promise: 'Edits and runs commands in this project. Codex can’t pause to ask.',
};

/** Open the unattended door at one mode. */
function openDoor(descriptor: PermissionModeDescriptor): void {
  render(
    <UnattendedAutonomyDialog
      descriptor={descriptor}
      consequence="Anyone who can message this connection can make the agent act."
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />
  );
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

describe('what the unattended door looks like', () => {
  for (const descriptor of [AUTONOMY, WORKSPACE_WRITE]) {
    it(`confirms with the plain primary button at ${descriptor.stop} — no red`, () => {
      openDoor(descriptor);
      expect(confirmButton(descriptor).className).not.toMatch(/bg-red-/);
    });

    it(`spends no red anywhere at ${descriptor.stop}`, () => {
      openDoor(descriptor);
      // Red is reserved for genuine alarms — quarantine, unreadable rules,
      // errors. A door a person walked up to deliberately is not one
      // (spec `full-power-defaults`, D8).
      expect(document.body.innerHTML).not.toMatch(/(text|bg|border|ring)-red-/);
    });
  }

  it('opens green at full power', () => {
    openDoor(AUTONOMY);
    expect(document.querySelector('.text-status-success')).not.toBeNull();
  });

  it('draws the icon of the stop being turned on, not a fixed one', () => {
    // The door opens for the middle stop too. A title reading "Turn on Act"
    // beside the full-autonomy bolt claims a position the person is not taking
    // — the same positional lie `STOP_ICONS` exists to prevent.
    openDoor(AUTONOMY);
    expect(titleIcon()).toMatch(/lucide-zap/);
    cleanup();
    openDoor(WORKSPACE_WRITE);
    const icon = titleIcon();
    expect(icon).toMatch(/lucide-sparkles/);
    expect(icon, 'must not borrow the autonomy bolt').not.toMatch(/lucide-zap/);
  });

  it('keeps the honest fact line word for word', () => {
    // This sentence is the one thing standing between "Act" and a runtime that
    // cannot pause to ask.
    openDoor(WORKSPACE_WRITE);
    expect(screen.getByTestId('consent-asks-note')).toHaveTextContent(
      'This stop never pauses to ask. It acts without checking with you.'
    );
  });
});

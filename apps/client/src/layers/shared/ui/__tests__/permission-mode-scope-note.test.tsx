/**
 * The one line that says what a bypass permission mode does NOT cover, and the
 * guard that keeps all three places saying it (spec `agent-approval-settings`
 * §3.7).
 *
 * @vitest-environment jsdom
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PermissionModeScopeNote } from '../permission-mode-scope-note';

/** `apps/client/src`, resolved from this file rather than from the cwd. */
const CLIENT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Every place a person actually picks a permission mode.
 *
 * The spec names these three, and the promise is that they cannot drift into
 * saying different things about the same setting. Sharing one component is what
 * makes that true; this list is what notices when a fourth picker appears with no
 * note, or when one of these three loses it.
 */
const MODE_PICKERS = [
  'layers/features/status/ui/PermissionModeItem.tsx',
  'layers/entities/binding/ui/BindingAdvancedSection.tsx',
  'layers/features/tasks/ui/TaskFormInner.tsx',
];

afterEach(cleanup);

describe('PermissionModeScopeNote', () => {
  it('says what the mode does not cover, and where to change that', () => {
    render(<PermissionModeScopeNote mode="bypassPermissions" />);

    expect(
      screen.getByText(
        'This covers tools inside the session. Actions on DorkOS itself, like removing packages, still ask. Change that in Settings, under Security.'
      )
    ).toBeInTheDocument();
  });

  it('appears for the other spelling of the same thing', () => {
    // `always-allow` is the test-mode runtime's name for "run everything". A note
    // that only knew one spelling would be silent on a session that bypasses.
    render(<PermissionModeScopeNote mode="always-allow" />);
    expect(screen.getByText(/This covers tools inside the session/)).toBeInTheDocument();
  });

  it('says nothing for a mode that still asks', () => {
    for (const mode of ['default', 'plan', 'acceptEdits', 'dontAsk', 'auto', null, undefined]) {
      const { unmount } = render(<PermissionModeScopeNote mode={mode} />);
      expect(screen.queryByText(/This covers tools inside the session/)).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('every place a permission mode is chosen carries the note', () => {
  for (const file of MODE_PICKERS) {
    it(`${file} renders PermissionModeScopeNote`, async () => {
      const source = await readFile(path.join(CLIENT_SRC, file), 'utf-8');
      expect(
        source.includes('<PermissionModeScopeNote'),
        `${file} lets a person choose a permission mode and does not render ` +
          `PermissionModeScopeNote. Somebody switching a mode on there would not be told ` +
          `that actions on DorkOS itself still ask — which is the surprise the note exists ` +
          `to prevent.`
      ).toBe(true);
    });
  }
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { HARNESS_STATUS_READY } from '../../__fixtures__/harness-status';
import { NotEnabledNotice } from '../NotEnabledNotice';

describe('NotEnabledNotice', () => {
  beforeEach(cleanup);

  it('names the tool and the command, and offers no button (D24)', () => {
    // Purpose: `--enable` writes a committed, team-shared file. A side-panel
    // button with no diff and no undo promises more than the fact it fixes, so
    // this notice is copy — and the copy has to carry the whole command.
    render(<NotEnabledNotice notEnabled={HARNESS_STATUS_READY.notEnabled} />);

    expect(
      screen.getByText('Gemini CLI files are in this folder, but DorkOS isn’t sharing to it.')
    ).toBeInTheDocument();
    // The command is one token per non-breaking span, so `getByText` — which
    // reads an element's DIRECT text nodes — sees only the spaces between them.
    // Both halves are asserted: the whole command, and the shape that keeps a
    // flag whole when the line wraps at the docked panel's narrowest.
    const command = document.querySelector('[data-slot="inline-code"]');
    expect(command?.textContent).toBe('dorkos harness sync --fix --enable gemini');
    expect(
      [...(command?.querySelectorAll('span.whitespace-nowrap') ?? [])].map((s) => s.textContent)
    ).toEqual(['dorkos', 'harness', 'sync', '--fix', '--enable', 'gemini']);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('draws nothing when every tool in the folder is already enabled', () => {
    const { container } = render(<NotEnabledNotice notEnabled={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});

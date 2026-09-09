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

  it('TR-11: says why for the tool that left no files to find', () => {
    // The DorkOS-runtime entry has no footprint by definition — a project that
    // has never run Claude Code has no `.claude/` — so the folder sentence would
    // be false about the one tool a person most needs to hear about (DOR-1901).
    const { container } = render(<NotEnabledNotice notEnabled={HARNESS_STATUS_READY.notEnabled} />);

    expect(
      screen.getByText('DorkOS runs Claude Code here, but this folder isn’t sharing to it.')
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Claude Code files are in this folder, but DorkOS isn’t sharing to it.')
    ).not.toBeInTheDocument();
    // Read off the code element rather than with `getByText`, which sees an
    // element's DIRECT text nodes only: the command is rendered one token per
    // non-breaking span, so a plain text query finds the spaces between them
    // and nothing else. `textContent` is the same string either way.
    expect(
      [...container.querySelectorAll('[data-slot="inline-code"]')].map((el) => el.textContent)
    ).toContain('dorkos harness sync --fix --enable claude-code');
  });

  it('draws nothing when every tool in the folder is already enabled', () => {
    const { container } = render(<NotEnabledNotice notEnabled={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});

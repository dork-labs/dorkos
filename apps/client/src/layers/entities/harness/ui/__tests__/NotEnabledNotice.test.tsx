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
    expect(screen.getByText('dorkos harness sync --fix --enable gemini')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('draws nothing when every tool in the folder is already enabled', () => {
    const { container } = render(<NotEnabledNotice notEnabled={[]} />);

    expect(container).toBeEmptyDOMElement();
  });
});

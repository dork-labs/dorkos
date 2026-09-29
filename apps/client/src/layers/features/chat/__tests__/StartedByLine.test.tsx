// @vitest-environment jsdom
/**
 * A started chat's first line and its folded prompt (spec `flow-multiproject`
 * §7.7, V7): who started it and why, in words for the person, with the prompt
 * readable but never the headline.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => navigate,
}));

import { StartedByLine, StartedPrompt } from '../ui/StartedByLine';

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

describe('StartedByLine', () => {
  it('says which extension started the chat, and why', () => {
    render(
      <StartedByLine
        startedBy={{
          kind: 'extension',
          extensionId: 'flow',
          extensionName: 'Flow',
          reason: '12 new ideas were waiting to be sorted',
        }}
      />
    );
    expect(screen.getByTestId('started-by-line')).toHaveTextContent(
      'Started by the Flow extension: 12 new ideas were waiting to be sorted'
    );
  });

  it('says an extension named like a person is an extension', () => {
    render(
      <StartedByLine
        startedBy={{ kind: 'extension', extensionId: 'x', extensionName: 'You', reason: 'hi' }}
      />
    );
    expect(screen.getByTestId('started-by-line')).toHaveTextContent(
      'Started by the You extension: hi'
    );
  });

  it('names the chat it was started from, and opens it', async () => {
    render(
      <StartedByLine
        startedBy={{
          kind: 'chat',
          sessionId: 'parent-1',
          title: 'Plan the launch',
          reason: 'Split off the tests',
        }}
      />
    );
    expect(screen.getByTestId('started-by-line')).toHaveTextContent(
      'Started from Plan the launch: Split off the tests'
    );
    await userEvent.click(screen.getByRole('button', { name: 'Plan the launch' }));
    expect(navigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'parent-1' },
    });
  });

  it('says "another chat" for one it cannot name, and leaves out a missing reason', () => {
    render(
      <StartedByLine
        startedBy={{ kind: 'chat', sessionId: 'parent-1', title: null, reason: null }}
      />
    );
    expect(screen.getByTestId('started-by-line').textContent).toBe('Started from another chat');
  });

  it('draws nothing for a chat a person started', () => {
    const { container } = render(<StartedByLine startedBy={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('StartedPrompt', () => {
  it('folds the prompt under "What it was asked" and opens it on click', async () => {
    render(<StartedPrompt content="/flow:triage --all" />);
    const toggle = screen.getByRole('button', { name: 'What it was asked' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('/flow:triage --all')).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('/flow:triage --all')).toBeVisible();
  });
});

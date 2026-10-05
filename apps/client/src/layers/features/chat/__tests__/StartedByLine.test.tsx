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
          permission: null,
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
        startedBy={{
          kind: 'chat',
          sessionId: 'parent-1',
          title: null,
          reason: null,
          permission: null,
        }}
      />
    );
    expect(screen.getByTestId('started-by-line').textContent).toBe('Started from another chat');
  });

  describe('the level it was started at', () => {
    const CLAUDE_MODES = [
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits files on its own.',
      },
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'It will not stop to ask you.',
      },
    ] as const;

    const startedAt = (mode: string, sameAsStarter: boolean) =>
      ({
        kind: 'chat',
        sessionId: 'parent-1',
        title: 'Plan the launch',
        reason: null,
        permission: { mode, sameAsStarter },
      }) as const;

    it('says Full autonomy, the same as the chat that started it', () => {
      render(
        <StartedByLine startedBy={startedAt('bypassPermissions', true)} modes={CLAUDE_MODES} />
      );
      expect(screen.getByTestId('started-level-line').textContent).toBe(
        'Full autonomy, same as the chat that started it.'
      );
    });

    it("names a lower level in the runtime's own words", () => {
      render(<StartedByLine startedBy={startedAt('acceptEdits', false)} modes={CLAUDE_MODES} />);
      expect(screen.getByTestId('started-level-line').textContent).toBe(
        'Accept edits, lower than the chat that started it.'
      );
    });

    it("names the level before the runtime's modes have loaded", () => {
      render(<StartedByLine startedBy={startedAt('bypassPermissions', true)} />);
      expect(screen.getByTestId('started-level-line')).toHaveTextContent(/^Full autonomy, same/);
    });

    it('draws no level for a chat started before levels were recorded', () => {
      render(
        <StartedByLine
          startedBy={{ ...startedAt('acceptEdits', false), permission: null }}
          modes={CLAUDE_MODES}
        />
      );
      expect(screen.queryByTestId('started-level-line')).not.toBeInTheDocument();
    });
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

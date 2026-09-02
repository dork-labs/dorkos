/**
 * The task form's agent row, and the four different things it can honestly say
 * about an agent id it has not resolved yet (DOR-1694).
 *
 * The state under test here is the ROSTER's, not the form's: the id is on the
 * task and is known immediately, while the list that resolves it into a name
 * arrives over the network and can fail. Collapsing "not answered yet" into
 * "answered, and it is not in there" is how a healthy task gets told its agent
 * is gone.
 *
 * The pairing between this row and the form's own consent machinery is driven
 * end to end in `TaskRunsOn.test.tsx`; this file is the component's own
 * vocabulary.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TaskAgentField, type TaskAgentRoster } from '../ui/TaskAgentField';
import type { AgentPick } from '../ui/use-agent-pick';

const AGENTS = [
  { id: 'agent-1', name: 'api-bot', projectPath: '/projects/api', icon: '🤖', color: '#6366f1' },
  { id: 'agent-2', name: 'test-bot', projectPath: '/projects/test', icon: '🧪', color: '#22c55e' },
];

/** A pick that nobody drives — the locked row never touches it. */
function idlePick(overrides: Partial<AgentPick> = {}): AgentPick {
  return { pick: vi.fn(), isWaiting: false, wasDropped: false, ...overrides };
}

/** The roster as it reads once the list has landed. */
function answered(agents = AGENTS): TaskAgentRoster {
  return { agents, answered: true, unreadable: false };
}

/** The roster during the window every cold open has: asked, not yet answered. */
const IN_FLIGHT: TaskAgentRoster = { agents: [], answered: false, unreadable: false };

/** The roster after a read that failed, which waiting will not fix. */
const UNREADABLE: TaskAgentRoster = { agents: [], answered: false, unreadable: true };

/** Every sentence this row must NOT say about an agent nobody has looked up. */
const CLAIMS = [/no longer/i, /isn’t registered/i, /not found/i, /^No agent$/];

function renderLocked(roster: TaskAgentRoster, value = 'agent-1') {
  render(<TaskAgentField roster={roster} value={value} locked pick={idlePick()} />);
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => cleanup());

describe('the task form agent row', () => {
  describe('once the roster has answered', () => {
    it('names the agent the task runs as', () => {
      renderLocked(answered());

      expect(screen.getByTestId('settled-agent')).toHaveTextContent('api-bot');
    });

    it('says an agent is gone only when the list actually came back without it', () => {
      renderLocked(answered(), 'agent-vanished');

      expect(screen.getByTestId('settled-agent')).toHaveTextContent(
        'This agent isn’t registered any more.'
      );
    });

    it('reports a task that runs as no agent at all', () => {
      renderLocked(answered(), '');

      expect(screen.getByTestId('settled-agent')).toHaveTextContent('No agent');
    });
  });

  describe('before the roster has answered', () => {
    // The window every cold open passes through: the dialog is on screen and
    // the agent list is still in flight. An empty list read as an ANSWER makes
    // every stored agent look unregistered, for as long as the read takes.

    it('makes no claim about the agent while the list is in flight', () => {
      renderLocked(IN_FLIGHT);

      expect(screen.getByTestId('settled-agent-loading')).toBeInTheDocument();
      // Nothing is asserted about the agent, in any of the wordings that would
      // be wrong here.
      expect(screen.queryByTestId('settled-agent')).toBeNull();
      for (const claim of CLAIMS) expect(screen.queryByText(claim)).toBeNull();
    });

    it('blames the read, not the task, when the list cannot be fetched', () => {
      // Permanent, unlike the case above — so silence would leave an empty row
      // forever. The sentence names what failed and says nothing about whether
      // the agent still exists, because this machine does not know.
      renderLocked(UNREADABLE);

      expect(screen.getByTestId('settled-agent')).toHaveTextContent(
        'DorkOS couldn’t read your list of agents, so it can’t show which one this is.'
      );
      for (const claim of CLAIMS) expect(screen.queryByText(claim)).toBeNull();
    });

    it('still reports "no agent" straight away, because that is on the task', () => {
      // The id lives on the task, not in the roster, so its absence is known
      // before any list arrives. Waiting to say so would be a loading state for
      // an answer already in hand.
      renderLocked(IN_FLIGHT, '');

      expect(screen.getByTestId('settled-agent')).toHaveTextContent('No agent');
      expect(screen.queryByTestId('settled-agent-loading')).toBeNull();
    });
  });

  describe('when the choice is settled', () => {
    it('offers no control at all, and says why', () => {
      // Not a disabled picker: there is no button to land on and nothing to
      // neutralise. The reviewer's repro needs a second agent to pick, and
      // there is no way to reach one.
      renderLocked(answered());

      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.queryByText('test-bot')).toBeNull();
      expect(screen.getByTestId('agent-locked-note')).toHaveTextContent(
        'You can’t change the agent after a task is created. To run this work as a different agent, create a new task.'
      );
    });
  });

  describe('when the choice is still open', () => {
    it('offers the picker, and none of the settled row', () => {
      const pick = idlePick();
      render(<TaskAgentField roster={answered()} value="agent-1" locked={false} pick={pick} />);

      fireEvent.click(screen.getByRole('button', { expanded: false }));
      fireEvent.click(screen.getByText('test-bot'));

      expect(pick.pick).toHaveBeenCalledWith('agent-2');
      expect(screen.queryByTestId('settled-agent')).toBeNull();
      expect(screen.queryByTestId('agent-locked-note')).toBeNull();
    });

    it('says a pick is being priced, and says when one was let go', () => {
      const { rerender } = render(
        <TaskAgentField
          roster={answered()}
          value="agent-1"
          locked={false}
          pick={idlePick({ isWaiting: true })}
        />
      );
      expect(screen.getByTestId('agent-pick-waiting')).toHaveTextContent(
        /Checking what that agent runs on/
      );

      rerender(
        <TaskAgentField
          roster={answered()}
          value="agent-1"
          locked={false}
          pick={idlePick({ wasDropped: true })}
        />
      );
      expect(screen.getByTestId('agent-pick-waiting')).toHaveTextContent(
        /couldn’t read what that agent runs on/
      );
    });
  });
});

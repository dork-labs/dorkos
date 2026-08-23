// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { TrustDial } from '../trust-dial';

afterEach(cleanup);

// The four runtimes' declared modes, mirroring the real profiles in the server
// adapters' `runtime-constants` — the dial's whole job is to render what a
// runtime declared, so a hand-tuned fixture would prove nothing.

const CLAUDE: PermissionModeDescriptor[] = [
  {
    id: 'default',
    label: 'Default',
    stop: 'ask',
    asks: 'always',
    reach: 'edit',
    promise: 'Asks before it edits a file or runs a command.',
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    stop: 'act',
    asks: 'when-risky',
    reach: 'edit',
    promise: 'Edits files on its own. Asks before it runs a command.',
  },
  {
    id: 'plan',
    label: 'Plan',
    stop: 'ask',
    axis: 'working',
    asks: 'always',
    reach: 'read',
    promise: 'Reads and plans only. Nothing changes until you approve the plan.',
  },
  {
    id: 'bypassPermissions',
    label: 'Bypass permissions',
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Runs everything without asking, including outside this project.',
  },
  {
    id: 'auto',
    label: 'Auto',
    stop: 'act',
    asks: 'when-risky',
    reach: 'edit',
    promise: 'Edits files on its own and weighs each command, asking you about the risky ones.',
  },
];

const CODEX: PermissionModeDescriptor[] = [
  {
    id: 'default',
    label: 'Read only',
    stop: 'ask',
    asks: 'never',
    reach: 'read',
    promise: 'Reads files and answers questions. Nothing on your machine changes.',
    native: 'read-only',
  },
  {
    id: 'acceptEdits',
    label: 'Workspace write',
    stop: 'act',
    asks: 'never',
    reach: 'workspace',
    promise: "Edits files and runs commands inside the workspace — Codex can't pause to ask.",
    native: 'workspace-write',
  },
  {
    id: 'bypassPermissions',
    label: 'Full access',
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Runs everything without asking, anywhere on your machine, network included.',
    native: 'danger-full-access',
  },
];

/**
 * `test-mode`'s declared modes, verbatim from its shipped profile. Its ids sit
 * outside every name the client knows, which is what makes it the fixture that
 * can prove the dial reads semantics rather than ids — Claude and Codex both
 * normalize their top stop to `bypassPermissions`, so a pair of those two
 * proves nothing about ids at all.
 */
const TEST_MODE: PermissionModeDescriptor[] = [
  {
    id: 'always-allow',
    label: 'Always allow',
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Approves every request without asking. For tests only.',
  },
  {
    id: 'always-deny',
    label: 'Always deny',
    stop: 'ask',
    asks: 'always',
    reach: 'read',
    promise: 'Refuses every request. For tests only.',
  },
];

/** A runtime that offers no middle ground at all. */
const TWO_STOP: PermissionModeDescriptor[] = [CLAUDE[0], CLAUDE[3]];

/** The dial's radio group. */
function dial() {
  return screen.getByRole('radiogroup', { name: /how much/i });
}

describe('TrustDial', () => {
  describe('the three stops', () => {
    it('renders one stop per position the runtime can take', () => {
      render(<TrustDial mode="default" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      const stops = within(dial()).getAllByRole('radio');
      expect(stops.map((s) => s.textContent)).toEqual(['Ask first', 'Act', 'Full autonomy']);
    });

    it('leaves a stop the runtime cannot take out entirely, rather than offering a dead one', () => {
      render(<TrustDial mode="default" descriptors={TWO_STOP} onChangeMode={vi.fn()} />);

      const stops = within(dial()).getAllByRole('radio');
      expect(stops.map((s) => s.textContent)).toEqual(['Ask first', 'Full autonomy']);
      expect(stops.every((s) => !s.hasAttribute('disabled'))).toBe(true);
    });

    it('keeps the stop words fixed when the runtime renames the mode behind them', () => {
      // Codex calls the middle stop 'Workspace write'. The dial still says Act —
      // the caption is what tells the truth about the difference.
      render(<TrustDial mode="acceptEdits" descriptors={CODEX} onChangeMode={vi.fn()} />);

      expect(
        within(dial())
          .getAllByRole('radio')
          .map((s) => s.textContent)
      ).toEqual(['Ask first', 'Act', 'Full autonomy']);
    });

    it('marks the stop the session is at', () => {
      render(<TrustDial mode="acceptEdits" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      expect(screen.getByRole('radio', { name: 'Act' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Ask first' })).not.toBeChecked();
    });

    it('selects the mode the runtime declared for that stop', async () => {
      const onChangeMode = vi.fn();
      render(<TrustDial mode="default" descriptors={CLAUDE} onChangeMode={onChangeMode} />);

      await userEvent.click(screen.getByRole('radio', { name: 'Act' }));
      expect(onChangeMode).toHaveBeenCalledWith('acceptEdits');
    });

    it('reaches the next stop with an arrow key', async () => {
      const onChangeMode = vi.fn();
      render(<TrustDial mode="default" descriptors={CLAUDE} onChangeMode={onChangeMode} />);

      await userEvent.tab();
      // Held, not tapped. Radix moves roving focus in a `setTimeout` and selects
      // the newly-focused stop only while an arrow key is still down — with a
      // tap, userEvent's keyup lands before that timer and cancels the select,
      // which no real key press does.
      await userEvent.keyboard('{ArrowRight>}');
      await waitFor(() => expect(onChangeMode).toHaveBeenCalledWith('acceptEdits'));
    });

    it('does not wrap from the first stop into Full autonomy', () => {
      // A radio group selects as focus moves, and Radix wraps by default — which
      // made ONE ArrowLeft on the safest stop commit the most dangerous one, with
      // no dialog and nothing to undo.
      const onChangeMode = vi.fn();
      render(<TrustDial mode="default" descriptors={CLAUDE} onChangeMode={onChangeMode} />);

      return (async () => {
        await userEvent.tab();
        await userEvent.keyboard('{ArrowLeft>}');
        await new Promise((r) => setTimeout(r, 10));
        expect(onChangeMode).not.toHaveBeenCalled();
        expect(screen.getByRole('radio', { name: 'Ask first' })).toBeChecked();
      })();
    });

    it('does not wrap off the last stop either', async () => {
      const onChangeMode = vi.fn();
      render(
        <TrustDial mode="bypassPermissions" descriptors={CLAUDE} onChangeMode={onChangeMode} />
      );

      await userEvent.tab();
      await userEvent.keyboard('{ArrowRight>}');
      await new Promise((r) => setTimeout(r, 10));
      expect(onChangeMode).not.toHaveBeenCalled();
    });

    it('lets a SURFACE re-word the stops, without letting a runtime do it', () => {
      // Settings reads cold, months later, so its dials say what a stop does
      // rather than what picking it means right now. Still one vocabulary per
      // surface: every position is re-worded together, and the runtime behind
      // the dial has no say in it.
      render(
        <TrustDial
          mode="acceptEdits"
          descriptors={CODEX}
          onChangeMode={vi.fn()}
          stopLabels={{
            ask: 'Asks before acting',
            act: 'Pauses at big steps',
            autonomy: 'Full autonomy',
          }}
        />
      );

      const stops = within(dial()).getAllByRole('radio');
      expect(stops.map((s) => s.textContent)).toEqual([
        'Asks before acting',
        'Pauses at big steps',
        'Full autonomy',
      ]);
      expect(screen.getByRole('radio', { name: 'Pauses at big steps' })).toBeChecked();
    });

    it('keeps its own word for any stop a surface did not re-word', () => {
      render(
        <TrustDial
          mode="default"
          descriptors={CLAUDE}
          onChangeMode={vi.fn()}
          stopLabels={{ act: 'Pauses at big steps' }}
        />
      );

      expect(
        within(dial())
          .getAllByRole('radio')
          .map((s) => s.textContent)
      ).toEqual(['Ask first', 'Pauses at big steps', 'Full autonomy']);
    });

    it('shows a refinement as selecting the stop that holds it', () => {
      // A session in `auto` is at Act — auto is a setting inside the stop.
      render(<TrustDial mode="auto" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      expect(screen.getByRole('radio', { name: 'Act' })).toBeChecked();
    });
  });

  describe('one shape per stop', () => {
    /** The lucide class on the glyph inside one segment. */
    function stopIcon(name: string): string {
      return screen.getByRole('radio', { name }).querySelector('svg')?.getAttribute('class') ?? '';
    }

    it('gives Ask first a padlock — the limited stop, marked by shape not colour', () => {
      // The whole of that stop's marking. Ask first is uncoloured on purpose
      // (painting the safe resting state in the alarm colour would shame the
      // cautious choice), so the padlock is the only thing carrying "this is
      // the held-back setting" — spec `full-power-defaults`, D8.
      render(<TrustDial mode="default" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      expect(stopIcon('Ask first')).toMatch(/lucide-lock/);
    });

    it('keeps the three stops on three different shapes', () => {
      render(<TrustDial mode="default" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      expect(stopIcon('Ask first')).toMatch(/lucide-lock/);
      expect(stopIcon('Act')).toMatch(/lucide-sparkles/);
      expect(stopIcon('Full autonomy')).toMatch(/lucide-zap/);
    });
  });

  describe('the caption', () => {
    it('says what the selected mode does, in the runtime’s own sentence', () => {
      render(<TrustDial mode="acceptEdits" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      expect(
        screen.getByText('Edits files on its own. Asks before it runs a command.')
      ).toBeInTheDocument();
    });

    it('rewrites itself for a runtime that means something else by the same stop', () => {
      render(<TrustDial mode="acceptEdits" descriptors={CODEX} onChangeMode={vi.fn()} />);

      expect(screen.getByText(/Codex can't pause to ask/)).toBeInTheDocument();
    });

    it('warms to amber when the runtime cannot keep the stop’s promise', () => {
      render(<TrustDial mode="acceptEdits" descriptors={CODEX} onChangeMode={vi.fn()} />);

      expect(screen.getByTestId('trust-dial-caption').className).toContain('amber');
    });

    it('stays quiet when the runtime does what the stop says', () => {
      render(<TrustDial mode="acceptEdits" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      expect(screen.getByTestId('trust-dial-caption').className).not.toContain('amber');
    });

    it('leaves the safest mode alone even though it never asks', () => {
      // Codex's read-only default has nothing to ask about.
      render(<TrustDial mode="default" descriptors={CODEX} onChangeMode={vi.fn()} />);

      expect(screen.getByTestId('trust-dial-caption').className).not.toContain('amber');
    });

    it('goes green at the top stop — full power, and it looks like it', () => {
      // Choosing autonomy must not look identical to choosing Act. Amber is the
      // runtime bending a promise; green is the person taking the whole dial.
      render(<TrustDial mode="bypassPermissions" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      expect(screen.getByTestId('trust-dial-caption').className).toContain('text-status-success');
    });

    it('goes green on Codex’s top stop too, under its own promise', () => {
      // Not the id case — DorkOS normalizes Codex's `danger-full-access` to the
      // same `bypassPermissions` id Claude uses. What this pins is that a
      // materially different promise sentence still reads green.
      render(<TrustDial mode="bypassPermissions" descriptors={CODEX} onChangeMode={vi.fn()} />);

      expect(screen.getByTestId('trust-dial-caption').className).toContain('text-status-success');
    });

    it('goes green on a top stop whose id no client table knows', () => {
      // `always-allow` is the id property, stated where it is actually true.
      render(<TrustDial mode="always-allow" descriptors={TEST_MODE} onChangeMode={vi.fn()} />);

      expect(screen.getByTestId('trust-dial-caption').className).toContain('text-status-success');
    });

    it('leaves Ask first colourless — safety is the resting state', () => {
      render(<TrustDial mode="default" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      const caption = screen.getByTestId('trust-dial-caption').className;
      expect(caption).not.toContain('text-status-success');
      expect(caption).not.toContain('amber');
    });

    it('spends no red on any stop — red is left for real alarms', () => {
      for (const mode of ['default', 'acceptEdits', 'bypassPermissions']) {
        render(<TrustDial mode={mode} descriptors={CLAUDE} onChangeMode={vi.fn()} />);
        expect(screen.getByTestId('trust-dial-caption').className).not.toMatch(/red/);
        cleanup();
      }
    });

    it('is what the dial is described by', () => {
      render(<TrustDial mode="default" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      expect(dial()).toHaveAttribute(
        'aria-describedby',
        screen.getByTestId('trust-dial-caption').id
      );
    });
  });

  describe('a session at a mode the dial has no stop for', () => {
    it('says which mode it is instead of showing an empty dial', () => {
      render(<TrustDial mode="dontAsk" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      const note = screen.getByTestId('trust-dial-stranded');
      // Named by the shared fallback label, the same words every other surface
      // uses for a mode with no descriptor in hand.
      expect(note).toHaveTextContent(/Don't Ask/);
      expect(note).toHaveAttribute('role', 'status');
      expect(within(dial()).queryAllByRole('radio', { checked: true })).toHaveLength(0);
    });

    it('says so for a refinement this model cannot run, too', () => {
      // `auto` filtered out by the model gate, with the session still in it.
      const withoutAuto = CLAUDE.filter((d) => d.id !== 'auto');
      render(<TrustDial mode="auto" descriptors={withoutAuto} onChangeMode={vi.fn()} />);

      expect(screen.getByTestId('trust-dial-stranded')).toHaveTextContent(/Auto/);
    });

    it('lets a form say it in its own words, because saving is what decides there', () => {
      // A session applies a stop the moment it is picked. A binding or a task
      // keeps the stored mode until somebody picks one AND saves, so the default
      // sentence would be describing the wrong mechanism.
      render(
        <TrustDial
          mode="plan"
          descriptors={CLAUDE.filter((d) => d.id !== 'plan')}
          onChangeMode={vi.fn()}
          strandedNote="Saving keeps it as it is."
        />
      );

      const note = screen.getByTestId('trust-dial-stranded');
      expect(note).toHaveTextContent('Saving keeps it as it is.');
      expect(note).not.toHaveTextContent(/This session is set to/);
    });

    it('keeps quiet when the session is at a stop it can see', () => {
      render(<TrustDial mode="default" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      expect(screen.queryByTestId('trust-dial-stranded')).not.toBeInTheDocument();
    });
  });

  describe('a refinement inside a stop', () => {
    it('offers it only while that stop is selected', () => {
      const { rerender } = render(
        <TrustDial mode="default" descriptors={CLAUDE} onChangeMode={vi.fn()} />
      );
      expect(screen.queryByRole('switch', { name: /Auto/ })).not.toBeInTheDocument();

      rerender(<TrustDial mode="acceptEdits" descriptors={CLAUDE} onChangeMode={vi.fn()} />);
      expect(screen.getByRole('switch', { name: /Auto/ })).toBeInTheDocument();
    });

    it('is absent on a runtime that declares none', () => {
      render(<TrustDial mode="acceptEdits" descriptors={CODEX} onChangeMode={vi.fn()} />);

      expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    });

    it('turns the stop’s mode into the refinement when switched on', async () => {
      const onChangeMode = vi.fn();
      render(<TrustDial mode="acceptEdits" descriptors={CLAUDE} onChangeMode={onChangeMode} />);

      await userEvent.click(screen.getByRole('switch', { name: /Auto/ }));
      expect(onChangeMode).toHaveBeenCalledWith('auto');
    });

    it('returns to the stop’s own mode when switched off', async () => {
      const onChangeMode = vi.fn();
      render(<TrustDial mode="auto" descriptors={CLAUDE} onChangeMode={onChangeMode} />);

      const toggle = screen.getByRole('switch', { name: /Auto/ });
      expect(toggle).toBeChecked();
      await userEvent.click(toggle);
      expect(onChangeMode).toHaveBeenCalledWith('acceptEdits');
    });
  });

  describe('while a way of working holds the session', () => {
    it('shows what planning means and why the stops cannot move', () => {
      render(<TrustDial mode="plan" descriptors={CLAUDE} onChangeMode={vi.fn()} planActive />);

      expect(
        screen.getByText('Reads and plans only. Nothing changes until you approve the plan.')
      ).toBeInTheDocument();
      expect(screen.getByTestId('trust-dial-caption')).toHaveTextContent(/turn off plan/i);
      for (const stop of within(dial()).getAllByRole('radio')) {
        expect(stop).toBeDisabled();
      }
    });

    it('freezes the stops from the mode itself, even when nobody passed the flag', () => {
      // Defence in depth: conformance forbids the shape that would strand a way
      // of working, but a dial with nothing lit and no reason is the exact
      // failure this component exists to end.
      render(<TrustDial mode="plan" descriptors={CLAUDE} onChangeMode={vi.fn()} />);

      for (const stop of within(dial()).getAllByRole('radio')) {
        expect(stop).toBeDisabled();
      }
      expect(screen.getByTestId('trust-dial-caption')).toHaveTextContent(/turn off plan/i);
      expect(screen.queryByTestId('trust-dial-stranded')).not.toBeInTheDocument();
    });

    it('does not call plan a stranded mode — it is a mode this runtime offers', () => {
      render(<TrustDial mode="plan" descriptors={CLAUDE} onChangeMode={vi.fn()} planActive />);

      expect(screen.queryByTestId('trust-dial-stranded')).not.toBeInTheDocument();
    });
  });

  describe('before the runtime has answered', () => {
    it('renders no stops at all rather than three it cannot honour', () => {
      render(<TrustDial mode="default" descriptors={[]} onChangeMode={vi.fn()} />);

      expect(screen.queryByRole('radio')).not.toBeInTheDocument();
      expect(screen.queryByTestId('trust-dial-stranded')).not.toBeInTheDocument();
    });
  });
});

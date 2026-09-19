// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { TrustRow } from '../rows/TrustRow';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Claude Code's declared modes, as the capability map hands them over. */
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
    id: 'bypassPermissions',
    label: 'Bypass permissions',
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Runs everything without asking, including outside this project.',
  },
];

function renderRow(props: Partial<Parameters<typeof TrustRow>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <TrustRow
      runtimeType="claude-code"
      runtimeLabel="Claude Code"
      descriptors={CLAUDE}
      stop={null}
      globalStop="ask"
      onChange={onChange}
      {...props}
    />
  );
  return { onChange };
}

/** The scope note, found by its slot rather than by a sentence that may be reworded. */
const scopeNote = () => document.querySelector('[data-slot="permission-mode-scope-note"]');

describe('TrustRow — what the stop does not cover (DOR-2102)', () => {
  it('carries the note on a card that chose Full autonomy itself', () => {
    renderRow({ stop: 'autonomy' });
    expect(scopeNote()).toBeInTheDocument();
    expect(scopeNote()).toHaveTextContent(/DorkOS’s own risky actions still stop for you/);
  });

  it('says nothing at a stop that still asks', () => {
    renderRow({ stop: 'ask' });
    expect(scopeNote()).not.toBeInTheDocument();
  });

  it('carries it for a runtime that never asks at the MIDDLE stop', () => {
    // Codex's workspace-write. The note follows what the mode DOES, so a
    // never-asking mode filed below the top stop is covered too (DOR-816).
    renderRow({
      stop: 'act',
      descriptors: [
        {
          id: 'acceptEdits',
          label: 'Workspace write',
          stop: 'act',
          asks: 'never',
          reach: 'workspace',
          promise: 'Codex cannot stop to ask you first.',
        },
      ],
    });
    expect(scopeNote()).toBeInTheDocument();
  });

  it('stays silent inheriting Full autonomy, because the row below says that one', () => {
    // The shipped full-power default is global autonomy with every card
    // inheriting. Drawing this per card printed the same paragraph once per
    // runtime plus once more under the cards (DOR-2102 review).
    renderRow({ stop: null, globalStop: 'autonomy' });
    expect(scopeNote()).not.toBeInTheDocument();
  });

  it('stays silent when its own override AGREES with the shared Full autonomy', () => {
    // Same sentence, same stop, same row below. An override that happens to
    // match is not a second thing to say (DOR-2102 re-review).
    renderRow({ stop: 'autonomy', globalStop: 'autonomy' });
    expect(scopeNote()).not.toBeInTheDocument();
  });

  it('speaks up inheriting a middle stop THIS runtime never asks at', () => {
    // The re-review's regression, at component scale. The row below renders the
    // canonical middle stop, which asks when risky, so it says nothing here —
    // suppressing this card on "inheriting" alone left Codex's "cannot stop to
    // ask you first" with no correction anywhere on the tab.
    renderRow({
      stop: null,
      globalStop: 'act',
      descriptors: [
        {
          id: 'default',
          label: 'Read only',
          stop: 'ask',
          asks: 'never',
          reach: 'read',
          promise: 'Codex can read files but not change them.',
        },
        {
          id: 'acceptEdits',
          label: 'Workspace write',
          stop: 'act',
          asks: 'never',
          reach: 'workspace',
          promise: 'Codex cannot stop to ask you first.',
        },
      ],
    });
    expect(scopeNote()).toBeInTheDocument();
  });

  it('still says nothing inheriting a middle stop that does stop to ask', () => {
    // The other side of the same rule: Claude's middle stop asks about
    // commands, so there is nothing to correct.
    renderRow({ stop: null, globalStop: 'act' });
    expect(scopeNote()).not.toBeInTheDocument();
  });
});

describe('TrustRow', () => {
  it('words the stops the way the rest of the tab does, not the way a session does', () => {
    // One vocabulary per surface (`SETTINGS_STOP_LABELS`): the row beneath the
    // cards has always said "Pauses at big steps", and a card dial saying "Act"
    // for the same stop is two spellings of one setting on one screen.
    renderRow();
    expect(
      screen.getAllByRole('radio').map((position) => position.getAttribute('aria-label'))
    ).toEqual(['Asks before acting', 'Pauses at big steps', 'Full autonomy']);
    expect(screen.getByText('Pauses at big steps')).toBeInTheDocument();
    expect(screen.queryByText('Act')).not.toBeInTheDocument();
  });

  it('reads Global setting until somebody overrides it, and offers no way back from nothing', () => {
    renderRow();
    expect(screen.getByTestId('runtime-trust-global-claude-code')).toHaveTextContent(
      'Global setting'
    );
    expect(screen.queryByRole('button', { name: 'Use the setting above' })).not.toBeInTheDocument();
  });

  it('shows where the global choice actually lands on this runtime', () => {
    // Inherited, not silent: the dial sits on the mode this runtime resolves the
    // shared stop to, in that runtime's own words.
    renderRow({ stop: null, globalStop: 'act' });
    expect(screen.getByRole('radio', { name: 'Pauses at big steps' })).toBeChecked();
    expect(screen.getByTestId('trust-dial-caption')).toHaveTextContent(
      'Edits files on its own. Asks before it runs a command.'
    );
  });

  it('writes the runtime-neutral stop of the mode picked, never a mode id', async () => {
    const { onChange } = renderRow();
    await userEvent.click(screen.getByRole('radio', { name: 'Pauses at big steps' }));
    expect(onChange).toHaveBeenCalledWith('act');
  });

  it('offers a way back once overridden, and reports it as a null rather than a copied stop', async () => {
    const { onChange } = renderRow({ stop: 'autonomy', globalStop: 'ask' });
    expect(screen.queryByTestId('runtime-trust-global-claude-code')).not.toBeInTheDocument();

    const revert = screen.getByRole('button', { name: 'Use the setting above' });
    await userEvent.click(revert);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('gives a runtime that has not said what it can do a sentence, not a dial over nothing', () => {
    renderRow({ runtimeType: 'codex', runtimeLabel: 'Codex', descriptors: [] });
    expect(screen.getByTestId('runtime-trust-unavailable-codex')).toHaveTextContent(
      'Codex hasn’t said what it can do, so there is nothing to choose from yet'
    );
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('freezes the dial and the way back when the write has nowhere to go', async () => {
    // No caption about turning something off: this freeze is the card's, not a
    // mode's, and it lasts exactly as long as the runtime takes to declare
    // where its settings live.
    const { onChange } = renderRow({ stop: 'autonomy', globalStop: 'ask', disabled: true });

    const stop = screen.getByRole('radio', { name: 'Pauses at big steps' });
    expect(stop).toBeDisabled();
    await userEvent.click(stop);

    const revert = screen.getByRole('button', { name: 'Use the setting above' });
    expect(revert).toBeDisabled();
    await userEvent.click(revert);

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('trust-dial-caption')).not.toHaveTextContent('Turn off');
  });

  it('keeps a stored way of working named instead of freezing a control nobody can unfreeze', () => {
    // A settings form has no Plan switch, so a mode with no stop is stranded
    // here exactly as it is on the binding and task dials (`strandsWorkingMode`).
    renderRow({
      descriptors: [
        ...CLAUDE,
        {
          id: 'plan',
          label: 'Plan',
          stop: 'ask',
          axis: 'working',
          asks: 'always',
          reach: 'read',
          promise: 'Reads and plans only.',
        },
      ],
      stop: null,
      globalStop: 'ask',
    });
    // The stop resolves to Claude's own `default`, not to the way of working —
    // and the dial stays live.
    expect(screen.getByRole('radio', { name: 'Asks before acting' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Pauses at big steps' })).toBeEnabled();
  });
});

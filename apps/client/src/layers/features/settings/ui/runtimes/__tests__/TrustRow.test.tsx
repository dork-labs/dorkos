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

describe('TrustRow', () => {
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
    expect(screen.getByRole('radio', { name: 'Act' })).toBeChecked();
    expect(screen.getByTestId('trust-dial-caption')).toHaveTextContent(
      'Edits files on its own. Asks before it runs a command.'
    );
  });

  it('writes the runtime-neutral stop of the mode picked, never a mode id', async () => {
    const { onChange } = renderRow();
    await userEvent.click(screen.getByRole('radio', { name: 'Act' }));
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
    expect(screen.getByRole('radio', { name: 'Ask first' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Act' })).toBeEnabled();
  });
});

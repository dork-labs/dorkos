// @vitest-environment jsdom
/**
 * The ask stop's "Limited — unlock" affordance (spec `full-power-defaults` §6,
 * deferred from the green-flip). Neutral, opt-in, and only where the caller has
 * somewhere to send the person — never a colour, never on the safe-but-not-ask
 * stops.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { TrustDial } from '../trust-dial';

const DESCRIPTORS: PermissionModeDescriptor[] = [
  { id: 'default', label: 'Ask', stop: 'ask', asks: 'always', reach: 'edit', promise: 'Asks.' },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    stop: 'act',
    asks: 'when-risky',
    reach: 'edit',
    promise: 'Acts.',
  },
  {
    id: 'bypassPermissions',
    label: 'Full autonomy',
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Runs everything.',
  },
];

afterEach(() => cleanup());

describe('TrustDial — the ask-stop unlock affordance', () => {
  it('shows a neutral "Limited — unlock" at the ask stop when onUnlock is given, and fires it', () => {
    const onUnlock = vi.fn();
    render(
      <TrustDial
        mode="default"
        descriptors={DESCRIPTORS}
        onChangeMode={() => {}}
        onUnlock={onUnlock}
      />
    );
    const affordance = screen.getByTestId('trust-dial-limited-unlock');
    expect(affordance).toHaveTextContent(/limited/i);
    // Not the alarm colour — no red anywhere on it.
    expect(affordance.className).not.toMatch(/red/);
    fireEvent.click(affordance);
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it('shows nothing at the ask stop when no unlock destination is given', () => {
    render(<TrustDial mode="default" descriptors={DESCRIPTORS} onChangeMode={() => {}} />);
    expect(screen.queryByTestId('trust-dial-limited-unlock')).not.toBeInTheDocument();
  });

  it('shows nothing at the autonomy stop even with an unlock destination', () => {
    render(
      <TrustDial
        mode="bypassPermissions"
        descriptors={DESCRIPTORS}
        onChangeMode={() => {}}
        onUnlock={() => {}}
      />
    );
    expect(screen.queryByTestId('trust-dial-limited-unlock')).not.toBeInTheDocument();
  });
});

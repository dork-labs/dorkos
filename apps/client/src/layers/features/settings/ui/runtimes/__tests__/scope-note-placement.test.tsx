// @vitest-environment jsdom
/**
 * Where the "what this stop does not cover" sentence lands on the Runtimes tab,
 * counted across the whole surface rather than one component at a time
 * (DOR-2102, re-review).
 *
 * Two components can each be right on their own and still leave the tab wrong:
 * a card suppressing its note because "the row below says it" is only correct
 * if the row below actually does. The row reads the CANONICAL descriptor for a
 * stop and a card reads its RUNTIME's descriptor for the same stop, and those
 * two disagree exactly where the product most needs the sentence — Codex files
 * a never-asking mode at the middle stop, where the canonical middle stop still
 * asks. So the contract is asserted here, on both components rendered together
 * the way `RuntimesTab` renders them, by counting notes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PermissionModeDescriptor, PermissionStop } from '@dorkos/shared/agent-runtime';
import { TrustRow } from '../rows/TrustRow';
import { GlobalTrustRow } from '../GlobalTrustRow';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A runtime whose stops behave the way the canonical dial says they do. */
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
    promise: 'Edits files and runs commands on its own. It will not stop to ask you.',
  },
];

/**
 * Codex: its MIDDLE stop never asks. The whole reason the note follows
 * `needsConsentRitual` rather than the dial position (DOR-816).
 */
const CODEX: PermissionModeDescriptor[] = [
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
];

/**
 * The tab, reduced to the two things that draw this sentence: one runtime card's
 * trust row, and the shared row beneath the cards.
 */
function renderTab(opts: {
  descriptors: PermissionModeDescriptor[];
  cardStop: PermissionStop | null;
  globalStop: PermissionStop;
}) {
  const { descriptors, cardStop, globalStop } = opts;
  render(
    <>
      <TrustRow
        runtimeType="probe"
        runtimeLabel="Probe"
        descriptors={descriptors}
        stop={cardStop}
        globalStop={globalStop}
        onChange={vi.fn()}
      />
      <GlobalTrustRow
        stop={globalStop}
        effectiveStop={globalStop}
        runtimes={[{ runtime: 'probe', label: 'Probe', stop: cardStop }]}
        onChange={vi.fn()}
        onChangeRuntime={vi.fn()}
      />
    </>
  );
  return document.querySelectorAll('[data-slot="permission-mode-scope-note"]').length;
}

describe('the scope note lands exactly once where it is owed (DOR-2102 re-review)', () => {
  it('A — inheriting the shared Full autonomy: the row below says it, the card does not', () => {
    // The shipped full-power default. Saying it per card as well printed the
    // same paragraph once per runtime plus once under the cards.
    expect(renderTab({ descriptors: CLAUDE, cardStop: null, globalStop: 'autonomy' })).toBe(1);
  });

  it('B — inheriting a middle stop this runtime never asks at: the CARD says it', () => {
    // The regression the re-review caught. The canonical middle stop asks when
    // risky, so the row below stays silent — and suppressing the card on
    // "inheriting" alone left Codex showing "Codex cannot stop to ask you
    // first." with nothing underneath. This is the DOR-816 case the widened
    // condition exists for.
    expect(renderTab({ descriptors: CODEX, cardStop: null, globalStop: 'act' })).toBe(1);
  });

  it('C — card set to the same Full autonomy the row is already at: still once', () => {
    expect(renderTab({ descriptors: CLAUDE, cardStop: 'autonomy', globalStop: 'autonomy' })).toBe(
      1
    );
  });

  it('D — card set to Full autonomy against a gentler shared stop: card and row', () => {
    // Two notes, and both earn their place. The card is announcing a choice the
    // row does not share, and the row has to name it too because that card can
    // be collapsed out of sight.
    expect(renderTab({ descriptors: CLAUDE, cardStop: 'autonomy', globalStop: 'act' })).toBe(2);
  });

  it('E — nothing anywhere that stops asking: no note at all', () => {
    expect(renderTab({ descriptors: CLAUDE, cardStop: null, globalStop: 'ask' })).toBe(0);
  });
});

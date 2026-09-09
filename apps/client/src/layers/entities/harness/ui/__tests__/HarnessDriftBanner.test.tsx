/**
 * The banner, the removal disclosure, the sync, and the "what changed" summary
 * (spec `harness-sync-status` §User Experience, "The banner").
 *
 * Every case names the seeded defect that reds it: none of this exists on
 * `main`, so "fails on main" is trivially true and proves nothing.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HarnessStatusResponse, HarnessSyncResponse } from '@dorkos/shared/harness-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { HARNESS_STATUS_ALL_SHARED, HARNESS_STATUS_READY } from '../../__fixtures__/harness-status';
import { HarnessDriftBanner } from '../HarnessDriftBanner';

// The `approval_resolved` subscription needs the app-level `EventStreamProvider`
// — a whole SSE stack for a stream nothing here fires. It is stubbed rather than
// mounted, which is what every other suite in this repo does with it; the
// subscription's own behaviour is asserted where the stream is real.
vi.mock('@/layers/shared/model', async () => {
  const actual =
    await vi.importActual<typeof import('@/layers/shared/model')>('@/layers/shared/model');
  return { ...actual, useEventSubscription: () => undefined };
});

// Sonner writes to a DOM region no assertion here reads, and its real
// implementation drags a portal into every case.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

/** A `ready` status with every count at rest — the shape each case edits one field of. */
const CLEAN: HarnessStatusResponse = {
  ...HARNESS_STATUS_ALL_SHARED,
  counts: { ...HARNESS_STATUS_ALL_SHARED.counts },
};

/** The same status with one thing wrong with it. */
function statusWith(counts: Partial<HarnessStatusResponse['counts']>): HarnessStatusResponse {
  return { ...CLEAN, clean: false, counts: { ...CLEAN.counts, ...counts } };
}

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** Render the banner against one status, and wait for the read to settle. */
async function renderBanner(status: HarnessStatusResponse, sync?: HarnessSyncResponse) {
  const getHarnessStatus = vi.fn().mockResolvedValue(status);
  const syncHarness = vi.fn().mockResolvedValue(
    sync ?? {
      status: CLEAN,
      applied: 0,
      swept: [],
      removals: [],
      conflicts: 0,
      askedAbout: [],
    }
  );
  const transport = createMockTransport({ getHarnessStatus, syncHarness });
  render(<HarnessDriftBanner projectPath="/repo" />, { wrapper: createWrapper(transport) });
  await waitFor(() => expect(getHarnessStatus).toHaveBeenCalledWith('/repo'));
  return { getHarnessStatus, syncHarness };
}

describe('HarnessDriftBanner — one condition, one message, one action', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('draws the drift line with its action', async () => {
    // Purpose: the first branch of the table, and the only one with a button.
    // Seeded defect: drop the `counts.drifted` half of the predicate and a tree
    // whose only fault is a stale file draws nothing at all.
    await renderBanner(statusWith({ drifted: 1 }));

    const banner = await screen.findByRole('status');
    expect(within(banner).getByText('Some agent files are out of date.')).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
  });

  it('draws the conflict line with NO action', async () => {
    // Purpose: a sync cannot clear a conflict, so offering one would be a button
    // that reports the same problem again. Seeded defect: offer the action on
    // every branch and this reds.
    await renderBanner(statusWith({ conflicts: 1 }));

    const banner = await screen.findByRole('status');
    expect(
      within(banner).getByText('DorkOS can’t update some files. Something else is in the way.')
    ).toBeInTheDocument();
    expect(within(banner).queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('draws the adoptable line with NO action', async () => {
    // Purpose: the third branch. Moving a skill is a decision nobody has asked
    // for (D3), so this says the fact and offers nothing.
    await renderBanner(statusWith({ adoptable: 2 }));

    const banner = await screen.findByRole('status');
    expect(
      within(banner).getByText('Some skills live where only a few of your agents look.')
    ).toBeInTheDocument();
    expect(within(banner).queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('draws nothing at all when the tree is clean', async () => {
    // Purpose: the fourth branch, and the one the other three are meaningless
    // without. Seeded defect: render the banner unconditionally and this reds —
    // which is also the seeded defect the browser test's last step catches.
    await renderBanner(CLEAN);

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
  });

  it('takes the drift branch first when a tree has more than one fault', async () => {
    // Purpose: first match wins, and the order matters — a tree with drift AND a
    // conflict still has something a click fixes, so the actionable line is the
    // one to draw. Seeded defect: reorder the table and the person is told only
    // about the half they cannot act on.
    await renderBanner(statusWith({ drifted: 1, conflicts: 1, adoptable: 3 }));

    const banner = await screen.findByRole('status');
    expect(within(banner).getByText('Some agent files are out of date.')).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Sync now' })).toBeInTheDocument();
  });
});

describe('HarnessDriftBanner — what a click removes, before the click', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('offers the action for an orphan-only tree, and names every path it would remove', async () => {
    // Purpose: the case DOR-1889 exists for. Nothing has drifted, so a
    // drift-only predicate draws no banner while a click deletes two files.
    // Seeded defect: render the banner without the disclosure and this reds on
    // the paths; drop `sweepPreview` from the predicate and it reds on the
    // action.
    const user = userEvent.setup();
    await renderBanner({ ...HARNESS_STATUS_READY, counts: { ...CLEAN.counts } });

    const banner = await screen.findByRole('status');
    expect(within(banner).getByRole('button', { name: 'Sync now' })).toBeInTheDocument();

    const disclosure = within(banner).getByRole('button', {
      name: /Syncing also removes 2 files DorkOS put here/,
    });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');

    await user.click(disclosure);

    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    // Every path, with the sentence saying why it goes — the promise the
    // terminal's `--check` has always made before a `--fix`.
    expect(within(banner).getByText('.claude/skills/beta')).toBeInTheDocument();
    expect(within(banner).getByText('.claude/skills/gamma')).toBeInTheDocument();
    expect(within(banner).getAllByText('The skill this link pointed to is gone.')).toHaveLength(2);
  });

  it('says nothing about removals when a sync would delete nothing', async () => {
    // Purpose: the disclosure is not decoration. A tree with drift and no
    // orphans must not carry a warning about files that are not going anywhere.
    await renderBanner(statusWith({ drifted: 1 }));

    const banner = await screen.findByRole('status');
    expect(within(banner).queryByText(/Syncing also removes/)).not.toBeInTheDocument();
  });
});

describe('HarnessDriftBanner — the sync', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('calls syncHarness once, disables while it runs, and draws what changed', async () => {
    // Purpose: the whole click. Seeded defect: leave the button enabled and a
    // second click fires a second sync at a tree the first one is still writing.
    const user = userEvent.setup();
    let release!: (value: HarnessSyncResponse) => void;
    const pending = new Promise<HarnessSyncResponse>((resolve) => {
      release = resolve;
    });
    const getHarnessStatus = vi.fn().mockResolvedValue(statusWith({ drifted: 1 }));
    const syncHarness = vi.fn().mockReturnValue(pending);
    const transport = createMockTransport({ getHarnessStatus, syncHarness });
    render(<HarnessDriftBanner projectPath="/repo" />, { wrapper: createWrapper(transport) });
    await waitFor(() => expect(getHarnessStatus).toHaveBeenCalled());

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(syncHarness).toHaveBeenCalledTimes(1);
    expect(syncHarness).toHaveBeenCalledWith('/repo');
    const running = await screen.findByRole('button', { name: 'Syncing…' });
    expect(running).toBeDisabled();

    release({
      status: CLEAN,
      applied: 4,
      swept: ['.claude/skills/beta', '.claude/settings.local.json'],
      removals: [
        { path: '.claude/skills/beta', reason: 'The skill this link pointed to is gone.' },
        {
          path: '.claude/settings.local.json',
          reason: 'Only the hook entries DorkOS added go; your own settings stay.',
        },
      ],
      conflicts: 0,
      askedAbout: [],
    });

    const summary = await screen.findByText('Agent files updated.');
    expect(summary).toBeInTheDocument();
    expect(screen.getByText(/4 files written\./)).toBeInTheDocument();
    // The removed paths live in the page, not in a toast: a list of files that
    // are gone is not a thing that should fade after four seconds.
    expect(screen.getByText('Removed 2 files DorkOS put here:')).toBeInTheDocument();
    expect(screen.getByText('.claude/skills/beta')).toBeInTheDocument();
    expect(screen.getByText('.claude/settings.local.json')).toBeInTheDocument();
    // And each one says WHY, including the path that is not a deletion at all.
    expect(
      screen.getByText('Only the hook entries DorkOS added go; your own settings stay.')
    ).toBeInTheDocument();
    // One read, ever: the answer in hand is what the page renders.
    expect(getHarnessStatus).toHaveBeenCalledTimes(1);
  });

  it('re-renders from the RETURNED status, so a post-write conflict is not lost', async () => {
    // Purpose: the rule the whole mutation is shaped around. Seeded defect:
    // `invalidateQueries` instead of `setQueryData` — the refetch answers the
    // pre-write read this mock still holds, the cell reverts to `drifted`, and
    // the person is offered a button that has already run and cannot help.
    const user = userEvent.setup();
    const getHarnessStatus = vi.fn().mockResolvedValue(statusWith({ drifted: 1 }));
    const syncHarness = vi.fn().mockResolvedValue({
      status: statusWith({ conflicts: 1 }),
      applied: 1,
      swept: [],
      removals: [],
      conflicts: 1,
      askedAbout: [],
    });
    const transport = createMockTransport({ getHarnessStatus, syncHarness });
    render(<HarnessDriftBanner projectPath="/repo" />, { wrapper: createWrapper(transport) });
    await waitFor(() => expect(getHarnessStatus).toHaveBeenCalled());

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    // Put the receipt away; what is left is the banner drawn from the cache the
    // sync just wrote.
    await user.click(await screen.findByRole('button', { name: 'Dismiss what changed' }));

    expect(
      await screen.findByText('DorkOS can’t update some files. Something else is in the way.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Some agent files are out of date.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sync now' })).not.toBeInTheDocument();
    expect(getHarnessStatus).toHaveBeenCalledTimes(1);
  });

  it('says a package is waiting when the sync raised a card', async () => {
    // Purpose: the route answers without waiting for anybody to decide, so the
    // summary is the only place the person is told a decision is outstanding.
    // Seeded defect: drop the line and a sync that installed no hooks looks like
    // one that had none to install.
    const user = userEvent.setup();
    const { syncHarness } = await renderBanner(statusWith({ drifted: 1 }), {
      status: statusWith({ pendingApproval: 1 }),
      applied: 2,
      swept: [],
      removals: [],
      conflicts: 0,
      askedAbout: ['acme-tools'],
    });

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));

    expect(syncHarness).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('One package is waiting for your approval.')
    ).toBeInTheDocument();
  });

  it('puts the summary away without bringing the banner’s old answer back', async () => {
    // Purpose: the summary is a receipt and clears on request; the banner is a
    // condition and clears only by being recomputed. Seeded defect: give the
    // banner an `onDismiss` too and a person can hide a tree that is still out
    // of date.
    const user = userEvent.setup();
    await renderBanner(statusWith({ drifted: 1 }), {
      status: statusWith({ drifted: 1 }),
      applied: 0,
      swept: [],
      removals: [],
      conflicts: 0,
      askedAbout: [],
    });

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    await user.click(await screen.findByRole('button', { name: 'Dismiss what changed' }));

    expect(screen.queryByText('Agent files updated.')).not.toBeInTheDocument();
    // The tree really is still out of date, so the banner is still true.
    expect(await screen.findByText('Some agent files are out of date.')).toBeInTheDocument();
  });
});

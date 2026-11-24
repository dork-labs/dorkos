/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HarnessRow, HarnessStatusResponse } from '@dorkos/shared/harness-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import {
  HARNESS_STATUS_ALL_SHARED,
  HARNESS_STATUS_READY,
  HARNESS_STATUS_WITH_GLOBAL,
} from '../../__fixtures__/harness-status';

import { SkillHarnessRow } from '../SkillHarnessRow';
import { SkillsWithHarnessesList } from '../SkillsWithHarnessesList';

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSafeNavigate: () => vi.fn(),
}));

/** The row every enabled tool shares — the one that collapses. */
const SHARED_SKILL_ROW = HARNESS_STATUS_ALL_SHARED.rows[0];

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

/** Render one row on its own, inside the providers its mutation hook needs. */
function renderRow(element: ReactNode) {
  return render(element, { wrapper: createWrapper(createMockTransport()) });
}

/** Render the list against one status and wait for the read to settle. */
async function renderWithStatus(status: HarnessStatusResponse) {
  const getHarnessStatus = vi.fn().mockResolvedValue(status);
  const transport = createMockTransport({ getHarnessStatus });
  render(<SkillsWithHarnessesList projectPath="/repo" />, { wrapper: createWrapper(transport) });
  await waitFor(() => expect(getHarnessStatus).toHaveBeenCalledWith('/repo'));
  return { getHarnessStatus };
}

describe('SkillsWithHarnessesList — the list', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('lists a package installed for all projects beside this project’s own, tagged', async () => {
    // Seeded defect: drop the tag from the row.
    await renderWithStatus(HARNESS_STATUS_WITH_GLOBAL);

    const rows = await screen.findAllByRole('group');
    expect(rows).toHaveLength(
      HARNESS_STATUS_WITH_GLOBAL.counts.skills + HARNESS_STATUS_WITH_GLOBAL.counts.globalSkills
    );
    // Two rows share the name; exactly one of them says where it came from.
    const named = rows.filter((row) => row.getAttribute('aria-label') === 'release');
    expect(named).toHaveLength(2);
    expect(screen.getAllByText('for all your projects')).toHaveLength(1);
  });

  it('draws one row per skill and, expanded, one chip per enabled agent tool', async () => {
    // Purpose: both counts first. An empty render passes every "does not show X"
    // assertion in this file, so the numbers are what stop one.
    const user = userEvent.setup();
    await renderWithStatus(HARNESS_STATUS_READY);

    const rows = await screen.findAllByRole('group');
    // Six skills out of seven rows: the hook row is in the response on purpose
    // (the API is wider than this page) and is not a skill.
    expect(rows).toHaveLength(HARNESS_STATUS_READY.counts.skills);
    expect(rows).toHaveLength(6);

    await user.click(screen.getByRole('switch', { name: 'Show every agent tool' }));

    const chips = screen.getAllByRole('listitem');
    expect(chips).toHaveLength(6 * HARNESS_STATUS_READY.enabled.length);
    expect(chips).toHaveLength(18);
  });

  it('SRC-07: prints the command that moves the skill, carrying the absolute project', async () => {
    // Seeded defect: pass `.` as the project.
    await renderWithStatus(HARNESS_STATUS_READY);

    const row = await screen.findByRole('group', { name: 'chat-self-test' });
    const command = within(row).getByText(
      'dorkos harness adopt chat-self-test --project /Users/kai/code/dorkos'
    );
    expect(command.parentElement).toHaveTextContent(
      'Run: dorkos harness adopt chat-self-test --project /Users/kai/code/dorkos'
    );
    // And only the adoptable row says it.
    expect(screen.getAllByText(/dorkos harness adopt/)).toHaveLength(1);
  });

  it('SRC-10: the chips flip from the answer the move returned, with no second read', async () => {
    // Case 31's other half, and the seeded defect the spec calls the single most likely thing to
    // get wrong here: invalidate instead of `setQueryData` and the page throws away the
    // authoritative answer, asks again, and re-renders whatever the second read happens to find.
    const adoptable = HARNESS_STATUS_READY.rows.find((row) => row.adoptable) as HarnessRow;
    const afterTheMove: HarnessStatusResponse = {
      ...HARNESS_STATUS_READY,
      counts: { ...HARNESS_STATUS_READY.counts, adoptable: 0 },
      rows: HARNESS_STATUS_READY.rows.map((row) =>
        row.adoptable
          ? {
              ...row,
              provenance: 'authored' as const,
              source: `.agents/skills/${row.name}`,
              adoptable: false,
              cells: {
                'claude-code': {
                  state: 'projected' as const,
                  target: `.claude/skills/${row.name}`,
                },
                codex: { state: 'native' as const, target: `.agents/skills/${row.name}` },
                cursor: { state: 'native' as const, target: `.agents/skills/${row.name}` },
              },
            }
          : row
      ),
    };
    const getHarnessStatus = vi.fn().mockResolvedValue(HARNESS_STATUS_READY);
    const adoptHarness = vi.fn().mockResolvedValue({
      moved: [
        {
          name: adoptable.name,
          from: adoptable.source,
          to: `.agents/skills/${adoptable.name}`,
          link: { target: `.claude/skills/${adoptable.name}` },
        },
      ],
      declared: [],
      refusals: [],
      status: afterTheMove,
    });
    const transport = createMockTransport({ getHarnessStatus, adoptHarness });
    render(<SkillsWithHarnessesList projectPath="/repo" />, { wrapper: createWrapper(transport) });
    await waitFor(() => expect(getHarnessStatus).toHaveBeenCalledTimes(1));

    const row = await screen.findByRole('group', { name: adoptable.name });
    // Expanded first: once the skill is canonical every tool has it, and a row every tool is
    // current on collapses to one chip — which would hide the very chip this case is about.
    await userEvent.click(screen.getByRole('switch', { name: 'Show every agent tool' }));
    expect(within(row).getByRole('listitem', { name: 'Codex can’t see it' })).toBeInTheDocument();

    await userEvent.click(within(row).getByRole('button', { name: 'Share with every agent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Move it' }));

    const moved = await screen.findByRole('group', { name: adoptable.name });
    await waitFor(() =>
      expect(within(moved).getByRole('listitem', { name: 'Codex reads it' })).toBeInTheDocument()
    );
    expect(within(moved).getByRole('listitem', { name: 'Claude Code shared' })).toBeInTheDocument();
    // The advice, the command and the button all go with the row's adoptability.
    expect(within(moved).queryByRole('button', { name: 'Share with every agent' })).toBeNull();
    expect(screen.queryByText(/dorkos harness adopt/)).toBeNull();
    // And nothing asked the server again.
    expect(getHarnessStatus).toHaveBeenCalledTimes(1);
  });

  it('XA-06: names the folder the row is actually in, not always .claude/skills', () => {
    // Seeded defect: keep the sentence a constant.
    const row = {
      ...SHARED_SKILL_ROW,
      provenance: 'harness-native',
      name: 'review-pr',
      source: '.opencode/skills/review-pr',
      adoptable: true,
    } as const;

    renderRow(
      <SkillHarnessRow
        row={row}
        enabled={['claude-code']}
        projectPath="/Users/kai/code/dorkos"
        showEveryHarness
      />
    );

    expect(
      screen.getByText('Lives in .opencode/skills. Move it to .agents/skills to share it.')
    ).toBeInTheDocument();
    // The command is built from the row's own name and the project it is in,
    // whatever folder the skill sits in today.
    expect(
      screen.getByText('dorkos harness adopt review-pr --project /Users/kai/code/dorkos')
        .parentElement
    ).toHaveTextContent('Run: dorkos harness adopt review-pr --project /Users/kai/code/dorkos');
  });
});

describe('SkillsWithHarnessesList — the collapse', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('collapses a row every tool shares to one chip, and expands one with an exception', async () => {
    await renderWithStatus(HARNESS_STATUS_READY);

    const healthy = await screen.findByRole('group', { name: 'release' });
    expect(within(healthy).getAllByRole('listitem')).toHaveLength(1);
    expect(
      within(healthy).getByRole('button', {
        name: 'Shared with all 3',
        description: 'Claude Code · Codex · Cursor',
      })
    ).toBeInTheDocument();

    const exceptional = screen.getByRole('group', { name: 'browser-testing' });
    expect(within(exceptional).getAllByRole('listitem')).toHaveLength(3);
    expect(within(exceptional).queryByRole('button')).not.toBeInTheDocument();

    // A warning is an exception too, even though its cell's STATE is `projected`: collapsing this
    // row would swallow the marker saying it may not work, which is the one thing on it worth
    // reading.
    const warned = screen.getByRole('group', { name: 'marketplace-dev' });
    expect(within(warned).getAllByRole('listitem')).toHaveLength(3);
    expect(within(warned).queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('SkillsWithHarnessesList — the six page states', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('says it could not load and offers a Retry', async () => {
    const getHarnessStatus = vi.fn().mockRejectedValue(new Error('boom'));
    const transport = createMockTransport({ getHarnessStatus });
    render(<SkillsWithHarnessesList projectPath="/repo" />, { wrapper: createWrapper(transport) });

    expect(await screen.findByText('Couldn’t load skills.')).toBeInTheDocument();

    // Retry asks again rather than only looking like it does.
    const user = userEvent.setup();
    getHarnessStatus.mockResolvedValueOnce(HARNESS_STATUS_ALL_SHARED);
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('group', { name: 'release' })).toBeInTheDocument();
    expect(getHarnessStatus).toHaveBeenCalledTimes(2);
  });
});

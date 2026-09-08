/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HarnessStatusResponse } from '@dorkos/shared/harness-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  HARNESS_STATUS_ALL_SHARED,
  HARNESS_STATUS_NOT_SET_UP,
  HARNESS_STATUS_NO_SKILLS,
  HARNESS_STATUS_READY,
  HARNESS_STATUS_UNAVAILABLE,
  HARNESS_STATUS_UNREADABLE,
} from '../../__fixtures__/harness-status';
import { SkillsWithHarnessesList } from '../SkillsWithHarnessesList';

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

  it('names every chip after its tool and what that tool does, and describes it with the reason', async () => {
    // Purpose: the accessibility tree is the assertion, not a class name. The
    // chip word is a fixed phrase per state; the description is the plan's own
    // sentence, never a paraphrase.
    await renderWithStatus(HARNESS_STATUS_READY);

    const row = await screen.findByRole('group', { name: 'browser-testing' });
    expect(within(row).getByRole('listitem', { name: 'Claude Code reads it' })).toBeInTheDocument();
    expect(
      within(row).getByRole('listitem', {
        name: 'Codex can’t see it',
        description:
          'Codex has no skills directory — its instructions file is the only place to put this',
      })
    ).toBeInTheDocument();
    expect(within(row).getByRole('listitem', { name: 'Cursor shared' })).toBeInTheDocument();
  });

  it('says the word for every state the vocabulary has', async () => {
    // Purpose: one case per chip word, so a renamed state cannot silently draw
    // the wrong sentence on somebody's screen.
    await renderWithStatus(HARNESS_STATUS_READY);

    await screen.findByRole('group', { name: 'release' });
    expect(screen.getByRole('listitem', { name: 'Codex out of date' })).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Codex blocked' })).toBeInTheDocument();
    // A plain `projected` cell has no reason to give, so its description is the
    // path it wrote to — the question a person actually has about that chip.
    expect(
      screen.getByRole('listitem', {
        name: 'Codex shared',
        description: '.codex/skills/marketplace-dev',
      })
    ).toBeInTheDocument();
    // The warning rides a cell that already landed: the state chip stays and a
    // marker joins it, carrying the warning as its own description.
    expect(
      screen.getByRole('img', {
        name: 'May not work',
        description: 'its frontmatter names a tool Codex does not have',
      })
    ).toBeInTheDocument();
  });

  it('draws the adoptable sentence, once, and only on the adoptable row', async () => {
    await renderWithStatus(HARNESS_STATUS_READY);

    const row = await screen.findByRole('group', { name: 'chat-self-test' });
    expect(
      within(row).getByText(
        'Lives in .claude/skills. Move it to .agents/skills so every agent can read it.'
      )
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Move it to \.agents\/skills/)).toHaveLength(1);
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

    // A warning is an exception too, even though its cell's STATE is
    // `projected`: collapsing this row would swallow the marker saying it may
    // not work, which is the one thing on it worth reading.
    const warned = screen.getByRole('group', { name: 'marketplace-dev' });
    expect(within(warned).getAllByRole('listitem')).toHaveLength(3);
    expect(within(warned).queryByRole('button')).not.toBeInTheDocument();
  });

  it('lets the collapsed chip expand its own row', async () => {
    const user = userEvent.setup();
    await renderWithStatus(HARNESS_STATUS_ALL_SHARED);

    const row = await screen.findByRole('group', { name: 'release' });
    const chip = within(row).getByRole('button', { name: 'Shared with all 3' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');

    await user.click(chip);

    expect(within(row).getAllByRole('listitem')).toHaveLength(3);
    expect(within(row).getByRole('listitem', { name: 'Claude Code reads it' })).toBeInTheDocument();
  });

  it('expands every row at once from the page-level toggle', async () => {
    const user = userEvent.setup();
    await renderWithStatus(HARNESS_STATUS_READY);

    const healthy = await screen.findByRole('group', { name: 'release' });
    expect(within(healthy).getAllByRole('listitem')).toHaveLength(1);

    await user.click(screen.getByRole('switch', { name: 'Show every agent tool' }));

    expect(within(healthy).getAllByRole('listitem')).toHaveLength(3);
    expect(
      within(healthy).queryByRole('button', { name: /Shared with all/ })
    ).not.toBeInTheDocument();
  });
});

describe('SkillsWithHarnessesList — the six page states', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('draws three placeholder rows and no spinner while it is reading', () => {
    // Purpose: the shape of what is coming, not the fact that something is.
    const transport = createMockTransport({
      getHarnessStatus: vi.fn(() => new Promise<HarnessStatusResponse>(() => {})),
    });
    const { container } = render(<SkillsWithHarnessesList projectPath="/repo" />, {
      wrapper: createWrapper(transport),
    });

    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(6);
    expect(container.querySelector('[data-slot="spinner"]')).toBeNull();
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
  });

  it('says it could not load and offers a Retry', async () => {
    const getHarnessStatus = vi.fn().mockRejectedValue(new Error('boom'));
    const transport = createMockTransport({ getHarnessStatus });
    render(<SkillsWithHarnessesList projectPath="/repo" />, { wrapper: createWrapper(transport) });

    expect(await screen.findByText('Couldn’t load skills.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('says nothing is set up yet, with the command and a docs link', async () => {
    await renderWithStatus(HARNESS_STATUS_NOT_SET_UP);

    expect(
      await screen.findByText('DorkOS isn’t sharing agent files for this folder yet.')
    ).toBeInTheDocument();
    expect(screen.getByText('dorkos harness sync --fix')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How agent file sharing works' })).toHaveAttribute(
      'href',
      'https://dorkos.ai/docs/guides/cli-usage#agent-files'
    );
  });

  it('says the settings could not be read, and repeats the detail', async () => {
    await renderWithStatus(HARNESS_STATUS_UNREADABLE);

    expect(
      await screen.findByText('DorkOS can’t read this folder’s agent file settings.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('.agents/harness.manifest.json is not valid JSON.')
    ).toBeInTheDocument();
  });

  it('says where agent file sharing runs, rather than showing an empty list', async () => {
    // Purpose: Decision 26 from the reader's side. `unavailable` must never
    // render as "you have no skills".
    await renderWithStatus(HARNESS_STATUS_UNAVAILABLE);

    expect(
      await screen.findByText('Agent file sharing runs in the DorkOS app.')
    ).toBeInTheDocument();
    expect(screen.queryByText('No skills here yet.')).not.toBeInTheDocument();
  });

  it('says there are none yet, with the marketplace link, when the tree really is empty', async () => {
    await renderWithStatus(HARNESS_STATUS_NO_SKILLS);

    expect(await screen.findByText('No skills here yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Browse skill-packs/ })).toBeInTheDocument();
  });
});

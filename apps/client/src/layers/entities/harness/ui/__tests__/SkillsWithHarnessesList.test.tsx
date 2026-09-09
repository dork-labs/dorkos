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
  HARNESS_STATUS_WITH_GLOBAL,
} from '../../__fixtures__/harness-status';
import { harnessRowKey } from '../../lib/harness-status';
import { SkillHarnessRow } from '../SkillHarnessRow';
import { SkillsWithHarnessesList } from '../SkillsWithHarnessesList';

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
    // Seeded defect: drop the tag from the row. The list then draws two rows
    // called "release" with the same chips and nothing to tell them apart, above
    // a count that agrees with neither on its own.
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

  it('keys two rows apart when only their scope differs', () => {
    // Seeded defect: drop `scope` from the client key. React then reconciles two
    // different rows as one, and the server keys them apart while the client
    // does not — the one disagreement a list key must never have.
    //
    // Constructed rather than taken from the fixture, for the reason the server's
    // twin gives: on real payloads the two sources already differ — one
    // repo-relative, one absolute — so no realistic pair collides on the other
    // three, and a key that quietly dropped the fourth would pass every
    // end-to-end assertion until the day two sources agreed.
    const entry = { artifact: 'skill', source: '/x/skills/release', name: 'release' } as const;
    expect(harnessRowKey({ ...entry, scope: 'project' })).not.toEqual(
      harnessRowKey({ ...entry, scope: 'global' })
    );
    // Absent means project, matching the schema default and the server.
    expect(harnessRowKey(entry)).toEqual(harnessRowKey({ ...entry, scope: 'project' }));
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

  it('XA-06: names the folder the row is actually in, not always .claude/skills', () => {
    // Seeded defect: keep the sentence a constant. An OpenCode-first team is then
    // told to look in `.claude/skills`, a directory they do not have — advice
    // about somebody else's repository (DOR-1902).
    const row = {
      ...SHARED_SKILL_ROW,
      provenance: 'harness-native',
      name: 'review-pr',
      source: '.opencode/skills/review-pr',
      adoptable: true,
    } as const;

    render(<SkillHarnessRow row={row} enabled={['claude-code']} showEveryHarness />);

    expect(
      screen.getByText(
        'Lives in .opencode/skills. Move it to .agents/skills so every agent can read it.'
      )
    ).toBeInTheDocument();
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

  it('lets the collapsed chip expand its own row, and collapse it again from the keyboard', async () => {
    // Purpose: the chip is a toggle, not a one-way door. It used to render only
    // while collapsed, so pressing it unmounted it: focus fell to <body>, the
    // row had no control left, and 18 of this repository's 31 rows could never
    // be re-collapsed. The same element has to survive both presses.
    const user = userEvent.setup();
    await renderWithStatus(HARNESS_STATUS_ALL_SHARED);

    const row = await screen.findByRole('group', { name: 'release' });
    const chip = within(row).getByRole('button', { name: 'Shared with all 3' });
    expect(chip).toHaveAttribute('aria-expanded', 'false');

    chip.focus();
    await user.keyboard('{Enter}');

    expect(document.activeElement).toBe(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(within(row).getByRole('listitem', { name: 'Claude Code reads it' })).toBeInTheDocument();
    expect(within(row).getByRole('listitem', { name: 'Codex shared' })).toBeInTheDocument();
    expect(within(row).getByRole('listitem', { name: 'Cursor shared' })).toBeInTheDocument();

    await user.keyboard('{Enter}');

    expect(document.activeElement).toBe(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(
      within(row).queryByRole('listitem', { name: 'Claude Code reads it' })
    ).not.toBeInTheDocument();
  });

  it('keeps the chips in manifest order, never sorted', async () => {
    // Purpose: the order in `.agents/harness.manifest.json` is the order the
    // person wrote. Sorting it would make one row read differently on two
    // screens, and the collapsed chip's own title is not enough to pin it.
    const user = userEvent.setup();
    await renderWithStatus(HARNESS_STATUS_READY);
    await screen.findByRole('group', { name: 'release' });

    await user.click(screen.getByRole('switch', { name: 'Show every agent tool' }));
    const row = screen.getByRole('group', { name: 'browser-testing' });

    expect(
      within(row)
        .getAllByRole('listitem')
        .map((chip) => chip.getAttribute('aria-label'))
    ).toEqual(['Claude Code reads it', 'Codex can’t see it', 'Cursor shared']);
  });

  it('clips the source path at its FRONT, keeping the path itself left-to-right', () => {
    // Purpose: a skill's path is identified by its leaf and its head is what
    // every row repeats, so the ellipsis belongs at the start. `dir="rtl"` is
    // the whole mechanism, and the `<bdi dir="ltr">` inside it is required
    // rather than decorative — without it the bidi algorithm claims any neutral
    // character at either end of the path and paints it at the opposite one.
    render(<SkillHarnessRow row={SHARED_SKILL_ROW} enabled={['claude-code']} showEveryHarness />);

    const path = screen.getByTitle('.agents/skills/release');
    expect(path).toHaveAttribute('dir', 'rtl');
    expect(path).toHaveClass('truncate');
    // A right-to-left box would otherwise align a path that FITS to the right.
    expect(path).toHaveClass('text-left');

    const isolated = path.querySelector('bdi');
    expect(isolated).toHaveAttribute('dir', 'ltr');
    expect(isolated).toHaveTextContent('.agents/skills/release');
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
    // The blocks say nothing to a screen reader, so one sentence does.
    expect(screen.getByRole('status')).toHaveTextContent('Loading skills…');
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

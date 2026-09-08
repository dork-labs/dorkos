/**
 * @vitest-environment jsdom
 *
 * The Skills page, and the row that pushes it (spec `harness-sync-status`
 * §User Experience, "The Skills page" and "The profile row's count").
 *
 * Two failures are what this file exists to stop, and both shipped before it.
 * The page told a person with thirty-one skills they had none, because it
 * listed installed marketplace packages rather than what was on disk. And the
 * Toolkit row said "Skills 0" about the same agent, for the same reason — so
 * the assertions here are the two numbers and the one link, never the markup
 * around them.
 */
import { useState } from 'react';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type { HarnessStatusResponse } from '@dorkos/shared/harness-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { HARNESS_STATUS_NO_SKILLS, HARNESS_STATUS_READY } from '@/layers/entities/harness';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { buildProfileDeepLinkHarness } from '@/test-helpers/profile-deep-link';
import { ProfileView } from '../ui/ProfileView';
import { profileStack, type ProfileStackState } from '../model/profile-stack';

const byId = (id: string): TeamMember => MOCK_TEAM_ROSTER.find((member) => member.id === id)!;

const MANAGED = byId('agent-warden');
const ROSTER: TeamMember[] = [byId('person-dorian'), MANAGED];
const PROJECT_PATH = MANAGED.agent!.projectPath!;

/** An agent the roster knows nothing about the folder of. */
const NO_FOLDER: TeamMember = {
  ...MANAGED,
  agent: { ...MANAGED.agent!, projectPath: undefined },
};

/**
 * A profile that really pushes and pops, so the page can be opened and left.
 *
 * Leaving matters here: the property list is not on screen while a page is, so
 * "the row says 31 once the page has been opened" can only be read after a pop.
 */
function StatefulProfile({ member }: { member: TeamMember }) {
  const [stack, setStack] = useState<ProfileStackState>(profileStack(member.id, []));
  return (
    <ProfileView
      member={member}
      roster={ROSTER}
      home="sheet"
      stack={stack}
      onPush={(entry) =>
        setStack((current) => (entry.kind === 'page' ? { ...current, entries: [entry] } : current))
      }
      onPop={() => setStack((current) => ({ ...current, entries: [] }))}
    />
  );
}

/** Mount a profile inside everything it needs, and hand back the transport. */
async function renderProfile(
  member: TeamMember = MANAGED,
  status: HarnessStatusResponse | Error = HARNESS_STATUS_READY
) {
  const harness = buildProfileDeepLinkHarness('/');
  const config = createQueryClientConfig();
  const queryClient = new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...config.defaultOptions?.queries, retry: false, gcTime: 0 },
    },
  });
  const getHarnessStatus =
    status instanceof Error ? vi.fn().mockRejectedValue(status) : vi.fn().mockResolvedValue(status);
  const transport = createMockTransport({ getHarnessStatus });

  render(
    <harness.Wrapper>
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <TooltipProvider>
            <StatefulProfile member={member} />
          </TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    </harness.Wrapper>
  );
  await harness.ready();
  return { getHarnessStatus };
}

/** Open the row with this id. */
async function openRow(id: string) {
  await userEvent.click(document.querySelector(`[data-profile-row="${id}"]`)!);
}

/**
 * The Skills page, once it is on screen and the read has landed.
 *
 * Both waits are needed and they are different: the frame mounts immediately
 * (the list draws its placeholder rows), while everything else on the page is
 * drawn from the answer. Returning on the frame alone would leave every
 * assertion below racing the read, which is a test that reds on a busy machine
 * rather than on a bug. The list's `role="status"` — its "Loading skills…" — is
 * the marker for the second wait.
 */
async function openSkillsPage(): Promise<HTMLElement> {
  await openRow('skills');
  return await waitFor(() => {
    const page = document.querySelector<HTMLElement>('[data-slot="profile-skills"]');
    expect(page, 'the Skills page never mounted').not.toBeNull();
    expect(within(page!).queryByRole('status'), 'the read had not landed').toBeNull();
    return page!;
  });
}

// The pages are code-split (`registry.ts` uses `lazy`), so the first render of
// one waits on a real dynamic import, which vitest transforms on demand. The
// ceiling is the hook's own for the reason `ProfileAgentPages.test.tsx` gives:
// what is being waited on is a module graph being compiled, which belongs to
// the machine rather than to anything under test.
beforeAll(async () => {
  await import('../ui/pages/SkillsPage');
}, 60_000);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe('the Skills page', () => {
  it('lists every skill the folder holds, one row each, and not the rows that are not skills', async () => {
    // Purpose: the count first. An empty render passes every "does not show X"
    // assertion below, so the number is what stops one — and the number is the
    // whole bug: this page said "no skills installed" to a person with
    // thirty-one. The hook row in the fixture is deliberate: the API is wider
    // than this page (D27), and a page that drew it would be listing a hook
    // under a heading that says Skills.
    await renderProfile();
    const page = await openSkillsPage();

    const rows = await within(page).findAllByRole('group');
    expect(rows).toHaveLength(HARNESS_STATUS_READY.counts.skills);
    expect(rows).toHaveLength(6);
    expect(within(page).queryByRole('group', { name: 'hooks' })).not.toBeInTheDocument();
  });

  it('draws the notice, the list, the panels and the link in that order', async () => {
    // Purpose: the reading order §User Experience fixes. Asserting each block is
    // present would pass with them shuffled, and the order is the design — the
    // list a person came for sits above the panels that explain its exceptions,
    // and the one action is at the foot because it is what you do after reading.
    await renderProfile();
    const page = await openSkillsPage();

    const notice = within(page).getByText(
      'Gemini CLI files are in this folder, but DorkOS isn’t sharing to it.'
    );
    const firstSkill = within(page).getAllByRole('group')[0]!;
    const notShared = within(page).getByText('Not shared with Codex');
    const projectLevel = within(page).getByText('Project-level notices');
    const browse = within(page).getByRole('button', { name: /Browse skill-packs/ });

    const order = [notice, firstSkill, notShared, projectLevel, browse];
    for (let i = 1; i < order.length; i += 1) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        `block ${i} should follow block ${i - 1}`
      ).toBeTruthy();
    }
  });

  it('offers exactly one Browse skill-packs, with skills and without', async () => {
    // Purpose: the list's zero-skills state draws its own marketplace link so it
    // can stand alone, and the page keeps one at the foot. Composed naively that
    // is two links to one place on one screen. Seeded defect: drop
    // `showBrowseLink={false}` in `SkillsPage` and the second case reds at 2.
    await renderProfile();
    const withSkills = await openSkillsPage();
    expect(within(withSkills).getAllByRole('button', { name: /Browse skill-packs/ })).toHaveLength(
      1
    );

    cleanup();
    await renderProfile(MANAGED, HARNESS_STATUS_NO_SKILLS);
    const empty = await openSkillsPage();
    expect(await within(empty).findByText('No skills here yet.')).toBeInTheDocument();
    expect(within(empty).getAllByRole('button', { name: /Browse skill-packs/ })).toHaveLength(1);
  });

  it('tells you how to turn a tool on with a command, and never with a button', async () => {
    // Purpose: Decision 24. `--enable` writes a committed, team-shared file, so
    // the fix is typed in the folder where `git diff` is one keystroke away. A
    // button here would be the promise this decision refused to make.
    await renderProfile();
    const page = await openSkillsPage();

    expect(
      await within(page).findByText(
        'Gemini CLI files are in this folder, but DorkOS isn’t sharing to it.'
      )
    ).toBeInTheDocument();
    expect(within(page).getByText('dorkos harness sync --fix --enable gemini')).toBeInTheDocument();
    const buttons = within(page)
      .getAllByRole('button')
      .map((button) => button.textContent ?? '');
    expect(buttons.filter((label) => /enable|turn (it )?on/i.test(label))).toEqual([]);
  });

  it('repeats every reason a tool gave, verbatim, in its own panel', async () => {
    // Purpose: Priya's honesty gate. `dorkos harness sync` prints these exact
    // sentences; a paraphrase here would leave two surfaces describing one fact
    // in two voices with no way to tell which is current.
    const user = userEvent.setup();
    await renderProfile();
    const page = await openSkillsPage();

    await user.click(within(page).getByText('Not shared with Codex'));

    expect(
      within(page).getByText(
        'Codex has no skills directory — its instructions file is the only place to put this'
      )
    ).toBeInTheDocument();
  });

  it('says the folder is not known, and asks for nothing, when the roster has no path', async () => {
    const { getHarnessStatus } = await renderProfile(NO_FOLDER);
    await openRow('skills');

    expect(await screen.findByText('This agent’s folder isn’t known here.')).toBeInTheDocument();
    expect(getHarnessStatus).not.toHaveBeenCalled();
  });
});

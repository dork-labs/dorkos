// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunityWireReport } from '@dorkos/shared/community-wire';
import { MuteDialog } from '../moderation/MuteDialog.js';
import { PostingStanding } from '../moderation/PostingStanding.js';
import { FlagEntry } from '../moderation/FlagEntry.js';
import { ReportQueue } from '../moderation/ReportQueue.js';
import { SlowModeControl } from '../moderation/SlowModeControl.js';
import { DisplayNamePanel } from '../moderation/DisplayNamePanel.js';
import type { Member } from '../types.js';
import { mockFetch, refusal } from '../owner-replacement/__tests__/harness.js';

// DOR-2768: the space web UI for mute, slow mode, flags, rules and display names.

const CHANNEL = '00000000-0000-4000-8000-0000000000c1';
const ENTRY = '00000000-0000-4000-8000-0000000000e1';
const REPORT = '00000000-0000-4000-8000-0000000000f1';
const me: Member = {
  memberId: '00000000-0000-4000-8000-000000000001',
  kind: 'human',
  displayName: 'Alice',
  handle: 'alice',
  role: 'member',
  ownerMemberId: null,
  joinedAt: '2026-10-01T00:00:00.000Z',
};

/** A perform like the settings page's: runs the change, never throws. */
const perform = async (operation: () => Promise<unknown>) => {
  await operation().catch(() => undefined);
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the mute dialog', () => {
  it('mutes for the chosen time, an hour unless changed', () => {
    const onMute = vi.fn();
    render(<MuteDialog name="Sam" busy={false} onMute={onMute} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Mute Sam?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(onMute).toHaveBeenLastCalledWith(60);
    fireEvent.change(screen.getByLabelText('For'), { target: { value: String(24 * 60) } });
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(onMute).toHaveBeenLastCalledWith(1440);
  });
});

describe('what holds a post', () => {
  it('asks for the current rules, accepts that exact version, then lets the person post', async () => {
    let accepted = 0;
    const calls = mockFetch({
      'GET /api/v1/rules': () => ({
        status: 200,
        body: { text: 'Be kind.', version: 4, acceptedVersion: accepted },
      }),
      'POST /api/v1/rules/accept': () => {
        accepted = 4;
        return { status: 200, body: { text: 'Be kind.', version: 4, acceptedVersion: 4 } };
      },
      'GET /api/v1/me/standing': { status: 200, body: { mutedUntil: null } },
      [`GET /api/v1/channels/${CHANNEL}/slow-mode`]: { status: 200, body: { seconds: 30 } },
    });
    render(<PostingStanding channelId={CHANNEL} exempt={false} revision="" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Read the rules' }));
    expect(screen.getByRole('dialog', { name: 'Space rules' }).textContent).toContain('Be kind.');
    expect(screen.getByText('Slow mode: one post every 30 seconds.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept rules' }));
    await waitFor(() =>
      expect(screen.queryByText("Accept this space's rules to post.")).toBeNull()
    );
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ version: 4 });
  });

  it('says when a mute ends, and hides slow mode from owners and admins', async () => {
    mockFetch({
      'GET /api/v1/rules': { status: 200, body: { text: null, version: 0, acceptedVersion: 0 } },
      'GET /api/v1/me/standing': {
        status: 200,
        body: { mutedUntil: new Date(Date.now() + 60 * 60_000).toISOString() },
      },
      [`GET /api/v1/channels/${CHANNEL}/slow-mode`]: { status: 200, body: { seconds: 30 } },
    });
    render(<PostingStanding channelId={CHANNEL} exempt revision="" />);
    expect(await screen.findByText(/^You're muted until /u)).toBeTruthy();
    expect(screen.queryByText(/Slow mode/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Read the rules' })).toBeNull();
  });
});

describe('flagging a message', () => {
  it('sends the reason and a trimmed note, then says it was flagged', async () => {
    const calls = mockFetch({
      [`POST /api/v1/entries/${ENTRY}/reports`]: { status: 201, body: { reported: true } },
    });
    render(<FlagEntry entryId={ENTRY} author="Bob" />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Flag the message from Bob for moderators' })
    );
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'harassment' } });
    fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: '  rude  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    expect(await screen.findByText('Flagged for moderators.')).toBeTruthy();
    expect(calls[0]?.body).toEqual({ reason: 'harassment', note: 'rude' });
  });

  it('keeps the dialog open with the server’s reason when it refuses', async () => {
    mockFetch({
      [`POST /api/v1/entries/${ENTRY}/reports`]: refusal(
        409,
        'STATE_CONFLICT',
        "You can't report your own message."
      ),
    });
    render(<FlagEntry entryId={ENTRY} author="Bob" />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Flag the message from Bob for moderators' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Flag' }));
    expect(await screen.findByText("You can't report your own message.")).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Flag this message?' })).toBeTruthy();
  });
});

describe('the flagged-message queue', () => {
  const report: CommunityWireReport = {
    id: REPORT,
    entryId: ENTRY,
    channelId: CHANNEL,
    source: 'member',
    checkName: null,
    reason: 'spam',
    note: 'Again',
    status: 'open',
    action: null,
    reporter: { memberId: me.memberId, displayName: 'Alice' },
    author: {
      memberId: '00000000-0000-4000-8000-0000000000a9',
      displayName: 'Bob Bot',
      kind: 'agent',
    },
    excerpt: 'buy now',
    createdAt: '2026-10-10T00:00:00.000Z',
    resolvedAt: null,
  };

  it('mutes an agent’s owner for the chosen time, then reads the queue again', async () => {
    let open = [report];
    const calls = mockFetch({
      'GET /api/v1/reports': () => ({ status: 200, body: { reports: open } }),
      [`POST /api/v1/reports/${REPORT}/resolve`]: () => {
        open = [];
        return { status: 200, body: { resolved: 1 } };
      },
    });
    render(<ReportQueue busy={false} perform={perform} />);
    expect(await screen.findByText(/buy now/u)).toBeTruthy();
    expect(screen.getByText('“Again”')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mute author' }));
    expect(screen.getByRole('dialog', { name: 'Mute the owner of Bob Bot?' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('For'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(await screen.findByText('Nothing flagged.')).toBeTruthy();
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      action: 'mute',
      minutes: 10,
    });
  });

  it('says how many reports about the owner wait, with no more than the number', async () => {
    mockFetch({
      'GET /api/v1/reports': () => ({ status: 200, body: { reports: [], waitingAboutYou: 2 } }),
    });
    render(<ReportQueue busy={false} perform={perform} />);
    const line = await screen.findByText(/2 reports about you are waiting\./u);
    expect(line.textContent).toBe('2 reports about you are waiting. Add an admin to review them.');
    expect(screen.getByRole('link', { name: 'Add an admin' }).getAttribute('href')).toBe(
      '#space-members'
    );
  });

  it('keeps the waiting line its own block, 8px above the helper line', async () => {
    mockFetch({
      'GET /api/v1/reports': () => ({ status: 200, body: { reports: [], waitingAboutYou: 3 } }),
    });
    render(<ReportQueue busy={false} perform={perform} />);
    const line = await screen.findByText(/3 reports about you are waiting\./u);
    const helper = screen.getByText('Automatic checks only flag. They never hide a message.');
    expect(line.tagName).toBe('P');
    expect(line.nextElementSibling).toBe(helper);
    expect(line.parentElement?.className).toContain('gap-2');
  });

  it('drops “Nothing flagged” when reports about the owner wait', async () => {
    mockFetch({
      'GET /api/v1/reports': () => ({ status: 200, body: { reports: [], waitingAboutYou: 1 } }),
    });
    render(<ReportQueue busy={false} perform={perform} />);
    await screen.findByText(/1 report about you is waiting\./u);
    expect(screen.queryByText('Nothing flagged.')).toBeNull();
  });

  it('says it in the singular for one report, and nothing when none wait', async () => {
    let waiting: number | undefined = 1;
    mockFetch({
      'GET /api/v1/reports': () => ({
        status: 200,
        body: { reports: [], ...(waiting ? { waitingAboutYou: waiting } : {}) },
      }),
    });
    const first = render(<ReportQueue busy={false} perform={perform} />);
    const line = await screen.findByText(/1 report about you is waiting\./u);
    expect(line.textContent).toBe('1 report about you is waiting. Add an admin to review it.');
    first.unmount();
    waiting = undefined;
    render(<ReportQueue busy={false} perform={perform} />);
    await screen.findByText('Nothing flagged.');
    expect(screen.queryByRole('link', { name: 'Add an admin' })).toBeNull();
  });

  it('shows what the automatic checks made of a message, and can list only their flags', async () => {
    const checked: CommunityWireReport = {
      ...report,
      id: '00000000-0000-4000-8000-0000000000c1',
      source: 'check',
      checkName: 'jev',
      reporter: null,
      note: 'Jev thinks this is spam (82% sure). Nothing was hidden.',
      excerpt: 'cheap watches',
      checks: [
        {
          check: 'jev',
          modelId: 'typesafe/jev-1.13',
          verdict: 'flagged',
          finding: 'spam',
          rule: null,
          confidence: 0.82,
          at: '2026-10-10T00:00:01.000Z',
        },
        {
          check: 'openai',
          modelId: 'gpt-test',
          verdict: 'flagged',
          finding: 'rule',
          rule: 2,
          confidence: 0.74,
          at: '2026-10-10T00:00:01.000Z',
        },
        {
          check: 'rules',
          modelId: 'rules',
          verdict: 'unsure',
          finding: null,
          rule: null,
          confidence: 0,
          at: '2026-10-10T00:00:00.500Z',
        },
      ],
    };
    mockFetch({
      'GET /api/v1/reports': () => ({ status: 200, body: { reports: [report, checked] } }),
    });
    render(<ReportQueue busy={false} perform={perform} />);
    expect(await screen.findByText(/cheap watches/u)).toBeTruthy();
    expect(screen.getByText(/From an automatic check \(Jev\)/u)).toBeTruthy();
    expect(screen.getByText('Jev: looks like spam, 82% sure')).toBeTruthy();
    expect(screen.getByText('gpt-test: may break rule 2, 74% sure')).toBeTruthy();
    expect(screen.getByText('Built-in rules: no clear answer')).toBeTruthy();
    expect(screen.getByText(/buy now/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Automatic checks only' }));
    expect(screen.queryByText(/buy now/u)).toBeNull();
    expect(screen.getByText(/cheap watches/u)).toBeTruthy();
  });
});

describe('slow mode control', () => {
  it('reads the channel’s wait and sets a new one', async () => {
    let seconds = 0;
    const calls = mockFetch({
      [`GET /api/v1/channels/${CHANNEL}/slow-mode`]: () => ({ status: 200, body: { seconds } }),
      [`PATCH /api/v1/channels/${CHANNEL}`]: (call) => {
        seconds = (call.body as { slowModeSeconds: number }).slowModeSeconds;
        return { status: 200, body: {} };
      },
    });
    render(<SlowModeControl channelId={CHANNEL} busy={false} perform={perform} />);
    const select = (await screen.findByLabelText('Slow mode')) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: '60' } });
    await waitFor(() => expect(select.value).toBe('60'));
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ slowModeSeconds: 60 });
  });
});

describe('display name', () => {
  it('saves a trimmed name and shows a refusal in the server’s words', async () => {
    let refuse = true;
    const calls = mockFetch({
      'PATCH /api/v1/me': () =>
        refuse
          ? refusal(409, 'STATE_CONFLICT', 'That name is taken in this space. Try another.')
          : { status: 200, body: { member: { ...me, displayName: 'Alice A.' } } },
    });
    const onChanged = vi.fn();
    render(<DisplayNamePanel me={me} onChanged={onChanged} />);
    const input = screen.getByLabelText('Display name');
    fireEvent.change(input, { target: { value: 'Bob Bot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('That name is taken in this space. Try another.')).toBeTruthy();
    refuse = false;
    fireEvent.change(input, { target: { value: '  Alice A.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Name changed. New messages use it.')).toBeTruthy();
    expect(calls.at(-1)?.body).toEqual({ displayName: 'Alice A.' });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});

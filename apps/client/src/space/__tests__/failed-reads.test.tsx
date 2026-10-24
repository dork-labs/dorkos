// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PostingStanding } from '../moderation/PostingStanding.js';
import { SlowModeControl } from '../moderation/SlowModeControl.js';
import { SpaceMembers } from '../components/members/SpaceMembers.js';
import { ExportPanel } from '../components/ExportPanel.js';
import type { Member } from '../types.js';
import { mockFetch } from '../owner-replacement/__tests__/harness.js';

// DOR-3154: a read that fails says so, rather than drawing a screen that looks
// complete. An unrouted request in `mockFetch` answers 599.

const CHANNEL = '00000000-0000-4000-8000-0000000000c1';
const admin: Member = {
  memberId: '00000000-0000-4000-8000-000000000001',
  kind: 'human',
  displayName: 'Alice',
  handle: 'alice',
  role: 'admin',
  ownerMemberId: null,
  joinedAt: '2026-10-01T00:00:00.000Z',
};
const perform = async (operation: () => Promise<unknown>) => {
  await operation().catch(() => undefined);
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('slow mode control', () => {
  it('says it could not read slow mode, and Retry reads it again', async () => {
    let up = false;
    mockFetch({
      [`GET /api/v1/channels/${CHANNEL}/slow-mode`]: () =>
        up ? { status: 200, body: { seconds: 30 } } : { status: 503, body: {} },
    });
    render(<SlowModeControl channelId={CHANNEL} busy={false} perform={perform} />);
    expect(await screen.findByText("Couldn't read slow mode.")).toBeTruthy();

    up = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const select = screen.getByLabelText('Slow mode') as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(screen.queryByText("Couldn't read slow mode.")).toBeNull();
  });
});

describe('what holds a post', () => {
  it('says it could not check, rather than showing no rules or mute', async () => {
    mockFetch({
      'GET /api/v1/me/standing': { status: 200, body: { mutedUntil: null } },
      [`GET /api/v1/channels/${CHANNEL}/slow-mode`]: { status: 200, body: { seconds: 0 } },
    });
    render(<PostingStanding channelId={CHANNEL} exempt={false} revision="" />);
    expect(await screen.findByText("Couldn't check your posting status.")).toBeTruthy();
  });
});

describe('the members page', () => {
  it('says it could not read who is muted or banned, rather than showing nobody', async () => {
    mockFetch({ 'GET /api/v1/mutes': { status: 200, body: { mutes: [] } } });
    render(
      <SpaceMembers
        me={admin}
        directory={[admin]}
        hasMore={false}
        busy={false}
        perform={perform}
        onMore={vi.fn()}
      />
    );
    expect(await screen.findByText("Couldn't read who is muted or banned.")).toBeTruthy();
  });
});

describe('the export panel', () => {
  it('shows the failed read instead of looking like there is no export', async () => {
    mockFetch({});
    render(<ExportPanel scope="personal" idPrefix="x" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});

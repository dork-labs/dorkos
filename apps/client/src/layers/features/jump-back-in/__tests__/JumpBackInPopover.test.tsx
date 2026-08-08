// @vitest-environment jsdom
/**
 * The panel itself: what a row says, which one reads as highlighted, and that a
 * click on one opens that thread and no other.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { agentAuthorRef, type AuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { roomIdentityMark } from '@/layers/entities/room';
import { mergeJumpBackIn } from '@/layers/entities/recents';
import { createMockSession } from '@dorkos/test-utils';
import { JumpBackInPopover } from '../ui/JumpBackInPopover';
import { jumpBackInRowId } from '../model/use-jump-back-in-popover';

const room = (overrides: Partial<RoomSummary> & Pick<RoomSummary, 'id' | 'kind'>): RoomSummary => ({
  slug: null,
  title: 'Untitled',
  topic: null,
  workspaceId: null,
  archived: false,
  createdAt: '2026-07-01T00:00:00.000Z',
  lastActivityAt: '2026-08-01T10:00:00.000Z',
  unreadCount: 0,
  participants: null,
  ...overrides,
});

/** One of each kind, most recent first: #general, a session, a direct message. */
function fixtureRows() {
  return mergeJumpBackIn({
    sessions: [
      createMockSession({
        id: 'sess-1',
        title: 'Refactor auth middleware',
        cwd: '/code/api',
        lastMessagePreview: 'Middleware is green',
        updatedAt: '2026-08-01T11:00:00.000Z',
      }),
    ],
    rooms: [
      room({
        id: 'c1',
        kind: 'channel',
        slug: 'general',
        title: 'general',
        unreadCount: 4,
        lastActivityAt: '2026-08-01T12:00:00.000Z',
      }),
      room({
        id: 'd1',
        kind: 'dm',
        title: 'code-reviewer',
        working: 1,
        participants: [dmParticipant()],
      }),
    ],
  }).items;
}

const AGENT_PATH = '/code/reviewer';

/** The agent on the other side of the direct message, as the roster carries it. */
const dmParticipant = (): AuthorRef =>
  ({
    id: 'author-reviewer',
    kind: 'agent',
    displayName: 'code-reviewer',
    handle: 'code-reviewer',
    agentRef: agentAuthorRef(AGENT_PATH),
    // Deliberately no emoji: `AuthorRef.emoji` is a render cache the server
    // fills in for almost no agent, which is exactly the hole DOR-582 fell
    // through. The face has to come from the manifest instead.
  }) as AuthorRef;

// Only the three fields a face is resolved from; the manifest's other twenty
// have no bearing on a mark, so the fixture states what it means and casts once.
const reviewerManifest = {
  id: 'agent-ulid-1',
  name: 'reviewer',
  icon: '🔍',
  color: '#6366f1',
} as unknown as AgentManifest;

/** The real derivation, over a one-agent fleet — what the host passes in. */
const visualOf = (room: RoomSummary) =>
  roomIdentityMark({
    room,
    agentsByPath: { [AGENT_PATH]: reviewerManifest },
    pathByAgentRef: new Map([[agentAuthorRef(AGENT_PATH), AGENT_PATH]]),
  });

afterEach(cleanup);

describe('JumpBackInPopover', () => {
  it('draws every kind of thread as one named list', () => {
    render(
      <JumpBackInPopover
        rows={fixtureRows()}
        selectedIndex={0}
        visualOf={visualOf}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByRole('listbox', { name: 'Jump back in' })).toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveTextContent('general');
    expect(options[1]).toHaveTextContent('Refactor auth middleware');
    expect(options[2]).toHaveTextContent('code-reviewer');
  });

  // The defect this pins: the panel used to hand `RoomAvatar` no faces at all
  // and let it fall back to the roster, which draws the room's letter disc for
  // every agent whose `AuthorRef.emoji` the server never cached — a letter in
  // the popover beside the same agent's face in the sidebar, one row apart.
  it('draws a direct message with its agent’s own face, never a letter (DOR-582)', () => {
    render(
      <JumpBackInPopover
        rows={fixtureRows()}
        selectedIndex={0}
        visualOf={visualOf}
        onSelect={vi.fn()}
      />
    );

    const dmRow = screen
      .getAllByRole('option')
      .find((o) => o.textContent?.includes('code-reviewer'));
    expect(dmRow).toBeDefined();
    expect(dmRow!).toHaveTextContent('🔍');
    // The letter the roster fallback would have drawn.
    expect(dmRow!.textContent).not.toContain('C');
  });

  it('says what last happened, and stays quiet when there is nothing honest to say', () => {
    render(
      <JumpBackInPopover
        rows={fixtureRows()}
        selectedIndex={0}
        visualOf={visualOf}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('4 new messages')).toBeInTheDocument();
    expect(screen.getByText('Middleware is green')).toBeInTheDocument();
    expect(screen.getByText('1 agent working')).toBeInTheDocument();
  });

  it('marks exactly one row as the one Enter would open, by the id the composer announces', () => {
    render(
      <JumpBackInPopover
        rows={fixtureRows()}
        selectedIndex={1}
        visualOf={visualOf}
        onSelect={vi.fn()}
      />
    );

    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(options[1]).toHaveAttribute('id', jumpBackInRowId(1));
  });

  it('offers no focus stop of its own — the composer keeps the caret', () => {
    render(
      <JumpBackInPopover
        rows={fixtureRows()}
        selectedIndex={0}
        visualOf={visualOf}
        onSelect={vi.fn()}
      />
    );

    for (const option of screen.getAllByRole('option')) {
      expect(option).not.toHaveAttribute('tabindex');
    }
  });

  it('opens the row that was clicked', () => {
    const onSelect = vi.fn();
    const rows = fixtureRows();
    render(
      <JumpBackInPopover rows={rows} selectedIndex={0} visualOf={visualOf} onSelect={onSelect} />
    );

    fireEvent.click(screen.getAllByRole('option')[2]!);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(rows[2]);
  });

  it('draws nothing but an empty list when there is nothing to offer', () => {
    render(
      <JumpBackInPopover rows={[]} selectedIndex={0} visualOf={visualOf} onSelect={vi.fn()} />
    );

    expect(screen.getByRole('listbox')).toBeEmptyDOMElement();
  });
});

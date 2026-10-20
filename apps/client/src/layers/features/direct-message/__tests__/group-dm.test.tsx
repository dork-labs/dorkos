// @vitest-environment jsdom
/**
 * A group DM's right panel is about one member at a time (DOR-3075): which
 * rooms are group DMs, who in one the panel can be about, and the picker at
 * the top of the panel that chooses, through the same explicit pick a room's
 * Profile tab already follows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { agentAuthorRef, type AuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { useAppStore } from '@/layers/shared/model';
import { groupDmMembers, isGroupDm, type GroupDmMember } from '../lib/group-dm';
import { GroupDmMemberPicker } from '../ui/GroupDmMemberPicker';

const person = (id: string, name: string): AuthorRef => ({
  id,
  kind: 'human',
  displayName: name,
  handle: null,
});
const agent = (id: string, name: string, path: string, extra: Partial<AuthorRef> = {}) =>
  ({
    id,
    kind: 'agent',
    displayName: name,
    handle: name,
    agentRef: agentAuthorRef(path),
    ...extra,
  }) as AuthorRef;

const room = (participants: AuthorRef[], over: Partial<RoomSummary> = {}) =>
  ({ id: 'r1', kind: 'dm', bridge: null, participants, ...over }) as RoomSummary;

const FLEET = [
  { id: 'm-qa', projectPath: '/agents/qa' },
  { id: 'm-designer', projectPath: '/agents/designer' },
] as never;

describe('isGroupDm', () => {
  it('is a DM that is not one person with one agent', () => {
    expect(isGroupDm(room([person('h1', 'Dorian'), agent('a1', 'qa', '/agents/qa')]))).toBe(false);
    expect(
      isGroupDm(
        room([person('h1', 'Dorian'), person('h2', 'Maya'), agent('a1', 'qa', '/agents/qa')])
      )
    ).toBe(true);
  });

  it('is never a channel or a bridged chat', () => {
    const three = [person('h1', 'Dorian'), person('h2', 'Maya'), agent('a1', 'qa', '/agents/qa')];
    expect(isGroupDm(room(three, { kind: 'channel' }))).toBe(false);
    expect(isGroupDm(room(three, { bridge: {} as RoomSummary['bridge'] }))).toBe(false);
  });
});

describe('groupDmMembers', () => {
  it('lists the agents the fleet knows, in roster order, by their directory', () => {
    const members = groupDmMembers(
      room([
        person('h1', 'Dorian'),
        agent('a2', 'designer', '/agents/designer', { emoji: '🎨' }),
        agent('a1', 'qa', '/agents/qa'),
        agent('a3', 'ghost', '/agents/gone'),
        agent('a4', 'retired', '/agents/qa', { retired: true }),
      ]),
      FLEET
    );
    expect(members.map((m) => [m.displayName, m.agentPath])).toEqual([
      ['designer', '/agents/designer'],
      ['qa', '/agents/qa'],
    ]);
    expect(members[0]!.emoji).toBe('🎨');
  });

  it('is empty until the fleet answers', () => {
    expect(groupDmMembers(room([agent('a1', 'qa', '/agents/qa')]), undefined)).toEqual([]);
  });
});

describe('GroupDmMemberPicker', () => {
  const MEMBERS: GroupDmMember[] = [
    { authorId: 'a2', agentPath: '/agents/designer', displayName: 'designer' },
    { authorId: 'a1', agentPath: '/agents/qa', displayName: 'qa' },
  ];

  beforeEach(() => useAppStore.getState().setExplicitAgentPath(null));
  afterEach(cleanup);

  it('picks the first agent when nobody in this DM is picked', async () => {
    useAppStore.getState().setExplicitAgentPath('/agents/someone-else');
    render(<GroupDmMemberPicker members={MEMBERS} />);
    await waitFor(() => expect(useAppStore.getState().explicitAgentPath).toBe('/agents/designer'));
    expect(screen.getByRole('radio', { name: 'designer' })).toHaveAttribute('aria-checked', 'true');
  });

  it('scopes the panel to the member pressed', async () => {
    render(<GroupDmMemberPicker members={MEMBERS} />);
    fireEvent.click(screen.getByRole('radio', { name: 'qa' }));
    await waitFor(() => expect(useAppStore.getState().explicitAgentPath).toBe('/agents/qa'));
    expect(screen.getByRole('radio', { name: 'qa' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'designer' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('keeps a pick that is already a member', () => {
    useAppStore.getState().setExplicitAgentPath('/agents/qa');
    render(<GroupDmMemberPicker members={MEMBERS} />);
    expect(useAppStore.getState().explicitAgentPath).toBe('/agents/qa');
  });

  it('draws nothing for a DM with no agent in it', () => {
    const { container } = render(<GroupDmMemberPicker members={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('GroupDmMemberPicker by keyboard', () => {
  const MEMBERS: GroupDmMember[] = [
    { authorId: 'a2', agentPath: '/agents/designer', displayName: 'designer' },
    { authorId: 'a1', agentPath: '/agents/qa', displayName: 'qa' },
  ];

  beforeEach(() => useAppStore.getState().setExplicitAgentPath('/agents/designer'));
  afterEach(cleanup);

  it('is one Tab stop, and the arrow keys move the pick and the focus together', async () => {
    render(<GroupDmMemberPicker members={MEMBERS} />);
    const designer = screen.getByRole('radio', { name: 'designer' });
    const qa = screen.getByRole('radio', { name: 'qa' });
    expect(designer).toHaveAttribute('tabindex', '0');
    expect(qa).toHaveAttribute('tabindex', '-1');

    designer.focus();
    fireEvent.keyDown(designer, { key: 'ArrowRight' });
    await waitFor(() => expect(useAppStore.getState().explicitAgentPath).toBe('/agents/qa'));
    expect(qa).toHaveFocus();
    expect(qa).toHaveAttribute('tabindex', '0');

    fireEvent.keyDown(qa, { key: 'ArrowRight' });
    await waitFor(() => expect(useAppStore.getState().explicitAgentPath).toBe('/agents/designer'));
    expect(designer).toHaveFocus();
  });
});

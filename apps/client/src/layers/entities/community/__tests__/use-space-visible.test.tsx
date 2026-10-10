/** @vitest-environment jsdom */
/**
 * The official DorkOS space through the spaces switch, on the client (spec
 * `official-community-space` D4, D5, D13): which space may show, the one-time offer to join it,
 * and the calm line while its server is not answering.
 *
 * The config and the connection list are stubbed at their hooks, so each case states the
 * experiment, the official link and the connections it is about.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';

const state = vi.hoisted(() => ({
  enabled: false,
  isLoading: false,
  officialLink: null as string | null,
  connections: undefined as Partial<CommunityConnectionDescriptor>[] | undefined,
  connectionsError: false,
  dismissed: [] as string[],
  dismissPromo: vi.fn(),
}));

vi.mock('@/layers/entities/config', () => ({
  useSpacesAccess: () => ({
    enabled: state.enabled,
    isLoading: state.isLoading,
    officialLink: state.officialLink,
    anySpace: state.enabled || state.officialLink !== null,
  }),
  usePromoDismissals: () => ({ dismissedIds: state.dismissed, dismissPromo: state.dismissPromo }),
}));
vi.mock('../model/use-community-connections', () => ({
  useCommunityConnections: () => ({ data: state.connections, isError: state.connectionsError }),
}));

import { isSpaceVisible, useSpaceVisible } from '../model/use-space-visible';
import { OFFICIAL_SPACE_OFFER_ID, useOfficialSpaceOffer } from '../model/use-official-space-offer';
import { useJoinSpaceRequest } from '../model/join-space-request';
import { OfficialSpaceOfferCard } from '../ui/OfficialSpaceOfferCard';
import { OfficialSpaceUnreachableNotice } from '../ui/OfficialSpaceUnreachableNotice';

const LINK = 'https://space.example.test/c/11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  state.enabled = false;
  state.isLoading = false;
  state.officialLink = LINK;
  state.connections = [{ ref: 'official', official: true }, { ref: 'other' }];
  state.connectionsError = false;
  state.dismissed = [];
  state.dismissPromo.mockReset();
  useJoinSpaceRequest.setState({ url: null });
});

afterEach(() => cleanup());

describe('isSpaceVisible', () => {
  it('lets every space through with the experiment on, and only the official one off', () => {
    expect(isSpaceVisible({}, true)).toBe(true);
    expect(isSpaceVisible({ official: true }, false)).toBe(true);
    expect(isSpaceVisible({}, false)).toBe(false);
    expect(isSpaceVisible({ official: false }, false)).toBe(false);
  });
});

describe('useSpaceVisible', () => {
  const visible = (ref: string | undefined) =>
    renderHook(() => useSpaceVisible(ref)).result.current;

  it('shows the official space with the experiment off, and no other', () => {
    expect(visible('official')).toEqual({ visible: true, isLoading: false });
    expect(visible('other')).toEqual({ visible: false, isLoading: false });
    expect(visible('unknown')).toEqual({ visible: false, isLoading: false });
  });

  it('shows every space once the experiment is on (the control)', () => {
    state.enabled = true;
    expect(visible('other')).toEqual({ visible: true, isLoading: false });
  });

  it('shows nothing with no official link, whatever a row claims', () => {
    state.officialLink = null;
    expect(visible('official')).toEqual({ visible: false, isLoading: false });
  });

  it('waits for the config and the list before it answers', () => {
    state.isLoading = true;
    expect(visible('official')).toEqual({ visible: false, isLoading: true });
    state.isLoading = false;
    state.connections = undefined;
    expect(visible('official')).toEqual({ visible: false, isLoading: true });
    // A failed list read is an answer: not shown, not waiting forever.
    state.connectionsError = true;
    expect(visible('official')).toEqual({ visible: false, isLoading: false });
  });
});

describe('useOfficialSpaceOffer', () => {
  const offer = () => renderHook(() => useOfficialSpaceOffer()).result.current;

  it('offers nothing once this install is connected to the official space', () => {
    expect(offer()).toMatchObject({ joined: true, offered: false });
  });

  it('offers the official space while it is not connected', () => {
    state.connections = [{ ref: 'other' }];
    expect(offer()).toMatchObject({ link: LINK, joined: false, offered: true });
  });

  it('offers nothing after Not now, without a link, or before the list answers', () => {
    state.connections = [{ ref: 'other' }];
    state.dismissed = [OFFICIAL_SPACE_OFFER_ID];
    expect(offer().offered).toBe(false);
    state.dismissed = [];
    state.officialLink = null;
    expect(offer().offered).toBe(false);
    state.officialLink = LINK;
    state.connections = undefined;
    expect(offer().offered).toBe(false);
  });
});

describe('OfficialSpaceOfferCard', () => {
  beforeEach(() => {
    state.connections = [{ ref: 'other' }];
  });

  it('asks for the Join dialog on the official link', () => {
    const onDone = vi.fn();
    render(<OfficialSpaceOfferCard onDone={onDone} />);
    expect(screen.getByRole('heading', { name: 'Join the DorkOS community' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(useJoinSpaceRequest.getState().url).toBe(LINK);
    expect(onDone).toHaveBeenCalledOnce();
    expect(state.dismissPromo).not.toHaveBeenCalled();
  });

  it('remembers Not now for good, and asks for nothing', () => {
    render(<OfficialSpaceOfferCard />);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(state.dismissPromo).toHaveBeenCalledWith(OFFICIAL_SPACE_OFFER_ID);
    expect(useJoinSpaceRequest.getState().url).toBeNull();
  });

  it('draws nothing once skipped', () => {
    state.dismissed = [OFFICIAL_SPACE_OFFER_ID];
    const { container } = render(<OfficialSpaceOfferCard />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('join-space request', () => {
  it('hands the link to one reader only', () => {
    useJoinSpaceRequest.getState().ask(LINK);
    expect(useJoinSpaceRequest.getState().take()).toBe(LINK);
    expect(useJoinSpaceRequest.getState().take()).toBeNull();
  });
});

describe('OfficialSpaceUnreachableNotice', () => {
  const unverified = {
    state: 'unverified',
    effective: { read: false, post: false, enrollAgent: false, stream: false },
    lastKnown: null,
  } as const;

  it('says calmly that the official space is not reachable right now', () => {
    render(
      <OfficialSpaceUnreachableNotice
        connection={{ official: true, status: 'connected', access: unverified }}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'The DorkOS community isn’t reachable right now.'
    );
  });

  it('says nothing for another space, or while the official one answers', () => {
    const other = render(
      <OfficialSpaceUnreachableNotice connection={{ status: 'connected', access: unverified }} />
    );
    expect(other.container).toBeEmptyDOMElement();
    const answering = render(
      <OfficialSpaceUnreachableNotice
        connection={{
          official: true,
          status: 'connected',
          access: { ...unverified, state: 'verified' },
        }}
      />
    );
    expect(answering.container).toBeEmptyDOMElement();
  });
});

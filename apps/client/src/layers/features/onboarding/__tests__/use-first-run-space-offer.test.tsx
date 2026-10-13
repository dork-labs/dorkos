/** @vitest-environment jsdom */
/**
 * When the first run's offer to join the official DorkOS space is due (DOR-2873): after a first
 * run that set up an AI, and only while the offer's own rules hold. Both surfaces that show it
 * (the Getting started card and the sidebar's bottom slot) read this one answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({
  firstRunPath: 'dorkos' as 'dorkos' | 'own' | 'none' | null,
  officialLink: null as string | null,
  connections: [] as { ref: string; official?: boolean }[] | undefined,
  loading: false,
  dismissed: [] as string[],
}));

vi.mock('@/layers/entities/config', () => ({
  useSpacesAccess: () => ({
    enabled: false,
    isLoading: false,
    officialLink: state.officialLink,
    anySpace: state.officialLink !== null,
  }),
  usePromoDismissals: () => ({ dismissedIds: state.dismissed, dismissPromo: vi.fn() }),
}));
vi.mock('@/layers/entities/community/model/use-community-connections', () => ({
  useCommunityConnections: () => ({
    data: state.connections,
    isError: false,
    isLoading: state.loading,
  }),
}));
vi.mock('../model/use-onboarding', () => ({
  useOnboarding: () => ({ state: { firstRunPath: state.firstRunPath } }),
}));

import { OFFICIAL_SPACE_OFFER_ID } from '@/layers/entities/community';
import { useFirstRunSpaceOffer } from '../model/use-first-run-space-offer';

const offer = () => renderHook(() => useFirstRunSpaceOffer()).result.current;
const due = () => offer().due;

beforeEach(() => {
  state.firstRunPath = 'dorkos';
  state.officialLink = 'https://space.example.test/c/11111111-1111-4111-8111-111111111111';
  state.connections = [];
  state.loading = false;
  state.dismissed = [];
});

describe('useFirstRunSpaceOffer', () => {
  it.each(['dorkos', 'own'] as const)('is due after the %s path', (path) => {
    state.firstRunPath = path;
    expect(due()).toBe(true);
  });

  it('is dormant while no official space is configured', () => {
    state.officialLink = null;
    expect(due()).toBe(false);
  });

  it.each(['none', null] as const)('waits after a first run with no AI (%s)', (path) => {
    state.firstRunPath = path;
    expect(due()).toBe(false);
  });

  it('is never due again once joined', () => {
    state.connections = [{ ref: 'official', official: true }];
    expect(due()).toBe(false);
  });

  it('is never due again after Not now', () => {
    state.dismissed = [OFFICIAL_SPACE_OFFER_ID];
    expect(due()).toBe(false);
  });

  it('is pending, not due, while the connection list loads', () => {
    state.connections = undefined;
    state.loading = true;
    expect(offer()).toEqual({ due: false, pending: true });
  });

  it('is not pending after a first run with no AI, or once skipped', () => {
    state.connections = undefined;
    state.loading = true;
    state.firstRunPath = 'none';
    expect(offer().pending).toBe(false);
    state.firstRunPath = 'own';
    state.dismissed = [OFFICIAL_SPACE_OFFER_ID];
    expect(offer().pending).toBe(false);
  });
});

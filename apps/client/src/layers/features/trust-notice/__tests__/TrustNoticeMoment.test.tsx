/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { toast } from 'sonner';
import type { ServerConfig } from '@dorkos/shared/types';

import { useNavigate } from '@tanstack/react-router';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import { useUpdateConfig } from '@/layers/entities/config';
import { useConnectorConnections } from '@/layers/entities/connectors';
import { useSetPermission } from '@/layers/entities/permissions';
import { Dialog, DialogContent } from '@/layers/shared/ui';

import { TrustNoticeMoment } from '../ui/TrustNoticeMoment';
import { isTrustNoticeEligible } from '../model/trust-notice-eligibility';

vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useUpdateConfig: vi.fn() };
});
vi.mock('@/layers/entities/permissions', () => ({ useSetPermission: vi.fn() }));
vi.mock('@/layers/entities/connectors', () => ({ useConnectorConnections: vi.fn() }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const calls: string[] = [];
const configMutateAsync = vi.fn();
const presetMutateAsync = vi.fn();
const onClose = vi.fn();
const navigate = vi.fn();

function setMutations() {
  vi.mocked(useUpdateConfig).mockReturnValue({
    mutateAsync: configMutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useUpdateConfig>);
  vi.mocked(useSetPermission).mockReturnValue({
    mutateAsync: presetMutateAsync,
    isPending: false,
  } as unknown as ReturnType<typeof useSetPermission>);
}

/** The notice as the rail mounts it: inside the rail's dialog. */
function renderNotice(sharedConnectionIds?: string[]) {
  return render(
    <Dialog open>
      <DialogContent>
        <TrustNoticeMoment onClose={onClose} sharedConnectionIds={sharedConnectionIds} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * One connected app as the Connections list reads it. `shared` gives it an
 * every-agent level and its grants; `'level-only'` gives it the level with no
 * grants yet (the app could not be read).
 */
function app(
  connectionId: string,
  toolkit: string,
  label: string,
  shared: boolean | 'level-only' = true
): ConnectorConnectionSummary {
  return {
    connectionId,
    toolkit,
    label,
    everyAgentLevel: shared ? 'read-write' : null,
    everyAgent:
      shared === true
        ? { operationRevisionIds: ['revision-1'], classifications: ['read', 'write'] }
        : null,
  } as unknown as ConnectorConnectionSummary;
}

function setApps(connections: ConnectorConnectionSummary[]) {
  vi.mocked(useConnectorConnections).mockReturnValue({
    data: { connections },
  } as unknown as ReturnType<typeof useConnectorConnections>);
}

/** A config the rail would read, eligible unless a test says otherwise. */
function config(overrides: { preset?: string | null; seenAt?: string | null } = {}): ServerConfig {
  return {
    onboarding: { completedAt: '2026-08-01T10:00:00.000Z', dismissedAt: null },
    ui: { trustNoticeSeenAt: overrides.seenAt ?? null },
    permissions: { preset: overrides.preset === undefined ? 'trusted' : overrides.preset },
  } as unknown as ServerConfig;
}

describe('TrustNoticeMoment', () => {
  beforeEach(() => {
    calls.length = 0;
    configMutateAsync.mockReset().mockImplementation(async () => {
      calls.push('stamp');
    });
    presetMutateAsync.mockReset().mockImplementation(async () => {
      calls.push('careful');
    });
    onClose.mockReset();
    navigate.mockReset();
    vi.mocked(useNavigate).mockReturnValue(navigate);
    vi.mocked(toast.success).mockReset();
    setMutations();
    setApps([]);
  });

  afterEach(cleanup);

  it('says what changed, how to see it, and what still asks', () => {
    renderNotice();

    expect(screen.getByTestId('trust-notice')).toHaveTextContent('Agents now work without asking');
    expect(
      screen.getByText(
        'They edit files, run commands, schedule work and use your connected apps on their own.'
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText('Everything they do is recorded in Activity. Anyone can pause an agent.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Messages and code from strangers still need your yes.')
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'What changed' })).toHaveAttribute(
      'href',
      'https://dorkos.ai/docs/guides/permissions#what-changed'
    );
    expect(screen.queryByTestId('trust-notice-shared-apps')).not.toBeInTheDocument();
  });

  it('lists the apps the upgrade shared that are still shared with every agent', () => {
    setApps([
      app('conn-gmail', 'gmail', 'Work'),
      app('conn-calendar', 'googlecalendar', 'Work'),
      app('conn-narrowed', 'slack', 'Team', false),
      app('conn-other', 'github', 'Mine'),
    ]);
    renderNotice(['conn-gmail', 'conn-calendar', 'conn-narrowed', 'conn-gone']);

    const list = screen.getByTestId('trust-notice-shared-apps');
    expect(list).toHaveTextContent('Shared with every agent:');
    expect(screen.getByRole('button', { name: 'Choose agents for Gmail' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^Choose agents for Google ?Calendar$/i })
    ).toBeInTheDocument();
    // Narrowed already, removed, or never shared by the upgrade: not listed.
    expect(screen.getAllByRole('button', { name: /^Choose agents for/ })).toHaveLength(2);
  });

  it('names two accounts of one app by their labels', () => {
    setApps([app('conn-a', 'gmail', 'Work'), app('conn-b', 'gmail', 'Home')]);
    renderNotice(['conn-a', 'conn-b']);

    expect(
      screen.getByRole('button', { name: 'Choose agents for Gmail (Work)' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Choose agents for Gmail (Home)' })
    ).toBeInTheDocument();
  });

  it('lists an app shared with every agent whose grants are not in place yet', () => {
    // The level is there; the app could not be read, so no agent holds a grant
    // yet. The follower will add them, so the person must hear about it now.
    setApps([app('conn-gmail', 'gmail', 'Work', 'level-only')]);
    renderNotice(['conn-gmail']);

    expect(screen.getByRole('button', { name: 'Choose agents for Gmail' })).toBeInTheDocument();
  });

  it('keeps the notice for the other apps when Choose agents opens one of several', async () => {
    setApps([app('conn-gmail', 'gmail', 'Work'), app('conn-calendar', 'googlecalendar', 'Work')]);
    const user = userEvent.setup();
    renderNotice(['conn-gmail', 'conn-calendar']);

    await user.click(screen.getByRole('button', { name: 'Choose agents for Gmail' }));

    // Not answered: it comes back on a later launch to name Calendar.
    expect(configMutateAsync).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/connections',
        search: { app: 'conn-gmail', who: 'picked' },
      })
    );
  });

  it('says the apps stay shared when Keep asking me is chosen with apps listed', async () => {
    setApps([app('conn-gmail', 'gmail', 'Work')]);
    const user = userEvent.setup();
    renderNotice(['conn-gmail']);

    await user.click(screen.getByRole('button', { name: 'Keep asking me' }));

    expect(toast.success).toHaveBeenCalledWith(
      'Agents ask first again. Shared apps stay shared; change them in Connections.'
    );
  });

  it("Choose agents on the last listed app stamps the notice, then opens that app's panel", async () => {
    setApps([
      app('conn-gmail', 'gmail', 'Work'),
      app('conn-calendar', 'googlecalendar', 'Work', false),
    ]);
    const user = userEvent.setup();
    renderNotice(['conn-gmail', 'conn-calendar']);

    await user.click(screen.getByRole('button', { name: 'Choose agents for Gmail' }));

    expect(configMutateAsync).toHaveBeenCalledWith({
      ui: { trustNoticeSeenAt: expect.any(String) },
    });
    expect(presetMutateAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/connections',
        search: { app: 'conn-gmail', who: 'picked' },
      })
    );
  });

  it('Got it stamps the notice seen and changes nothing else', async () => {
    const user = userEvent.setup();
    renderNotice();

    await user.click(screen.getByRole('button', { name: 'Got it' }));

    expect(configMutateAsync).toHaveBeenCalledTimes(1);
    expect(configMutateAsync).toHaveBeenCalledWith({
      ui: { trustNoticeSeenAt: expect.any(String) },
    });
    expect(presetMutateAsync).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Keep asking me chooses Careful, then stamps the notice, then says how to undo it', async () => {
    const user = userEvent.setup();
    renderNotice();

    await user.click(screen.getByRole('button', { name: 'Keep asking me' }));

    expect(presetMutateAsync).toHaveBeenCalledWith({
      kind: 'preset',
      preset: 'careful',
      surface: 'first-run',
    });
    expect(calls).toEqual(['careful', 'stamp']);
    expect(toast.success).toHaveBeenCalledWith('Agents ask first again. Change it in Permissions.');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('stamps nothing and stays open when Careful cannot be saved', async () => {
    presetMutateAsync.mockRejectedValue(new Error('Only a person can change permissions.'));
    const user = userEvent.setup();
    renderNotice();

    await user.click(screen.getByRole('button', { name: 'Keep asking me' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only a person can change permissions.'
    );
    expect(configMutateAsync).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('isTrustNoticeEligible', () => {
  it('shows on a Trusted install that has not seen it', () => {
    expect(isTrustNoticeEligible(config())).toBe(true);
    // Never chosen resolves as Trusted.
    expect(isTrustNoticeEligible(config({ preset: null }))).toBe(true);
  });

  it('is hidden for a Careful install', () => {
    expect(isTrustNoticeEligible(config({ preset: 'careful' }))).toBe(false);
  });

  it('is hidden once stamped', () => {
    expect(isTrustNoticeEligible(config({ seenAt: '2026-10-13T09:00:00.000Z' }))).toBe(false);
  });

  it('is hidden until config loads and while onboarding runs', () => {
    expect(isTrustNoticeEligible(undefined)).toBe(false);
    const running = {
      ...config(),
      onboarding: { completedAt: null, dismissedAt: null },
    } as unknown as ServerConfig;
    expect(isTrustNoticeEligible(running)).toBe(false);
  });
});

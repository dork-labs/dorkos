/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { toast } from 'sonner';
import type { ServerConfig } from '@dorkos/shared/types';

import { useUpdateConfig } from '@/layers/entities/config';
import { useSetPermission } from '@/layers/entities/permissions';
import { Dialog, DialogContent } from '@/layers/shared/ui';

import { TrustNoticeMoment } from '../ui/TrustNoticeMoment';
import { isTrustNoticeEligible } from '../model/trust-notice-eligibility';

vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useUpdateConfig: vi.fn() };
});
vi.mock('@/layers/entities/permissions', () => ({ useSetPermission: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const calls: string[] = [];
const configMutateAsync = vi.fn();
const presetMutateAsync = vi.fn();
const onClose = vi.fn();

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
function renderNotice() {
  return render(
    <Dialog open>
      <DialogContent>
        <TrustNoticeMoment onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
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
    vi.mocked(toast.success).mockReset();
    setMutations();
  });

  afterEach(cleanup);

  it('says what changed, how to see it, and what still asks', () => {
    renderNotice();

    expect(screen.getByTestId('trust-notice')).toHaveTextContent('Agents now work without asking');
    expect(
      screen.getByText('They edit files, run commands and schedule work on their own.')
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

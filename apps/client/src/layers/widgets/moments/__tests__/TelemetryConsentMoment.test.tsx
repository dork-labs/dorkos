/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

import { useUpdateConfig } from '@/layers/entities/config';
import { TelemetryConsentMoment } from '@/layers/features/telemetry-consent';
import { Dialog, DialogContent } from '@/layers/shared/ui';

// The moment writes via `useUpdateConfig` and reads nothing — eligibility is the
// descriptor hook's job. Mocking the write means no TransportProvider or
// QueryClient is needed; the TelemetryPayload* components are preserved via
// importOriginal because the disclosure really renders them.
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useUpdateConfig: vi.fn() };
});

const updateMutate = vi.fn();

function setUpdateConfigState(isPending = false) {
  vi.mocked(useUpdateConfig).mockReturnValue({
    mutate: updateMutate,
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending,
    isSuccess: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateConfig>);
}

/** The moment as the host mounts it — inside the rail's dialog. */
function renderMoment() {
  return render(
    <Dialog open>
      <DialogContent>
        <TelemetryConsentMoment />
      </DialogContent>
    </Dialog>
  );
}

describe('TelemetryConsentMoment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMutate.mockReset();
    setUpdateConfigState();
  });

  afterEach(cleanup);

  it('renders the invitation and consent buttons, with the payload collapsed by default', () => {
    renderMoment();

    expect(screen.getByText(/sends us nothing unless you say so/i)).toBeInTheDocument();
    // Progressive disclosure: the payload stays hidden until asked for.
    expect(screen.queryByText(/runtimesConfigured/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /see what.s sent/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /no thanks/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /share anonymously/i })).toBeInTheDocument();
  });

  it('reveals the heartbeat payload verbatim after clicking "See what\'s sent"', async () => {
    const user = userEvent.setup();
    renderMoment();

    await user.click(screen.getByRole('button', { name: /see what.s sent/i }));

    expect(await screen.findByText(/runtimesConfigured/)).toBeInTheDocument();
  });

  it('accepting turns on every channel it covers and records the decision', async () => {
    const user = userEvent.setup();
    renderMoment();

    await user.click(screen.getByRole('button', { name: /share anonymously/i }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    // `usage` rides along: with the channels defaulting off, a "yes" that
    // omitted one would be silently narrower than the copy promises.
    expect(updateMutate).toHaveBeenCalledWith({
      telemetry: { install: true, heartbeat: true, usage: true, userHasDecided: true },
    });
  });

  it('declining writes every channel off and records the decision', async () => {
    const user = userEvent.setup();
    renderMoment();

    await user.click(screen.getByRole('button', { name: /no thanks/i }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate).toHaveBeenCalledWith({
      telemetry: { install: false, heartbeat: false, usage: false, userHasDecided: true },
    });
  });

  it('never stamps lastPromptedVersion — that field is the server’s', async () => {
    const user = userEvent.setup();
    renderMoment();

    await user.click(screen.getByRole('button', { name: /share anonymously/i }));

    // `hasTier1SendGate` opens on a non-null `lastPromptedVersion` too, so a
    // client-side stamp would open the send gate for someone who never answered.
    const [patch] = updateMutate.mock.calls[0] as [{ telemetry: Record<string, unknown> }];
    expect(patch.telemetry).not.toHaveProperty('lastPromptedVersion');
  });

  it('links to the public telemetry contract with safe attributes', () => {
    renderMoment();

    const link = screen.getByRole('link', { name: /full contract/i });
    expect(link).toHaveAttribute('href', 'https://dorkos.ai/telemetry');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('disables both buttons while the update is in flight', () => {
    setUpdateConfigState(true);

    renderMoment();

    expect(screen.getByRole('button', { name: /no thanks/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /share anonymously/i })).toBeDisabled();
  });
});

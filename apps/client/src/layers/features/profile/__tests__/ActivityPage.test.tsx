/**
 * @vitest-environment jsdom
 *
 * An agent's Activity page (spec `audit-trail` PR4): its account timeline from
 * the audit log, drawn with the Activity feed's own rows.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AuditEvent } from '@dorkos/shared/audit-schemas';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { MOCK_TEAM_ROSTER } from '@/dev/mock-samples';
import { buildProfileDeepLinkHarness } from '@/test-helpers/profile-deep-link';
import { ActivityPage } from '../ui/pages/ActivityPage';

const WARDEN = MOCK_TEAM_ROSTER.find((member) => member.id === 'agent-warden') as TeamMember;

/** One audit event, as `GET /api/audit/accounts/:id/timeline` answers it. */
function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    seq: 1,
    id: 'aud-1',
    at: new Date().toISOString(),
    spaceId: null,
    actor: { accountId: WARDEN.agent!.manifestId, kind: 'agent', name: 'Warden' },
    source: { surface: 'runtime-tool' },
    action: 'runtime.tool_used',
    operation: 'execute',
    target: null,
    outcome: 'ok',
    summary: 'Warden ran a shell command',
    visibility: 'space',
    prevHash: '0'.repeat(64),
    hash: '1'.repeat(64),
    ...overrides,
  } as AuditEvent;
}

async function renderPage(transport: ReturnType<typeof createMockTransport>) {
  const harness = buildProfileDeepLinkHarness('/');
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <harness.Wrapper>
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      </harness.Wrapper>
    );
  }
  render(
    <Wrapper>
      <ActivityPage member={WARDEN} roster={[WARDEN]} onPush={vi.fn()} />
    </Wrapper>
  );
  await harness.ready();
}

afterEach(() => cleanup());

describe('the profile Activity page', () => {
  it('draws the agent’s timeline, read by its agent id', async () => {
    const transport = createMockTransport({
      getAccountTimeline: vi.fn().mockResolvedValue({
        events: [
          auditEvent({
            seq: 2,
            id: 'aud-2',
            summary: 'Warden edited README.md',
            source: { surface: 'runtime-tool', sessionId: 'sess-1' },
          }),
          auditEvent(),
        ],
      }),
    });

    await renderPage(transport);

    expect(await screen.findByText('Warden edited README.md')).toBeInTheDocument();
    expect(screen.getByText('Warden ran a shell command')).toBeInTheDocument();
    expect(transport.getAccountTimeline).toHaveBeenCalledWith(
      WARDEN.agent!.manifestId,
      expect.objectContaining({ limit: 50 })
    );
    // The row from a chat opens it; the other has nowhere to go.
    expect(screen.getAllByRole('button', { name: /Open/ })).toHaveLength(1);
  });

  it('says so when nothing is on record', async () => {
    const transport = createMockTransport({
      getAccountTimeline: vi.fn().mockResolvedValue({ events: [] }),
    });

    await renderPage(transport);

    expect(await screen.findByText('Nothing on record yet')).toBeInTheDocument();
  });

  it('offers more when the server says there is an older page', async () => {
    const transport = createMockTransport({
      getAccountTimeline: vi.fn().mockResolvedValue({ events: [auditEvent()], nextBeforeSeq: 1 }),
    });

    await renderPage(transport);

    expect(await screen.findByRole('button', { name: 'Load 50 more' })).toBeInTheDocument();
  });
});

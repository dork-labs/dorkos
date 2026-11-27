// @vitest-environment jsdom
/** The honest quiet state (team-room-home spec D3.6). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { Task } from '@dorkos/shared/types';
import type { ExtensionDecisionDTO } from '@dorkos/shared/extension-decision-schemas';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';

// The attention rows navigate, and the session list reads `?session=`. Neither
// is what this file is about, so the router is stubbed rather than stood up.
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useRouter: () => ({ state: { location: { pathname: '/', search: {} } } }),
}));

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: vi.fn() };
});

// DorkBot's suggestion has its own suite, where the registry can be controlled.
let suggestionQualifies = true;
vi.mock('@/layers/features/feature-promos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/feature-promos')>();
  return {
    ...actual,
    QuietSuggestion: () => (suggestionQualifies ? <p data-testid="quiet-suggestion" /> : null),
  };
});

import { TransportProvider } from '@/layers/shared/model';
import { roomKeys } from '@/layers/entities/room';
import { HomeQuietState } from '../ui/HomeQuietState';

const ROOM_ID = 'team-room';
const VIEWER_ID = 'author-you';

/** One post in the room, so it has a history behind it. */
function post(seq: number): RoomEntry {
  return {
    roomId: ROOM_ID,
    seq,
    id: `entry-${seq}`,
    authorId: 'dorian',
    kind: 'post',
    body: { text: `line ${seq}` },
    mentions: [],
    sessionId: null,
    cascadeRoot: `entry-${seq}`,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-08-07T10:00:00.000Z',
  };
}

/** A scheduled task, overriding only what a test cares about. */
function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'morning-standup',
    displayName: 'Morning standup',
    description: null,
    prompt: 'Summarise yesterday',
    cron: '0 9 * * *',
    timezone: null,
    defaultCron: '0 9 * * *',
    defaultTimezone: null,
    timingOverridden: false,
    packageOwned: null,
    approvalChanges: [],
    agentId: null,
    enabled: true,
    sticky: false,
    maxRuntime: null,
    permissionMode: 'default',
    runtime: null,
    model: null,
    effort: null,
    account: null,
    status: 'active',
    approvedAt: null,
    approvedBy: null,
    approvedVia: null,
    filePath: '/tasks/morning-standup.md',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    reason: null,
    proposedBySessionId: null,
    proposedByAgentPath: null,
    proposedByName: null,
    origin: null,
    reasonSource: null,
    nextRuns: [],
    nextRun: null,
    ...overrides,
  };
}

/** A pending approval, so the header has something to say instead. */
function buildApproval(): PendingApproval {
  return {
    approvalId: '01JZ0000000000000000000001',
    capabilityId: 'marketplace.uninstall',
    capabilityTitle: 'Uninstall a marketplace package',
    tier: 'destructive',
    summary: 'Uninstall "sentry-monitor"',
    hasAgentPath: true,
    area: null,
    alwaysOffered: false,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
  };
}

/** #team with a roster, so the reader has a read cursor to be frozen from. */
function roomWithCursor(lastReadSeq: number) {
  return {
    id: ROOM_ID,
    kind: 'channel' as const,
    slug: 'team',
    title: '#team',
    topic: null,
    archived: false,
    ambientMaxEntries: 30,
    wellKnown: 'team',
    createdAt: '2026-08-01T09:00:00.000Z',
    lastActivityAt: '2026-08-07T10:00:00.000Z',
    viewerAuthorId: VIEWER_ID,
    reactionFrequents: [] as string[],
    members: [
      {
        roomId: ROOM_ID,
        authorId: VIEWER_ID,
        responseMode: 'always' as const,
        joinedAt: '2026-08-01T09:00:00.000Z',
        joinedSeq: 0,
        lastReadSeq,
        author: { id: VIEWER_ID, kind: 'human' as const, displayName: 'Dorian', handle: null },
        origin: 'local' as const,
      },
    ],
  };
}

/**
 * Render the quiet state over a room whose history is already in the cache — which is how it
 * reaches this component in the app, since the room surface below it does the fetching.
 */
function renderQuiet({
  entries = [post(1)],
  lastReadSeq,
  presenceOccupied = false,
  transport: overrides = {},
}: {
  entries?: RoomEntry[];
  lastReadSeq?: number;
  presenceOccupied?: boolean;
  transport?: Partial<Transport>;
} = {}) {
  const caughtUpTo = lastReadSeq ?? entries.at(-1)?.seq ?? 0;
  const transport = createMockTransport({
    getRoom: vi.fn().mockResolvedValue(roomWithCursor(caughtUpTo)),
    ...overrides,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  queryClient.setQueryData(roomKeys.entries(ROOM_ID), entries);

  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }

  const view = render(<HomeQuietState roomId={ROOM_ID} presenceOccupied={presenceOccupied} />, {
    wrapper: Wrapper,
  });

  /** Re-render with a different presence occupancy, keeping everything else. */
  const setPresence = (occupied: boolean) =>
    view.rerender(<HomeQuietState roomId={ROOM_ID} presenceOccupied={occupied} />);

  return { transport, queryClient, setPresence, ...view };
}

/** Open extension decisions the stubbed `/extension-decisions` route answers with. */
let mockExtensionDecisions: ExtensionDecisionDTO[] = [];
/** When true, the extension routes never answer — a first load still in flight. */
let extensionReadsHang = false;
/** When true, the decisions route answers 500 — a read that failed. */
let decisionsReadFails = false;

/**
 * The two extension reads in the Inbox's waiting queue are plain `fetch` calls,
 * not transport methods, so they are answered here by path.
 */
function fakeFetch(input: RequestInfo | URL): Promise<Response> {
  if (extensionReadsHang) return new Promise<Response>(() => {});
  const url = String(input);
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
  if (url.endsWith('/extensions/pending-approvals?limit=200'))
    return json({ approvals: [], nextCursor: null });
  if (url.endsWith('/extension-decisions') && decisionsReadFails) {
    return Promise.resolve(new Response('{"error":"boom"}', { status: 500 }));
  }
  if (url.endsWith('/extension-decisions')) {
    return json({ decisions: mockExtensionDecisions, offers: [] });
  }
  return Promise.resolve(new Response('{}', { status: 404 }));
}

/** The quiet line, or `null` when it drew nothing at all. */
function quietLine(): HTMLElement | null {
  return document.querySelector('[data-slot="home-quiet-state"]');
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.useRealTimers();
  suggestionQualifies = true;
  mockExtensionDecisions = [];
  extensionReadsHang = false;
  decisionsReadFails = false;
  vi.stubGlobal('fetch', vi.fn(fakeFetch));
});

describe('HomeQuietState — when it speaks', () => {
  it('says "All quiet." and nothing more when there is nothing ahead', async () => {
    const { transport } = renderQuiet();

    expect(await screen.findByText('All quiet.')).toBeInTheDocument();
    await waitFor(() => expect(transport.listTasks).toHaveBeenCalled());
    // The whole line, so a padded second sentence would show up here.
    expect(quietLine()!.textContent).toBe('All quiet.');
  });

  it('names a scheduled run with a real time when there is one', async () => {
    // Tomorrow morning, local — not "now plus 26 hours", which lands two days
    // out for anyone running this suite late in the evening.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const at = tomorrow.toISOString();
    const task = buildTask({ nextRun: at });
    renderQuiet({ transport: { listTasks: vi.fn().mockResolvedValue([task]) } });

    await screen.findByText('All quiet.');
    await waitFor(() => expect(quietLine()!.textContent).toContain(task.displayName));
    // Read off the fixture's own timestamp — not a sentence this test invented.
    expect(quietLine()!.textContent).toContain(
      new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    );
    expect(quietLine()!.textContent).toContain('tomorrow');
  });
});

describe('HomeQuietState — when it stands down', () => {
  it('draws nothing on a room with no history — day one is the chips, not a recap', async () => {
    const { transport } = renderQuiet({ entries: [] });

    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    expect(quietLine()).toBeNull();
  });

  it('draws nothing when an approval is waiting — the header already says so', async () => {
    const { transport } = renderQuiet({
      transport: {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      },
    });

    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    await waitFor(() => expect(quietLine()).toBeNull());
  });

  it('draws nothing while somebody is working — that is not quiet', async () => {
    const { transport } = renderQuiet({ presenceOccupied: true });

    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    expect(quietLine()).toBeNull();
  });
});

describe('HomeQuietState — "quiet" is a claim about right now', () => {
  it('says nothing over a room that has been talking since the reader arrived', async () => {
    // The reader had read up to entry 1.
    const { transport } = renderQuiet({
      entries: [post(1), post(2), post(3)],
      lastReadSeq: 1,
    });

    await waitFor(() => expect(transport.getRoom).toHaveBeenCalledWith(ROOM_ID));
    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    expect(quietLine()).toBeNull();
  });

  it('holds the cursor it arrived with, so reading the room cannot make it lie', async () => {
    // The reader arrives caught up, and the line is honest.
    const { queryClient } = renderQuiet({ entries: [post(1), post(2)], lastReadSeq: 2 });
    expect(await screen.findByText('All quiet.')).toBeInTheDocument();

    // Now somebody says something, and looking at the room marks it read — which is exactly what
    // `useMarkRoomRead` does to this cache, within a frame.
    act(() => {
      queryClient.setQueryData(roomKeys.entries(ROOM_ID), [post(1), post(2), post(3)]);
      queryClient.setQueryData(roomKeys.detail(ROOM_ID), roomWithCursor(3));
    });

    await waitFor(() => expect(quietLine()).toBeNull());
  });
});

describe('HomeQuietState — DorkBot may say one thing (spec D5.3)', () => {
  /** The suggestion stub, or `null` when the quiet state never mounted it. */
  const suggestion = () => screen.queryByTestId('quiet-suggestion');

  it('offers the suggestion when there is nothing ahead', async () => {
    renderQuiet();

    expect(await screen.findByText('All quiet.')).toBeInTheDocument();
    await waitFor(() => expect(suggestion()).toBeInTheDocument());
    // Inside the quiet state's own strip, so it fades and retires with it.
    expect(quietLine()!.contains(suggestion())).toBe(true);
  });

  it('says nothing at all when an approval is waiting — the whole line stands down', async () => {
    const { transport } = renderQuiet({
      transport: {
        listPendingApprovals: vi.fn().mockResolvedValue({ approvals: [buildApproval()] }),
      },
    });

    await waitFor(() => expect(transport.listPendingApprovals).toHaveBeenCalled());
    await waitFor(() => expect(quietLine()).toBeNull());
    // The gate is inherited, not restated: no line, so no suggestion either.
    expect(suggestion()).toBeNull();
  });
});

describe('HomeQuietState — it comes down once', () => {
  it('does not blink back in when the presence strip clears again', async () => {
    const { setPresence } = renderQuiet();

    // Shown: the room is quiet and nobody is working.
    expect(await screen.findByText('All quiet.')).toBeInTheDocument();

    // An agent picks something up. The header takes over, and this stands down.
    setPresence(true);
    await waitFor(() => expect(quietLine()).toBeNull());

    // The turn ends.
    setPresence(false);
    await waitFor(() => expect(quietLine()).toBeNull());
    expect(screen.queryByText('All quiet.')).toBeNull();
  });
});

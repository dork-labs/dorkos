// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/** What `useRuntimeCapabilities()` resolves to — the `/capabilities` payload. */
interface CapabilityMap {
  capabilities: Record<string, RuntimeCapabilities>;
  defaultRuntime: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Mocks (hoisted before the component import)
// ──────────────────────────────────────────────────────────────────────────────

// The capability map is the variable under test: `undefined` is the in-flight
// frame, a resolved object is steady state. Mutable so one suite can render both.
const capsState: { data: CapabilityMap | undefined } = { data: undefined };

// A started session row is what makes the runtime chip resolve WITHOUT the
// capability map — the chip falls back to `defaultRuntime` only when the session
// has no runtime of its own, so this is the state where a missing map used to be
// misread as "not the default runtime".
const sessionRow: { runtime: string } = { runtime: 'codex' };

// The Trust Dial reads the standing Full-autonomy acknowledgement from user
// config before it sends one. Stubbed to "nobody has acknowledged anything",
// which is the shipped state and the one every case below assumes.
vi.mock('@/layers/entities/config/model/use-autonomy-acknowledgement', () => ({
  useAutonomyAcknowledgement: () => ({
    acknowledgedAt: null,
    acknowledge: vi.fn(),
    clear: vi.fn(),
    isPending: false,
  }),
}));

// The status line now also asks where NEW sessions start, so it reads config and
// can write it (spec `trust-dial`, decision 6C). Stubbed to "nothing configured,
// writes go nowhere" — the offer is its own suite's subject
// (`ChatStatusSection-make-default.test.tsx`), and every case below is about
// something else.
vi.mock('@/layers/entities/config/model/use-config', () => ({
  useConfig: () => ({ data: undefined }),
}));
vi.mock('@/layers/entities/config/model/use-update-config', () => ({
  useUpdateConfig: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => false }));

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useCapabilitiesForRuntime: () => undefined,
  useRuntimeCapabilities: () => capsState,
}));

vi.mock('@/layers/entities/session/model/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/use-sessions')>()),
  useSessions: () =>
    ({
      sessions: [{ id: SESSION_ID, runtime: sessionRow.runtime, model: null }],
      isLoading: false,
    }) as never,
}));

vi.mock('@/layers/entities/session/model/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: 'default',
    cwd: '/test/dir',
    model: 'default',
    costUsd: null,
    contextPercent: null,
    updateSession: vi.fn(),
  }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: undefined })),
    useQueryClient: vi.fn(() => ({ invalidateQueries: vi.fn() })),
  };
});

vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: vi.fn(() => ({})),
}));

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state: Record<string, unknown> = {
      selectedCwd: '/test/dir',
      pendingRuntime: null,
      setPendingRuntime: vi.fn(),
      enableMessagePolling: false,
      setEnableMessagePolling: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

// The identity chip needs a router; it is not part of what this suite asserts.
vi.mock('../ui/status/AgentIdentityChip', () => ({ AgentIdentityChip: () => null }));

vi.mock('@/layers/features/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/status')>();
  return {
    ...actual,
    // The real promotion + budget pipeline runs; only its OUTPUT is stubbed, so the
    // assertion is about which items earned a slot rather than how they draw.
    StatusLine: ({ items }: { items: { key: string }[] }) => (
      <div data-testid="promoted-keys">{items.map((item) => item.key).join(' ')}</div>
    ),
    SessionPopover: () => null,
    useGitStatus: vi.fn(() => ({ data: undefined })),
    useStatusBarPins: () => ({ pins: [], toggle: vi.fn(), reset: vi.fn() }),
    RuntimeItem: () => null,
    ModelConfigPopover: () => null,
    PermissionModeItem: () => null,
    CwdItem: () => null,
    ConnectionItem: () => null,
    SubagentsItem: () => null,
  };
});

// ──────────────────────────────────────────────────────────────────────────────
// Import after mocks
// ──────────────────────────────────────────────────────────────────────────────

import { ChatStatusSection } from '../ui/status/ChatStatusSection';

const SESSION_ID = 'runtime-promotion-session';

const props = {
  sessionId: SESSION_ID,
  sessionStatus: null,
  isStreaming: false,
  syncConnectionState: 'connected' as const,
};

/** The keys that earned a slot in the line for the current render. */
function promotedKeys(): string[] {
  return (screen.getByTestId('promoted-keys').textContent ?? '').split(' ').filter(Boolean);
}

function caps(defaultRuntime: string): CapabilityMap {
  return { defaultRuntime, capabilities: {} };
}

afterEach(() => {
  cleanup();
  capsState.data = undefined;
  sessionRow.runtime = 'codex';
  vi.clearAllMocks();
});

describe('ChatStatusSection — the runtime item and the capability map', () => {
  it('gives the runtime no slot while the capability map is still in flight', () => {
    // Purpose: with no map there is no `defaultRuntime` to compare against, so
    // "is this the default?" has no answer yet. Answering `false` promoted the item
    // at RUNTIME_NON_DEFAULT (30) — above git, model, and the directory — for the
    // frames before the query landed, which on a 340-440px bar displaces a real
    // signal and flashes exactly the wallpaper this redesign removes. Every other
    // item follows "data hasn't arrived → no slot"; this one must too.
    render(<ChatStatusSection {...props} />);
    expect(promotedKeys()).not.toContain('runtime');
  });

  it('gives the runtime its slot once the map says it is not the default', () => {
    // The other half of the invariant: withholding the slot must be about the
    // missing map, not about the item having quietly stopped promoting at all.
    capsState.data = caps('claude-code');
    render(<ChatStatusSection {...props} />);
    expect(promotedKeys()).toContain('runtime');
  });

  it('keeps the runtime quiet once the map says it is the usual one', () => {
    capsState.data = caps('claude-code');
    sessionRow.runtime = 'claude-code';
    render(<ChatStatusSection {...props} />);
    expect(promotedKeys()).not.toContain('runtime');
  });
});

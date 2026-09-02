// @vitest-environment jsdom
/**
 * ChatStatusSection is the ONLY producer of
 * `StatusPromotionContext.permissionDescriptor`. Every other test in the tree
 * hands the registry a descriptor directly, so replacing this one line with
 * `null` would leave all of them green while the running app quietly went back
 * to ranking permissions by mode NAME — the id table this work exists to delete.
 *
 * So this suite drives the real component with a runtime whose run-everything
 * mode is called something no list in the client contains, and asserts the
 * status line ranks it as a bypass. Nulling the wire fails it; nothing else does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/**
 * A runtime whose "runs everything" mode is spelled `yolo`. The id is the point:
 * `isBypassPermissionMode`'s list has never heard of it, so a bypass ranking can
 * only have come from the declared semantics.
 */
const EXOTIC_CAPABILITIES: RuntimeCapabilities = {
  type: 'exotic',
  supportsToolApproval: true,
  supportsCostTracking: false,
  supportsResume: false,
  supportsMcp: false,
  supportsManagedMcpServers: false,
  supportsQuestionPrompt: false,
  supportsPlugins: false,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  mediaOutput: 'none',
  nativeContext: [],
  permissionModes: {
    supported: true,
    default: 'yolo',
    values: [
      {
        id: 'yolo',
        label: 'Yolo',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking.',
      },
    ],
  },
  commandIntents: { compact: { supported: false } },
  settings: { configSection: null, supportsEffort: false, sections: [] },
  features: {},
};

/** The mode the mocked session reports; mutable so one suite can render both. */
const sessionState = { permissionMode: 'yolo' as string };

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
  useCapabilitiesForRuntime: () => EXOTIC_CAPABILITIES,
  useRuntimeCapabilities: () => ({
    data: { defaultRuntime: 'exotic', capabilities: { exotic: EXOTIC_CAPABILITIES } },
  }),
}));

vi.mock('@/layers/entities/session/model/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/use-sessions')>()),
  useSessions: () =>
    ({
      sessions: [{ id: SESSION_ID, runtime: 'exotic', model: null }],
      isLoading: false,
    }) as never,
}));

vi.mock('@/layers/entities/session/model/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: sessionState.permissionMode,
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
      pendingAccount: null,
      setPendingAccount: vi.fn(),
      enableMessagePolling: false,
      setEnableMessagePolling: vi.fn(),
    };
    return selector ? selector(state) : state;
  },
}));

vi.mock('../ui/status/AgentIdentityChip', () => ({ AgentIdentityChip: () => null }));

vi.mock('@/layers/features/status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/status')>();
  return {
    ...actual,
    // The real promotion pipeline runs; only the drawing is stubbed. Severity is
    // exposed because it is what the descriptor changes — the item promotes
    // either way, so a keys-only assertion would not see the difference.
    StatusLine: ({ items }: { items: { key: string; severity: number }[] }) => (
      <div data-testid="promoted-severities">
        {items.map((item) => `${item.key}:${item.severity}`).join(' ')}
      </div>
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

import { ChatStatusSection } from '../ui/status/ChatStatusSection';

const SESSION_ID = 'permission-descriptor-session';

/** Ranks from `SEVERITY` in the status registry, restated so a drift is visible. */
const PERMISSION_BYPASS = 70;
const PERMISSION_ELEVATED = 40;

const props = {
  sessionId: SESSION_ID,
  sessionStatus: null,
  isStreaming: false,
  syncConnectionState: 'connected' as const,
};

/** The rank the permission item earned in the current render. */
function permissionSeverity(): number {
  const text = screen.getByTestId('promoted-severities').textContent ?? '';
  const entry = text.split(' ').find((pair) => pair.startsWith('permission:'));
  expect(entry, 'the permission item did not reach the line').toBeDefined();
  return Number(entry!.split(':')[1]);
}

afterEach(() => {
  cleanup();
  sessionState.permissionMode = 'yolo';
  vi.clearAllMocks();
});

describe('ChatStatusSection — the permission item is ranked by what the mode does', () => {
  it('ranks a run-everything mode as a bypass under a name no id list contains', () => {
    // The mutation this catches: passing `null` for `permissionDescriptor` sends
    // the registry back to the name fallback, where `yolo` is merely "not
    // default" and ranks 30 points lower than the session actually deserves.
    render(<ChatStatusSection {...props} />);
    expect(permissionSeverity()).toBe(PERMISSION_BYPASS);
  });

  it('leaves an ordinary mode at the elevated rank', () => {
    // The other half: the bypass rank has to be about this mode's semantics, not
    // about the item having quietly started shouting about everything.
    sessionState.permissionMode = 'acceptEdits';
    render(<ChatStatusSection {...props} />);
    expect(permissionSeverity()).toBe(PERMISSION_ELEVATED);
  });
});

/**
 * The one set of stubs every `ChatStatusSection-*` suite renders the real status
 * section against. Import it FIRST in a suite, before `ChatStatusSection`, so the
 * mocks below are registered before the component loads.
 *
 * Every stub reads {@link harness} when it is called, never when it is created,
 * so a suite steers a case by writing to `harness` in `beforeEach` or in the
 * test itself. {@link resetHarness} puts every field back.
 *
 * What stays real: the session stores, the promotion and budget pipeline, and
 * every `features/status` item a suite does not replace in `harness.status`.
 *
 * @module features/chat/__tests__/chat-status-harness
 */
import React from 'react';
import { vi, type Mock } from 'vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

type StatusModule = typeof import('@/layers/features/status');
type UiModule = typeof import('@/layers/shared/ui');
// Stubs accept whatever props the real item is handed; each suite types its own.
type AnyComponent = React.ComponentType<any>;

/** The `features/status` items a suite may replace. Anything left out renders for real. */
export type StatusStubName =
  | 'StatusLine'
  | 'SessionPopover'
  | 'CwdItem'
  | 'GitStatusItem'
  | 'PermissionModeItem'
  | 'ModelConfigPopover'
  | 'ContextItem'
  | 'UsageStatusItem'
  | 'ConnectionItem'
  | 'SubagentsItem'
  | 'UsageRevealPopover'
  | 'WifiTurnCapPill'
  | 'RuntimeItem';

const STATUS_STUB_NAMES: readonly StatusStubName[] = [
  'StatusLine',
  'SessionPopover',
  'CwdItem',
  'GitStatusItem',
  'PermissionModeItem',
  'ModelConfigPopover',
  'ContextItem',
  'UsageStatusItem',
  'ConnectionItem',
  'SubagentsItem',
  'UsageRevealPopover',
  'WifiTurnCapPill',
  'RuntimeItem',
];

/**
 * How the context-menu and tooltip primitives draw. `real` is Radix; `flat`
 * renders triggers inline and drops menu and tooltip content; `flat-tooltips`
 * also draws tooltip content inline, for a suite that reads what a tooltip says.
 */
export type OverlayMode = 'real' | 'flat' | 'flat-tooltips';

/** Everything a suite can steer. */
export interface ChatStatusHarness {
  /** What `useConfig()` answers. */
  config: { data: unknown };
  /** `useUpdateConfig().mutate`. */
  updateConfig: Mock;
  /** What `useCapabilitiesForRuntime()` answers. */
  capabilitiesForRuntime: RuntimeCapabilities | undefined;
  /** What `useRuntimeCapabilities()` answers (the `/capabilities` query). */
  runtimeCapabilities: { data: unknown };
  /** The rows `useSessions()` lists. */
  sessions: { id: string; runtime: string; model: string | null }[];
  /** Fields of `useSessionStatus()` that differ from a settled default session. */
  sessionStatus: Record<string, unknown>;
  /** `useSessionStatus().updateSession`; async, like the hook it stands in for. */
  updateSession: Mock;
  /** What `useModels()` answers. */
  models: { data: unknown };
  /** The app store's state. */
  appState: Record<string, unknown>;
  /** What `useTransport()` answers. */
  transport: Record<string, unknown>;
  /** The status pins, as `useStatusBarPins()` reports them. */
  pins: string[];
  /** `features/status` items replaced for this case. */
  status: Partial<Record<StatusStubName, AnyComponent>>;
  /** How overlays draw; see {@link OverlayMode}. */
  overlays: OverlayMode;
}

/** A line that draws every promoted item's node, in order. */
function DefaultStatusLine({ items }: { items: { key: string; node: React.ReactNode }[] }) {
  return (
    <div data-testid="status-line">
      {items.map((item) => (
        <div key={item.key}>{item.node}</div>
      ))}
    </div>
  );
}

function PassThrough({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

function Nothing() {
  return null;
}

function defaults(): ChatStatusHarness {
  return {
    config: { data: undefined },
    updateConfig: vi.fn(),
    capabilitiesForRuntime: undefined,
    runtimeCapabilities: { data: undefined },
    sessions: [],
    sessionStatus: {},
    updateSession: vi.fn((..._args: unknown[]) => Promise.resolve(undefined)),
    models: { data: undefined },
    appState: {
      selectedCwd: '/test/dir',
      pendingRuntime: null,
      setPendingRuntime: vi.fn(),
      pendingAccount: null,
      setPendingAccount: vi.fn(),
      enableMessagePolling: false,
      setEnableMessagePolling: vi.fn(),
    },
    transport: { runCommandIntent: vi.fn() },
    pins: [],
    status: {
      StatusLine: DefaultStatusLine,
      SessionPopover: PassThrough,
      ConnectionItem: Nothing,
    },
    overlays: 'real',
  };
}

/** The live stub state. Write to it; every stub reads it on each call. */
export const harness: ChatStatusHarness = defaults();

/** Put every field of {@link harness} back to its default. */
export function resetHarness(): void {
  Object.assign(harness, defaults());
}

/** Replace the named `features/status` items with components that draw nothing. */
export function hideStatusItems(...names: StatusStubName[]): void {
  for (const name of names) harness.status[name] = Nothing;
}

// Radix reads `window.matchMedia`, which jsdom does not provide.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

vi.mock('@/layers/entities/config/model/use-config', () => ({
  useConfig: () => harness.config,
}));
vi.mock('@/layers/entities/config/model/use-update-config', () => ({
  useUpdateConfig: () => ({ mutate: harness.updateConfig, isPending: false }),
}));

vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => false }));

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useCapabilitiesForRuntime: () => harness.capabilitiesForRuntime,
  useRuntimeCapabilities: () => harness.runtimeCapabilities,
}));

// The real `useSessions` needs router search params, which no suite provides.
vi.mock('@/layers/entities/session/model/query/use-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/session/model/query/use-sessions')>()),
  useSessions: () => ({ sessions: harness.sessions, isLoading: false }) as never,
}));

vi.mock('@/layers/entities/session/model/settings/use-session-status', () => ({
  useSessionStatus: () => ({
    permissionMode: 'default',
    // A SETTLED session: something has answered what it runs at, so the
    // permissions control draws the mode rather than its loading placeholder
    // (DOR-2103). `vi.mock` factories are not checked against the module's own
    // types, so leaving this out would silently render the placeholder.
    permissionModeKnown: true,
    cwd: '/test/dir',
    model: 'default',
    costUsd: null,
    contextPercent: null,
    ...harness.sessionStatus,
    updateSession: harness.updateSession,
  }),
}));

vi.mock('@/layers/entities/session/model/query/use-models', () => ({
  useModels: () => harness.models,
}));
vi.mock('@/layers/entities/session/model/query/use-subagents', () => ({
  useSubagents: () => ({ data: undefined }),
}));
vi.mock('@/layers/entities/workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/workspace')>()),
  useWorkspaceForSession: () => null,
}));

vi.mock('@/layers/shared/model/TransportContext', () => ({
  useTransport: () => harness.transport,
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: undefined })),
    useQueryClient: vi.fn(() => ({
      invalidateQueries: vi.fn(),
      getQueryData: vi.fn(),
      getQueriesData: vi.fn(() => []),
    })),
  };
});

vi.mock('@/layers/shared/model/app-store', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) =>
    selector ? selector(harness.appState) : harness.appState,
}));

vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<UiModule>();
  /** Radix when overlays are real, otherwise `flat`. */
  const overlay = (name: keyof UiModule, flat: AnyComponent, flatTooltips = flat) =>
    function Overlay(props: Record<string, unknown>) {
      const Real = actual[name] as AnyComponent;
      const Drawn =
        harness.overlays === 'real' ? Real : harness.overlays === 'flat' ? flat : flatTooltips;
      return <Drawn {...props} />;
    };
  return {
    ...actual,
    ContextMenu: overlay('ContextMenu', PassThrough),
    ContextMenuTrigger: overlay('ContextMenuTrigger', PassThrough),
    ContextMenuContent: overlay('ContextMenuContent', Nothing),
    ContextMenuItem: overlay('ContextMenuItem', PassThrough),
    ContextMenuSeparator: overlay('ContextMenuSeparator', Nothing),
    TooltipProvider: overlay('TooltipProvider', PassThrough),
    Tooltip: overlay('Tooltip', PassThrough),
    TooltipTrigger: overlay('TooltipTrigger', PassThrough),
    TooltipContent: overlay('TooltipContent', Nothing, PassThrough),
  };
});

// The identity chip needs a router; no suite asserts on it.
vi.mock('../ui/status/AgentIdentityChip', () => ({ AgentIdentityChip: () => null }));

vi.mock('@/layers/features/status', async (importOriginal) => {
  const actual = await importOriginal<StatusModule>();
  const stubs: Partial<Record<StatusStubName, AnyComponent>> = {};
  for (const name of STATUS_STUB_NAMES) {
    stubs[name] = function Item(props: Record<string, unknown>) {
      const Drawn = harness.status[name] ?? (actual[name] as AnyComponent);
      return <Drawn {...props} />;
    };
  }
  return {
    ...actual,
    ...stubs,
    useGitStatus: () => ({ data: undefined }),
    // Pins live in server config (`ui.statusBar.pins`); the bridge is stubbed so
    // no suite needs a query client or transport for them.
    useStatusBarPins: () => ({ pins: harness.pins, toggle: vi.fn(), reset: vi.fn() }),
  };
});

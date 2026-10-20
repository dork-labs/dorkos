/**
 * Mocks for the `Transport` slices split out of `mock-factories.ts`: what
 * happened (`ActivityTransport`), where every read answers an empty page, and
 * pausing agents (`AgentPauseTransport`), where nothing is paused and every
 * pause or resume succeeds, held connected-app actions, where every cancel
 * succeeds, sign-in landing pages, where no landing is held, a canvas
 * document's route controls, where no document declares a route, a space's
 * docs, where there are none, signed-in devices, where there are none, and an
 * account's automatic moves, where every change succeeds, and a framed page's
 * script decision, which is never known.
 * Heartbeats and a hub's computers come from their own mocks.
 *
 * @module test-utils/mock-transport-slices
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';
import { createMockComputerTransport } from './mock-computer-transport.js';
import { createMockLocalBrowserTransport } from './mock-local-browser-transport.js';
import { createMockHeartbeatTransport } from './mock-heartbeat-transport.js';
import { createMockHubTransport, createMockSessionRelayTransport } from './mock-hub-transport.js';

/** The methods {@link transportSliceMocks} covers. */
type SliceMethods =
  | 'listActivityEvents'
  | 'listAuditEvents'
  | 'getAccountTimeline'
  | 'getChatActivity'
  | 'listAgentPauses'
  | 'pauseAgent'
  | 'resumeAgent'
  | 'cancelHeldConnectorAction'
  | 'getSignInLanding'
  | 'retrySignIn'
  | 'getCanvasDocRoutes'
  | 'reviewCanvasDocRoute'
  | 'approveCanvasDocRoute'
  | 'revokeCanvasDocRoute'
  | 'getDocIndex'
  | 'resolveDocLink'
  | 'listSignedInDevices'
  | 'signOutDevice'
  | 'signOutEverywhereElse'
  | 'setAccountNoAutoMove'
  | 'getFrameBridgeStatus';

/** Mocks for every method of the split-out `Transport` slices. */
export function transportSliceMocks(): Pick<Transport, SliceMethods> &
  ReturnType<typeof createMockHeartbeatTransport> &
  ReturnType<typeof createMockLocalBrowserTransport> &
  ReturnType<typeof createMockComputerTransport> &
  ReturnType<typeof createMockHubTransport> &
  ReturnType<typeof createMockSessionRelayTransport> {
  return {
    ...createMockHeartbeatTransport(),
    ...createMockComputerTransport(),
    ...createMockLocalBrowserTransport(),
    ...createMockHubTransport(),
    ...createMockSessionRelayTransport(),
    listActivityEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    // Nobody is signed in anywhere, and every sign-out succeeds.
    listSignedInDevices: vi.fn().mockResolvedValue({ sessions: [], canSignOutOthers: false }),
    signOutDevice: vi.fn().mockResolvedValue(undefined),
    signOutEverywhereElse: vi.fn().mockResolvedValue({ signedOut: 0 }),
    listAuditEvents: vi.fn().mockResolvedValue({ events: [] }),
    getAccountTimeline: vi.fn().mockResolvedValue({ events: [] }),
    getChatActivity: vi.fn().mockResolvedValue({ sent: [], stops: [] }),
    listAgentPauses: vi.fn().mockResolvedValue({ pauses: [] }),
    pauseAgent: vi
      .fn()
      .mockImplementation(async (agentId: string) => ({ agentId, paused: true, changed: true })),
    resumeAgent: vi
      .fn()
      .mockImplementation(async (agentId: string) => ({ agentId, paused: false, changed: true })),
    cancelHeldConnectorAction: vi
      .fn()
      .mockImplementation(async (holdId: string) => ({ status: 'cancelled', holdId })),
    getSignInLanding: vi.fn().mockRejectedValue(new Error('No such sign-in')),
    retrySignIn: vi.fn().mockResolvedValue({ kind: 'connected' }),
    // No document declares a route, so the header draws no route control.
    getCanvasDocRoutes: vi
      .fn()
      .mockImplementation(async (documentId: string) => ({ documentId, routes: [] })),
    reviewCanvasDocRoute: vi.fn().mockRejectedValue(new Error('No such route')),
    approveCanvasDocRoute: vi.fn().mockRejectedValue(new Error('No such route')),
    revokeCanvasDocRoute: vi.fn().mockRejectedValue(new Error('No such route')),
    getDocIndex: vi.fn().mockResolvedValue({ root: '/', docs: [], truncated: false }),
    resolveDocLink: vi.fn().mockResolvedValue({ doc: null, complete: true }),
    setAccountNoAutoMove: vi
      .fn()
      .mockImplementation(async (_accountId: string, noAutoMove: boolean) => ({ noAutoMove })),
    // DorkOS has served no page into a frame, so the canvas says nothing.
    getFrameBridgeStatus: vi.fn().mockResolvedValue({ bridge: 'unknown' }),
  };
}

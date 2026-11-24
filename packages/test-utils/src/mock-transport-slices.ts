/**
 * Mocks for the `Transport` slices split out of `mock-factories.ts`: what
 * happened (`ActivityTransport`), where every read answers an empty page, and
 * pausing agents (`AgentPauseTransport`), where nothing is paused and every
 * pause or resume succeeds, held connected-app actions, where every cancel
 * succeeds, mini apps' access to connected apps, where none waits and every
 * revoke
 * succeeds, sign-in landing pages, where no landing is held, a canvas
 * document's route controls, where no document declares a route or has work
 * to review, a space's docs, where there are none, signed-in devices, where
 * there are none, an account's automatic moves, where every change succeeds,
 * a framed page's script decision, which is never known, an agent's
 * level, where every agent runs at Full autonomy, confirming a paused
 * connection's settings, which succeeds, and undoing an agent's task mode,
 * where there is nothing to undo, and sending another chat's queued message
 * now, which joins the running turn, and `dork:` links, which open nothing.
 * Heartbeats, a hub's computers, the spend limit and a connected app's
 * writes-back switch come from their own mocks.
 *
 * @module test-utils/mock-transport-slices
 */
import type { InstructionsView } from '@dorkos/shared/agent-instructions-schemas';
import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Transport } from '@dorkos/shared/transport';
import { createMockComputerTransport } from './mock-computer-transport.js';
import { createMockLocalBrowserTransport } from './mock-local-browser-transport.js';
import { createMockHeartbeatTransport } from './mock-heartbeat-transport.js';
import { createMockHubTransport, createMockSessionRelayTransport } from './mock-hub-transport.js';
import { createMockConnectorSpendingTransport } from './mock-connector-spending-transport.js';
import { createMockConnectorWritesBackTransport } from './mock-connector-writes-back-transport.js';

/** The methods {@link transportSliceMocks} covers. */
type SliceMethods =
  | 'listActivityEvents'
  | 'listAuditEvents'
  | 'getAccountTimeline'
  | 'getChatActivity'
  | 'createSessionLocation'
  | 'allocateSession'
  | 'getSessionLocation'
  | 'listAgentPauses'
  | 'pauseAgent'
  | 'resumeAgent'
  | 'cancelHeldConnectorAction'
  | 'getAccessChange'
  | 'undoAccessChange'
  | 'getMiniAppAccess'
  | 'revokeMiniAppAccess'
  | 'restartExtension'
  | 'listBackups'
  | 'removeBackup'
  | 'moveBackup'
  | 'resolveDorkLink'
  | 'getSignInLanding'
  | 'retrySignIn'
  | 'getCanvasDocRoutes'
  | 'reviewCanvasDocRoute'
  | 'approveCanvasDocRoute'
  | 'revokeCanvasDocRoute'
  | 'getCanvasDocWork'
  | 'replayCanvasDocWork'
  | 'confirmRelayAdapterReferences'
  | 'clearCanvasDocWork'
  | 'getDocIndex'
  | 'resolveDocLink'
  | 'listSignedInDevices'
  | 'signOutDevice'
  | 'signOutEverywhereElse'
  | 'setDeviceRunsAgents'
  | 'listWifiSignInRequests'
  | 'approveWifiSignIn'
  | 'declineWifiSignIn'
  | 'listOwnerFactors'
  | 'startAddingPasskey'
  | 'finishAddingPasskey'
  | 'startAddingAuthenticator'
  | 'confirmAuthenticator'
  | 'removeOwnerFactor'
  | 'setAccountNoAutoMove'
  | 'getFrameBridgeStatus'
  | 'getAgentLevel'
  | 'getAgentInstructionsTemplate'
  | 'getAgentInstructionsPreview'
  | 'undoAgentTaskMode'
  | 'approveTaskFile'
  | 'sendFeedback'
  | 'listMyFeedback'
  | 'previewRoomTranscript'
  | 'steerQueuedChatMessage';

/** An instructions view with no blocks, for tests that never open the viewer. */
const EMPTY_INSTRUCTIONS_VIEW: InstructionsView = {
  mode: 'template',
  runtime: 'claude-code',
  place: 'direct',
  level: 'act',
  agentId: null,
  runtimeNotes: [],
  levelNote: '',
  blocks: [],
  notIncluded: [],
  variables: [],
  tokens: 0,
};

/** Mocks for every method of the split-out `Transport` slices. */
export function transportSliceMocks(): Pick<Transport, SliceMethods> &
  ReturnType<typeof createMockHeartbeatTransport> &
  ReturnType<typeof createMockLocalBrowserTransport> &
  ReturnType<typeof createMockComputerTransport> &
  ReturnType<typeof createMockHubTransport> &
  ReturnType<typeof createMockSessionRelayTransport> &
  ReturnType<typeof createMockConnectorSpendingTransport> &
  ReturnType<typeof createMockConnectorWritesBackTransport> {
  return {
    ...createMockConnectorSpendingTransport(),
    createSessionLocation: vi.fn().mockResolvedValue({ id: 'test-location' }),
    allocateSession: vi.fn(async (source: Parameters<Transport['allocateSession']>[0]) => ({
      sessionId: randomUUID(),
      ...(source.kind === 'location' && { launchRef: source.launchRef }),
    })),
    getSessionLocation: vi.fn().mockResolvedValue({ cwd: '/test/project' }),
    ...createMockConnectorWritesBackTransport(),
    ...createMockHeartbeatTransport(),
    ...createMockComputerTransport(),
    ...createMockLocalBrowserTransport(),
    ...createMockHubTransport(),
    ...createMockSessionRelayTransport(),
    listActivityEvents: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    // Feedback goes through; nothing sent before; an empty room to preview.
    sendFeedback: vi.fn().mockResolvedValue({ ok: true }),
    listMyFeedback: vi.fn().mockResolvedValue([]),
    previewRoomTranscript: vi.fn().mockResolvedValue({ text: '', throughSeq: null }),
    // Nobody is signed in anywhere, and every sign-out succeeds.
    listSignedInDevices: vi.fn().mockResolvedValue({ sessions: [], canSignOutOthers: false }),
    signOutDevice: vi.fn().mockResolvedValue(undefined),
    signOutEverywhereElse: vi.fn().mockResolvedValue({ signedOut: 0 }),
    // No device is waiting, and every change succeeds.
    setDeviceRunsAgents: vi.fn().mockResolvedValue({ kind: 'done' }),
    listWifiSignInRequests: vi.fn().mockResolvedValue({ requests: [] }),
    approveWifiSignIn: vi.fn().mockResolvedValue({ kind: 'needs-passkey' }),
    declineWifiSignIn: vi.fn().mockResolvedValue(undefined),
    // No sign-in checks yet; adding one succeeds.
    listOwnerFactors: vi.fn().mockResolvedValue({ factors: [], everHadAway: false }),
    startAddingPasskey: vi.fn().mockResolvedValue({ kind: 'options', options: {} }),
    finishAddingPasskey: vi.fn().mockResolvedValue({ id: 'f1', host: 'localhost' }),
    startAddingAuthenticator: vi.fn().mockResolvedValue({
      kind: 'started',
      pending: { id: 'f2', secret: 'ABCDEFGH', uri: 'otpauth://totp/DorkOS' },
    }),
    confirmAuthenticator: vi.fn().mockResolvedValue({ id: 'f2' }),
    removeOwnerFactor: vi.fn().mockResolvedValue({ kind: 'done' }),
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
    getMiniAppAccess: vi.fn().mockResolvedValue({ waiting: [], allowed: [] }),
    restartExtension: vi.fn().mockResolvedValue(undefined),
    listBackups: vi
      .fn()
      .mockResolvedValue({ folder: '/home/demo/.dork/backups', copies: [], totalBytes: 0 }),
    removeBackup: vi.fn().mockResolvedValue(undefined),
    moveBackup: vi.fn().mockImplementation(async (name: string, destination: string) => ({
      destinationPath: `${destination}/${name}`,
    })),
    revokeMiniAppAccess: vi
      .fn()
      .mockImplementation(async (approvalId: string) => ({ status: 'revoked', approvalId })),
    cancelHeldConnectorAction: vi
      .fn()
      .mockImplementation(async (holdId: string) => ({ status: 'cancelled', holdId })),
    getAccessChange: vi.fn().mockRejectedValue(new Error('Nothing to show there.')),
    undoAccessChange: vi
      .fn()
      .mockImplementation(async (changeId: string) => ({ changeId, undoId: 'undo-1' })),
    // No link opens anything: the 404 every unknown or private link answers.
    resolveDorkLink: vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('That link opens nothing you can see here.'), { status: 404 })
      ),
    getSignInLanding: vi.fn().mockRejectedValue(new Error('No such sign-in')),
    retrySignIn: vi.fn().mockResolvedValue({ kind: 'connected' }),
    // No document declares a route, so the header draws no route control.
    getCanvasDocRoutes: vi
      .fn()
      .mockImplementation(async (documentId: string) => ({ documentId, routes: [] })),
    reviewCanvasDocRoute: vi.fn().mockRejectedValue(new Error('No such route')),
    approveCanvasDocRoute: vi.fn().mockRejectedValue(new Error('No such route')),
    revokeCanvasDocRoute: vi.fn().mockRejectedValue(new Error('No such route')),
    getCanvasDocWork: vi
      .fn()
      .mockImplementation(async (documentId: string) => ({ documentId, items: [] })),
    replayCanvasDocWork: vi.fn().mockRejectedValue(new Error('No such work')),
    clearCanvasDocWork: vi.fn().mockRejectedValue(new Error('No such work')),
    getDocIndex: vi.fn().mockResolvedValue({ root: '/', docs: [], truncated: false }),
    resolveDocLink: vi.fn().mockResolvedValue({ doc: null, complete: true }),
    setAccountNoAutoMove: vi
      .fn()
      .mockImplementation(async (_accountId: string, noAutoMove: boolean) => ({ noAutoMove })),
    // DorkOS has served no page into a frame, so the canvas says nothing.
    getFrameBridgeStatus: vi.fn().mockResolvedValue({ bridge: 'unknown' }),
    confirmRelayAdapterReferences: vi.fn().mockResolvedValue({ ok: true }),
    getAgentInstructionsTemplate: vi.fn().mockResolvedValue(EMPTY_INSTRUCTIONS_VIEW),
    getAgentInstructionsPreview: vi.fn().mockResolvedValue(EMPTY_INSTRUCTIONS_VIEW),
    getAgentLevel: vi.fn().mockResolvedValue({
      effective: 'autonomy',
      effectiveMode: 'bypassPermissions',
      declared: 'autonomy',
      cappedByPerson: false,
    }),
    // No agent changed a task's mode, so there is nothing to undo.
    undoAgentTaskMode: vi.fn().mockRejectedValue(new Error('Nothing to undo')),
    // No task's file is capped, so there is nothing to approve.
    approveTaskFile: vi.fn().mockRejectedValue(new Error('Nothing to change')),
    // Another chat's queued message joins the running turn.
    steerQueuedChatMessage: vi.fn().mockResolvedValue({ outcome: 'steered' }),
  };
}

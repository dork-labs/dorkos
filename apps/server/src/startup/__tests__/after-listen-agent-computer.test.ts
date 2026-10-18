/**
 * What `startAfterListen` leaves off on an agent computer (DOR-2940): the
 * tasks scheduler, the tunnel autostart and the DorkOS account link. A
 * person's own computer starts each, so a stub that never starts anything
 * cannot pass. The credits lifecycle starts on both: credits are the only way
 * an agent computer pays for models, minted with its own key (part 9).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Role = 'computer' | 'hub' | 'agent-computer';
const role = vi.hoisted(() => ({ value: 'agent-computer' as Role }));
vi.mock('../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));
vi.mock('../../env.js', () => ({ env: {} }));
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logError: (err: unknown) => ({ err }),
}));

const started = vi.hoisted(() => ({
  autostartOwnTunnel: vi.fn(async () => undefined),
  initOnStartup: vi.fn(async () => undefined),
  startCreditsLifecycle: vi.fn(),
  ensureCreditsClaudeRoot: vi.fn(),
  docDelivery: vi.fn(),
}));
const cloudLink = {
  initOnStartup: started.initOnStartup,
  setOnUnlink: vi.fn(),
  setOnNewLink: vi.fn(),
  getSummary: () => ({ linked: false }),
};
vi.mock('../../services/core/auth/cloud-link.js', () => ({ getCloudLinkManager: () => cloudLink }));
vi.mock('../../services/core/remote/remote-boot.js', () => ({
  autostartOwnTunnel: started.autostartOwnTunnel,
  currentRemoteBootPlan: () => ({}),
}));
vi.mock('../../services/core/cloud/credits-inference.js', () => ({
  startCreditsLifecycle: started.startCreditsLifecycle,
  revokeHeldCreditsToken: vi.fn(),
}));
vi.mock('../../services/runtimes/claude-code/credits-root.js', () => ({
  ensureCreditsClaudeRoot: started.ensureCreditsClaudeRoot,
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: () => undefined, onChange: () => () => {} },
}));
vi.mock('../../services/core/tunnel-manager.js', () => ({ tunnelManager: { on: vi.fn() } }));
vi.mock('../../services/core/event-fan-out.js', () => ({ eventFanOut: { broadcast: vi.fn() } }));
vi.mock('../../services/core/remote/managed-remote-coordinator.js', () => ({
  managedRemoteCoordinator: { withdrawOnUnlink: vi.fn() },
}));
vi.mock('../../services/core/cloud/credits-runtimes.js', () => ({
  stopCodexCreditsTurns: vi.fn(),
  fillCreditsGapsOnNewLink: vi.fn(),
}));
vi.mock('../../services/runtimes/opencode/index.js', () => ({ openCodeServerManager: {} }));
vi.mock('../../services/core/cloud/v1-client.js', () => ({ readCloudAccountKey: vi.fn() }));
vi.mock('../../services/session/attachments/index.js', () => ({
  sweepSessionAttachments: vi.fn(async () => undefined),
  SESSION_ATTACHMENT_SWEEP_INTERVAL_MS: 60_000,
}));
vi.mock('../../lib/jittered-schedule.js', () => ({ scheduleJittered: () => ({ stop: vi.fn() }) }));
vi.mock('@dorkos/db', async (original) => ({
  ...(await original<typeof import('@dorkos/db')>()),
  takeDailySnapshot: vi.fn(),
}));

const { startAfterListen } = await import('../steps/after-listen.js');

const resolved = () => ({ catch: () => undefined, then: () => ({ catch: () => undefined }) });
/** Everything `startAfterListen` reads, as inert stubs. */
function built() {
  const sweeps = { sweepRetention: vi.fn(), sweepMetadata: vi.fn(), sweepPreparations: vi.fn() };
  return {
    backgroundWorkCutShort: [],
    roomStore: {},
    recoverAcceptedPrivateSessions: vi.fn(),
    db: {},
    backupsDir: '/tmp/backups',
    dorkHome: '/tmp/dork',
    connectorEventInbox: sweeps,
    connectorEventSessionSource: sweeps,
    connectorAuthenticationFlows: { expireAbandoned: vi.fn() },
    recoverConnectorEventDelivery: vi.fn(async () => undefined),
    connectorEventGrants: { recoverPending: resolved },
    connectorEventService: { recoverCleanup: resolved },
    connectorEventPull: { recover: resolved },
    managedConnectorAuthority: { recoverPending: resolved },
    connectorLifecycle: { finishOwedCleanups: resolved },
    managedUsageMirrors: { recover: resolved },
    PORT: 4242,
    docDeliveryRunner: { start: started.docDelivery },
  } as never;
}

let refs: Record<string, unknown> & { schedulerService: { start: ReturnType<typeof vi.fn> } };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  refs = { schedulerService: { start: vi.fn(async () => undefined) } };
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('startAfterListen on an agent computer', () => {
  it('starts no scheduler, tunnel or account link, and keeps a credits token', async () => {
    role.value = 'agent-computer';
    await startAfterListen(refs as never, built());
    expect(refs.schedulerService.start).not.toHaveBeenCalled();
    expect(started.autostartOwnTunnel).not.toHaveBeenCalled();
    expect(started.initOnStartup).not.toHaveBeenCalled();
    expect(started.startCreditsLifecycle).toHaveBeenCalledTimes(1);
    // Its own agents' document work still runs.
    expect(started.docDelivery).toHaveBeenCalledTimes(1);
  });

  it('starts each of them on a person`s own computer', async () => {
    role.value = 'computer';
    await startAfterListen(refs as never, built());
    expect(refs.schedulerService.start).toHaveBeenCalledTimes(1);
    expect(started.autostartOwnTunnel).toHaveBeenCalledTimes(1);
    expect(started.initOnStartup).toHaveBeenCalledTimes(1);
    expect(started.startCreditsLifecycle).toHaveBeenCalledTimes(1);
  });
});

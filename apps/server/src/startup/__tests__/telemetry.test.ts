import { beforeEach, describe, expect, it, vi } from 'vitest';

type TelemetryFixture = {
  usage: boolean;
  install: boolean;
  heartbeat: boolean;
  errorReporting: boolean;
  aiMetadata: boolean;
  userHasDecided: boolean;
  lastPromptedVersion: string | null;
};

const mocks = vi.hoisted(() => {
  const state: { telemetry: TelemetryFixture } = {
    telemetry: {
      usage: true,
      install: false,
      heartbeat: false,
      errorReporting: false,
      aiMetadata: false,
      userHasDecided: false,
      lastPromptedVersion: null,
    },
  };
  return {
    state,
    get: vi.fn((key: string) => (key === 'telemetry' ? state.telemetry : undefined)),
    set: vi.fn((key: string, value: TelemetryFixture) => {
      if (key === 'telemetry') state.telemetry = value;
    }),
    registerUsageReporter:
      vi.fn<
        (options: {
          enabled: boolean;
          isConsentLive?: () => boolean;
          dorkosVersion: string;
        }) => void
      >(),
    startInstallFunnel: vi.fn(),
    info: vi.fn(),
  };
});

vi.mock('../../env.js', () => ({
  env: {
    NODE_ENV: 'test',
    DO_NOT_TRACK: undefined,
    DORKOS_TELEMETRY_DISABLED: undefined,
    DORKOS_TELEMETRY_DEBUG: undefined,
  },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: mocks.get, set: mocks.set },
}));
vi.mock('../../lib/logger.js', () => ({ logger: { info: mocks.info } }));
vi.mock('../../services/core/operator/config-write.js', () => ({ logConfigWrite: vi.fn() }));
vi.mock('../../services/core/usage-reporter.js', () => ({
  registerUsageReporter: mocks.registerUsageReporter,
}));
vi.mock('../../services/core/telemetry/install-funnel.js', () => ({
  startInstallFunnel: mocks.startInstallFunnel,
}));
vi.mock('../../services/marketplace/telemetry/telemetry-reporter.js', () => ({
  registerDorkosCommunityTelemetry: vi.fn(),
}));
vi.mock('../../services/core/error-reporter.js', () => ({ registerServerErrorReporting: vi.fn() }));
vi.mock('../../services/core/ai-metadata-reporter.js', () => ({
  registerAiMetadataReporter: vi.fn(),
}));
vi.mock('../../services/core/heartbeat-reporter.js', () => ({ registerHeartbeat: vi.fn() }));
vi.mock('@dorkos/db', () => ({ agents: {} }));

import { configManager } from '../../services/core/config-manager.js';
import { wireStartupTelemetry } from '../telemetry.js';

const VERSION = '0.0.0-startup-test';
const DORK_HOME = '/private/startup-telemetry-test';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.telemetry = {
    usage: true,
    install: false,
    heartbeat: false,
    errorReporting: false,
    aiMetadata: false,
    userHasDecided: false,
    lastPromptedVersion: null,
  };
});

describe('startup telemetry consent ordering', () => {
  it('keeps the install funnel closed on the boot that first records the notice', () => {
    const boot = wireStartupTelemetry(DORK_HOME, VERSION);

    expect(mocks.state.telemetry.lastPromptedVersion).toBe(VERSION);
    expect(boot.tier1SendGate).toBe(false);
    expect(mocks.registerUsageReporter).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, dorkosVersion: VERSION })
    );
    expect(mocks.startInstallFunnel).not.toHaveBeenCalled();
  });

  it('starts the opted-in install funnel once when the notice was already recorded', () => {
    mocks.state.telemetry.lastPromptedVersion = VERSION;

    const boot = wireStartupTelemetry(DORK_HOME, VERSION);

    expect(boot.tier1SendGate).toBe(true);
    expect(mocks.registerUsageReporter).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, dorkosVersion: VERSION })
    );
    expect(mocks.startInstallFunnel).toHaveBeenCalledExactlyOnceWith({
      dorkHome: DORK_HOME,
      config: configManager,
    });
  });

  it('checks fresh usage consent after revocation without reopening the boot gate', () => {
    mocks.state.telemetry.lastPromptedVersion = VERSION;
    wireStartupTelemetry(DORK_HOME, VERSION);
    const reporter = mocks.registerUsageReporter.mock.calls[0]?.[0];
    expect(reporter?.isConsentLive?.()).toBe(true);

    mocks.state.telemetry = { ...mocks.state.telemetry, usage: false };

    expect(reporter?.isConsentLive?.()).toBe(false);
    expect(mocks.startInstallFunnel).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import type { ConfigStore } from '../../../config-commands.js';
import {
  runTelemetryStatus,
  runTelemetryEnable,
  runTelemetryDisable,
  type TelemetryCommandIO,
  type TelemetryDeps,
} from '../telemetry.js';

/** Minimal in-memory ConfigStore that understands `telemetry.*` dot paths. */
function createMockStore(initial: Record<string, unknown> = {}): ConfigStore & {
  telemetry: Record<string, unknown>;
} {
  const telemetry: Record<string, unknown> = { ...initial };
  return {
    telemetry,
    path: '/tmp/config.json',
    getAll: () => ({ telemetry }) as never,
    getDot: (key: string) => {
      if (!key.startsWith('telemetry.')) return undefined;
      return telemetry[key.slice('telemetry.'.length)];
    },
    setDot: (key: string, value: unknown) => {
      if (key.startsWith('telemetry.')) telemetry[key.slice('telemetry.'.length)] = value;
      return {};
    },
    reset: () => {},
    validate: () => ({ valid: true }),
  };
}

/** Collects output lines for assertions. */
function createIo(): { io: TelemetryCommandIO; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: { log: (m) => lines.push(m), error: (m) => errors.push(m) },
  };
}

function makeDeps(
  store: ReturnType<typeof createMockStore>,
  env: Record<string, string | undefined> = {}
): TelemetryDeps & { lines: string[] } {
  const { io, lines } = createIo();
  return { store, env, io, lines };
}

describe('runTelemetryEnable', () => {
  let store: ReturnType<typeof createMockStore>;
  beforeEach(() => {
    store = createMockStore();
  });

  it('turns on all channels and records the decision', () => {
    const deps = makeDeps(store);
    const code = runTelemetryEnable(deps);
    expect(code).toBe(0);
    expect(store.telemetry).toMatchObject({
      install: true,
      heartbeat: true,
      errorReporting: true,
      userHasDecided: true,
    });
    expect(deps.lines.join('\n')).toContain('Enabled all telemetry channels');
  });

  it('turns on a single channel via --channel and still records the decision', () => {
    const deps = makeDeps(store);
    runTelemetryEnable(deps, 'heartbeat');
    expect(store.telemetry.heartbeat).toBe(true);
    expect(store.telemetry.install).toBeUndefined();
    expect(store.telemetry.errorReporting).toBeUndefined();
    expect(store.telemetry.userHasDecided).toBe(true);
  });

  it('maps the "errors" channel to telemetry.errorReporting', () => {
    const deps = makeDeps(store);
    runTelemetryEnable(deps, 'errors');
    expect(store.telemetry.errorReporting).toBe(true);
  });

  it('warns when a kill switch would suppress the newly enabled channel', () => {
    const deps = makeDeps(store, { DO_NOT_TRACK: '1' });
    runTelemetryEnable(deps);
    expect(deps.lines.join('\n')).toContain('kill switch');
  });
});

describe('runTelemetryDisable', () => {
  it('turns off all channels and records the decision', () => {
    const store = createMockStore({ install: true, heartbeat: true, errorReporting: true });
    const deps = makeDeps(store);
    runTelemetryDisable(deps);
    expect(store.telemetry).toMatchObject({
      install: false,
      heartbeat: false,
      errorReporting: false,
      userHasDecided: true,
    });
  });

  it('turns off a single channel via --channel', () => {
    const store = createMockStore({ install: true, heartbeat: true });
    const deps = makeDeps(store);
    runTelemetryDisable(deps, 'install');
    expect(store.telemetry.install).toBe(false);
    expect(store.telemetry.heartbeat).toBe(true);
    expect(store.telemetry.userHasDecided).toBe(true);
  });
});

describe('runTelemetryStatus', () => {
  it('shows the config value for each channel and the decision gate', () => {
    const store = createMockStore({
      install: true,
      heartbeat: false,
      errorReporting: false,
      userHasDecided: true,
    });
    const deps = makeDeps(store);
    const code = runTelemetryStatus(deps);
    expect(code).toBe(0);
    const out = deps.lines.join('\n');
    expect(out).toContain('Install events');
    expect(out).toContain('config: true');
    expect(out).toContain('made a telemetry choice');
  });

  it('flags that a kill switch forces enabled channels off', () => {
    const store = createMockStore({ install: true, userHasDecided: true });
    const deps = makeDeps(store, { DORKOS_TELEMETRY_DISABLED: 'true' });
    runTelemetryStatus(deps);
    const out = deps.lines.join('\n');
    expect(out).toContain('forced off by env');
    expect(out).toContain('kill switch');
  });

  it('notes debug mode when DORKOS_TELEMETRY_DEBUG is on', () => {
    const store = createMockStore({ userHasDecided: false });
    const deps = makeDeps(store, { DORKOS_TELEMETRY_DEBUG: '1' });
    runTelemetryStatus(deps);
    expect(deps.lines.join('\n')).toContain('Debug mode is on');
  });

  it('says the user has not chosen yet when undecided', () => {
    const store = createMockStore({});
    const deps = makeDeps(store);
    runTelemetryStatus(deps);
    expect(deps.lines.join('\n')).toContain('have not chosen yet');
  });
});

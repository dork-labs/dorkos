import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  salvageTelemetryDecision,
  salvageProtectedState,
  applyProtectedState,
  latestInstant,
  PROTECTIVE_CARRYOVERS,
} from '../protected-state.js';
import { ConfigManager } from '../../config-manager.js';
import { configSchemaLeafPaths } from '../../operator/config-disclosure.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Minimal stand-in for the `conf` store, matching `ProtectedStateStore`. */
function createStore(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = structuredClone(initial);
  return {
    data,
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
  };
}

/** A telemetry block as it stands for someone who answered "no" to everything. */
const OPTED_OUT = {
  userHasDecided: true,
  install: false,
  heartbeat: false,
  errorReporting: false,
  lastPromptedVersion: '0.57.0',
  usage: false,
  linkAnalyticsToAccount: false,
  aiMetadata: false,
};

describe('salvageTelemetryDecision', () => {
  it('carries an explicit opt-out back verbatim', () => {
    expect(salvageTelemetryDecision({ telemetry: OPTED_OUT })).toEqual(OPTED_OUT);
  });

  it('carries an explicit opt-IN back verbatim too — a decision is a decision', () => {
    const optedIn = { ...OPTED_OUT, install: true, heartbeat: true, usage: true };
    expect(salvageTelemetryDecision({ telemetry: optedIn })).toEqual(optedIn);
  });

  it('returns nothing for a never-answered install, so the notice gate re-arms', () => {
    expect(
      salvageTelemetryDecision({ telemetry: { userHasDecided: false, install: true } })
    ).toBeUndefined();
    expect(salvageTelemetryDecision({ telemetry: {} })).toBeUndefined();
    expect(salvageTelemetryDecision({})).toBeUndefined();
  });

  it('never returns a bare userHasDecided — that would open the gate onto default-ON channels', () => {
    // The exact shape of the reported defect: a decision flag with no channel
    // values beside it. Every channel must come back, and a channel the person
    // was never asked about comes back OFF.
    const salvaged = salvageTelemetryDecision({ telemetry: { userHasDecided: true } });
    expect(salvaged).toEqual({
      userHasDecided: true,
      install: false,
      heartbeat: false,
      errorReporting: false,
      lastPromptedVersion: null,
      usage: false,
      linkAnalyticsToAccount: false,
      aiMetadata: false,
    });
  });

  it('drops a garbage block rather than carrying it into a fresh file', () => {
    expect(salvageTelemetryDecision({ telemetry: 'nonsense' })).toBeUndefined();
    expect(salvageTelemetryDecision({ telemetry: { userHasDecided: 'yes' } })).toBeUndefined();
  });

  it('ignores a non-boolean channel value but keeps the rest of the decision', () => {
    const salvaged = salvageTelemetryDecision({
      telemetry: { ...OPTED_OUT, install: 'maybe' },
    });
    // `install` could not be read, so it falls to the protective OFF rather than
    // to the schema's permissive default.
    expect(salvaged?.install).toBe(false);
    expect(salvaged?.heartbeat).toBe(false);
    expect(salvaged?.userHasDecided).toBe(true);
  });
});

describe('salvageProtectedState', () => {
  const fresh = USER_CONFIG_DEFAULTS;

  it('keeps a channel turned off without the banner (userHasDecided never set)', () => {
    // `dorkos telemetry disable` / `dorkos config set` never touch
    // `userHasDecided`, so there is no decision to carry — but "off" is still an
    // explicit act and the value comparison preserves it.
    const salvaged = salvageProtectedState(
      { telemetry: { userHasDecided: false, install: false, heartbeat: false, usage: true } },
      fresh
    );
    expect(salvaged.telemetry).toBeUndefined();
    expect(salvaged.leaves['telemetry.install']).toBe(false);
    expect(salvaged.leaves['telemetry.heartbeat']).toBe(false);
    expect(salvaged.leaves['telemetry.usage']).toBeUndefined();
  });

  it('never carries a value more permissive than a fresh install', () => {
    const salvaged = salvageProtectedState(
      {
        auth: { enabled: false },
        mcp: { enabled: true },
        approvals: { standingGrants: true, trustWindowMinutes: 1440 },
        rooms: { maxAgentDepth: 99 },
      },
      fresh
    );
    expect(salvaged.leaves).toEqual({});
  });

  it('carries a login gate that was switched on', () => {
    const salvaged = salvageProtectedState({ auth: { enabled: true } }, fresh);
    expect(salvaged.leaves['auth.enabled']).toBe(true);
  });

  it('carries a tightened bound, and only when it is actually tighter', () => {
    const salvaged = salvageProtectedState(
      { rooms: { maxAgentDepth: 1, maxAutomaticTurnsTotalPerHour: 1000 } },
      fresh
    );
    expect(salvaged.leaves['rooms.maxAgentDepth']).toBe(1);
    expect(salvaged.leaves['rooms.maxAutomaticTurnsTotalPerHour']).toBeUndefined();
  });

  it('carries the standing-grant void floor, which outlives the config file', () => {
    const floor = '2026-07-20T10:00:00.000Z';
    const salvaged = salvageProtectedState(
      { approvals: { standingGrantsVoidBefore: floor } },
      fresh
    );
    expect(salvaged.leaves['approvals.standingGrantsVoidBefore']).toBe(floor);
  });

  it('drops a void floor that is not a real timestamp instead of letting it sort above every real one', () => {
    const salvaged = salvageProtectedState(
      { approvals: { standingGrantsVoidBefore: 'whenever' } },
      fresh
    );
    expect(salvaged.leaves['approvals.standingGrantsVoidBefore']).toBeUndefined();
  });

  it('survives an unreadable input without throwing — the caller is already failing', () => {
    expect(salvageProtectedState(undefined, fresh)).toEqual({ leaves: {} });
    expect(salvageProtectedState('{ truncated', fresh)).toEqual({ leaves: {} });
    expect(salvageProtectedState(null, fresh)).toEqual({ leaves: {} });
  });

  it('lets a carried decision own the telemetry block outright', () => {
    // With a decision present the per-leaf rules must not also fire, or the two
    // could contradict each other on the same field.
    const salvaged = salvageProtectedState(
      { telemetry: { ...OPTED_OUT, install: true, heartbeat: true } },
      fresh
    );
    expect(salvaged.telemetry?.install).toBe(true);
    expect(Object.keys(salvaged.leaves)).not.toContain('telemetry.install');
  });
});

describe('applyProtectedState', () => {
  it('writes the decision back onto a freshly-defaulted store', () => {
    const store = createStore(USER_CONFIG_DEFAULTS as unknown as Record<string, unknown>);
    const restored = applyProtectedState(store, {
      telemetry: OPTED_OUT,
      leaves: { 'auth.enabled': true },
    });
    expect(store.data.telemetry).toMatchObject({ install: false, userHasDecided: true });
    expect((store.data.auth as { enabled: boolean }).enabled).toBe(true);
    expect(restored).toContain('auth.enabled');
  });

  it('leaves every sibling default in the section intact', () => {
    const store = createStore(USER_CONFIG_DEFAULTS as unknown as Record<string, unknown>);
    applyProtectedState(store, { leaves: { 'rooms.maxAgentDepth': 1 } });
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 1,
      maxAutomaticTurnsPerRoomPerHour: 60,
      maxAutomaticTurnsTotalPerHour: 240,
    });
  });

  it('writes nothing at all when there is nothing to protect', () => {
    const store = createStore(USER_CONFIG_DEFAULTS as unknown as Record<string, unknown>);
    expect(applyProtectedState(store, { leaves: {} })).toEqual([]);
  });
});

describe('latestInstant', () => {
  it('picks the later instant and treats a missing one as no floor', () => {
    expect(latestInstant(null, null)).toBeNull();
    expect(latestInstant('2026-01-01T00:00:00.000Z', null)).toBe('2026-01-01T00:00:00.000Z');
    expect(latestInstant('2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')).toBe(
      '2026-06-01T00:00:00.000Z'
    );
  });
});

describe('PROTECTIVE_CARRYOVERS registry', () => {
  it('names only paths that really exist in the config schema', () => {
    const known = new Set(configSchemaLeafPaths());
    for (const entry of PROTECTIVE_CARRYOVERS) {
      expect(known, `${entry.path} is not a leaf of UserConfigSchema`).toContain(entry.path);
    }
  });

  it('lists a protectiveValue for every boolean rule, and a reason for all of them', () => {
    for (const entry of PROTECTIVE_CARRYOVERS) {
      expect(entry.reason.length, `${entry.path} needs a reason`).toBeGreaterThan(20);
      if (entry.direction === 'boolean') {
        expect(typeof entry.protectiveValue, `${entry.path}`).toBe('boolean');
      }
    }
  });

  it('only lists leaves whose default is the permissive side — the rest need no rule', () => {
    // A rule whose protective value already equals the default can never fire,
    // so it is dead weight rather than a safeguard.
    const read = (path: string): unknown =>
      path
        .split('.')
        .reduce<unknown>(
          (cur, part) =>
            cur !== null && typeof cur === 'object'
              ? (cur as Record<string, unknown>)[part]
              : undefined,
          USER_CONFIG_DEFAULTS
        );
    for (const entry of PROTECTIVE_CARRYOVERS.filter((e) => e.direction === 'boolean')) {
      expect(read(entry.path), `${entry.path} default already protective`).not.toBe(
        entry.protectiveValue
      );
    }
  });
});

/**
 * The seam the mock-store tests cannot reach: a real `ConfigManager` over a real
 * file that `conf`'s Ajv refuses. `UserConfigSchema.parse` is not a stand-in —
 * Zod strips unknown keys where Ajv rejects them.
 */
describe('ConfigManager recovery keeps protections (real conf + Ajv)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a config file that parses as JSON but fails schema validation. */
  function seedInvalidConfig(stored: Record<string, unknown>): {
    dir: string;
    configPath: string;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-safe-recovery-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    // `server.port` must be an integer; a string is Ajv-invalid while leaving
    // the rest of the file perfectly readable — the realistic failure shape.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, server: { port: 'not-a-port' }, ...stored })
    );
    return { dir, configPath };
  }

  it('is genuinely a condemned file — the recovery path really runs', () => {
    const { dir, configPath } = seedInvalidConfig({});
    new ConfigManager(dir);
    expect(fs.existsSync(configPath + '.bak')).toBe(true);
  });

  it('does NOT resurrect telemetry after an explicit opt-out (the reported defect)', () => {
    const { dir } = seedInvalidConfig({ telemetry: OPTED_OUT });
    const telemetry = new ConfigManager(dir).get('telemetry');

    // Before this fix: userHasDecided true -> false, install/heartbeat false -> true.
    expect(telemetry.userHasDecided).toBe(true);
    expect(telemetry.install).toBe(false);
    expect(telemetry.heartbeat).toBe(false);
    expect(telemetry.usage).toBe(false);
    expect(telemetry.lastPromptedVersion).toBe('0.57.0');
  });

  it('recovers into a valid config — the salvaged values do not re-condemn the file', () => {
    const { dir } = seedInvalidConfig({ telemetry: OPTED_OUT, auth: { enabled: true } });
    const manager = new ConfigManager(dir);
    expect(manager.validate()).toEqual({ valid: true });
    // A second boot reads the recovered file cleanly rather than looping.
    expect(new ConfigManager(dir).get('telemetry').install).toBe(false);
  });

  it('keeps a login gate and a void floor across recovery', () => {
    const floor = '2026-07-20T10:00:00.000Z';
    const { dir } = seedInvalidConfig({
      auth: { enabled: true },
      approvals: { standingGrants: true, trustWindowMinutes: 30, standingGrantsVoidBefore: floor },
    });
    const manager = new ConfigManager(dir);
    expect(manager.get('auth').enabled).toBe(true);
    expect(manager.get('approvals').standingGrantsVoidBefore).toBe(floor);
    expect(manager.get('approvals').trustWindowMinutes).toBe(30);
    // The permissive half of that section is NOT carried.
    expect(manager.get('approvals').standingGrants).toBe(false);
  });

  it('falls back to plain defaults when the file cannot be parsed at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-safe-recovery-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), '{ truncated');
    const manager = new ConfigManager(dir);
    expect(manager.validate()).toEqual({ valid: true });
    expect(manager.get('server').port).toBe(4242);
  });

  it('keeps a privacy choice across a full reset()', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-safe-reset-'));
    dirs.push(dir);
    const manager = new ConfigManager(dir);
    manager.set('telemetry', OPTED_OUT);
    manager.setDot('server.port', 5000);

    manager.reset();

    // Preferences go, as a reset should. The protection stays.
    expect(manager.get('server').port).toBe(4242);
    expect(manager.get('telemetry').install).toBe(false);
    expect(manager.get('telemetry').userHasDecided).toBe(true);
  });

  it('still resets telemetry when that section is named outright', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-safe-reset-'));
    dirs.push(dir);
    const manager = new ConfigManager(dir);
    manager.set('telemetry', OPTED_OUT);

    manager.reset('telemetry');

    // Naming the section IS the explicit act, so it does exactly what it says.
    expect(manager.get('telemetry').userHasDecided).toBe(false);
    expect(manager.get('telemetry').install).toBe(true);
  });
});

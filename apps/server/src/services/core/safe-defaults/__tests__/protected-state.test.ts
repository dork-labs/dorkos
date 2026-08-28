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
import { logger } from '../../../../lib/logger.js';
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

const FRESH_TELEMETRY = {
  userHasDecided: false,
  install: false,
  heartbeat: false,
  errorReporting: false,
  lastPromptedVersion: null,
  usage: false,
  linkAnalyticsToAccount: false,
  aiMetadata: false,
};

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
    expect(salvageTelemetryDecision({ telemetry: OPTED_OUT }, FRESH_TELEMETRY)).toEqual(OPTED_OUT);
  });

  it('does NOT carry an opt-IN, because it cannot be reproduced within the bound', () => {
    // Carryover is monotone toward protection: with the channels defaulting
    // off, "yes" cannot come back without raising exposure above a fresh
    // install. Dropping the decision leaves the notice armed, so the person is
    // asked again rather than silently opted out.
    const optedIn = { ...OPTED_OUT, install: true, heartbeat: true, usage: true };
    expect(salvageTelemetryDecision({ telemetry: optedIn }, FRESH_TELEMETRY)).toBeUndefined();
  });

  it('never carries a Tier 2 channel that was left on', () => {
    // The reviewer's case: one `true` read out of a file that just failed
    // validation must not re-enable error reporting or the account link.
    const leaky = {
      ...OPTED_OUT,
      errorReporting: true,
      linkAnalyticsToAccount: true,
      aiMetadata: true,
    };
    expect(salvageTelemetryDecision({ telemetry: leaky }, FRESH_TELEMETRY)).toBeUndefined();
  });

  it('carries an opt-IN when a fresh install would be there anyway', () => {
    // The clamp is written against `fresh`, not a hardcoded false, so it stays
    // correct if the Tier 1 defaults are ever flipped back.
    const freshOn = { ...FRESH_TELEMETRY, install: true, heartbeat: true, usage: true };
    const optedIn = { ...OPTED_OUT, install: true, heartbeat: true, usage: true };
    expect(salvageTelemetryDecision({ telemetry: optedIn }, freshOn)).toEqual(optedIn);
  });

  it('returns nothing for a never-answered install, so the notice gate re-arms', () => {
    expect(
      salvageTelemetryDecision(
        { telemetry: { userHasDecided: false, install: true } },
        FRESH_TELEMETRY
      )
    ).toBeUndefined();
    expect(salvageTelemetryDecision({ telemetry: {} }, FRESH_TELEMETRY)).toBeUndefined();
    expect(salvageTelemetryDecision({}, FRESH_TELEMETRY)).toBeUndefined();
  });

  it('never returns a bare userHasDecided — that would open the gate onto default-ON channels', () => {
    // The exact shape of the reported defect: a decision flag with no channel
    // values beside it. Every channel must come back, and a channel the person
    // was never asked about comes back OFF.
    const salvaged = salvageTelemetryDecision(
      { telemetry: { userHasDecided: true } },
      FRESH_TELEMETRY
    );
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
    expect(salvageTelemetryDecision({ telemetry: 'nonsense' }, FRESH_TELEMETRY)).toBeUndefined();
    expect(
      salvageTelemetryDecision({ telemetry: { userHasDecided: 'yes' } }, FRESH_TELEMETRY)
    ).toBeUndefined();
  });

  it('ignores a non-boolean channel value but keeps the rest of the decision', () => {
    const salvaged = salvageTelemetryDecision(
      {
        telemetry: { ...OPTED_OUT, install: 'maybe' },
      },
      FRESH_TELEMETRY
    );
    // `install` could not be read, so it falls to the protective OFF rather than
    // to the schema's permissive default.
    expect(salvaged?.install).toBe(false);
    expect(salvaged?.heartbeat).toBe(false);
    expect(salvaged?.userHasDecided).toBe(true);
  });
});

describe('salvageProtectedState', () => {
  const fresh = USER_CONFIG_DEFAULTS;

  it('needs no telemetry carryover now that the channels default off', () => {
    // `dorkos telemetry disable` / `dorkos config set` never touch
    // `userHasDecided`, so there is no decision to carry. Since the Tier 1
    // channels default OFF (ADR 260727-181825) the wipe lands on the protective
    // value by itself, so nothing needs carrying — and nothing claims to.
    const salvaged = salvageProtectedState(
      { telemetry: { userHasDecided: false, install: false, heartbeat: false } },
      fresh
    );
    expect(salvaged.telemetry).toBeUndefined();
    expect(salvaged.leaves).toEqual({});
  });

  it('drops a decision to keep sharing rather than raising exposure', () => {
    const sharing = { ...OPTED_OUT, install: true, heartbeat: true, usage: true };
    const salvaged = salvageProtectedState({ telemetry: sharing }, fresh);
    expect(salvaged.telemetry).toBeUndefined();
    expect(salvaged.leaves).toEqual({});
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
      { rooms: { maxAgentDepth: 1, maxAutomaticTurnsTotalPerHour: 20_000 } },
      fresh
    );
    expect(salvaged.leaves['rooms.maxAgentDepth']).toBe(1);
    expect(salvaged.leaves['rooms.maxAutomaticTurnsTotalPerHour']).toBeUndefined();
  });

  it('carries a raised threshold, where UP is the tightening', () => {
    // The mirror case, and the one a cap-shaped assumption gets backwards.
    // `welcomeBack.absenceThresholdMinutes` is crossed rather than capped: a
    // week means fewer returns qualify, so the person who set 10080 and lands
    // back on 240 is greeted several times as often as they chose.
    const salvaged = salvageProtectedState(
      { welcomeBack: { absenceThresholdMinutes: 10_080 } },
      fresh
    );
    expect(salvaged.leaves['welcomeBack.absenceThresholdMinutes']).toBe(10_080);
  });

  it('does not carry a lowered threshold, which is the permissive side of it', () => {
    const salvaged = salvageProtectedState({ welcomeBack: { absenceThresholdMinutes: 15 } }, fresh);
    expect(salvaged.leaves['welcomeBack.absenceThresholdMinutes']).toBeUndefined();
  });

  it('carries a refusal to spend on next-step offers (DOR-1121)', () => {
    // Offers ship ON, so OFF is somebody declining a per-agent model turn. A
    // wipe landing back on the default would start billing them again with no
    // prompt anywhere — the invoice would be how they found out. Carried
    // independently of `enabled`, because "greet me, but do not run anything" is
    // a position a person can hold.
    const salvaged = salvageProtectedState(
      { welcomeBack: { enabled: true, offersEnabled: false } },
      fresh
    );
    expect(salvaged.leaves['welcomeBack.offersEnabled']).toBe(false);
    expect(salvaged.leaves['welcomeBack.enabled']).toBeUndefined();
  });

  it('does not carry offers that were left on, which is the permissive side', () => {
    const salvaged = salvageProtectedState({ welcomeBack: { offersEnabled: true } }, fresh);
    expect(salvaged.leaves['welcomeBack.offersEnabled']).toBeUndefined();
  });

  it('leaves a fresh install alone — an untouched threshold carries nothing', () => {
    const salvaged = salvageProtectedState(
      { welcomeBack: { enabled: true, absenceThresholdMinutes: 240, maxPosts: 3 } },
      fresh
    );
    expect(salvaged.leaves).toEqual({});
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
    expect(salvageProtectedState(undefined, fresh)).toEqual({ leaves: {}, dropped: [] });
    expect(salvageProtectedState('{ truncated', fresh)).toEqual({ leaves: {}, dropped: [] });
    expect(salvageProtectedState(null, fresh)).toEqual({ leaves: {}, dropped: [] });
  });

  it('lets a carried decision own the telemetry block outright', () => {
    // When a decision IS carried, the per-leaf rules must not also fire on
    // telemetry, or the two could contradict each other on the same field.
    const salvaged = salvageProtectedState({ telemetry: OPTED_OUT }, fresh);
    expect(salvaged.telemetry).toEqual(OPTED_OUT);
    expect(Object.keys(salvaged.leaves).filter((p) => p.startsWith('telemetry.'))).toEqual([]);
  });
});

describe('applyProtectedState', () => {
  it('writes the decision back onto a freshly-defaulted store', () => {
    const store = createStore(USER_CONFIG_DEFAULTS as unknown as Record<string, unknown>);
    const restored = applyProtectedState(store, {
      telemetry: OPTED_OUT,
      leaves: { 'auth.enabled': true },
      dropped: [],
    });
    expect(store.data.telemetry).toMatchObject({ install: false, userHasDecided: true });
    expect((store.data.auth as { enabled: boolean }).enabled).toBe(true);
    expect(restored).toContain('auth.enabled');
  });

  it('leaves every sibling default in the section intact', () => {
    const store = createStore(USER_CONFIG_DEFAULTS as unknown as Record<string, unknown>);
    applyProtectedState(store, { leaves: { 'rooms.maxAgentDepth': 1 }, dropped: [] });
    expect(store.data.rooms).toEqual({
      turnLimitsEnabled: true,
      maxAgentDepth: 1,
      maxTurnsPerAgentPerCascade: 10,
      maxAutomaticTurnsPerRoomPerHour: 1000,
      maxAutomaticTurnsTotalPerHour: 5000,
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 10,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
      responseGate: 'routing',
      repo: {
        enabled: true,
        worktreeReapDays: 14,
        maxFileBytes: 5 * 1024 * 1024,
        maxRepoBytes: 500 * 1024 * 1024,
        maxRoomMdBytes: 24 * 1024,
        mergeQueueWaitMs: 30_000,
      },
    });
  });

  it('writes nothing at all when there is nothing to protect', () => {
    const store = createStore(USER_CONFIG_DEFAULTS as unknown as Record<string, unknown>);
    expect(applyProtectedState(store, { leaves: {}, dropped: [] })).toEqual([]);
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
    // `mesh.scanRoots` is a list; a string there is a SHAPE the schema does not
    // describe, which is the class Ajv still refuses (DOR-1227 took values on
    // named scalar leaves out of its hands — `server.port: 'not-a-port'`, which
    // used to be this fixture, now boots on the default instead of condemning).
    // The rest of the file stays perfectly readable, which is the realistic
    // failure shape and what makes salvage both possible and necessary.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, mesh: { scanRoots: 'not-a-list' }, ...stored })
    );
    return { dir, configPath };
  }

  it('is genuinely a condemned file — the recovery path really runs', () => {
    const { dir } = seedInvalidConfig({});
    new ConfigManager(dir);
    // Backups are timestamped and rotated (DOR-1221), so there is no one name
    // to look for.
    expect(fs.readdirSync(dir).some((name) => name.endsWith('.bak'))).toBe(true);
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

  /**
   * The last-resort always-boots guarantee. Every input below is type-correct
   * and schema-INVALID, which is what a `typeof` check waves through: it was
   * then written back inside the recovery catch, Ajv threw on `set()`, and the
   * throw escaped past `initConfigManager` so the server did not start at all.
   * These are the four inputs that reproduced it, plus the partial write.
   */
  describe('a carried value can never stop the server booting', () => {
    const OUT_OF_RANGE: Array<[string, Record<string, unknown>]> = [
      ['a trust window below the schema minimum', { approvals: { trustWindowMinutes: 1 } }],
      ['a negative room depth', { rooms: { maxAgentDepth: -1 } }],
      ['a date-only void floor', { approvals: { standingGrantsVoidBefore: '2026-07-27' } }],
      [
        'a human-readable void floor',
        { approvals: { standingGrantsVoidBefore: 'December 31, 2020' } },
      ],
    ];

    for (const [name, stored] of OUT_OF_RANGE) {
      it(`boots past ${name}, and does not carry it`, () => {
        const { dir } = seedInvalidConfig(stored);
        const manager = new ConfigManager(dir);
        expect(manager.validate()).toEqual({ valid: true });
        // Dropped, not clamped: we do not invent a value the person never chose.
        expect(manager.get('approvals').trustWindowMinutes).toBe(480);
        expect(manager.get('approvals').standingGrantsVoidBefore).toBeNull();
        expect(manager.get('rooms').maxAgentDepth).toBe(30);
      });
    }

    it('keeps every bound the person tightened, across all three sections', () => {
      // A `safe` default is a real limit, not the tightest one a person may
      // want. Before the completeness guard reached safe numerics, all three of
      // these were silently loosened by every recovery.
      const { dir } = seedInvalidConfig({
        uploads: { maxFileSize: 1024, maxFiles: 1 },
        mcp: { rateLimit: { maxPerWindow: 5 } },
        rooms: { maxAgentDepth: 1 },
      });
      const manager = new ConfigManager(dir);
      expect(manager.get('uploads').maxFileSize).toBe(1024);
      expect(manager.get('uploads').maxFiles).toBe(1);
      expect(manager.get('mcp').rateLimit.maxPerWindow).toBe(5);
      expect(manager.get('rooms').maxAgentDepth).toBe(1);
      // A loosened bound is never carried — recovery only ever tightens.
      expect(manager.validate()).toEqual({ valid: true });
    });

    it('keeps a raised welcome-back threshold across a real recovery', () => {
      // The defect a `'lower'`-only union shipped: this leaf tightens UPWARD, so
      // every recovery reset a week back to four hours and greeted the person
      // four times as often as they chose, without asking. The lowered cap
      // beside it proves the two directions coexist on one section.
      const { dir } = seedInvalidConfig({
        welcomeBack: { absenceThresholdMinutes: 10_080, maxPosts: 1 },
      });
      const manager = new ConfigManager(dir);
      expect(manager.get('welcomeBack').absenceThresholdMinutes).toBe(10_080);
      expect(manager.get('welcomeBack').maxPosts).toBe(1);
      expect(manager.validate()).toEqual({ valid: true });
    });

    it('does not carry a shortened welcome-back threshold — recovery only tightens', () => {
      const { dir } = seedInvalidConfig({ welcomeBack: { absenceThresholdMinutes: 15 } });
      const manager = new ConfigManager(dir);
      expect(manager.get('welcomeBack').absenceThresholdMinutes).toBe(240);
      expect(manager.validate()).toEqual({ valid: true });
    });

    it('boots past a threshold past the schema ceiling, and does not carry it', () => {
      // The hazard `higher` newly opens, and the reason the direction alone is
      // not the last word: this value IS on the protective side, so the
      // direction says carry it, and it is schema-INVALID (`.max(10080)`), so
      // writing it back would throw on `set()` inside the recovery catch and
      // take down the boot this code exists to rescue. Dropped, not clamped.
      const { dir } = seedInvalidConfig({ welcomeBack: { absenceThresholdMinutes: 20_000 } });
      const manager = new ConfigManager(dir);
      expect(manager.get('welcomeBack').absenceThresholdMinutes).toBe(240);
      expect(manager.validate()).toEqual({ valid: true });
    });

    it('does not carry a bound the person had loosened', () => {
      const { dir } = seedInvalidConfig({
        uploads: { maxFiles: 50 },
        rooms: { maxAgentDepth: 90 },
      });
      const manager = new ConfigManager(dir);
      expect(manager.get('uploads').maxFiles).toBe(10);
      expect(manager.get('rooms').maxAgentDepth).toBe(30);
    });

    it('says in the log which tightened setting it could not keep', () => {
      // An operator whose bound was discarded has only the log to find out.
      const warn = vi.mocked(logger.warn);
      warn.mockClear();
      const { dir } = seedInvalidConfig({ approvals: { trustWindowMinutes: 1 } });
      new ConfigManager(dir);
      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('approvals.trustWindowMinutes'))).toBe(true);
      expect(lines.some((line) => line.includes('Could not keep'))).toBe(true);
    });

    it('drops only the bad value and still carries the good ones', () => {
      // One unreadable field must never cost another, and the write must not
      // land half-applied across sections.
      const { dir } = seedInvalidConfig({
        auth: { enabled: true },
        mcp: { enabled: false },
        approvals: { trustWindowMinutes: 2 },
      });
      const manager = new ConfigManager(dir);
      expect(manager.validate()).toEqual({ valid: true });
      expect(manager.get('auth').enabled).toBe(true);
      expect(manager.get('mcp').enabled).toBe(false);
      expect(manager.get('approvals').trustWindowMinutes).toBe(480);
    });

    it('keeps the fresh void floor when the stored one is unparseable garbage', () => {
      // "December 31, 2020" sorts above every real timestamp as text, so an
      // unvalidated compare would LOWER a floor that had voided permissions.
      const { dir } = seedInvalidConfig({
        approvals: { standingGrantsVoidBefore: 'December 31, 2020' },
      });
      expect(new ConfigManager(dir).get('approvals').standingGrantsVoidBefore).toBeNull();
    });
  });

  it('keeps a privacy choice across a full reset()', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-safe-reset-'));
    dirs.push(dir);
    const manager = new ConfigManager(dir);
    manager.set('telemetry', OPTED_OUT);
    manager.setDot('server.port', 5000);

    manager.reset();

    // Preferences go, as a reset should. The protection stays, whole.
    expect(manager.get('server').port).toBe(4242);
    expect(manager.get('telemetry')).toEqual(OPTED_OUT);
  });

  it('still resets telemetry when that section is named outright', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-safe-reset-'));
    dirs.push(dir);
    const manager = new ConfigManager(dir);
    manager.set('telemetry', { ...OPTED_OUT, install: true, heartbeat: true, usage: true });

    manager.reset('telemetry');

    // Naming the section IS the explicit act, so it does exactly what it says —
    // and what it says now lands on the defaults, which are off.
    expect(manager.get('telemetry').userHasDecided).toBe(false);
    expect(manager.get('telemetry').install).toBe(false);
  });

  it('a reset never raises exposure, and re-arms the notice instead', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-safe-reset-'));
    dirs.push(dir);
    const manager = new ConfigManager(dir);
    manager.set('telemetry', { ...OPTED_OUT, install: true, heartbeat: true, usage: true });

    manager.reset();

    // Every channel, not just the one an earlier version of this test checked.
    const telemetry = manager.get('telemetry');
    expect(telemetry.install).toBe(false);
    expect(telemetry.heartbeat).toBe(false);
    expect(telemetry.usage).toBe(false);
    expect(telemetry.errorReporting).toBe(false);
    expect(telemetry.linkAnalyticsToAccount).toBe(false);
    expect(telemetry.aiMetadata).toBe(false);
    // The notice is armed again, so they get asked rather than silently opted out.
    expect(telemetry.userHasDecided).toBe(false);
    expect(telemetry.lastPromptedVersion).toBeNull();
  });
});

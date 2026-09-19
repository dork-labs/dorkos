/**
 * The display twin of the seeding tests beside this file (DOR-2103).
 *
 * DOR-2105 pinned the thing types cannot check on the RUNNING side: that a mode
 * nobody typed travels origin → mapping → row → launch resolver → the SDK call.
 * This pins the same claim on the SCREEN side, which is where it was broken: a
 * conversation nobody has written to yet has no `session_metadata` row, and
 * `GET /api/sessions/:id` answers 404 for a session with no transcript, so the
 * client has to RESOLVE what the first turn will seed rather than read it. It
 * used to write the literal `'default'` there instead, so an operator whose
 * configured stop was Full autonomy read "Default" on the dial right up until
 * the first message silently made it Full autonomy.
 *
 * ## What is actually asserted, and why it is not circular
 *
 * The client cannot import a runtime's capability profile (the standing reason
 * `permission-semantics.ts` lives in `@dorkos/shared` at all), so the
 * profile-wide half of the claim has to be made here:
 *
 * > For every runtime this install can serve and every stop an operator can
 * > configure, the mode the SEED writes and the mode the SCREEN resolves are
 * > the same mode — once "seeded nothing" is read as what it means, which is
 * > that the runtime's own declared default runs the turn.
 *
 * The screen's half of that is `resolveStopMode` + `permissionModes.default`,
 * exactly as `useSessionStartMode` in `entities/session` composes them. They
 * share the stop→mode mapping on purpose (one mapping, so a dial position
 * cannot mean two modes); what this file proves is that the two sides feed it
 * the same INPUTS and read its `undefined` the same way — which is the part
 * that can drift, and the part a shared function does not give for free.
 *
 * The complementary half — that the resolved value really reaches the dial
 * instead of a literal — is an RTL test, because only the client can render:
 * `apps/client/src/layers/entities/session/model/settings/__tests__/use-session-start-mode.test.tsx`.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionStop, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { PERMISSION_STOPS, resolveStopMode } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../runtimes/codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../../../runtimes/opencode/runtime-constants.js';
import { TEST_MODE_CAPABILITIES } from '../../../runtimes/test-mode/runtime-constants.js';
import { resolveSessionDefaults } from '../../resolve-session-defaults.js';
import { permissionSeedForOrigin } from '../turn-origin.js';

/** Every runtime profile a DorkOS install can serve from `/api/capabilities`. */
const PROFILES: RuntimeCapabilities[] = [
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES,
  OPENCODE_CAPABILITIES,
  TEST_MODE_CAPABILITIES,
];

/** The stored `runtimes` block, with the named sections replaced. */
function runtimes(overrides: Partial<UserConfig['runtimes']> = {}): UserConfig['runtimes'] {
  return { ...USER_CONFIG_DEFAULTS.runtimes, ...overrides };
}

/**
 * What the first interactive turn will seed onto a brand-new row, for one
 * runtime under one configured stop.
 *
 * The real path, minus the database: `permissionSeedForOrigin` decides whether
 * the runtime's modes are handed over at all, and `resolveSessionDefaults` is
 * handed exactly what `RuntimeRegistry.seedForNewRow` hands it. `undefined` is
 * a real answer and means the column stays NULL.
 *
 * @param caps - The runtime's declared profile.
 * @param stop - The operator's configured global trust stop.
 */
function seededMode(caps: RuntimeCapabilities, stop: PermissionStop | null): string | undefined {
  const follows = permissionSeedForOrigin({ kind: 'interactive' }) !== 'none';
  return resolveSessionDefaults({
    runtimeType: caps.type,
    runtimes: runtimes({ defaultTrustStop: stop }),
    configSection: caps.settings.configSection,
    supportsEffort: caps.settings.supportsEffort,
    ...(follows ? { permissionModes: caps.permissionModes.values } : {}),
  }).permissionMode;
}

/**
 * What the dial shows for a session with no row, for the same runtime under the
 * same configured stop — `useSessionStartMode`'s body, with the two hook reads
 * (config, capability map) supplied directly.
 *
 * @param caps - The runtime's declared profile.
 * @param stop - The operator's configured global trust stop.
 */
function displayedMode(caps: RuntimeCapabilities, stop: PermissionStop | null): string | undefined {
  return resolveStopMode(stop, caps.permissionModes.values) ?? caps.permissionModes.default;
}

describe('what a new conversation shows is what its first turn will run at', () => {
  const cases = PROFILES.flatMap((caps) =>
    [null, ...PERMISSION_STOPS].map((stop) => [caps.type, stop, caps] as const)
  );

  it.each(cases)('%s at stop %s', (_type, stop, caps) => {
    // The one translation of "seeded nothing": a NULL column means the runtime
    // decides, and what it decides is the default it declares. So the screen's
    // answer is the seed where there is one and the runtime's own default where
    // there is not — never a name the client made up.
    expect(displayedMode(caps, stop)).toBe(seededMode(caps, stop) ?? caps.permissionModes.default);
  });

  it('shows Full autonomy before the first message when that is the configured stop', () => {
    // The reported case, stated as itself rather than as a row in the table
    // above: `runtimes.defaultTrustStop: 'autonomy'`, no row, and a runtime
    // that declares a mode at that stop.
    for (const caps of PROFILES) {
      const autonomy = caps.permissionModes.values.find((d) => d.stop === 'autonomy');
      if (!autonomy) continue;
      expect(displayedMode(caps, 'autonomy')).toBe(autonomy.id);
      expect(seededMode(caps, 'autonomy')).toBe(autonomy.id);
      // And it is not the literal the client used to print — which is a real
      // assertion rather than a restatement, because every shipped runtime
      // except test-mode names a mode `'default'` and files it at the ASK stop.
      expect(displayedMode(caps, 'autonomy')).not.toBe('default');
    }
  });

  it('falls back to the runtime own default, never to the literal, at a stop it cannot take', () => {
    // A runtime that declares no mode at the configured stop contributes
    // nothing — the seed writes NULL and the turn runs at the runtime's own
    // default. The screen has to say that same thing, and saying `'default'`
    // would be a coincidence on three runtimes and a lie on test-mode.
    const noAutonomy = PROFILES.filter(
      (caps) => !caps.permissionModes.values.some((d) => d.stop === 'autonomy')
    );
    for (const caps of noAutonomy) {
      expect(seededMode(caps, 'autonomy')).toBeUndefined();
      expect(displayedMode(caps, 'autonomy')).toBe(caps.permissionModes.default);
    }
    // test-mode is the profile that makes the distinction visible at all: its
    // declared default is `always-allow`, an id no Claude-shaped list holds.
    expect(displayedMode(TEST_MODE_CAPABILITIES, null)).toBe('always-allow');
  });

  it('honours a per-runtime override over the global stop, on both sides', () => {
    // The tier the client reads out of `executionDefaults.perRuntime` and the
    // server reads out of `runtimes.<section>.defaultTrustStop`. They must pick
    // the same leaf, or a person who narrowed ONE runtime sees the global
    // answer on the dial and gets the narrow one in the turn.
    const caps = CLAUDE_CODE_CAPABILITIES;
    const seeded = resolveSessionDefaults({
      runtimeType: caps.type,
      runtimes: runtimes({
        defaultTrustStop: 'autonomy',
        claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultTrustStop: 'ask' },
      }),
      configSection: caps.settings.configSection,
      permissionModes: caps.permissionModes.values,
    }).permissionMode;
    // The client's `operatorStopForRuntime` resolves the same precedence off
    // the reported `executionDefaults` — per-runtime override, then global —
    // and hands the winner to the same mapping.
    expect(displayedMode(caps, 'ask')).toBe(seeded);
    expect(seeded).not.toBe(displayedMode(caps, 'autonomy'));
  });
});

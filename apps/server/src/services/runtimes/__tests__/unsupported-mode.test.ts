/**
 * DOR-4411: a chat set to a mode its runtime does not have never runs at the
 * agent's level. One rule for every runtime, in two places:
 *
 * - The API refuses the mode (`rejectUndeclaredPermissionMode`), asked of the
 *   runtime the chat runs on (`routes/sessions.ts`).
 * - A mode stored anyway is replaced with that runtime's strictest trust-axis
 *   mode when the chat is bound to it (`RuntimeRegistry.claimedPermissionMode`,
 *   via `strictestTrustModeId`), and runs at it under any ceiling that bounds
 *   the turn (`clampModeToCeiling`), never at the ceiling's loosest.
 *
 * QA's case was a Codex chat set to `plan` under a Full agent: accepted, then
 * bound at the configured stop, which is the agent's Full. The census walks every runtime in the capability matrix, so a
 * new runtime cannot skip the rule.
 */
import { describe, expect, it } from 'vitest';
import type { AgentRuntime, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import {
  ceilingOnlyRecords,
  clampModeToCeiling,
  isNoLooserThan,
  levelOfMode,
  strictestTrustModeId,
} from '@dorkos/shared/permission-semantics';
import { MATRIX_RUNTIMES, type MatrixRuntime } from '@dorkos/test-utils/runtime-capability-matrix';
import { rejectUndeclaredPermissionMode } from '../../../routes/session-model-gate.js';
import { CLAUDE_CODE_CAPABILITIES } from '../claude-code/runtime-constants.js';
import { CODEX_APP_SERVER_CAPABILITIES, CODEX_CAPABILITIES } from '../codex/runtime-constants.js';
import { DOE_CAPABILITIES } from '../doe/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../opencode/runtime-constants.js';
import { TEST_MODE_CAPABILITIES } from '../test-mode/runtime-constants.js';

/** Every runtime's declared modes; the type makes a new runtime join here. */
const RUNTIMES: Readonly<Record<MatrixRuntime, RuntimeCapabilities>> = {
  'claude-code': CLAUDE_CODE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
  opencode: OPENCODE_CAPABILITIES,
  doe: DOE_CAPABILITIES,
  'test-mode': TEST_MODE_CAPABILITIES,
};

/** Both Codex transports declare modes, so both are checked. */
const DECLARATIONS: ReadonlyArray<[string, RuntimeCapabilities]> = [
  ...Object.entries(RUNTIMES),
  ['codex (app-server)', { ...CODEX_CAPABILITIES, ...CODEX_APP_SERVER_CAPABILITIES }],
];

/** Every mode id any runtime declares, plus one none does. */
const ALL_IDS = [
  ...new Set([
    ...DECLARATIONS.flatMap(([, caps]) => caps.permissionModes.values.map((m) => m.id)),
    'retired-mode',
  ]),
];

/** A runtime that answers only what the mode gate asks of it. */
function runtimeOf(type: string, caps: RuntimeCapabilities): AgentRuntime {
  return { type, getCapabilities: () => caps } as unknown as AgentRuntime;
}

/** Whether `id` is a trust-axis mode no looser than any other the runtime declares. */
function isStrictestTrust(caps: RuntimeCapabilities, id: string): boolean {
  const trust = caps.permissionModes.values.filter((m) => m.axis !== 'working');
  const mode = trust.find((m) => m.id === id);
  return mode !== undefined && trust.every((other) => isNoLooserThan(other, mode));
}

describe('QA’s case: Plan on a Codex chat under a Full agent (DOR-4411)', () => {
  const codex = CODEX_CAPABILITIES.permissionModes;
  const full = levelOfMode(codex, 'bypassPermissions')!;

  it('is refused at the API with a clear error', () => {
    const error = rejectUndeclaredPermissionMode(runtimeOf('codex', CODEX_CAPABILITIES), 'plan');
    expect(error).toContain("cannot run permission mode 'plan'");
  });

  it('binds and runs at Codex’s strictest mode if it was stored anyway, never at Full', () => {
    expect(isStrictestTrust(CODEX_CAPABILITIES, strictestTrustModeId(codex)!)).toBe(true);
    expect(clampModeToCeiling(codex, 'plan', full)).not.toBe('bypassPermissions');
  });
});

describe('a ceiling below every trust mode keeps its fallback (Security M1 on #3770)', () => {
  const claude = CLAUDE_CODE_CAPABILITIES.permissionModes;
  const plan = levelOfMode(claude, 'plan')!;

  it('runs an unknown id on Claude at Plan under a sender in Plan, never at Default', () => {
    expect(clampModeToCeiling(claude, 'retired-mode', plan)).toBe('plan');
  });

  it('runs a declared mode the same way under that ceiling', () => {
    expect(clampModeToCeiling(claude, 'bypassPermissions', plan)).toBe('plan');
  });
});

describe('every runtime refuses and contains a mode it does not have (census)', () => {
  it('covers every runtime in the capability matrix', () => {
    expect(Object.keys(RUNTIMES).sort()).toEqual([...MATRIX_RUNTIMES].sort());
  });

  for (const [name, caps] of DECLARATIONS) {
    const declared = caps.permissionModes;
    const own = new Set(declared.values.map((m) => m.id));
    const missing = ALL_IDS.filter((id) => !own.has(id));

    it(`${name}: names a strictest mode a dropped one is replaced with`, () => {
      const strictest = strictestTrustModeId(declared);
      expect(strictest).toBeDefined();
      expect(isStrictestTrust(caps, strictest!)).toBe(true);
    });

    for (const id of missing) {
      it(`${name}: refuses '${id}' at the API`, () => {
        expect(rejectUndeclaredPermissionMode(runtimeOf(name, caps), id)).not.toBeNull();
      });

      it(`${name}: runs a stored '${id}' as its strictest mode would, under every bounding level`, () => {
        const strictest = strictestTrustModeId(declared)!;
        for (const level of declared.values) {
          const ceiling = levelOfMode(declared, level.id);
          // A Full ceiling bounds nothing and hands the id back; the runtime's
          // own mapping and the bind-time replacement answer for it.
          if (!ceiling || ceilingOnlyRecords(ceiling)) continue;
          expect(clampModeToCeiling(declared, id, ceiling)).toBe(
            clampModeToCeiling(declared, strictest, ceiling)
          );
        }
        expect(isStrictestTrust(caps, clampModeToCeiling(declared, id, 'runtime-default'))).toBe(
          true
        );
      });
    }
  }
});

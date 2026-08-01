/**
 * Every permission mode every runtime declares, run through the real derivation
 * rules — the test the client cannot write, because nothing under `apps/client`
 * can import a runtime's capability profile.
 *
 * Two jobs. First, the semantics must be complete and well-formed on every
 * declared mode, everywhere. Second — and this is the point of this file — the
 * rules must reach the SAME visible outcomes the id-keyed client tables reached
 * before they were deleted, so the substrate lands with nothing changing on
 * screen. The one deliberate exception is spelled out and pinned below.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionModeDescriptor, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { isBypassSemantics, warnTier, isDivergent } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../opencode/runtime-constants.js';
import { TEST_MODE_CAPABILITIES } from '../test-mode/runtime-constants.js';

/** Every runtime profile a DorkOS install can serve from `/api/capabilities`. */
const PROFILES: RuntimeCapabilities[] = [
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES,
  OPENCODE_CAPABILITIES,
  TEST_MODE_CAPABILITIES,
];

/** Every declared mode, tagged with the runtime that declared it. */
function declaredModes(): Array<[string, PermissionModeDescriptor]> {
  return PROFILES.flatMap((caps) =>
    caps.permissionModes.values.map(
      (descriptor) => [caps.type, descriptor] as [string, PermissionModeDescriptor]
    )
  );
}

/**
 * The mode ids the deleted `BYPASS_PERMISSION_MODES` set held — what the banner,
 * the scope note, and the status line's severity used to key off.
 */
const LEGACY_BYPASS_IDS = new Set(['bypassPermissions', 'always-allow']);

/** The mode ids the deleted `MODE_WARN` table tinted red in the picker. */
const LEGACY_WARN_IDS = new Set(['bypassPermissions', 'auto', 'always-allow']);

describe('declared permission-mode semantics', () => {
  it.each(declaredModes())('%s/%o carries complete, plain-language semantics', (_runtime, d) => {
    expect(['ask', 'act', 'autonomy']).toContain(d.stop);
    expect(['always', 'when-risky', 'never']).toContain(d.asks);
    expect(['read', 'edit', 'workspace', 'everything']).toContain(d.reach);
    expect(d.promise.trim().length).toBeGreaterThan(0);
  });

  it('never lets a runtime default to a stop that stops asking', () => {
    // The safety invariant the conformance suite enforces per runtime, asserted
    // here across the whole set so a new profile cannot slip in unnoticed.
    for (const caps of PROFILES) {
      const declaredDefault = caps.permissionModes.default;
      if (declaredDefault === undefined) continue;
      const descriptor = caps.permissionModes.values.find((v) => v.id === declaredDefault);
      expect(descriptor, `${caps.type} default must be a declared mode`).toBeDefined();
      if (caps.type === 'test-mode') {
        // The one waiver, declared in its conformance call: an always-allow
        // fixture is the entire purpose of the runtime.
        expect(descriptor!.stop).toBe('autonomy');
        continue;
      }
      expect(['ask', 'act'], `${caps.type} default stop`).toContain(descriptor!.stop);
    }
  });
});

describe('equivalence with the id tables it replaces', () => {
  it.each(declaredModes())(
    '%s/%o: isBypassSemantics agrees with the old bypass id list',
    (_runtime, d) => {
      expect(isBypassSemantics(d)).toBe(LEGACY_BYPASS_IDS.has(d.id));
    }
  );

  it.each(declaredModes())(
    '%s/%o: only the old bypass ids reach the danger tier',
    (_runtime, d) => {
      expect(warnTier(d) === 'danger').toBe(LEGACY_BYPASS_IDS.has(d.id));
    }
  );

  it.each(declaredModes())('%s/%o: nothing else earns the red tint', (_runtime, d) => {
    // The picker tints on `danger` alone in this change, so the set of red modes
    // is unchanged EXCEPT for Claude's `auto` — see the pinned exception below.
    const wasRed = LEGACY_WARN_IDS.has(d.id);
    const isRed = warnTier(d) === 'danger';
    if (d.id === 'auto') return;
    expect(isRed).toBe(wasRed);
  });

  it('drops the red tint on Claude’s auto mode, deliberately', () => {
    // The only visible difference this change makes. `auto` was red because it
    // sat in a hand-kept table of "modes that feel dangerous"; what it actually
    // does is let a classifier resolve the routine calls and raise an approval
    // card for the risky ones (`resolveModeDecision`). Red is reserved for the
    // one mode that never asks about anything, anywhere, and `auto` is not it —
    // marking it the same colour is what taught people to ignore the colour
    // (spec `trust-dial`, decision 3).
    const auto = CLAUDE_CODE_CAPABILITIES.permissionModes.values.find((v) => v.id === 'auto');
    expect(auto?.asks).toBe('when-risky');
    expect(warnTier(auto!)).toBe('none');
  });
});

describe('divergence', () => {
  it('flags Codex’s workspace-write, the mode that cannot pause to ask', () => {
    const workspaceWrite = CODEX_CAPABILITIES.permissionModes.values.find(
      (v) => v.id === 'acceptEdits'
    );
    expect(workspaceWrite?.native).toBe('workspace-write');
    expect(isDivergent(workspaceWrite!)).toBe(true);
    expect(workspaceWrite!.promise).toContain("can't pause to ask");
  });

  it('leaves every mode that keeps its stop’s promise unflagged', () => {
    // Everything Claude and OpenCode declare does what its position says.
    for (const caps of [CLAUDE_CODE_CAPABILITIES, OPENCODE_CAPABILITIES]) {
      for (const descriptor of caps.permissionModes.values) {
        expect(isDivergent(descriptor), `${caps.type}/${descriptor.id}`).toBe(false);
      }
    }
  });
});

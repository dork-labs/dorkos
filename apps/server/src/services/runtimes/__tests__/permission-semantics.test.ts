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
import {
  findWorkingMode,
  isAutonomyStop,
  isBypassSemantics,
  isDivergent,
  needsConsentRitual,
  resolveTrustStops,
} from '@dorkos/shared/permission-semantics';
import { PermissionModeIdSchema } from '@dorkos/shared/schemas';
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

/** The mode ids the deleted `MODE_WARN` table singled out in the picker. */
const LEGACY_MARKED_IDS = new Set(['bypassPermissions', 'auto', 'always-allow']);

describe('declared permission-mode semantics', () => {
  it.each(declaredModes())('%s/%o carries complete, plain-language semantics', (_runtime, d) => {
    expect(['ask', 'act', 'autonomy']).toContain(d.stop);
    expect(['always', 'when-risky', 'never']).toContain(d.asks);
    expect(['read', 'edit', 'workspace', 'everything']).toContain(d.reach);
    expect(d.promise.trim().length).toBeGreaterThan(0);
  });

  // THE PIN that makes the session-PATCH wire honest (DOR-811).
  //
  // `PATCH /api/sessions/:id` deliberately does not validate `permissionMode`
  // against a fixed enum — a runtime names its own modes, so the wire takes any
  // id matching `PermissionModeIdSchema` and the owning runtime's declaration
  // decides the rest. That only holds if every id a runtime CAN declare fits
  // through the wire. `PermissionModeDescriptor.id` is a plain `string` and
  // nothing else checks it, so a future profile naming a mode `_internal`,
  // `read only`, or something 65 characters long would be refused with a
  // shape error before its own runtime was ever consulted — the exact DOR-811
  // defect, moved from an enum to a regex.
  //
  // So the shape is a CONTRACT on declared ids, and this is where it is
  // enforced. A new profile that breaks it fails here, next to the rest of its
  // descriptor contract, instead of at a route somebody has to reproduce.
  it.each(declaredModes())('%s/%o declares an id the session PATCH wire accepts', (runtime, d) => {
    const parsed = PermissionModeIdSchema.safeParse(d.id);
    expect(
      parsed.success,
      `${runtime} declares mode id '${d.id}', which PATCH /api/sessions/:id would ` +
        `refuse as malformed before asking ${runtime} about it. Mode ids must match ` +
        `PermissionModeIdSchema (1-64 chars, alphanumeric start, then [A-Za-z0-9_.-]).`
    ).toBe(true);
  });

  it('never lets a runtime be BORN in a mode that never asks', () => {
    // The safety invariant the conformance suite enforces per runtime, asserted
    // here across the whole set so a new profile cannot slip in unnoticed.
    //
    // Asserted through `needsConsentRitual`, NOT against the set of stops. A
    // session born at its runtime's default never PATCHes and so never meets the
    // consent door — this is the only thing standing between a person and an
    // agent that starts without asking. Checking `stop` instead left the exact
    // hole DOR-816 closed everywhere else: a profile defaulting to
    // `{ stop: 'act', asks: 'never', reach: 'workspace' }` is not an autonomy
    // stop, so it passed, and no door exists on that path to catch it.
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
      expect(
        needsConsentRitual(descriptor!),
        `${caps.type} defaults to '${declaredDefault}', a mode that never asks — a session ` +
          'born there passes no door and consents to nothing'
      ).toBe(false);
    }
  });

  it('still lets a runtime be born read-only, though that never asks either', () => {
    // Codex's default is `asks: 'never'` because it can only read. The invariant
    // above must not be readable as "never say never": it is about being born
    // able to ACT without asking, which is why it goes through the predicate
    // rather than through `asks` alone.
    const codexDefault = CODEX_CAPABILITIES.permissionModes.values.find(
      (v) => v.id === CODEX_CAPABILITIES.permissionModes.default
    );
    expect(codexDefault?.asks).toBe('never');
    expect(codexDefault?.reach).toBe('read');
    expect(needsConsentRitual(codexDefault!)).toBe(false);
  });
});

describe('equivalence with the id tables it replaces', () => {
  it.each(declaredModes())(
    '%s/%o: isBypassSemantics agrees with the old bypass id list',
    (_runtime, d) => {
      expect(isBypassSemantics(d)).toBe(LEGACY_BYPASS_IDS.has(d.id));
    }
  );

  it.each(declaredModes())('%s/%o: nothing else is marked as never-asking', (_runtime, d) => {
    // The set of marked modes is the old hand-kept table EXCEPT for Claude's
    // `auto` — see the pinned exception below.
    if (d.id === 'auto') return;
    expect(isBypassSemantics(d)).toBe(LEGACY_MARKED_IDS.has(d.id));
  });

  it('stops marking Claude’s auto mode, deliberately', () => {
    // The only visible difference this change makes. `auto` was marked because
    // it sat in a hand-kept table of "modes that feel dangerous"; what it
    // actually does is let a classifier resolve the routine calls and raise an
    // approval card for the risky ones (`resolveModeDecision`). A mode that
    // still stops for the person is not one that never asks, and marking it the
    // same as one that does is what taught people to ignore the mark
    // (spec `trust-dial`, decision 3).
    const auto = CLAUDE_CODE_CAPABILITIES.permissionModes.values.find((v) => v.id === 'auto');
    expect(auto?.asks).toBe('when-risky');
    expect(isBypassSemantics(auto!)).toBe(false);
  });
});

describe('the consent door’s reach across every runtime', () => {
  // The one rule the server's session PATCH applies to decide whether a mode
  // change needs the person's acknowledgement (spec `trust-dial`, decision 5,
  // widened 2026-08-01 by DOR-816). Asserted here, over real profiles, because a
  // door that misses a runtime's never-asking mode is a door that is not there.

  it.each(declaredModes())(
    '%s/%o: the door asks first about every mode that never asks and can act',
    (_runtime, d) => {
      // Read this as COVERAGE, not as a guard: the expectation restates the
      // implementation, so an edit to the predicate that also edits this line
      // stays green. What it buys is that every mode of every shipped profile
      // is run through the real function, so a new profile whose semantics
      // nobody thought about is at least evaluated here. The guards with teeth
      // are the value-pinned cases below — Codex's middle stop, the read-only
      // default, and the birth invariant — which name an answer this line
      // cannot follow.
      const expected = d.stop === 'autonomy' || (d.asks === 'never' && d.reach !== 'read');
      expect(needsConsentRitual(d)).toBe(expected);
    }
  );

  it('gates Codex’s middle stop, which the autonomy-stop rule missed', () => {
    // THE PIN for DOR-816. `workspace-write` sits at the middle stop and runs
    // shell commands with no way to pause and ask; before the widening it
    // entered with no ritual at all, disclosed only by the amber caption.
    const [readOnly, workspaceWrite, fullAccess] = CODEX_CAPABILITIES.permissionModes.values;
    expect(needsConsentRitual(workspaceWrite!)).toBe(true);
    expect(isAutonomyStop(workspaceWrite!), 'it is not at the autonomy stop').toBe(false);
    // The other two, for contrast: read-only never asks and is left alone
    // because it has nothing to ask about; full access was always gated.
    expect(needsConsentRitual(readOnly!)).toBe(false);
    expect(needsConsentRitual(fullAccess!)).toBe(true);
  });

  it('leaves every mode that still stops for the person alone', () => {
    for (const [runtime, d] of declaredModes()) {
      if (d.asks === 'never') continue;
      expect(needsConsentRitual(d), `${runtime}/${d.id}`).toBe(false);
    }
  });

  it('finds exactly one autonomy mode in every profile that has one', () => {
    for (const caps of PROFILES) {
      const autonomy = caps.permissionModes.values.filter(isAutonomyStop);
      // Two modes at one stop is a shape `resolveTrustStops` already handles by
      // demoting the second to a refinement — but the door has to gate BOTH, and
      // nothing today declares two. Pinned so the day one does, this is read.
      expect(autonomy.length, `${caps.type} autonomy modes`).toBeLessThanOrEqual(1);
    }
  });

  it.each(declaredModes())(
    '%s/%o: the door gates exactly the modes the dial puts at the autonomy stop',
    (_runtime, d) => {
      const stops = resolveTrustStops(
        PROFILES.find((c) => c.permissionModes.values.includes(d))!.permissionModes.values
      );
      const atAutonomy = stops.some((s) => s.stop === 'autonomy' && s.mode.id === d.id);
      expect(isAutonomyStop(d)).toBe(atAutonomy);
    }
  );

  it('gates a sandboxed autonomy stop too, where the danger tier would not', () => {
    // The two rules answer different questions and must not be conflated. A mode
    // that never asks but cannot leave the workspace earns `caution`, not
    // `danger` — and still gets the door, because the door is about the position
    // a person is choosing, not how far the blast reaches.
    const sandboxedAutonomy: PermissionModeDescriptor = {
      id: 'sandboxed-autonomy',
      label: 'Sandboxed autonomy',
      stop: 'autonomy',
      asks: 'never',
      reach: 'workspace',
      promise: 'Works inside the project without asking.',
    };
    expect(isAutonomyStop(sandboxedAutonomy)).toBe(true);
    expect(isBypassSemantics(sandboxedAutonomy)).toBe(false);
  });
});

describe('divergence', () => {
  /**
   * The pair that defines what divergence means — read both before changing
   * `isDivergent`, and before the caption PR decides where its amber goes.
   *
   * Codex declares `asks: 'never'` on BOTH of these modes, so plain inequality
   * against the stop's expectation flags both. Only one of them is a broken
   * promise. `workspace-write` runs shell commands the middle stop said it would
   * pause for; `read-only` "never asks" because it cannot write, run, or reach
   * the network — there is nothing to ask about. Ambering the safest setting on
   * offer is how a caption stops being read, so a mode that cannot act cannot
   * break an asking promise.
   */
  it.each([
    ['acceptEdits', true, 'runs commands the middle stop promised to pause for'],
    ['default', false, 'read-only: nothing to ask about, so no promise to break'],
  ])('codex/%s divergent=%s — %s', (id, expected) => {
    const descriptor = CODEX_CAPABILITIES.permissionModes.values.find((v) => v.id === id);
    expect(descriptor, `codex must declare ${id}`).toBeDefined();
    expect(descriptor!.asks, 'both of these declare never — that is the whole point').toBe('never');
    expect(isDivergent(descriptor!)).toBe(expected);
  });

  it('flags Codex’s workspace-write with a promise that says so in plain words', () => {
    const workspaceWrite = CODEX_CAPABILITIES.permissionModes.values.find(
      (v) => v.id === 'acceptEdits'
    );
    expect(workspaceWrite?.native).toBe('workspace-write');
    expect(workspaceWrite!.promise).toContain("can't pause to ask");
  });

  it('never flags a mode for asking MORE often than its position promised', () => {
    // Over-delivering on safety is not a surprise a caption has to warn about.
    expect(
      isDivergent({
        id: 'cautious',
        label: 'Cautious',
        stop: 'autonomy',
        asks: 'always',
        reach: 'everything',
        promise: 'Asks anyway.',
      })
    ).toBe(false);
  });

  it('leaves every mode that keeps its stop’s promise unflagged', () => {
    // Everything Claude and OpenCode declare does what its position says.
    for (const caps of [CLAUDE_CODE_CAPABILITIES, OPENCODE_CAPABILITIES]) {
      for (const descriptor of caps.permissionModes.values) {
        expect(isDivergent(descriptor), `${caps.type}/${descriptor.id}`).toBe(false);
      }
    }
  });

  it('leaves Codex’s full access unflagged — it never claimed it would ask', () => {
    const fullAccess = CODEX_CAPABILITIES.permissionModes.values.find(
      (v) => v.id === 'bypassPermissions'
    );
    expect(isDivergent(fullAccess!)).toBe(false);
  });
});

describe('the dial every runtime can offer', () => {
  /** `stop → mode id` for one runtime, as `resolveTrustStops` resolves it. */
  function dial(caps: RuntimeCapabilities): Array<[string, string]> {
    return resolveTrustStops(caps.permissionModes.values).map((s) => [s.stop, s.mode.id]);
  }

  it('gives each runtime the stops it can actually take, and the mode behind each', () => {
    // The shipped mapping, in one place, checkable against the profiles rather
    // than against a table in the client that nobody can compare to a runtime.
    expect(dial(CLAUDE_CODE_CAPABILITIES)).toEqual([
      ['ask', 'default'],
      ['act', 'acceptEdits'],
      ['autonomy', 'bypassPermissions'],
    ]);
    expect(dial(CODEX_CAPABILITIES)).toEqual([
      ['ask', 'default'],
      ['act', 'acceptEdits'],
      ['autonomy', 'bypassPermissions'],
    ]);
    expect(dial(OPENCODE_CAPABILITIES)).toEqual([
      ['ask', 'default'],
      ['act', 'acceptEdits'],
      ['autonomy', 'bypassPermissions'],
    ]);
    expect(dial(TEST_MODE_CAPABILITIES)).toEqual([
      ['ask', 'always-deny'],
      ['act', 'scripted'],
      ['autonomy', 'always-allow'],
    ]);
  });

  it('keeps Claude’s auto inside the middle stop instead of beside it', () => {
    const act = resolveTrustStops(CLAUDE_CODE_CAPABILITIES.permissionModes.values).find(
      (s) => s.stop === 'act'
    );
    expect(act?.mode.id).toBe('acceptEdits');
    expect(act?.refinements.map((d) => d.id)).toEqual(['auto']);
  });

  it('takes plan off the dial and offers it as the way of working it is', () => {
    const stops = resolveTrustStops(CLAUDE_CODE_CAPABILITIES.permissionModes.values);
    expect(stops.flatMap((s) => [s.mode.id, ...s.refinements.map((d) => d.id)])).not.toContain(
      'plan'
    );
    expect(findWorkingMode(CLAUDE_CODE_CAPABILITIES.permissionModes.values)?.id).toBe('plan');
  });

  it('leaves every other runtime with no way of working to offer', () => {
    for (const caps of [CODEX_CAPABILITIES, OPENCODE_CAPABILITIES, TEST_MODE_CAPABILITIES]) {
      expect(findWorkingMode(caps.permissionModes.values), caps.type).toBeUndefined();
    }
  });

  it('never leaves a runtime with a stop it declares two trust modes for by accident', () => {
    // A second mode at a stop is a REFINEMENT — a switch inside the stop, which
    // something has to render. Claude's `auto` is the only one that ships, so a
    // new one showing up here is a UI decision, not a data detail.
    const refined = PROFILES.flatMap((caps) =>
      resolveTrustStops(caps.permissionModes.values)
        .filter((s) => s.refinements.length > 0)
        .map((s) => `${caps.type}/${s.stop}`)
    );
    expect(refined).toEqual(['claude-code/act']);
  });
});

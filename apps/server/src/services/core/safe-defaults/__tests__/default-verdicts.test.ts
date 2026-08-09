import { describe, it, expect } from 'vitest';
import { USER_CONFIG_DEFAULTS, UserConfigSchema } from '@dorkos/shared/config-schema';
import {
  NO_RISK_DEFAULTS,
  SAFE_DEFAULTS,
  PERMISSIVE_DEFAULTS,
  verdictFor,
  recordedDefaultFor,
} from '../default-verdicts.js';
import { PROTECTIVE_CARRYOVERS } from '../protected-state.js';
import { configSchemaLeafPaths } from '../../operator/config-disclosure.js';

/** Read a dot-path out of an object. `[]` hops are array elements, not read. */
function readAt(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const part of path.split('.')) {
    if (part.endsWith('[]')) return undefined;
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/**
 * The default a leaf gets when its whole SECTION is absent.
 *
 * This is `USER_CONFIG_DEFAULTS`, which every section supplies through an
 * object-level `.default(() => ({ ... }))` literal.
 */
function objectLevelDefault(path: string): unknown {
  return readAt(USER_CONFIG_DEFAULTS, path);
}

/**
 * The default a leaf gets when its section is PRESENT but the leaf is absent —
 * which is a different code path with a different source of truth.
 *
 * Each section declares its defaults twice: once per field
 * (`install: z.boolean().default(false)`) and once as an object-level literal.
 * Parsing `{ version: 1 }` only ever fires the literal, so a per-field
 * `.default(...)` can be flipped without moving `USER_CONFIG_DEFAULTS` at all.
 *
 * Both are live, at different moments. The literal feeds a FRESH install. The
 * per-field defaults govern what an EXISTING install observes on READ: they are
 * what `z.toJSONSchema` emits, so conf's Ajv fills them in when a stored section
 * is missing a key, and `get('telemetry')` on a file holding only
 * `{"userHasDecided": true}` hands back all eight leaves. Note it is a read-time
 * fill, not a write-back — conf's `Object.assign` shares the section object, so
 * the `deepEqual` short-circuit means the file on disk keeps its sparse shape.
 * That makes the per-field default the value every consumer actually sees.
 *
 * Checking only one source would miss half the drift, so the guard reads both
 * and requires them to agree with each other and with the recorded verdict.
 */
function fieldLevelDefault(path: string): unknown {
  const [section, ...rest] = path.split('.');
  if (section === undefined || rest.length === 0) return objectLevelDefault(path);
  const parsed = UserConfigSchema.safeParse({ version: 1, [section]: {} });
  if (!parsed.success) return objectLevelDefault(path);
  return readAt(parsed.data, path);
}

/**
 * The drift guard. It exists so the safe-defaults principle can be FAILED: a
 * config field added without a stated verdict, or an existing default flipped
 * underneath its verdict, turns this file red at the moment it happens rather
 * than at the next audit.
 */
describe('config default verdicts cover the whole schema', () => {
  const leaves = configSchemaLeafPaths();
  const classified = [
    ...NO_RISK_DEFAULTS,
    ...Object.keys(SAFE_DEFAULTS),
    ...Object.keys(PERMISSIVE_DEFAULTS),
  ];

  it('classifies every leaf of UserConfigSchema', () => {
    const missing = leaves.filter((path) => verdictFor(path) === undefined);
    expect(
      missing,
      `Unclassified config default(s). Every default must state what it does for the person who ` +
        `never touches it. Add each path to NO_RISK_DEFAULTS, SAFE_DEFAULTS, or PERMISSIVE_DEFAULTS ` +
        `(with a reason) in safe-defaults/default-verdicts.ts:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });

  it('classifies nothing that is not a leaf — a rename must not leave a stale verdict', () => {
    const known = new Set(leaves);
    const stale = classified.filter((path) => !known.has(path));
    expect(
      stale,
      `Verdict(s) for path(s) that no longer exist in UserConfigSchema:\n  ${stale.join('\n  ')}`
    ).toEqual([]);
  });

  it('gives each leaf exactly one verdict', () => {
    const seen = new Set<string>();
    const duplicates = classified.filter((path) =>
      seen.has(path) ? true : (seen.add(path), false)
    );
    expect(duplicates, `Path(s) classified twice:\n  ${duplicates.join('\n  ')}`).toEqual([]);
  });

  /**
   * The assertion that makes this registry more than a string lookup. Without
   * it, flipping `telemetry.install` back to `.default(true)` while leaving it
   * in SAFE_DEFAULTS stays green — and a one-line default flip is likelier
   * drift than a new field, and is the exact defect class this exists to catch.
   */
  it('fails when a real default drifts away from the value its verdict recorded', () => {
    const drifted: string[] = [];
    for (const path of [...Object.keys(SAFE_DEFAULTS), ...Object.keys(PERMISSIVE_DEFAULTS)]) {
      const recorded = recordedDefaultFor(path);
      if (!recorded) continue;
      const want = JSON.stringify(recorded.value);
      // Both sources, because a section declares its defaults twice and either
      // one can be flipped on its own.
      const whenSectionAbsent = JSON.stringify(objectLevelDefault(path));
      const whenSectionPresent = JSON.stringify(fieldLevelDefault(path));
      if (whenSectionAbsent !== want) {
        drifted.push(`${path}: verdict records ${want}, fresh install gets ${whenSectionAbsent}`);
      } else if (whenSectionPresent !== want) {
        drifted.push(
          `${path}: verdict records ${want}, but the per-field .default() gives ${whenSectionPresent} ` +
            `(the object-level literal and the field default disagree)`
        );
      }
    }
    expect(
      drifted,
      `A config default changed without its verdict being revisited. Decide whether the new ` +
        `default is still 'safe' or is now 'permissive' (and needs a reason and probably a ` +
        `carryover rule), then update the recorded value:\n  ${drifted.join('\n  ')}`
    ).toEqual([]);
  });

  it('makes every permissive default carry a real argument', () => {
    for (const [path, entry] of Object.entries(PERMISSIVE_DEFAULTS)) {
      expect(
        entry.reason.length,
        `${path}: a permissive default needs a stated reason`
      ).toBeGreaterThan(60);
    }
  });

  it('keeps the permissive list short enough to actually read', () => {
    // Not a style rule. A registry where the permissive list has grown to
    // dozens of entries has stopped being a set of reviewed trades and become
    // a rubber stamp, which is the failure mode this whole mechanism has.
    expect(Object.keys(PERMISSIVE_DEFAULTS).length).toBeLessThanOrEqual(15);
  });
});

/**
 * Permissive leaves this deliberately does not carry across a wipe, and why.
 *
 * The carryover rules speak `boolean` / `lower` / `higher` / `later`, so a
 * permissive enum, array, or free string cannot be expressed as one today.
 * Naming them here rather than letting the assertion below skip them silently is
 * the point: the gap is recorded, not hidden.
 *
 * An exemption is for a leaf where no direction is more protective — never for
 * one whose direction the union happens not to speak yet.
 * `welcomeBack.absenceThresholdMinutes` was listed here on first writing and was
 * wrong for it: someone who set a week and lands back on four hours loses a real
 * protection, so the union grew `higher` and the leaf moved to
 * PROTECTIVE_CARRYOVERS where it belonged.
 */
const CARRYOVER_EXEMPT: Readonly<Record<string, string>> = {
  'uploads.allowedTypes':
    'An array of MIME globs. "More protective" is a subset test the carryover directions cannot express. The size and count caps are the real bound, and both of those DO carry across a wipe.',
  'mcp.rateLimit.windowSecs':
    'Lower is not more protective here: a shorter window with the same request count allows MORE traffic, not less. The count (`maxPerWindow`) is the bound that carries.',
  'scheduler.maxConcurrentRuns':
    'Ships at its schema minimum (1), so there is nothing below the default for a person to tighten to.',
  'rooms.replyWaitMinutes':
    'How long a room waits before carrying on without an answer. Neither direction is more protective: the turn runs either way, and the answer is posted late rather than dropped, so a shorter wait costs nothing and a longer one spends nothing.',
  'rooms.lateReplyCeilingMinutes':
    'When a room stops listening to a turn that never closes. Bounds a subscription, not a spend, so lower is tidier rather than safer. The `maxAutomaticTurns*` caps are the bounds that carry.',
};

describe('verdicts and wipe-carryover agree', () => {
  it('only carries leaves that can actually lose something', () => {
    // A carryover rule for a no-risk leaf is protecting a preference.
    for (const entry of PROTECTIVE_CARRYOVERS) {
      const verdict = verdictFor(entry.path);
      expect(
        verdict,
        `${entry.path} has a carryover rule but verdict "${verdict}". A carryover only makes ` +
          `sense where the default sits on the permissive side, or where a person can tighten ` +
          `a bound below it.`
      ).not.toBe('no-risk');
    }
  });

  /**
   * Replaces an earlier test that filtered PERMISSIVE_DEFAULTS for a
   * `telemetry.` prefix — a filter that became empty once those channels moved
   * to SAFE_DEFAULTS, so its loop body stopped running and it certified
   * nothing. This one iterates the whole permissive list, so it cannot go
   * vacuous without the list itself being empty.
   */
  it('carries every permissive default a person could have turned off', () => {
    const carried = new Set(PROTECTIVE_CARRYOVERS.map((entry) => entry.path));
    const unprotected = Object.keys(PERMISSIVE_DEFAULTS).filter(
      (path) => !carried.has(path) && !Object.hasOwn(CARRYOVER_EXEMPT, path)
    );
    expect(
      unprotected,
      `Permissive default(s) with no carryover rule: a person who moved these to the protective ` +
        `side would silently lose that on a config wipe. Add a rule to PROTECTIVE_CARRYOVERS, or ` +
        `record why one cannot be expressed in CARRYOVER_EXEMPT:\n  ${unprotected.join('\n  ')}`
    ).toEqual([]);
  });

  /**
   * The other half of completeness, and the half that was missing.
   *
   * A `safe` verdict means the default IS the protective option — but for a
   * numeric bound that only means it is a real limit, not that it is the
   * tightest one a person might want. `rooms.maxAgentDepth` ships at 3 and is
   * `safe`, and someone who set it to 1 still loses that on a wipe unless a rule
   * carries it. Iterating only PERMISSIVE_DEFAULTS could never see them, which
   * is how `uploads.maxFileSize`, `uploads.maxFiles` and
   * `mcp.rateLimit.maxPerWindow` were silently loosened by every recovery.
   *
   * Numeric-ness is read off the recorded default, so a new tightenable bound is
   * caught by this guard rather than by a reviewer.
   */
  it('carries every safe numeric bound a person could have tightened', () => {
    const carried = new Set(PROTECTIVE_CARRYOVERS.map((entry) => entry.path));
    const unprotected = Object.entries(SAFE_DEFAULTS)
      .filter(([, value]) => typeof value === 'number')
      .map(([path]) => path)
      .filter((path) => !carried.has(path) && !Object.hasOwn(CARRYOVER_EXEMPT, path));
    expect(
      unprotected,
      `Numeric bound(s) with no carryover rule. A "safe" default is a real limit, but a person ` +
        `can set a tighter one, and a config wipe would silently loosen it back. Add a ` +
        `'lower'- or 'higher'-direction rule to PROTECTIVE_CARRYOVERS (a cap tightens by going ` +
        `down, a threshold by going up), or record in CARRYOVER_EXEMPT why neither direction is ` +
        `more protective for this field:\n  ${unprotected.join('\n  ')}`
    ).toEqual([]);
  });

  it('exempts nothing that is neither permissive nor a safe numeric bound', () => {
    for (const path of Object.keys(CARRYOVER_EXEMPT)) {
      const verdict = verdictFor(path);
      const isSafeNumber = verdict === 'safe' && typeof SAFE_DEFAULTS[path] === 'number';
      expect(
        verdict === 'permissive' || isSafeNumber,
        `${path} is exempted from carryover but is neither a permissive default nor a safe ` +
          `numeric bound, so there is nothing for the exemption to be about`
      ).toBe(true);
    }
  });
});

/**
 * Drift guard + matching tests for the agent-facing manifest WRITE allowlist.
 *
 * The point of this file is the guard: it compares {@link AGENT_WRITE_POLICY}
 * against the live leaves of `UpdateAgentRequestSchema` and
 * `UpdateAgentConventionsSchema` in **both** directions, so widening either
 * schema fails until someone gives the new field a verdict. That is the defect
 * generator this table exists to close — a field added to the `.pick(...)` list
 * became agent-writable the moment it existed, with no decision anywhere, which
 * is how the four `enabledToolGroups` documentation keys stayed writable while
 * their global twins were refused (DOR-1506).
 *
 * The second guard is the one a reviewer reads: the operator-only SET is
 * asserted item by item, so moving a field across the line has to break a test.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  UpdateAgentRequestSchema,
  UpdateAgentConventionsSchema,
} from '@dorkos/shared/mesh-schemas';
import { classifySchemaLeaves } from '../config-disclosure.js';
import {
  AGENT_OPERATOR_ONLY_STAKES,
  AGENT_WRITE_POLICY,
  OPERATOR_ONLY_AGENT_PATHS,
  TIGHTEN_ONLY_AGENT_PATHS,
  describeAgentOperatorOnlyRefusal,
  findOperatorOnlyAgentPaths,
} from '../agent-write-policy.js';

/** Every leaf an agent can reach on this seam, from the two live schemas. */
function agentWriteLeafPaths(): string[] {
  const leaves = [UpdateAgentRequestSchema, UpdateAgentConventionsSchema].flatMap((schema) =>
    classifySchemaLeaves(z.toJSONSchema(schema, { target: 'jsonSchema2019-09' }))
  );
  // The two schemas overlap on `traits` and `conventions`, which ride the same
  // PATCH body: one verdict each, not two.
  return [...new Set(leaves.map((leaf) => leaf.path))];
}

describe('AGENT_WRITE_POLICY drift guard', () => {
  it('classifies every leaf an agent can reach on its own manifest', () => {
    // Direction A: a newly picked manifest field must not become agent-writable
    // just by existing. The failure names the offenders so the fix is "add a
    // verdict", not "go hunting".
    const unclassified = agentWriteLeafPaths().filter((path) => !(path in AGENT_WRITE_POLICY));
    expect(unclassified).toEqual([]);
  });

  it('classifies nothing that is not on the wire', () => {
    // Direction B: a renamed or removed field must not leave a stale verdict
    // behind, which would silently stop covering the field that replaced it.
    const onTheWire = new Set(agentWriteLeafPaths());
    const stale = Object.keys(AGENT_WRITE_POLICY).filter((path) => !onTheWire.has(path));
    expect(stale).toEqual([]);
  });

  it('reports no leaf the walk could not classify', () => {
    // A shape the path language cannot express (a tuple, an open record) would
    // be classified `unsupported`, and a verdict on a path nobody can reach is
    // no verdict at all. Nothing on this wire is such a shape today; a field
    // that introduces one has to be dealt with rather than waved through.
    const shapes = [UpdateAgentRequestSchema, UpdateAgentConventionsSchema].flatMap((schema) =>
      classifySchemaLeaves(z.toJSONSchema(schema, { target: 'jsonSchema2019-09' }))
    );
    expect(shapes.filter((leaf) => leaf.shape === 'unsupported')).toEqual([]);
  });

  it('holds exactly this set of operator-only manifest fields', () => {
    // The classification itself is asserted, not just the behavior. Moving any
    // of these to `agent-writable` hands an agent a decision about itself.
    expect([...OPERATOR_ONLY_AGENT_PATHS].sort()).toEqual(
      [
        // Whose subscription the agent's work bills to (spec
        // `billing-account-ladder` invariant 4).
        'account',
        // Whether the agent speaks in a room without being asked, and how readily
        // it escalates — the stake `rooms.responseGate` carries at the config seam.
        'behavior.escalationThreshold',
        'behavior.responseMode',
        // The four documentation keys, refused because a per-agent value BEATS the
        // global `agentContext.*` switch a person set, and those four are
        // operator-only at the config seam (DOR-1497 → DOR-1506).
        'enabledToolGroups.adapter',
        'enabledToolGroups.mesh',
        'enabledToolGroups.relay',
        'enabledToolGroups.tasks',
        // The one real grant of the five (DOR-1611).
        'enabledToolGroups.roomsManage',
        // The slug every other agent addresses this one by.
        'name',
        // Which other agents this one can reach.
        'namespace',
      ].sort()
    );
  });

  it('leaves the tier ceiling as the only direction-shaped verdict', () => {
    // `updateAgentManifest` enforces the direction with a comparison written for
    // this one field. A second `tighten-only` entry needs its own comparison
    // there, so it has to break here first.
    expect([...TIGHTEN_ONLY_AGENT_PATHS]).toEqual(['tierCeiling']);
  });

  it('keeps every field an agent legitimately edits about itself writable', () => {
    // The mirror of the guard above: refusing more than the line justifies makes
    // self-edit useless, and these are the fields the cockpit's own profile
    // pages write through this route.
    for (const path of [
      'displayName',
      'description',
      'runtime',
      'capabilities',
      'model',
      'effort',
      'color',
      'icon',
      'traits.humor',
      'conventions.soul',
      'soulContent',
      'memoryContent',
    ]) {
      expect(AGENT_WRITE_POLICY[path as keyof typeof AGENT_WRITE_POLICY]).toBe('agent-writable');
    }
  });

  it('gives every operator-only field a stake sentence', () => {
    // The fallback exists so an unclaimed field is still refused with words, but
    // a field nobody wrote a sentence for gets a generic one — which is how a
    // refusal stops telling a caller where the setting actually lives.
    const claimed = new Set(AGENT_OPERATOR_ONLY_STAKES.flatMap((stake) => stake.paths));
    expect(OPERATOR_ONLY_AGENT_PATHS.filter((path) => !claimed.has(path))).toEqual([]);
  });

  it('names no path in a stake group that is not operator-only', () => {
    const operatorOnly = new Set(OPERATOR_ONLY_AGENT_PATHS);
    const stray = AGENT_OPERATOR_ONLY_STAKES.flatMap((stake) => stake.paths).filter(
      (path) => !operatorOnly.has(path)
    );
    expect(stray).toEqual([]);
  });
});

describe('findOperatorOnlyAgentPaths', () => {
  it('finds a nested field the caller named exactly', () => {
    expect(findOperatorOnlyAgentPaths({ enabledToolGroups: { relay: true } })).toEqual([
      'enabledToolGroups.relay',
    ]);
  });

  it('catches an ancestor write, so emptying the object is not a way past it', () => {
    // `{ enabledToolGroups: {} }` names no key and still replaces all five.
    expect(findOperatorOnlyAgentPaths({ enabledToolGroups: {} }).sort()).toEqual(
      [
        'enabledToolGroups.adapter',
        'enabledToolGroups.mesh',
        'enabledToolGroups.relay',
        'enabledToolGroups.roomsManage',
        'enabledToolGroups.tasks',
      ].sort()
    );
  });

  /**
   * The shape the first version of this matrix never tried, found by adversarial
   * review and reproduced against a real manifest before the fix.
   *
   * The walk emits LEAVES, so `{ enabledToolGroups: {} }` was caught (it stops
   * above the guarded leaves and matches them as an ancestor) while
   * `{ enabledToolGroups: { zzz: 1 } }` was not — `enabledToolGroups.zzz` equals
   * no policy key, sits under none, and sits above none. And that patch WRITES:
   * Zod strips the unknown key, the raw body still names `enabledToolGroups`, and
   * the merge REPLACES the stored object. Measured before the fix: 200, `{}` on
   * disk, `roomsManage: true` gone.
   */
  describe('an object carrying only keys nobody classified', () => {
    it('refuses every leaf it would have replaced', () => {
      expect(findOperatorOnlyAgentPaths({ enabledToolGroups: { zzz: 1 } }).sort()).toEqual(
        [
          'enabledToolGroups.adapter',
          'enabledToolGroups.mesh',
          'enabledToolGroups.relay',
          'enabledToolGroups.roomsManage',
          'enabledToolGroups.tasks',
        ].sort()
      );
    });

    it('catches a nested __proto__ key, which arrives as an own key over HTTP', () => {
      // `JSON.parse` makes it an own, enumerable property — the shape Express
      // hands the route — where the object literal `{ __proto__: {…} }` instead
      // sets the prototype and leaves an empty object, which was already caught.
      const body: unknown = JSON.parse('{"enabledToolGroups":{"__proto__":{"relay":true}}}');

      expect(findOperatorOnlyAgentPaths(body)).toContain('enabledToolGroups.relay');
    });

    it('catches it on `behavior`, where the schema default is the permissive one', () => {
      // Worse in kind than the tool groups: `AgentBehaviorSchema` defaults
      // `responseMode`, so the replacing write re-armed `always` — the most
      // permissive setting there is — and dropped `escalationThreshold`.
      expect(findOperatorOnlyAgentPaths({ behavior: { zzz: 1 } }).sort()).toEqual([
        'behavior.escalationThreshold',
        'behavior.responseMode',
      ]);
    });

    it('still lets an unknown key through above fields nobody guards', () => {
      // The rule is scoped by the TABLE, not by the shape: `traits` holds no
      // operator-only leaf, so an unrecognised key under it is somebody else's
      // problem (it replaces the object with schema defaults — the same
      // whole-object write every `traits` patch does) and not a refusal here.
      expect(findOperatorOnlyAgentPaths({ traits: { zzz: 1 } })).toEqual([]);
    });

    it('adds no ancestor for a top-level unknown key, because it writes nothing', () => {
      // There is nothing above it, and `updateAgentManifest` intersects the parse
      // result with the raw keys — an undeclared top-level key survives neither.
      expect(findOperatorOnlyAgentPaths({ zzz: 1, displayName: 'Warden' })).toEqual([]);
    });
  });

  it('catches a field whatever its value, including null and undefined', () => {
    for (const value of [true, false, null, undefined]) {
      expect(findOperatorOnlyAgentPaths({ account: value })).toEqual(['account']);
    }
  });

  it('finds nothing in a patch of ordinary settings', () => {
    expect(
      findOperatorOnlyAgentPaths({
        displayName: 'Warden',
        traits: { humor: 5 },
        soulContent: 'Be careful.',
      })
    ).toEqual([]);
  });

  it('touches nothing for a non-object body', () => {
    expect(findOperatorOnlyAgentPaths(null)).toEqual([]);
    expect(findOperatorOnlyAgentPaths('nope')).toEqual([]);
    expect(findOperatorOnlyAgentPaths([{ account: 'acme' }])).toEqual([]);
  });
});

describe('describeAgentOperatorOnlyRefusal', () => {
  it('says what was refused, why, and who can change it', () => {
    const message = describeAgentOperatorOnlyRefusal(['enabledToolGroups.roomsManage']);

    expect(message).toContain('DorkOS changed nothing.');
    expect(message).toMatch(/set by a person/i);
    expect(message).toContain('enabledToolGroups.roomsManage');
  });

  it('gives each stake its own sentence rather than one blanket claim', () => {
    const message = describeAgentOperatorOnlyRefusal(['account', 'namespace']);

    expect(message).toMatch(/billing account/i);
    expect(message).toMatch(/can reach/i);
  });

  it('still answers in words for a path no stake group claims', () => {
    const message = describeAgentOperatorOnlyRefusal(['some.future.field']);

    expect(message).toContain('some.future.field');
    expect(message).toMatch(/person/i);
  });
});

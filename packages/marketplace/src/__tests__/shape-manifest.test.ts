import { describe, it, expect } from 'vitest';
import { PermissionModeSchema } from '@dorkos/shared/schemas';
import {
  MarketplacePackageManifestSchema,
  SCHEDULE_PERMISSION_MODES,
  type MarketplacePackageManifest,
  type ShapePackageManifest,
} from '../manifest-schema.js';

// A fully-populated, valid Linear-Ops-shaped shape manifest. Cross-field rules
// all hold: the schedule's agentRef resolves, exactly one default agent, the
// secret targets an activated extension, and the agent has a template + matchName.
function validShapeManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: 'linear-ops',
    version: '1.0.0',
    type: 'shape',
    displayName: 'Linear Ops',
    description: 'Your Linear issues, tended by an agent on a 15-minute inbox check.',
    author: 'dorkos',
    category: 'project-management',
    icon: '📋',
    layers: ['extensions', 'agents', 'tasks'],
    requires: [],
    activates: ['linear-issues'],
    extensions: [],
    layout: {
      sidebarOpen: true,
      sidebarTab: 'overview',
      openPanels: [],
      focusDashboardSections: ['linear-issues:linear-loop-dashboard'],
    },
    agents: [
      {
        ref: 'linear-tender',
        affinity: 'default',
        matchName: 'Linear Tender',
        template: {
          displayName: 'Linear Tender',
          runtime: 'claude-code',
          persona: 'You tend the Linear tracker like a teammate.',
          capabilities: ['linear', 'triage'],
          skills: ['flow__tending-tracker', 'flow__linear-adapter'],
        },
      },
    ],
    schedules: [
      {
        name: 'inbox-tick',
        description: 'Poll the Linear inbox and act on assigned/mentioned issues.',
        prompt: 'Run one tending tick.',
        cron: '*/15 * * * *',
        agentRef: 'linear-tender',
        permissionMode: 'acceptEdits',
        startEnabled: true,
      },
    ],
    connections: [
      {
        kind: 'extension-secret',
        extension: 'linear-issues',
        secret: 'linear_api_key',
        required: true,
      },
    ],
  };
}

describe('ShapeManifestSchema construction (union-member constraint)', () => {
  // If ShapeManifestSchema were a refined wrapper (e.g. from attaching .superRefine
  // to the member), z.discriminatedUnion would throw at module load and this import
  // would fail. A reachable schema object here proves construction did not throw
  // — the exact failure the plain-member + top-level-superRefine placement avoids.
  it('constructs the union with the shape member without throwing', () => {
    expect(MarketplacePackageManifestSchema).toBeDefined();
    expect(MarketplacePackageManifestSchema.safeParse({}).success).toBe(false);
  });
});

describe('ShapeManifestSchema — valid manifest through the union', () => {
  it('parses a fully-populated shape manifest via the union', () => {
    const result = MarketplacePackageManifestSchema.safeParse(validShapeManifest());
    expect(result.success, JSON.stringify(result.success ? {} : result.error.issues)).toBe(true);
    if (!result.success) return;
    expect(result.data.type).toBe('shape');
    // Discriminated-union narrowing still works with the shape member present.
    if (result.data.type === 'shape') {
      const shape = result.data satisfies ShapePackageManifest;
      expect(shape.activates).toEqual(['linear-issues']);
      expect(shape.agents[0]?.affinity).toBe('default');
      expect(shape.schedules[0]?.agentRef).toBe('linear-tender');
    } else {
      throw new Error('expected shape variant');
    }
  });

  it('round-trips (parse(serialize(parse(x))) is stable)', () => {
    const parsed = MarketplacePackageManifestSchema.parse(validShapeManifest());
    const reparsed = MarketplacePackageManifestSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  it('applies shape sub-schema defaults', () => {
    const minimal = {
      schemaVersion: 1,
      name: 'bare-shape',
      version: '1.0.0',
      type: 'shape',
      description: 'A minimal shape with only base fields.',
    };
    const result = MarketplacePackageManifestSchema.parse(minimal);
    if (result.type !== 'shape') throw new Error('expected shape variant');
    expect(result.activates).toEqual([]);
    expect(result.extensions).toEqual([]);
    expect(result.agents).toEqual([]);
    expect(result.schedules).toEqual([]);
    expect(result.connections).toEqual([]);
    expect(result.layout).toEqual({
      sidebarOpen: true,
      openPanels: [],
      focusDashboardSections: [],
    });
    expect(result.lineage).toBeUndefined();
  });

  it('defaults an agent affinity to suggested and a schedule permissionMode to acceptEdits', () => {
    const m = validShapeManifest();
    (m.agents as Record<string, unknown>[])[0]!.affinity = undefined;
    delete (m.agents as Record<string, unknown>[])[0]!.affinity;
    (m.schedules as Record<string, unknown>[])[0]!.permissionMode = undefined;
    delete (m.schedules as Record<string, unknown>[])[0]!.permissionMode;
    const result = MarketplacePackageManifestSchema.parse(m);
    if (result.type !== 'shape') throw new Error('expected shape variant');
    expect(result.agents[0]?.affinity).toBe('suggested');
    expect(result.schedules[0]?.permissionMode).toBe('acceptEdits');
  });

  it('accepts a fork lineage block', () => {
    const m = validShapeManifest();
    m.lineage = {
      forkedFrom: 'linear-ops@dorkos',
      forkedFromVersion: '1.0.0',
      forkedAt: '2026-07-18T00:00:00Z',
    };
    const result = MarketplacePackageManifestSchema.safeParse(m);
    expect(result.success).toBe(true);
  });
});

// Each rule is asserted THROUGH THE UNION (the install path's parse entry —
// `package-validator.ts` calls `MarketplacePackageManifestSchema.safeParse`),
// never the bare member, which skips the rules by construction.
describe('shapeCrossFieldChecks — rejected through the union with precise paths', () => {
  it('rule 1: a dangling schedules[].agentRef fails at that path', () => {
    const m = validShapeManifest();
    (m.schedules as Record<string, unknown>[])[0]!.agentRef = 'ghost';
    const result = MarketplacePackageManifestSchema.safeParse(m);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'schedules.0.agentRef')).toBe(
        true
      );
    }
  });

  it('rule 2: two default agents fail at the surplus affinity path', () => {
    const m = validShapeManifest();
    (m.agents as Record<string, unknown>[]).push({
      ref: 'second-agent',
      affinity: 'default',
      matchName: 'Second',
    });
    const result = MarketplacePackageManifestSchema.safeParse(m);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'agents.1.affinity')).toBe(true);
    }
  });

  it('rule 3: an extension-secret for a non-activated extension fails at that path', () => {
    const m = validShapeManifest();
    (m.connections as Record<string, unknown>[])[0]!.extension = 'not-activated';
    const result = MarketplacePackageManifestSchema.safeParse(m);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'connections.0.extension')).toBe(
        true
      );
    }
  });

  it('rule 4: an agent with neither template nor matchName fails at the agent path', () => {
    const m = validShapeManifest();
    m.agents = [{ ref: 'orphan', affinity: 'suggested' }];
    m.schedules = [];
    const result = MarketplacePackageManifestSchema.safeParse(m);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'agents.0')).toBe(true);
    }
  });

  it('composes with the taxonomy coherence refine — an incoherent category still fails on a shape', () => {
    const m = validShapeManifest();
    m.category = 'code-review';
    m.categories = ['security', 'code-review'];
    const result = MarketplacePackageManifestSchema.safeParse(m);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'category')).toBe(true);
    }
  });
});

describe('DependencyDeclarationSchema — shape: prefix', () => {
  it('accepts shape:foo@^1.0.0', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      schemaVersion: 1,
      name: 'shape-set',
      version: '1.0.0',
      type: 'shape',
      description: 'A shape that composes another shape.',
      requires: ['shape:linear-ops@^1.0.0'],
    });
    expect(result.success).toBe(true);
  });

  it('still rejects an off-taxonomy prefix like theme:foo', () => {
    const result = MarketplacePackageManifestSchema.safeParse({
      schemaVersion: 1,
      name: 'bad-dep',
      version: '1.0.0',
      type: 'plugin',
      description: 'A plugin with an invalid dependency prefix.',
      requires: ['theme:foo'],
    });
    expect(result.success).toBe(false);
  });
});

describe('PermissionMode drift — marketplace mirror vs @dorkos/shared source', () => {
  // What a Shape schedule may declare is re-exported from @dorkos/skills, which
  // holds the single zod-v3 mirror of @dorkos/shared's PermissionModeSchema (the
  // zod-version boundary forbids importing the schema itself). This test reads
  // PermissionModeSchema.options — a plain string array, safe to read across zod
  // majors — and asserts value-set parity so the chain never silently diverges.
  it('the two value sets are equal', () => {
    expect([...SCHEDULE_PERMISSION_MODES].sort()).toEqual([...PermissionModeSchema.options].sort());
  });

  // The manifest enum must be built FROM that set, not merely equal to a copy of
  // it: an author could re-add a hand-written list and the parity check above
  // would still be green.
  it('the manifest field accepts exactly that set', () => {
    for (const mode of PermissionModeSchema.options) {
      const manifest = validShapeManifest() as { schedules: Record<string, unknown>[] };
      manifest.schedules[0]!.permissionMode = mode;
      const result = MarketplacePackageManifestSchema.safeParse(manifest);
      expect(result.success, `${mode} should be declarable`).toBe(true);
    }
  });
});

describe('startEnabled — a package does not arm its own cron (DOR-607)', () => {
  // A Shape schedule fires unattended. Deciding that it starts firing the moment
  // the package is installed is the operator's call, so the field defaults OFF
  // and a manifest has to opt in. This is a rename of the old `startDisabled`
  // rather than a flipped default precisely so that no already-published
  // manifest quietly changes meaning: the old key is not read at all.
  function scheduleOf(manifest: Record<string, unknown>): Record<string, unknown> {
    const parsed = MarketplacePackageManifestSchema.parse(manifest);
    if (parsed.type !== 'shape') throw new Error('expected shape variant');
    return parsed.schedules[0]! as unknown as Record<string, unknown>;
  }

  it('defaults to false when the manifest says nothing', () => {
    const manifest = validShapeManifest() as { schedules: Record<string, unknown>[] };
    delete manifest.schedules[0]!.startEnabled;
    expect(scheduleOf(manifest).startEnabled).toBe(false);
  });

  it('does not read the retired startDisabled key', () => {
    // A manifest written against the old key gets the safe default, not its
    // former meaning. `startDisabled: false` used to mean "start it running".
    const manifest = validShapeManifest() as { schedules: Record<string, unknown>[] };
    delete manifest.schedules[0]!.startEnabled;
    manifest.schedules[0]!.startDisabled = false;
    expect(scheduleOf(manifest).startEnabled).toBe(false);
  });

  it('preserves the retired key so apply-time can warn about it', () => {
    // The retired key is declared purely so it survives parsing: zod would
    // otherwise strip it, and `apply-shape.ts` could not tell a Shape written
    // against the old schema from one that simply wants its timer off. Its
    // value is never read for behaviour, only its presence, for the warning.
    const manifest = validShapeManifest() as { schedules: Record<string, unknown>[] };
    manifest.schedules[0]!.startDisabled = true;
    expect(scheduleOf(manifest).startDisabled).toBe(true);
  });

  it('leaves the retired key absent when the manifest does not use it', () => {
    expect(scheduleOf(validShapeManifest()).startDisabled).toBeUndefined();
  });

  it('honours an explicit opt-in', () => {
    expect(scheduleOf(validShapeManifest()).startEnabled).toBe(true);
  });
});

describe('existing package types still parse after adding shape', () => {
  it.each(['plugin', 'skill-pack'])('parses a minimal %s manifest unchanged', (type) => {
    const result: MarketplacePackageManifest = MarketplacePackageManifestSchema.parse({
      schemaVersion: 1,
      name: 'legacy-pkg',
      version: '1.0.0',
      type,
      description: 'An existing package type.',
    });
    expect(result.type).toBe(type);
  });
});

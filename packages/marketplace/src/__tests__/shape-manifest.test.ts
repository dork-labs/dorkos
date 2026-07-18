import { describe, it, expect } from 'vitest';
import { PermissionModeSchema } from '@dorkos/shared/schemas';
import {
  MarketplacePackageManifestSchema,
  SHAPE_SCHEDULE_PERMISSION_MODES,
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
        startDisabled: false,
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

describe('ShapeManifestSchema construction (Zod 3 union-member constraint)', () => {
  // If ShapeManifestSchema were a ZodEffects (e.g. from attaching .superRefine to
  // the member), z.discriminatedUnion would throw at module load and this import
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
  // The shape schedule permissionMode enum is an inlined mirror of
  // @dorkos/shared's PermissionModeSchema (the Zod-version boundary forbids a
  // direct import in source). This test reads PermissionModeSchema.options — a
  // plain string array, safe to read across Zod majors — and asserts value-set
  // parity so the two never silently diverge.
  it('the two value sets are equal', () => {
    expect([...SHAPE_SCHEDULE_PERMISSION_MODES].sort()).toEqual(
      [...PermissionModeSchema.options].sort()
    );
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

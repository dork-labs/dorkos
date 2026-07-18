import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarketplacePackageManifestSchema } from '../manifest-schema.js';

// The Linear Ops fixture the install-shape flow (Phase 2) stages. Loading the
// ON-DISK file — not an inline object — makes this the executable proof of the
// spec's validation criterion: "Linear Ops must be fully describable in this
// manifest with no escape hatches." The path walks up from
// packages/marketplace/src/__tests__ to the repo root, then into apps/server.
const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/server/src/services/marketplace/fixtures/valid-shape/.dork/manifest.json'
);

describe('Linear Ops fixture — zero-escape-hatch validation (DOR-355 task 1.4)', () => {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as unknown;

  it('validates green through MarketplacePackageManifestSchema (the install path)', () => {
    // Validate through the UNION — the install path's parse entry
    // (`package-validator.ts` calls `MarketplacePackageManifestSchema.safeParse`)
    // — NOT the bare ShapeManifestSchema member, which skips the cross-field rules.
    const result = MarketplacePackageManifestSchema.safeParse(raw);
    expect(result.success, result.success ? '' : JSON.stringify(result.error.issues, null, 2)).toBe(
      true
    );
  });

  it('round-trips (parse(serialize(parse(x))) is stable)', () => {
    const parsed = MarketplacePackageManifestSchema.parse(raw);
    const reparsed = MarketplacePackageManifestSchema.parse(JSON.parse(JSON.stringify(parsed)));
    expect(reparsed).toEqual(parsed);
  });

  it('maps the worked-example fields the apply flow depends on', () => {
    const parsed = MarketplacePackageManifestSchema.parse(raw);
    if (parsed.type !== 'shape') throw new Error('expected shape variant');

    // activates the core linear-issues extension
    expect(parsed.activates).toEqual(['linear-issues']);

    // exactly one default agent (the arrival offer), and its ref is stable
    const defaults = parsed.agents.filter((a) => a.affinity === 'default');
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.ref).toBe('linear-tender');

    // every schedule's agentRef resolves to a declared agent
    const agentRefs = new Set(parsed.agents.map((a) => a.ref));
    for (const schedule of parsed.schedules) {
      expect(agentRefs.has(schedule.agentRef)).toBe(true);
    }
    expect(parsed.schedules[0]?.cron).toBe('*/15 * * * *');
    expect(parsed.schedules[0]?.permissionMode).toBe('acceptEdits');

    // the extension-secret connection targets an activated extension
    const secretConns = parsed.connections.filter((c) => c.kind === 'extension-secret');
    expect(secretConns).toHaveLength(1);
    if (secretConns[0]?.kind === 'extension-secret') {
      expect(parsed.activates).toContain(secretConns[0].extension);
      expect(secretConns[0].secret).toBe('linear_api_key');
    }
  });
});

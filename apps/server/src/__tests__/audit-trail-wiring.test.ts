/**
 * Startup wires the audit trail (spec `audit-trail`): `index.ts` builds it with
 * `wireAuditTrail`, serves `/api/audit`, and hands the log to the capability
 * registry so `audit.verify` is registered. The behaviour of each piece is
 * tested where it lives; this pins that startup actually uses them.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

describe('audit trail startup wiring', () => {
  it('builds the trail right after the Activity feed, before anything can emit', () => {
    const activity = source.indexOf('const activityService = new ActivityService(db);');
    const wire = source.indexOf('wireAuditTrail({');
    const prune = source.indexOf('activityService.prune(');
    expect(activity).toBeGreaterThan(-1);
    expect(wire).toBeGreaterThan(activity);
    expect(prune).toBeGreaterThan(wire);
  });

  it('serves /api/audit and registers audit.verify with the same log', () => {
    expect(source).toContain("app.use('/api/audit', createAuditRouter(auditLog));");
    expect(source).toContain('auditDeps: { log: auditLog },');
  });
});

/**
 * Startup wires the audit trail (spec `audit-trail`): `index.ts` builds it with
 * `wireAuditTrail`, serves `/api/audit`, and hands the log to the capability
 * registry so the `audit.*` capabilities are registered, and sets the session
 * visibility lookup the transcript reads use. The behaviour of each piece is
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

  it('serves /api/audit and registers the audit capabilities with the same log', () => {
    expect(source).toContain(
      "app.use('/api/audit', createAuditRouter({ log: auditLog, accounts: auditAccounts }));"
    );
    expect(source).toContain(
      'auditDeps: auditCapabilityDeps(auditLog, auditAccounts, runtimeRegistry),'
    );
  });

  it('sets the session visibility lookup from the stored origin and the overlays', () => {
    expect(source).toContain(
      'wireSessionVisibility({ db, accounts: auditAccounts, resolveTaskOrigins, resolveStartedBy });'
    );
  });

  it('enters the request audit scope after both identity gates, before any route', () => {
    const app = readFileSync(new URL('../app.ts', import.meta.url), 'utf8');
    const gate = app.indexOf('app.use(sessionGate);');
    const identity = app.indexOf('app.use(resolveAgentIdentity);');
    const scope = app.indexOf('app.use(auditActor);');
    const firstRoute = app.indexOf("app.use('/api/sessions'");
    expect(gate).toBeGreaterThan(-1);
    expect(identity).toBeGreaterThan(gate);
    expect(scope).toBeGreaterThan(identity);
    expect(firstRoute).toBeGreaterThan(scope);
  });
});

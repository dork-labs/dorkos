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
    // Served from the Hono `/api` app (`http/hono-api.ts`), which reads this.
    expect(source).toContain('deps.audit = { log: auditLog, accounts: auditAccounts };');
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
    const chain = readFileSync(new URL('../http/api-chain.ts', import.meta.url), 'utf8');
    const gate = chain.indexOf('decideSessionGate(c.req.method');
    const identity = chain.indexOf('resolveAgentIdentityFromHeaders(c.env.incoming.headers');
    const scope = chain.indexOf('app.use(enterAuditScope);');
    // Every route is mounted on the app the chain returns, after all of it.
    const end = chain.indexOf('  return app;\n}');
    expect(gate).toBeGreaterThan(-1);
    expect(identity).toBeGreaterThan(gate);
    expect(scope).toBeGreaterThan(identity);
    expect(end).toBeGreaterThan(scope);
  });
});

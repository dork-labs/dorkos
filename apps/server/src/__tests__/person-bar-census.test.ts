/**
 * Census: every person-only bar asks whether the person proved themselves,
 * never only whether the gate asked for a password (DOR-3330).
 *
 * At this computer the gate asks for nothing by default, so a bar keyed off
 * `credentialGated` alone reads every program here as the person. The bars
 * key off `personSessionRequired` instead. This fails when:
 *
 * - a file outside the allowlist below calls `credentialGated(`: a new bar
 *   reading the old question, or an old one drifting back; and
 * - a route the step-up protects stops naming the session-aware bar it runs.
 *
 * What the bars then DO is proved on the real chain: no headers is refused,
 * the owner's session passes (`http/__tests__/contract/person-bar.contract.test.ts`,
 * `services/core/auth/__tests__/person-step-up.integration.test.ts`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');

/** Every non-test source file under `src`, relative to it. */
function sourceFiles(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [path.relative(SRC, full)] : [];
  });
}

/**
 * The files that may still ask `credentialGated`, each for a reason that is
 * not a person bar.
 */
const CREDENTIAL_GATED_ALLOWED: Record<string, string> = {
  'services/core/auth/gate-policy.ts': 'defines it, and builds the person question on it',
  'lib/caller-authority.ts': 'isPersonAtTheApp: only ordering rides on it, never power',
  'lib/person-without-session.ts': 'tells the open gate apart, to answer with the step-up',
  'routes/debug.ts': 'a read: which owner-only flags a view shows',
  'routes/relay-delivery-receipts.ts': 'a read: whose receipts a view shows',
  'services/core/browser-registry/owner-scope.ts':
    'a locality check beside refuseUnlessAccountOwner, which asks the person question',
};

/** Each route the step-up protects, and the session-aware bar it must run. */
const ROUTE_BARS: Record<string, readonly string[]> = {
  'routes/approvals.ts': ['requireOperatorCookieUnderLogin', 'readCallerAuthority'],
  'routes/session-answers.ts': ['requireOperatorCookieUnderLogin', 'readCallerAuthority'],
  'routes/permissions.ts': ['requireOperatorCookieUnderLogin', 'readCallerAuthority'],
  'middleware/agent-execution-gate.ts': ['clearsTheAgentBar'],
  'routes/agents.ts': ['trustedCaller'],
  'routes/tasks.ts': ['clearsTheAgentBar'],
  'routes/config.ts': ['requireOperatorCookieUnderLogin', 'trustedCaller'],
  'routes/extensions-approval.ts': ['refusedNotAPerson'],
  'routes/extensions.ts': ['refusedNotAPerson'],
  'routes/extensions-trusted-sources.ts': ['refusedNotAPerson'],
  'routes/extensions-person-bar.ts': ['requireOperatorCookieUnderLogin', 'trustedCaller'],
  'services/extensions/inbox/extension-inbox-context.ts': ['assessPerson'],
  'routes/marketplace/context.ts': ['trustedCaller'],
  'routes/marketplace/package-actions.ts': ['trustedCaller'],
  'routes/marketplace/held-back.ts': ['trustedCaller'],
  'routes/connector-management.ts': ['resolveConnectorOperator'],
  'routes/connector-resources.ts': ['resolveConnectorOperator'],
  'routes/extensions-rooms-bar.ts': ['personSessionRequired'],
  'routes/room-caller.ts': ['PERSON_SESSION_REQUIRED'],
  'routes/sessions.ts': ['isPersonTurn'],
  'routes/mesh.ts': ['clearsTheAgentBar'],
  'startup/steps/core-routes.ts': ['loginEnabled: personSessionRequired'],
};

describe('the person bar census', () => {
  it('lets no person bar ask only whether the gate asked for a password', () => {
    const callers = sourceFiles().filter((file) =>
      fs.readFileSync(path.join(SRC, file), 'utf8').includes('credentialGated(')
    );
    expect(callers.sort()).toEqual(Object.keys(CREDENTIAL_GATED_ALLOWED).sort());
  });

  it.each(Object.entries(ROUTE_BARS))('%s runs a session-aware bar', (file, bars) => {
    const source = fs.readFileSync(path.join(SRC, file), 'utf8');
    for (const bar of bars) expect(source, `${file} should name ${bar}`).toContain(bar);
  });

  it('keys every shared person bar off the person question', () => {
    const source = fs.readFileSync(path.join(SRC, 'lib/caller-authority.ts'), 'utf8');
    for (const fn of [
      'readCallerAuthority',
      'requireOperatorCookieUnderLogin',
      'refuseUnlessAccountOwner',
      'requirePersonAtThisComputer',
    ]) {
      const start = source.indexOf(`export function ${fn}(`);
      expect(start, fn).toBeGreaterThan(-1);
      const body = source.slice(start, source.indexOf('\n}\n', start));
      expect(body, fn).toMatch(/personSessionRequired|sessionAskedOf/);
      expect(body, fn).not.toContain('credentialGated(');
    }
  });
});

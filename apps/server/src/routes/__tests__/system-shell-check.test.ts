/**
 * The route behind "Continue without the check" (DOR-3300). The bars' own rules are tested with
 * `extensions-person-bar.ts` and the classifier; this pins that this route runs them, in front of
 * the choice, and writes the audit row only when the choice took.
 *
 * @vitest-environment node
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { refused, kind, took, audit } = vi.hoisted(() => ({
  refused: vi.fn(),
  kind: vi.fn(),
  took: vi.fn(),
  audit: vi.fn(),
}));
const STATUS = { down: true, full: true, canContinue: true, continuing: true };

vi.mock('../extensions-person-bar.js', () => ({ refusedNotAPerson: refused }));
vi.mock('../../lib/request-classifier.js', () => ({ classifyRequest: () => ({ kind: kind() }) }));
vi.mock('../../lib/server-role.js', () => ({ currentServerRole: () => 'computer' }));
vi.mock('../../http/request-facts.js', () => ({ honoRequestFacts: () => ({}) }));
vi.mock('../../services/audit/audit-trail.js', () => ({ recordAudit: audit }));
vi.mock('../../services/runtimes/claude-code/shell-guard/guard-service.js', () => ({
  continueWithoutCheck: took,
  shellCheckStatus: () => STATUS,
}));

const { mountShellCheckRoutes } = await import('../system-shell-check.js');

/** The routes, alone. */
function app() {
  const router = new Hono();
  mountShellCheckRoutes(router as never);
  return router;
}

const post = () => app().request('/shell-check/continue', { method: 'POST' });

beforeEach(() => {
  vi.clearAllMocks();
  refused.mockReturnValue(undefined);
  kind.mockReturnValue('this-computer');
  took.mockReturnValue(true);
});

describe('/api/system/shell-check', () => {
  it('answers the status to anyone the chain let in', async () => {
    const response = await app().request('/shell-check');
    expect(await response.json()).toEqual(STATUS);
  });

  it('goes on for a person at this computer, and records it', async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]![0]).toMatchObject({
      action: 'shell-check.continue-without',
      outcome: 'ok',
      source: { surface: 'app' },
    });
  });

  it('refuses anything the person bars refuse, before the choice', async () => {
    refused.mockReturnValue(new Response('no', { status: 403 }));
    expect((await post()).status).toBe(403);
    expect(took).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses a phone or any other device', async () => {
    kind.mockReturnValue('other-device');
    expect((await post()).status).toBe(403);
    expect(took).not.toHaveBeenCalled();
  });

  it('answers conflict when the choice isn’t open, with no audit row', async () => {
    took.mockReturnValue(false);
    expect((await post()).status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });
});

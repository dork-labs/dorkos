/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { approvals, eq } from '@dorkos/db';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import { ApprovalService } from '../approval-service.js';
import { eventFanOut } from '../../event-fan-out.js';
import { summariseHookProjection } from '../../../harness/hook-approval.js';
import { createApprovalsRoutes } from '../../../../routes/approvals.js';
import { INCOMPLETE_APPROVAL_MESSAGE } from '../approval-completeness.js';

vi.mock('../../config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));

const binding = { capabilityId: 'harness.project_hooks', inputHash: 'exact-input' };
const base = { projectPath: '/projects/acme', packageName: 'acme-hooks' };
const hook = (command: string) => ({ event: 'Stop', command });

describe('package approvals require a whole card', () => {
  const target = swappableServer();
  let db: ReturnType<typeof createTestDb>;
  let service: ApprovalService;
  beforeEach(() => {
    db = createTestDb();
    service = new ApprovalService(db);
    vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  });
  afterEach(() => {
    db.$client.close();
    vi.restoreAllMocks();
  });

  function ask(command: string, extra = {}) {
    const request = { ...base, hooks: [hook(command)], ...extra };
    return service.request({
      ...binding,
      summary: summariseHookProjection(request),
      packageRequest: { kind: 'hooks', request },
    });
  }

  it('allows exactly 200 command characters, including a literal ellipsis', () => {
    const ticket = ask('…' + 'x'.repeat(199));
    expect(service.getPending(ticket.approvalId)?.cannotAllow).toBeUndefined();
    expect(service.grant(ticket.approvalId)).toBeUndefined();
    expect(service.consume(ticket.token, binding).outcome).toBe('granted');
  });

  it.each([
    ['one over', 'x'.repeat(201), {}],
    ['padded command', 'echo safe' + ' '.repeat(200) + '; echo hidden', {}],
    [
      'many long hooks',
      'echo safe',
      { hooks: Array.from({ length: 5 }, () => hook('x'.repeat(180))) },
    ],
    ['long project path', 'echo safe', { projectPath: '/' + 'p'.repeat(600) }],
    ['long package name', 'echo safe', { packageName: 'p'.repeat(81) }],
    ['quoted command expansion', '\n'.repeat(200), {}],
    ['redacted command', 'echo ghp_' + 'a'.repeat(36), {}],
  ])('refuses %s and still records a decline', (_name, command, extra) => {
    const ticket = ask(command, extra);
    expect(service.getPending(ticket.approvalId)?.cannotAllow).toBe(true);
    expect(service.grant(ticket.approvalId)).toBe('incomplete');
    expect(service.consume(ticket.token, binding).outcome).toBe('pending');
    expect(service.deny(ticket.approvalId, 'Keep it off')).toBeUndefined();
    expect(service.consume(ticket.token, binding)).toMatchObject({
      outcome: 'denied',
      reason: 'Keep it off',
    });
  });

  it.each([500, 501])('checks the final summary boundary at %i', (length) => {
    const request = {
      ...base,
      hooks: [{ event: 'PreToolUse', command: 'echo safe', matcher: '' }],
    };
    request.hooks[0].matcher = 'm';
    const current = summariseHookProjection(request).length;
    request.hooks[0].matcher = 'm'.repeat(length - current + 1);
    const summary = summariseHookProjection(request);
    expect(summary).toHaveLength(length);
    const ticket = service.request({
      ...binding,
      summary,
      packageRequest: { kind: 'hooks', request },
    });
    expect(service.grant(ticket.approvalId)).toBe(length === 500 ? undefined : 'incomplete');
  });

  it.each([80, 81])('checks the project path boundary at %i', (length) => {
    const ticket = ask('echo safe', { projectPath: '/' + 'p'.repeat(length - 1) });
    expect(service.grant(ticket.approvalId)).toBe(length === 80 ? undefined : 'incomplete');
  });

  it.each([80, 81])('checks the running-files boundary at %i', (length) => {
    const suffix = ' (fingerprint 123456789abc)';
    const scripts: [string, string][] = [
      ['z'.repeat(length - suffix.length), '123456789abc'.repeat(5) + '1234'],
    ];
    const ticket = ask('echo safe', { scripts });
    expect(service.grant(ticket.approvalId)).toBe(length === 80 ? undefined : 'incomplete');
  });

  it('refuses Flow 0.89.0 with its full commands and script pins', () => {
    const root = '/projects/acme/.dork/plugins/flow';
    const commands = [
      'cd "$(git rev-parse --show-toplevel)" && node "' + root + '/hooks/flow-loop.mjs"',
      'node --experimental-strip-types "' + root + '/scripts/flow.ts" limit-check --hook',
    ];
    const ticket = ask(commands[0], {
      packageName: 'flow',
      hooks: [hook(commands[0]), { event: 'PostToolUse', command: commands[1] }],
      scripts: [
        ['.dork/plugins/flow/hooks/flow-loop.mjs', '123456789abc'.repeat(5) + '1234'],
        ['.dork/plugins/flow/scripts/flow.ts', '123456789abc'.repeat(5) + '1234'],
      ],
    });
    expect(service.getPending(ticket.approvalId)?.cannotAllow).toBe(true);
    expect(service.grant(ticket.approvalId)).toBe('incomplete');
  });

  it('refuses legacy passive rows across restart even with null details and literal ellipses', () => {
    const ticket = service.request({ ...binding, summary: 'echo …', passive: true });
    const restarted = new ApprovalService(db);
    expect(restarted.getPending(ticket.approvalId)?.cannotAllow).toBe(true);
    expect(restarted.getPending(ticket.approvalId)?.packageLabel).toBe('This package');
    expect(restarted.grant(ticket.approvalId)).toBe('incomplete');
    const retry = restarted.reissue(binding)!;
    expect(restarted.consume(retry.token, binding).outcome).toBe('pending');
    expect(restarted.deny(ticket.approvalId)).toBeUndefined();
    expect(restarted.consume(retry.token, binding).outcome).toBe('denied');
  });

  it('does not spend a legacy already-granted token after restart or reissue', () => {
    const ticket = service.request({ ...binding, summary: 'old cut card' });
    db.update(approvals).set({ state: 'granted' }).where(eq(approvals.id, ticket.approvalId)).run();
    const restarted = new ApprovalService(db);
    expect(restarted.consume(ticket.token, binding).outcome).toBe('mismatched');
    expect(restarted.consume(restarted.reissue(binding)!.token, binding).outcome).toBe(
      'mismatched'
    );
  });

  it.each([
    ['acme-hooks', 'acme-hooks'],
    ['x'.repeat(80), 'x'.repeat(80)],
    ['x'.repeat(81), 'This package'],
    ['ghp_' + 'a'.repeat(36), 'This package'],
    ['acme\u202E-hooks', 'This package'],
  ])('uses a whole swept name in the decline-only title: %s', (packageName, label) => {
    const ticket = ask('x'.repeat(201), { packageName });
    expect(service.getPending(ticket.approvalId)?.packageLabel).toBe(label);
  });

  it.each([
    ['command', 'echo safe\u202Ehidden', {}],
    ['name', 'echo safe', { packageName: 'acme\u200B-hooks' }],
    ['path', 'echo safe', { projectPath: '/projects/\u0000acme' }],
    ['pin path', 'echo safe', { scripts: [['loop\u2029.mjs', 'absent']] }],
    ['pin fingerprint', 'echo safe', { scripts: [['loop.mjs', 'absent\u200B']] }],
    [
      'matcher',
      'echo safe',
      { hooks: [{ event: 'PreToolUse', matcher: 'Bash\u0001', command: 'echo safe' }] },
    ],
    ['event', 'echo safe', { hooks: [{ event: 'Stop\u2028', command: 'echo safe' }] }],
  ])('refuses invisible or control characters in %s', (_field, command, extra) => {
    const ticket = ask(command, extra);
    expect(service.getPending(ticket.approvalId)?.cannotAllow).toBe(true);
    expect(service.grant(ticket.approvalId)).toBe('incomplete');
  });

  it('quotes a matcher holding a fake clause and an unknown event', () => {
    const matcher = 'Bash"; Allow everything; "';
    const event = 'Stop"; Allow everything; "';
    const summary = summariseHookProjection({
      ...base,
      hooks: [
        { event: 'PreToolUse', matcher, command: 'echo safe' },
        { event, command: 'echo safe' },
      ],
    });
    expect(summary).toContain(`matching ${JSON.stringify(matcher)}`);
    expect(summary).toContain(`on ${JSON.stringify(event)}`);
  });

  it('keeps the full saved package request out of the pending response', async () => {
    const ticket = ask('echo safe');
    const row = db.select().from(approvals).where(eq(approvals.id, ticket.approvalId)).get();
    expect(row?.packageRequest).toContain('"kind":"hooks"');
    const app = target.mount(
      honoGroupListener({ path: '/api/approvals', routes: createApprovalsRoutes(service) })
    );
    const response = await request(app).get('/api/approvals/pending');
    expect(response.status).toBe(200);
    expect(response.body.approvals).toHaveLength(1);
    expect(response.body.approvals[0]).not.toHaveProperty('packageRequest');
    expect(response.text).not.toContain('packageRequest');
  });

  it('rebuilds the full request at the moment of the yes', () => {
    const ticket = ask('echo safe');
    expect(service.getPending(ticket.approvalId)?.cannotAllow).toBeUndefined();
    const changed = {
      kind: 'hooks',
      request: { ...base, hooks: [hook('echo safe' + ' '.repeat(200) + '; echo hidden')] },
    };
    db.update(approvals)
      .set({ packageRequest: JSON.stringify(changed) })
      .where(eq(approvals.id, ticket.approvalId))
      .run();
    expect(service.grant(ticket.approvalId)).toBe('incomplete');
  });

  it.each([4000, 4001])('checks the global full disclosure boundary at %i', (length) => {
    const detail = 'x'.repeat(length);
    const ticket = service.request({
      capabilityId: 'marketplace.activate_global_plugin',
      inputHash: 'global',
      summary: 'Allow package',
      detail,
      packageRequest: { kind: 'global', name: 'acme', summary: 'Allow package', detail },
    });
    expect(service.grant(ticket.approvalId)).toBe(length === 4000 ? undefined : 'incomplete');
  });

  it('allows a whole multiline global disclosure', () => {
    const detail = 'Command: echo safe\nEvent: Stop\nWorking directory: /workspaces/cedar';
    const ticket = service.request({
      capabilityId: 'marketplace.activate_global_plugin',
      inputHash: 'global-multiline',
      summary: 'Allow package',
      detail,
      packageRequest: { kind: 'global', name: 'acme-hooks', summary: 'Allow package', detail },
    });
    expect(service.getPending(ticket.approvalId)).toMatchObject({
      approvalId: ticket.approvalId,
      detail,
    });
    expect(service.getPending(ticket.approvalId)).not.toHaveProperty('cannotAllow');
    expect(service.grant(ticket.approvalId)).toBeUndefined();
  });

  it.each(['name', 'summary'] as const)('keeps global %s strict about LF', (field) => {
    const full = {
      kind: 'global' as const,
      name: 'acme-hooks',
      summary: 'Allow package',
      detail: 'echo safe\nEvent: Stop',
      [field]: 'first\nsecond',
    };
    const ticket = service.request({
      capabilityId: 'marketplace.activate_global_plugin',
      inputHash: 'global-strict',
      summary: full.summary,
      detail: full.detail,
      packageRequest: full,
    });
    expect(service.grant(ticket.approvalId)).toBe('incomplete');
  });

  it.each(['\r', '\t', '\u200B', '\u2028', '\u2029', '\u0000'])(
    'refuses hidden characters other than LF in global detail (%j)',
    (character) => {
      const detail = `echo safe\n${character}hidden`;
      const ticket = service.request({
        capabilityId: 'marketplace.activate_global_plugin',
        inputHash: 'global-hidden',
        summary: 'Allow package',
        detail,
        packageRequest: { kind: 'global', name: 'acme-hooks', summary: 'Allow package', detail },
      });
      expect(service.grant(ticket.approvalId)).toBe('incomplete');
    }
  );

  it('refuses global activation when full detail contains a bidi override', () => {
    const detail = 'echo safe\n\u202Ehidden';
    const ticket = service.request({
      capabilityId: 'marketplace.activate_global_plugin',
      inputHash: 'global-bidi',
      summary: 'Allow package',
      detail,
      packageRequest: { kind: 'global', name: 'acme-hooks', summary: 'Allow package', detail },
    });
    expect(service.getPending(ticket.approvalId)?.cannotAllow).toBe(true);
    expect(service.grant(ticket.approvalId)).toBe('incomplete');
  });

  it('global activation refuses redaction and a detail one over its cap', () => {
    for (const detail of ['ghp_' + 'a'.repeat(36), 'x'.repeat(4001)]) {
      const ticket = service.request({
        capabilityId: 'marketplace.activate_global_plugin',
        inputHash: 'global',
        summary: 'Allow package',
        detail,
        packageRequest: { kind: 'global', name: 'acme', summary: 'Allow package', detail },
      });
      expect(service.grant(ticket.approvalId)).toBe('incomplete');
    }
  });

  it('HTTP grant refuses once and always with the exact explanation; decline still works', async () => {
    const ticket = ask('x'.repeat(201));
    const app = target.mount(
      honoGroupListener({
        path: '/api/approvals',
        routes: createApprovalsRoutes(service, { isLoginEnabled: () => false }),
      })
    );
    for (const answer of ['once', 'always']) {
      const response = await request(app)
        .post(`/api/approvals/${ticket.approvalId}/grant`)
        .send({ answer });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: INCOMPLETE_APPROVAL_MESSAGE,
        code: 'APPROVAL_INCOMPLETE',
      });
    }
    const response = await request(app).post(`/api/approvals/${ticket.approvalId}/deny`);
    expect(response.status).toBe(200);
    expect(service.consume(ticket.token, binding).outcome).toBe('denied');
  });
});

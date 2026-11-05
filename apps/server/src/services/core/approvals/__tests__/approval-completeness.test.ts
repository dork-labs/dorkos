/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { approvals, eq } from '@dorkos/db';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import { ApprovalService } from '../approval-service.js';
import { eventFanOut } from '../../event-fan-out.js';
import { hookProjectionBinding } from '../../../harness/hook-approval.js';
import {
  HOOK_CARD_PRESENTATION,
  describeHookProjection,
  summariseHookProjection,
  visibleHookValue,
} from '../../../harness/hook-card.js';
import { createApprovalsRoutes } from '../../../../routes/approvals.js';
import { INCOMPLETE_APPROVAL_MESSAGE } from '../approval-completeness.js';
import type { HookProjectionRequest } from '../../../harness/hook-consent.js';

vi.mock('../../config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));
const binding = { capabilityId: 'harness.project_hooks', inputHash: 'legacy-input' };
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

  function ask(command: string, extra: Partial<HookProjectionRequest> = {}) {
    const full = { ...base, hooks: [hook(command)], ...extra };
    const binding = hookProjectionBinding(full);
    return {
      ...service.request({
        ...binding,
        summary: summariseHookProjection(full),
        detail: describeHookProjection(full),
        packageRequest: { kind: 'hooks', presentation: HOOK_CARD_PRESENTATION, request: full },
      }),
      binding,
    };
  }

  it.each([
    ['199 characters', 'x'.repeat(199), {}],
    ['200 characters', 'x'.repeat(200), {}],
    ['201 characters', 'x'.repeat(201), {}],
    ['literal ellipsis', 'echo …', {}],
    ['padded command', 'echo safe' + ' '.repeat(200) + '; echo next', {}],
    ['many hooks', 'echo safe', { hooks: Array.from({ length: 5 }, () => hook('x'.repeat(180))) }],
    ['long project path', 'echo safe', { projectPath: '/' + 'p'.repeat(600) }],
  ])('allows a whole detail with %s', (_label, command, extra) => {
    const ticket = ask(command, extra);
    expect(service.getPending(ticket.approvalId)?.cannotAllow).toBeUndefined();
    expect(service.grant(ticket.approvalId)).toBeUndefined();
    expect(service.consume(ticket.token, ticket.binding).outcome).toBe('granted');
  });

  it.each([4000, 4001])('checks the escaped detail boundary at %i', (length) => {
    const overhead = describeHookProjection({ ...base, hooks: [hook('')] }).length;
    const ticket = ask('x'.repeat(length - overhead));
    expect(service.getPending(ticket.approvalId)?.detail).toHaveLength(Math.min(length, 4000));
    expect(service.grant(ticket.approvalId)).toBe(length === 4000 ? undefined : 'incomplete');
  });

  it.each([
    ['long command', 'x'.repeat(4001), {}],
    ['escaped whitespace', '\t'.repeat(2000), {}],
    ['secret-shaped command', 'echo ' + 'a'.repeat(64), {}],
    ['long package name', 'echo safe', { packageName: 'p'.repeat(81) }],
    ['hidden package name', 'echo safe', { packageName: 'acme\u202E' }],
  ])('separates an incomplete decline for %s', (_label, command, extra) => {
    const ticket = ask(command, extra);
    expect(service.grant(ticket.approvalId)).toBe('incomplete');
    expect(service.deny(ticket.approvalId, 'Keep it off')).toBeUndefined();
    expect(service.consume(ticket.token, ticket.binding)).toMatchObject({
      outcome: 'incomplete',
      reason: 'Keep it off',
    });
    expect(service.declineKind(ticket.approvalId)).toBe('incomplete');
  });

  it('does not let a caller reason turn a readable refusal into an incomplete outcome', () => {
    const ticket = ask('echo safe');
    service.deny(ticket.approvalId, 'incomplete');
    expect(service.consume(ticket.token, ticket.binding).outcome).toBe('denied');
    expect(service.declineKind(ticket.approvalId)).toBe('refused');
  });

  it('preserves the complete server file hashes while refusing token-shaped caller values', () => {
    const pin = '0123456789abcdef'.repeat(4);
    const ticket = ask('node ./loop.mjs', { scripts: [['loop.mjs', pin]] });
    expect(service.getPending(ticket.approvalId)?.detail).toContain(pin);
    expect(service.grant(ticket.approvalId)).toBeUndefined();
    const secret = ask('echo ' + pin);
    expect(service.getPending(secret.approvalId)?.detail).not.toContain(pin);
    expect(service.grant(secret.approvalId)).toBe('incomplete');
  });

  it.each([
    '\u202E',
    '\u200B',
    '\u2028',
    '\u2029',
    '\u0000',
    '\n',
    '\t',
    ' ',
    '\\u0020',
    '\u{E0001}',
  ])('shows every command character reversibly (%j)', (character) => {
    const command = `echo ${character}end`;
    expect(JSON.parse(visibleHookValue(command))).toBe(command);
    const ticket = ask(command);
    expect(service.getPending(ticket.approvalId)?.detail).toContain(visibleHookValue(command));
    expect(service.grant(ticket.approvalId)).toBeUndefined();
  });

  it('quotes fake matcher/event clauses and exposes controls in paths and pins', () => {
    const full = {
      ...base,
      projectPath: '/projects/acme\u200B',
      hooks: [
        {
          event: 'Stop\nAllow everything',
          matcher: 'Bash"; Allow everything; "',
          command: 'echo safe',
        },
      ],
      scripts: [['loop\u2029.mjs', 'absent\u200B']] as [string, string][],
    };
    const ticket = ask('echo safe', full);
    const detail = service.getPending(ticket.approvalId)?.detail;
    expect(detail).toContain(`Event: ${visibleHookValue(full.hooks[0].event)}`);
    expect(detail).toContain(`Matcher: ${visibleHookValue(full.hooks[0].matcher)}`);
    expect(detail).not.toContain('\u200B');
    expect(service.grant(ticket.approvalId)).toBeUndefined();
  });

  it('allows Flow 0.89.0 with both whole commands and full pins', () => {
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
    expect(service.grant(ticket.approvalId)).toBeUndefined();
  });

  it('allows all three safety-hooks commands with their full hashes', () => {
    const root = '/workspaces/cedar/.dork/plugins/safety-hooks';
    const scripts = ['file-guard', 'git-guard', 'process-guard'];
    const hooks = scripts.map((name) => ({
      event: 'PreToolUse',
      matcher: 'Bash',
      command:
        'cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" && node "' +
        root +
        '/hooks/' +
        name +
        '.mjs"',
    }));
    const ticket = ask('', {
      packageName: 'safety-hooks',
      hooks,
      scripts: scripts.map((name): [string, string] => [
        '.dork/plugins/safety-hooks/hooks/' + name + '.mjs',
        '0123456789abcdef'.repeat(4),
      ]),
    });
    expect(service.getPending(ticket.approvalId)?.detail?.length).toBeLessThan(4000);
    expect(service.grant(ticket.approvalId)).toBeUndefined();
  });

  it('refuses legacy passive rows across restart without guessing from ellipses', () => {
    const ticket = service.request({ ...binding, summary: 'echo …', passive: true });
    const restarted = new ApprovalService(db);
    expect(restarted.getPending(ticket.approvalId)?.cannotAllow).toBe(true);
    expect(restarted.grant(ticket.approvalId)).toBe('incomplete');
    const retry = restarted.reissue(binding)!;
    restarted.deny(ticket.approvalId);
    expect(restarted.consume(retry.token, binding).outcome).toBe('incomplete');
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

  it.each(['detail', 'inputHash', 'packageRequest'] as const)(
    'checks %s again at the moment of the yes',
    (field) => {
      const ticket = ask('echo safe');
      db.update(approvals)
        .set({ [field]: 'different' })
        .where(eq(approvals.id, ticket.approvalId))
        .run();
      expect(service.grant(ticket.approvalId)).toBe('incomplete');
    }
  );

  it('keeps the saved full request off the pending HTTP response', async () => {
    ask('echo safe');
    const app = target.mount(
      honoGroupListener({ path: '/api/approvals', routes: createApprovalsRoutes(service) })
    );
    const response = await request(app).get('/api/approvals/pending');
    expect(response.status).toBe(200);
    expect(response.body.approvals).toHaveLength(1);
    expect(response.body.approvals[0]).not.toHaveProperty('packageRequest');
    expect(response.text).not.toContain('packageRequest');
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
    const ticket = ask('x'.repeat(4001));
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
    expect(service.consume(ticket.token, ticket.binding).outcome).toBe('incomplete');
  });
});

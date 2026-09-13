/**
 * The approval driver, against a real loopback HTTP server that records every
 * request it receives.
 *
 * A fake server rather than a mocked `fetch` on purpose. Two of the properties
 * that matter most here are properties of the REQUEST — that a decision carries
 * neither `X-DorkOS-Agent` nor `X-DorkOS-Approval`, which is the entire reason
 * `resolveDecisionAuthority` lets the harness decide at all — and a mocked fetch
 * would let a regression there pass unnoticed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SseFrame } from '@dorkos/test-utils';
import {
  ApprovalDriver,
  UnansweredApprovalPromptError,
  unansweredPromptWatcher,
} from '../approval-driver.js';
import type { ApprovalPolicy } from '../../types.js';

/** One request the fake server saw. */
interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

/** A pending approval the fake server serves until it is decided. */
interface FakeApproval {
  approvalId: string;
  capabilityId: string;
  tier: string;
}

describe('ApprovalDriver', () => {
  let server: http.Server;
  let baseUrl: string;
  let seen: SeenRequest[];
  let pending: FakeApproval[];
  /** Status the session approve/deny routes answer with. */
  let sessionStatus: number;

  beforeEach(async () => {
    seen = [];
    pending = [];
    sessionStatus = 200;
    server = http.createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      if (req.url === '/api/approvals/pending') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ approvals: pending }));
        return;
      }
      const decided = /^\/api\/approvals\/([^/]+)\/(grant|deny)$/.exec(req.url ?? '');
      if (decided) {
        pending = pending.filter((a) => a.approvalId !== decided[1]);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, approvalId: decided[1], outcome: decided[2] }));
        return;
      }
      res.statusCode = sessionStatus;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: sessionStatus === 200 }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A durable `approval_required` frame for the runtime's tool prompt. */
  function prompt(toolCallId: string, toolName: string): SseFrame {
    return {
      event: 'approval_required',
      data: { type: 'approval_required', id: toolCallId, toolName, input: '{}' },
    };
  }

  /** Requests to a given path fragment, in order. */
  function requestsTo(fragment: string): SeenRequest[] {
    return seen.filter((r) => r.url.includes(fragment));
  }

  /** Wait until `check` holds, or fail after `timeoutMs`. */
  async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error('condition never held');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  const allowUninstall: ApprovalPolicy = {
    allowTools: ['marketplace_uninstall'],
    capability: { capabilityId: 'marketplace.uninstall', decision: 'grant' },
  };

  describe('the runtime tool-permission prompt', () => {
    it('allows an allowlisted tool under its MCP-QUALIFIED wire name', async () => {
      const driver = new ApprovalDriver({ baseUrl, policy: allowUninstall });
      driver.start();
      driver.observe([prompt('tc1', 'mcp__dorkos__marketplace_uninstall')], 'sess-1');
      await driver.stop();

      expect(requestsTo('/approve').map((r) => r.url)).toEqual(['/api/sessions/sess-1/approve']);
      expect(driver.log.toolPermissions).toEqual([
        expect.objectContaining({ toolCallId: 'tc1', answer: 'allow', status: 200 }),
      ]);
    });

    it('DENIES a tool outside the allowlist rather than leaving it to stall', async () => {
      // `Bash` is how an agent would delete the directory itself once the gate
      // says no. Denying is the answer; silence would hang the turn for ten
      // minutes, which is the bug this whole driver exists to end.
      const driver = new ApprovalDriver({ baseUrl, policy: allowUninstall });
      driver.start();
      driver.observe([prompt('tc9', 'Bash')], 'sess-1');
      await driver.stop();

      expect(requestsTo('/api/sessions/sess-1/deny')).toHaveLength(1);
      expect(driver.log.toolPermissions).toEqual([
        expect.objectContaining({ toolCallId: 'tc9', toolName: 'Bash', answer: 'deny' }),
      ]);
    });

    it('does not match a tool whose name merely contains the allowed one', async () => {
      const driver = new ApprovalDriver({
        baseUrl,
        policy: { allowTools: ['marketplace_install'] },
      });
      driver.start();
      driver.observe([prompt('tc1', 'mcp__dorkos__marketplace_uninstall')], 'sess-1');
      await driver.stop();
      expect(driver.log.toolPermissions[0]?.answer).toBe('deny');
    });

    it('answers each prompt once, however many times the frame is re-parsed', async () => {
      // The drive loop re-parses the whole raw buffer on every chunk, so the same
      // prompt arrives again and again. Counting frames instead of ids would
      // POST an answer per chunk.
      const driver = new ApprovalDriver({ baseUrl, policy: allowUninstall });
      driver.start();
      const frames = [prompt('tc1', 'mcp__dorkos__marketplace_uninstall')];
      driver.observe(frames, 'sess-1');
      driver.observe(frames, 'sess-1');
      driver.observe([...frames, prompt('tc2', 'mcp__dorkos__marketplace_uninstall')], 'sess-1');
      await driver.stop();

      expect(driver.log.toolPermissions.map((p) => p.toolCallId)).toEqual(['tc1', 'tc2']);
    });

    it('follows a mid-turn session remap to the id the frames arrive on', async () => {
      const driver = new ApprovalDriver({ baseUrl, policy: allowUninstall });
      driver.start();
      driver.observe([prompt('tc1', 'mcp__dorkos__marketplace_uninstall')], 'before-remap');
      driver.observe(
        [
          prompt('tc1', 'mcp__dorkos__marketplace_uninstall'),
          prompt('tc2', 'mcp__dorkos__marketplace_uninstall'),
        ],
        'after-remap'
      );
      await driver.stop();

      expect(requestsTo('/approve').map((r) => r.url)).toEqual([
        '/api/sessions/before-remap/approve',
        '/api/sessions/after-remap/approve',
      ]);
    });

    it('records a refusal from the server as an error rather than throwing', async () => {
      sessionStatus = 409;
      const driver = new ApprovalDriver({ baseUrl, policy: allowUninstall });
      driver.start();
      driver.observe([prompt('tc1', 'mcp__dorkos__marketplace_uninstall')], 'sess-1');
      await driver.stop();

      expect(driver.log.toolPermissions[0]?.status).toBe(409);
      expect(driver.log.errors.join()).toContain('409');
    });

    it('ignores frames that are not approval prompts', async () => {
      const driver = new ApprovalDriver({ baseUrl, policy: allowUninstall });
      driver.start();
      driver.observe(
        [{ event: 'tool_call', data: { type: 'tool_call', toolName: 'marketplace_uninstall' } }],
        'sess-1'
      );
      await driver.stop();
      expect(driver.log.toolPermissions).toEqual([]);
    });
  });

  describe('the capability approval', () => {
    it('grants the capability it was scoped to', async () => {
      pending = [
        { approvalId: 'ap-1', capabilityId: 'marketplace.uninstall', tier: 'destructive' },
      ];
      const driver = new ApprovalDriver({
        baseUrl,
        policy: allowUninstall,
        pollIntervalMs: 10,
      });
      driver.start();
      await until(() => driver.log.decisions.length === 1);
      await driver.stop();

      expect(requestsTo('/grant').map((r) => r.url)).toEqual(['/api/approvals/ap-1/grant']);
      expect(driver.log.decisions[0]).toMatchObject({
        approvalId: 'ap-1',
        capabilityId: 'marketplace.uninstall',
        decision: 'granted',
        status: 200,
      });
    });

    it('denies when the policy says deny, and never grants', async () => {
      pending = [
        { approvalId: 'ap-1', capabilityId: 'marketplace.uninstall', tier: 'destructive' },
      ];
      const driver = new ApprovalDriver({
        baseUrl,
        policy: {
          allowTools: ['marketplace_uninstall'],
          capability: { capabilityId: 'marketplace.uninstall', decision: 'deny' },
        },
        pollIntervalMs: 10,
      });
      driver.start();
      await until(() => driver.log.decisions.length === 1);
      await driver.stop();

      expect(requestsTo('/deny').map((r) => r.url)).toEqual(['/api/approvals/ap-1/deny']);
      expect(requestsTo('/grant')).toEqual([]);
      expect(driver.log.decisions[0]?.decision).toBe('denied');
    });

    it('LEAVES a capability it was not scoped to alone, and records that it did', async () => {
      // The too-broad-decider failure: a driver that answered whatever was
      // pending would make the denied case inherit a yes it never asked for.
      pending = [
        { approvalId: 'ap-other', capabilityId: 'agents.delete', tier: 'destructive' },
        { approvalId: 'ap-1', capabilityId: 'marketplace.uninstall', tier: 'destructive' },
      ];
      const driver = new ApprovalDriver({
        baseUrl,
        policy: allowUninstall,
        pollIntervalMs: 10,
      });
      driver.start();
      await until(() => driver.log.decisions.length === 1);
      await driver.stop();

      expect(driver.log.decisions.map((d) => d.approvalId)).toEqual(['ap-1']);
      expect(driver.log.ignored).toEqual([
        { approvalId: 'ap-other', capabilityId: 'agents.delete' },
      ]);
      expect(seen.some((r) => r.url.includes('ap-other'))).toBe(false);
    });

    it('decides NOTHING when the policy names no capability', async () => {
      pending = [
        { approvalId: 'ap-1', capabilityId: 'marketplace.uninstall', tier: 'destructive' },
      ];
      const driver = new ApprovalDriver({
        baseUrl,
        policy: { allowTools: ['marketplace_uninstall'] },
        pollIntervalMs: 10,
      });
      driver.start();
      await new Promise((r) => setTimeout(r, 80));
      await driver.stop();

      expect(driver.log.decisions).toEqual([]);
      // It does not even poll: with nothing to decide there is nothing to look for.
      expect(requestsTo('/api/approvals')).toEqual([]);
    });

    it('sends neither an agent identity nor an approval token with a decision', async () => {
      // This is what makes the harness a legitimate decider under
      // `resolveDecisionAuthority` instead of a caller the gate must refuse.
      // Either header appearing here turns every governance run into a 403.
      pending = [
        { approvalId: 'ap-1', capabilityId: 'marketplace.uninstall', tier: 'destructive' },
      ];
      const driver = new ApprovalDriver({
        baseUrl,
        policy: allowUninstall,
        pollIntervalMs: 10,
      });
      driver.start();
      await until(() => driver.log.decisions.length === 1);
      await driver.stop();

      const grant = requestsTo('/grant')[0];
      expect(grant?.headers['x-dorkos-agent']).toBeUndefined();
      expect(grant?.headers['x-dorkos-approval']).toBeUndefined();
    });

    it('captures the probe BEFORE the decision is sent', async () => {
      pending = [
        { approvalId: 'ap-1', capabilityId: 'marketplace.uninstall', tier: 'destructive' },
      ];
      let probedBeforeGrant = false;
      const driver = new ApprovalDriver({
        baseUrl,
        policy: allowUninstall,
        pollIntervalMs: 10,
        probe: async () => {
          probedBeforeGrant = requestsTo('/grant').length === 0;
          return { intact: true };
        },
      });
      driver.start();
      await until(() => driver.log.decisions.length === 1);
      await driver.stop();

      expect(probedBeforeGrant).toBe(true);
      expect(driver.log.decisions[0]?.probe).toEqual({ intact: true });
    });

    it('records a failing probe as an error and still decides', async () => {
      pending = [
        { approvalId: 'ap-1', capabilityId: 'marketplace.uninstall', tier: 'destructive' },
      ];
      const driver = new ApprovalDriver({
        baseUrl,
        policy: allowUninstall,
        pollIntervalMs: 10,
        probe: async () => {
          throw new Error('probe blew up');
        },
      });
      driver.start();
      await until(() => driver.log.decisions.length === 1);
      await driver.stop();

      expect(driver.log.errors.join()).toContain('probe blew up');
      expect(driver.log.decisions[0]?.probe).toBeUndefined();
    });

    it('decides an approval once, however many polls see it', async () => {
      pending = [
        { approvalId: 'ap-1', capabilityId: 'marketplace.uninstall', tier: 'destructive' },
      ];
      const driver = new ApprovalDriver({
        baseUrl,
        policy: allowUninstall,
        pollIntervalMs: 5,
      });
      driver.start();
      await until(() => driver.log.decisions.length === 1);
      await new Promise((r) => setTimeout(r, 60));
      await driver.stop();

      expect(driver.log.decisions).toHaveLength(1);
    });

    it('stops polling once stopped', async () => {
      const driver = new ApprovalDriver({
        baseUrl,
        policy: allowUninstall,
        pollIntervalMs: 5,
      });
      driver.start();
      await until(() => requestsTo('/api/approvals/pending').length > 0);
      await driver.stop();
      const after = requestsTo('/api/approvals/pending').length;
      await new Promise((r) => setTimeout(r, 60));
      expect(requestsTo('/api/approvals/pending').length).toBe(after);
    });

    it('answers nothing before start or after stop', async () => {
      const driver = new ApprovalDriver({ baseUrl, policy: allowUninstall });
      driver.observe([prompt('tc0', 'mcp__dorkos__marketplace_uninstall')], 'sess-1');
      driver.start();
      await driver.stop();
      driver.observe([prompt('tc1', 'mcp__dorkos__marketplace_uninstall')], 'sess-1');
      await driver.stop();
      expect(driver.log.toolPermissions).toEqual([]);
    });

    it('survives an unreachable server, recording the fault as evidence', async () => {
      const driver = new ApprovalDriver({
        baseUrl: 'http://127.0.0.1:1',
        policy: allowUninstall,
        pollIntervalMs: 5,
      });
      driver.start();
      driver.observe([prompt('tc1', 'mcp__dorkos__marketplace_uninstall')], 'sess-1');
      await until(() => driver.log.errors.length > 0);
      await driver.stop();
      expect(driver.log.errors.length).toBeGreaterThan(0);
    });
  });
});

describe('unansweredPromptWatcher — the case that forgot its policy', () => {
  /** The same durable prompt frame the driver answers, for a case with no driver. */
  function prompt(toolCallId: string, toolName: string): SseFrame {
    return {
      event: 'approval_required',
      data: { type: 'approval_required', id: toolCallId, toolName, input: '{}' },
    };
  }

  it('throws on the first permission prompt, naming the tool and the fix', () => {
    const watch = unansweredPromptWatcher();
    expect(() => watch([prompt('tc1', 'mcp__dorkos__config_patch')])).toThrow(
      UnansweredApprovalPromptError
    );
    try {
      watch([prompt('tc1', 'mcp__dorkos__config_patch')]);
      expect.unreachable('the watcher must throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UnansweredApprovalPromptError);
      expect((err as Error).message).toContain('mcp__dorkos__config_patch');
      expect((err as Error).message).toContain('approvalPolicy');
    }
  });

  it('recognises the prompt by its payload type as well as its event line', () => {
    const watch = unansweredPromptWatcher();
    expect(() =>
      watch([{ event: '', data: { type: 'approval_required', id: 'tc1', toolName: 'Skill' } }])
    ).toThrow(UnansweredApprovalPromptError);
  });

  it('stays silent for a turn that is never asked for permission', () => {
    // The case this exists to permit: a genuinely read-only turn, whose tools the
    // runtime auto-allows. It must cost such a case nothing.
    const watch = unansweredPromptWatcher();
    expect(() =>
      watch([
        { event: 'turn_start', data: { type: 'turn_start' } },
        { event: 'tool_call', data: { type: 'tool_call', toolName: 'mcp__dorkos__activity_list' } },
        { event: 'turn_end', data: { type: 'turn_end' } },
      ])
    ).not.toThrow();
  });

  it('ignores an approval_required frame that names no tool', () => {
    // The runtime's prompt always names one. A frame carrying the type and no
    // tool is not something the driver could have answered or a case could have
    // written a policy for, so turning it into a red would be a red nobody can
    // act on — the watcher must fire on exactly what the driver answers.
    const watch = unansweredPromptWatcher();
    expect(() =>
      watch([{ event: 'approval_required', data: { type: 'approval_required', id: 'tc1' } }])
    ).not.toThrow();
  });

  it('ignores an approval_required frame with no prompt id', () => {
    const watch = unansweredPromptWatcher();
    expect(() =>
      watch([{ event: 'approval_required', data: { type: 'approval_required', toolName: 'Bash' } }])
    ).not.toThrow();
  });

  it('ignores the capability gate\u2019s own inline card, which is a different event', () => {
    // `capability_approval_required` is the tier gate ASKING, which is the whole
    // subject of the governance cases. It must never trip a guard about prompts
    // nobody answers.
    const watch = unansweredPromptWatcher();
    expect(() =>
      watch([
        {
          event: 'capability_approval_required',
          data: {
            type: 'capability_approval_required',
            approval: { approvalId: 'a1', capabilityId: 'marketplace.uninstall' },
          },
        },
      ])
    ).not.toThrow();
  });

  it('fires on exactly the frames the driver would have answered', () => {
    // One rule, two halves: the driver answers what it can identify, and the
    // watcher fails the case on the same set. A frame either is a prompt for
    // both of them or for neither.
    const answerable = prompt('tc1', 'mcp__dorkos__config_patch');
    const idless = { event: 'approval_required', data: { type: 'approval_required' } } as SseFrame;

    const watch = unansweredPromptWatcher();
    expect(() => watch([answerable])).toThrow(UnansweredApprovalPromptError);
    expect(() => watch([idless])).not.toThrow();

    const driver = new ApprovalDriver({
      baseUrl: 'http://127.0.0.1:1',
      policy: { allowTools: [] },
    });
    driver.start();
    driver.observe([idless], 'sess-1');
    // The driver skipped the id-less frame outright — no answer attempted, so
    // nothing was even recorded against it.
    expect(driver.log.toolPermissions).toHaveLength(0);
  });
});

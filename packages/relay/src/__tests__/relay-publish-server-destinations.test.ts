import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RelayCore } from '../relay-core.js';
import { SERVER_DESTINATION_SENDERS, mayReachServerDestination } from '../lib/reserved-subjects.js';
import { approvalBridgePrincipal } from '../lib/approval-principal.js';
import {
  AGENT_SENDABLE_SERVER_SUBJECTS,
  SERVER_DESTINATION_PREFIXES,
  SERVER_DESTINATION_REFUSAL,
  reachesServerDestination,
  A2A_GATEWAY_PRINCIPAL,
  AGENT_CANCEL_SUBJECT_PREFIX,
  TASK_CANCEL_SUBJECT_PREFIX,
  TASK_SCHEDULER_PRINCIPAL,
} from '@dorkos/shared/relay-schemas';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

/**
 * DOR-2432: an agent cannot send to `relay.system.*` or `relay.control.*`.
 *
 * The agent-facing tools refuse first; these tests drive a REAL RelayCore with
 * no tool in front of it, which is the case the pipeline guard exists for — a
 * publish path that forgot to ask. The other half matters as much: every
 * server publisher to those namespaces must still get through.
 */

describe('the server-destination rule', () => {
  it('pins the agent allowlist: no server-owned subject is sendable by an agent', () => {
    // Adding an entry is a security decision. Change this list only with a
    // reason on the entry saying why its handler is safe to reach.
    expect(AGENT_SENDABLE_SERVER_SUBJECTS).toEqual([]);
    expect(SERVER_DESTINATION_PREFIXES).toEqual(['relay.system.', 'relay.control.']);
  });

  it.each([
    'relay.system.tasks.task-1',
    'relay.system.approval.agent-1',
    'relay.system.console',
    'relay.control.task-cancel.run-1',
    'relay.control.agent-cancel.task-1',
    // A published subject may be a pattern, and a publish reaches every
    // mailbox the pattern matches.
    'relay.*.console',
    'relay.system.>',
    'relay.>',
    '>',
    '*.system.tasks.task-1',
    // The bus matches case-sensitively today; refusing these costs nothing.
    'relay.SYSTEM.tasks.task-1',
    'Relay.Control.task-cancel.run-1',
  ])('reaches a server destination: %s', (subject) => {
    expect(reachesServerDestination(subject)).toBe(true);
  });

  it.each([
    'relay.agent.ns.agent-1',
    'relay.inbox.query.abc',
    'relay.human.console.client-1',
    'relay.systems.tasks',
    'relay.agent.system',
    'relay.system',
    'relay.control',
    'relay.a2a.reply.task.nonce',
  ])('does not reach a server destination: %s', (subject) => {
    expect(reachesServerDestination(subject)).toBe(false);
  });

  it('pins the senders allowed to reach a server destination', () => {
    // An allowlist, so a sender nobody thought of is refused by default.
    // Adding a prefix is a security decision: its reason must say who mints
    // it and why no agent or remote caller can.
    expect(SERVER_DESTINATION_SENDERS.map((sender) => sender.prefix)).toEqual(['relay.system.']);
    for (const sender of SERVER_DESTINATION_SENDERS)
      expect(sender.reason.length).toBeGreaterThan(40);
  });

  it.each([
    [TASK_SCHEDULER_PRINCIPAL, true],
    [A2A_GATEWAY_PRINCIPAL, true],
    ['relay.system.chat.notice', true],
    [approvalBridgePrincipal('slack', 'slack-main'), true],
    [approvalBridgePrincipal('telegram', 'tg-main'), true],
    // The bare senders approval clicks used before DOR-2431; nothing mints them now.
    ['slack:U123', false],
    ['telegram:42', false],
    ['relay.agent.ns.agent-1', false],
    ['relay.session.project-1a2b3c4d', false],
    ['relay.external.mcp', false],
    ['agent:session-1', false],
    ['relay.webhook.hook-1', false],
    ['relay.human.console', false],
    ['relay.bridge.reply.tg1.chat-42', false],
    ['plugin.my-adapter', false],
    ['a2a-gateway', false],
  ])('%s may reach a server destination: %s', (from, expected) => {
    expect(mayReachServerDestination(from)).toBe(expected);
  });
});

describe('publish pipeline — only server senders reach server-owned addresses', () => {
  let tmpDir: string;
  let relay: RelayCore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-server-dest-test-'));
    relay = new RelayCore({ dataDir: tmpDir });
  });

  afterEach(async () => {
    await relay.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function collect(pattern: string): RelayEnvelope[] {
    const received: RelayEnvelope[] = [];
    relay.subscribe(pattern, (envelope) => {
      received.push(envelope);
    });
    return received;
  }

  it.each([
    ['relay.agent.ns.agent-1', 'relay.system.tasks.task-1'],
    ['relay.session.project-1a2b3c4d', 'relay.system.approval.agent-1'],
    ['relay.external.mcp', 'relay.system.tasks.task-1'],
    // An agent answering a message whose reply address was set to a server
    // subject by whoever sent it.
    ['agent:session-1', 'relay.system.approval.agent-1'],
    ['relay.agent.ns.agent-1', `${TASK_CANCEL_SUBJECT_PREFIX}run-1`],
    // Not an agent, and still refused: a webhook whose inbound subject was
    // aimed here, and the console route's caller-chosen sender.
    ['relay.webhook.hook-1', 'relay.system.tasks.task-1'],
    ['relay.human.console', 'relay.system.approval.agent-1'],
    // The pre-DOR-2431 approval senders, now off the allowlist.
    ['telegram:42', 'relay.system.approval.agent-1'],
    ['slack:U123', 'relay.system.approval.agent-1'],
    ['telegram:42', 'relay.system.tasks.task-1'],
  ])('refuses %s -> %s with the rule named, delivering nothing', async (from, subject) => {
    const received = collect(subject);
    await expect(relay.publish(subject, { type: 'forged' }, { from })).rejects.toThrow(
      SERVER_DESTINATION_REFUSAL
    );
    expect(received).toHaveLength(0);
  });

  it('refuses a wildcard that would land in the system console mailbox', async () => {
    await relay.registerEndpoint('relay.system.console');
    await expect(
      relay.publish('relay.*.console', { hi: 1 }, { from: 'relay.agent.ns.agent-1' })
    ).rejects.toThrow(SERVER_DESTINATION_REFUSAL);
    const inbox = await relay.readInbox('relay.system.console');
    expect(inbox.messages).toHaveLength(0);
  });

  it('still lets an agent reach another agent', async () => {
    const received = collect('relay.agent.ns.agent-2');
    const result = await relay.publish(
      'relay.agent.ns.agent-2',
      { hi: 1 },
      { from: 'relay.agent.ns.agent-1' }
    );
    expect(result.deliveredTo).toBe(1);
    expect(received).toHaveLength(1);
  });

  describe('server publishers still get through', () => {
    it('the scheduler dispatches a task run', async () => {
      const received = collect('relay.system.tasks.task-1');
      const result = await relay.publish(
        'relay.system.tasks.task-1',
        { type: 'task_dispatch' },
        { from: TASK_SCHEDULER_PRINCIPAL }
      );
      expect(result.deliveredTo).toBe(1);
      expect(received[0]?.from).toBe(TASK_SCHEDULER_PRINCIPAL);
    });

    it('the scheduler stops a run', async () => {
      const subject = `${TASK_CANCEL_SUBJECT_PREFIX}run-1`;
      const received = collect(subject);
      const result = await relay.publish(
        subject,
        { type: 'task_cancel', runId: 'run-1' },
        { from: TASK_SCHEDULER_PRINCIPAL }
      );
      expect(result.deliveredTo).toBe(1);
      expect(received).toHaveLength(1);
    });

    it('the A2A gateway stops a turn', async () => {
      const subject = `${AGENT_CANCEL_SUBJECT_PREFIX}task-1`;
      const received = collect(subject);
      await relay.publish(subject, { type: 'agent_cancel' }, { from: A2A_GATEWAY_PRINCIPAL });
      expect(received).toHaveLength(1);
    });

    it.each([
      approvalBridgePrincipal('slack', 'slack-main'),
      approvalBridgePrincipal('telegram', 'tg-main'),
    ])('a chat approval bridge (%s) answers a tool approval', async (from) => {
      const received = collect('relay.system.approval.>');
      await relay.publish('relay.system.approval.agent-1', { type: 'approval_response' }, { from });
      expect(received).toHaveLength(1);
    });
  });
});

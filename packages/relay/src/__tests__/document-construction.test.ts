import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RelayCore, consumeServerDocumentRelayOrigin } from '../relay-core.js';
import type { ServerDocumentRelayOrigin } from '../document-delivery.js';

let directory: string;
let constructed: ReturnType<typeof RelayCore.createServerDocumentRelay>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'original-doc-relay-'));
  constructed = RelayCore.createServerDocumentRelay({ dataDir: directory });
});
afterEach(async () => {
  await constructed.relay.close();
  await rm(directory, { recursive: true, force: true });
});

describe('original server document construction', () => {
  it('refuses forged and replayed origins without replacing the original binding', () => {
    expect(() => consumeServerDocumentRelayOrigin({} as ServerDocumentRelayOrigin)).toThrow(
      'DOCUMENT_RELAY_ORIGIN_REQUIRED'
    );
    const access = consumeServerDocumentRelayOrigin(constructed.origin);
    expect(() => consumeServerDocumentRelayOrigin(constructed.origin)).toThrow(
      'DOCUMENT_RELAY_ORIGIN_REQUIRED'
    );
    expect(() => access.requireOpen()).not.toThrow();
  });

  it('rejects ordinary default allow and uses the original bus explicit rule', () => {
    const access = consumeServerDocumentRelayOrigin(constructed.origin);
    expect(() => access.requireExplicitOpenerAccess('opener', 'target')).toThrow(
      'DOCUMENT_RELAY_EXPLICIT_OPENER_ACL_REQUIRED'
    );
    constructed.relay.addAccessRule({
      from: 'relay.agent.opener',
      to: 'relay.agent.target',
      action: 'allow',
      priority: 100,
    });
    expect(() => access.requireExplicitOpenerAccess('opener', 'target')).not.toThrow();
    expect(() => access.requireExplicitOpenerAccess('other', 'target')).toThrow(
      'DOCUMENT_RELAY_EXPLICIT_OPENER_ACL_REQUIRED'
    );
    constructed.relay.addAccessRule({
      from: 'relay.agent.opener',
      to: 'relay.agent.target',
      action: 'deny',
      priority: 200,
    });
    expect(() => access.requireExplicitOpenerAccess('opener', 'target')).toThrow(
      'DOCUMENT_RELAY_EXPLICIT_OPENER_ACL_REQUIRED'
    );
  });

  it('does not permit identifiers to supply subject wildcards or another namespace', () => {
    const access = consumeServerDocumentRelayOrigin(constructed.origin);
    for (const identifier of ['*', '>', 'opener.other', '', 'x'.repeat(201)]) {
      expect(() => access.requireExplicitOpenerAccess(identifier, 'target')).toThrow(
        'DOCUMENT_RELAY_AGENT_ID_INVALID'
      );
    }
  });

  it('revokes a captured original access view when its actual bus closes', async () => {
    const access = consumeServerDocumentRelayOrigin(constructed.origin);
    await constructed.relay.close();
    expect(() => access.requireOpen()).toThrow('RelayCore has been closed');
    expect(() => access.requireExplicitOpenerAccess('opener', 'target')).toThrow(
      'RelayCore has been closed'
    );
  });

  it('consumes a closed original rather than making its origin reusable', async () => {
    await constructed.relay.close();
    expect(() => consumeServerDocumentRelayOrigin(constructed.origin)).toThrow(
      'RelayCore has been closed'
    );
    expect(() => consumeServerDocumentRelayOrigin(constructed.origin)).toThrow(
      'DOCUMENT_RELAY_ORIGIN_REQUIRED'
    );
  });

  it('public system senders cannot publish document destinations or assert document origins', async () => {
    const handler = vi.fn();
    constructed.relay.subscribe('relay.doc.>', handler);
    for (const subject of ['relay.doc', 'relay.doc.document', 'RELAY.DOC.document']) {
      await expect(
        constructed.relay.publish(subject, {}, { from: 'relay.system.test' })
      ).rejects.toThrow('DOCUMENT_RELAY_CONSTRUCTION_REQUIRED');
    }
    await expect(
      constructed.relay.publish('relay.agent.target', {}, { from: 'relay.doc.document' })
    ).rejects.toThrow('DOCUMENT_RELAY_CONSTRUCTION_REQUIRED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('public signals cannot assert document destinations or document endpoint origins', () => {
    const handler = vi.fn();
    const signal = {
      type: 'presence' as const,
      state: 'online',
      endpointSubject: 'relay.system.test',
      timestamp: '2026-10-04T00:00:00.000Z',
    };
    constructed.relay.onSignal('relay.doc.>', handler);
    expect(() => constructed.relay.signal('relay.doc.document', signal)).toThrow(
      'DOCUMENT_RELAY_CONSTRUCTION_REQUIRED'
    );
    expect(() =>
      constructed.relay.signal('relay.agent.target', {
        ...signal,
        endpointSubject: 'relay.doc.document',
      })
    ).toThrow('DOCUMENT_RELAY_CONSTRUCTION_REQUIRED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('public mailboxes and private notification callbacks cannot shadow a document sink', async () => {
    for (const subject of ['relay.doc', 'relay.doc.document', 'RELAY.DOC.document']) {
      await expect(constructed.relay.registerEndpoint(subject)).rejects.toThrow(
        'DOCUMENT_RELAY_CONSTRUCTION_REQUIRED'
      );
    }
    expect(constructed.relay.listEndpoints()).toHaveLength(0);
    const authorizeDispatch = vi.fn(() => true);
    await expect(
      constructed.relay.deliverPrivateNotification('relay.human.slack.channel', 'text', {
        adapterId: 'slack',
        from: 'relay.doc.document',
        authorizeDispatch,
      })
    ).rejects.toThrow('DOCUMENT_RELAY_CONSTRUCTION_REQUIRED');
    expect(authorizeDispatch).not.toHaveBeenCalled();
  });
  it('captured origin refuses reflected currentness and ACL replacements', async () => {
    const access = consumeServerDocumentRelayOrigin(constructed.origin);
    const replacementCheck = vi.fn(() => ({ allowed: true, matchedRule: { action: 'allow' } }));
    Object.assign(constructed.relay, {
      assertOpen: vi.fn(),
      closed: false,
      accessControl: { checkAccess: replacementCheck },
    });
    expect(() => access.requireExplicitOpenerAccess('opener', 'target')).toThrow(
      'DOCUMENT_RELAY_EXPLICIT_OPENER_ACL_REQUIRED'
    );
    constructed.relay.addAccessRule({
      from: 'relay.agent.opener',
      to: 'relay.agent.target',
      action: 'allow',
      priority: 100,
    });
    expect(() => access.requireExplicitOpenerAccess('opener', 'target')).not.toThrow();
    constructed.relay.addAccessRule({
      from: 'relay.agent.opener',
      to: 'relay.agent.target',
      action: 'deny',
      priority: 200,
    });
    expect(() => access.requireExplicitOpenerAccess('opener', 'target')).toThrow(
      'DOCUMENT_RELAY_EXPLICIT_OPENER_ACL_REQUIRED'
    );
    await constructed.relay.close();
    Object.assign(constructed.relay, { closed: false });
    expect(() => access.requireOpen()).toThrow('RelayCore has been closed');
    expect(replacementCheck).not.toHaveBeenCalled();
  });
});

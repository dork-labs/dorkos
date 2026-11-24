import { describe, it, expect } from 'vitest';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import { TASK_SCHEDULER_PRINCIPAL } from '@dorkos/shared/relay-schemas';
import {
  bindingAllowsInitiate,
  bindingAllowsReply,
  createInitiateConsentGate,
  createAgentSubjectResolver,
  isConsentExemptPrincipal,
  isServerOnlyPrincipal,
  type ConsentBindingStore,
} from '../initiate-consent.js';
import { buildBridgePrincipal } from '../bridge-principal.js';

/** Build a binding with initiate-relevant fields, defaulting to a permissive DM. */
function makeBinding(overrides: Partial<AdapterBinding> = {}): AdapterBinding {
  return {
    id: 'b-1',
    adapterId: 'tg1',
    agentId: 'agent-1',
    sessionStrategy: 'per-chat',
    enabled: true,
    canInitiate: true,
    canReply: true,
    canReceive: true,
    notifyOnTaskComplete: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AdapterBinding;
}

/**
 * A store that resolves the binding ONLY for the expected channel and fails the
 * test otherwise: a double that ignored its arguments let a gate resolving
 * consent from the wrong channel stay green.
 */
function storeFor(
  binding: AdapterBinding | undefined,
  expectedChatId = 'chat-42'
): ConsentBindingStore {
  return {
    resolve: (adapterId, chatId) => {
      expect(adapterId).toBe('tg1');
      expect(chatId).toBe(expectedChatId);
      return binding;
    },
  };
}

const HUMAN = 'relay.human.telegram.tg1.chat-42';
const AGENT = 'relay.agent.ns.agent-1';
const OTHER_AGENT = 'relay.agent.ns.agent-2';

/** The mesh lookup: the bound agent `agent-1` publishes as {@link AGENT}. */
const resolveAgentSubject = (agentId: string): string | undefined =>
  agentId === 'agent-1' ? AGENT : undefined;

/** A gate over one binding, wired to the mesh lookup above. */
function gateFor(binding: AdapterBinding | undefined, expectedChatId?: string) {
  return createInitiateConsentGate({
    bindingStore: storeFor(binding, expectedChatId),
    resolveAgentSubject,
  });
}

describe('binding predicates', () => {
  it.each([
    [{ enabled: true, canInitiate: true, canReply: true }, true, true],
    [{ enabled: true, canInitiate: false, canReply: false }, false, false],
    [{ enabled: false, canInitiate: true, canReply: true }, false, false],
  ])('%o allows initiate=%s, reply=%s (DOR-871)', (fields, initiate, reply) => {
    expect(bindingAllowsInitiate(makeBinding(fields))).toBe(initiate);
    expect(bindingAllowsReply(makeBinding(fields))).toBe(reply);
  });
});

describe('isConsentExemptPrincipal vs isServerOnlyPrincipal (A11.3)', () => {
  // The two predicates cannot be collapsed: bridge and Doc senders are
  // server-only but never consent-exempt. The task scheduler must stay exempt,
  // because exemption is what makes `POST /api/relay/messages` refuse a caller
  // spoofing it (DOR-808).
  it('classifies each principal on both predicates', () => {
    const cases: [string, boolean, boolean][] = [
      ['agent:session-abc', true, true],
      ['relay.system.tasks.notifier', true, true],
      [TASK_SCHEDULER_PRINCIPAL, true, true],
      ['relay.human.telegram.tg1.bot', true, true],
      ['relay.human.slack.s1.bot', true, true],
      [buildBridgePrincipal('reply', 'tg1', 'chat-42'), false, true],
      [buildBridgePrincipal('initiate', 'tg1', 'chat-42'), false, true],
      ['relay.doc', false, true],
      ['relay.doc.canvas-hash', false, true],
      ['relay.docx.canvas-hash', false, false],
      ['relay.human.console', false, false],
      ['relay.human.console.client-9', false, false],
      ['relay.agent.ns.agent-1', false, false],
      ['relay.session.scratch', false, false],
      ['relay.external.mcp', false, false],
      ['relay.human.telegram.tg1.chat-42', false, false],
    ];
    for (const [principal, exempt, serverOnly] of cases) {
      expect(isConsentExemptPrincipal(principal), principal).toBe(exempt);
      expect(isServerOnlyPrincipal(principal), principal).toBe(serverOnly);
    }
  });
});

describe('createInitiateConsentGate (DOR-277)', () => {
  it.each([
    // Agent-initiated principals are gated by canInitiate and enabled.
    [
      'the bound agent, canInitiate off',
      AGENT,
      { canInitiate: false },
      false,
      'INITIATE_NOT_ALLOWED',
    ],
    ['the bound agent, consenting', AGENT, {}, true, undefined],
    ['the bound agent, binding paused', AGENT, { enabled: false }, false, undefined],
    // Consent belongs to the agent it was granted to.
    ['a different agent on a consenting binding', OTHER_AGENT, {}, false, 'INITIATE_NOT_ALLOWED'],
    ['an unregistered session', 'relay.session.scratch', {}, false, undefined],
    ['the external MCP principal', 'relay.external.mcp', {}, false, undefined],
    ['a bound agent no longer in the mesh', AGENT, { agentId: 'ghost' }, false, 'NO_BINDING'],
    // The operator's console owns every binding here, but not past canInitiate.
    ['the console', 'relay.human.console', {}, true, undefined],
    ['a console client', 'relay.human.console.client-9', {}, true, undefined],
    [
      'the console, canInitiate off',
      'relay.human.console',
      { canInitiate: false },
      false,
      undefined,
    ],
    // Trusted server-injected principals bypass consent entirely.
    [
      'the reply-forwarding principal',
      'agent:session-abc',
      { canInitiate: false },
      true,
      undefined,
    ],
    ['the task notifier', 'relay.system.tasks.notifier', { canInitiate: false }, true, undefined],
    [
      'an inbound bot echo',
      'relay.human.telegram.tg1.bot',
      { canInitiate: false },
      true,
      undefined,
    ],
  ])('%s', (_label, from, overrides, allowed, code) => {
    const decision = gateFor(makeBinding(overrides as Partial<AdapterBinding>))(from, HUMAN);
    expect(decision.allowed).toBe(allowed);
    if (code) expect(decision.code).toBe(code);
  });

  it('denies fail-closed, naming the sender, when nothing resolves', () => {
    expect(gateFor(undefined)(AGENT, HUMAN)).toMatchObject({ allowed: false, code: 'NO_BINDING' });
    expect(gateFor(makeBinding())(OTHER_AGENT, HUMAN).reason).toContain(OTHER_AGENT);
  });

  it.each([['relay.agent.ns.other'], ['relay.human.console.client-9']])(
    'does not gate a send to %s',
    (subject) => {
      expect(gateFor(makeBinding({ canInitiate: false }))(AGENT, subject).allowed).toBe(true);
    }
  );
});

describe('createAgentSubjectResolver — by id, never by path (DOR-790)', () => {
  it('is not fooled by two agents whose project paths collide', () => {
    const collidingMesh = {
      inspect: (agentId: string) =>
        agentId === 'agent-1' ? { relaySubject: AGENT } : { relaySubject: OTHER_AGENT },
      getProjectPath: () => '/shared/path',
      getSubjectByPath: () => ({ subject: OTHER_AGENT, agentId: 'agent-2' }),
    };
    const gate = createInitiateConsentGate({
      bindingStore: storeFor(makeBinding()),
      resolveAgentSubject: createAgentSubjectResolver(collidingMesh),
    });
    expect(gate(OTHER_AGENT, HUMAN).allowed).toBe(false);
    expect(gate(AGENT, HUMAN).allowed).toBe(true);
  });

  it('resolves nothing for an unknown agent, a subjectless entry, or no mesh', () => {
    expect(createAgentSubjectResolver({ inspect: () => undefined })('ghost')).toBeUndefined();
    expect(
      createAgentSubjectResolver({ inspect: () => ({ relaySubject: null }) })('agent-1')
    ).toBeUndefined();
    expect(createAgentSubjectResolver(undefined)('agent-1')).toBeUndefined();
  });
});

describe('createInitiateConsentGate — the relay.bridge.* branch (DOR-871, spec §6.6)', () => {
  it.each([
    ['case 1: reply, canReply on', 'reply', { canReply: true }, true],
    ['case 2: reply, canReply off', 'reply', { canReply: false }, false],
    ['cases 3 & 5: initiate, canInitiate on', 'initiate', { canInitiate: true }, true],
    ['cases 4 & 6: initiate, canInitiate off', 'initiate', { canInitiate: false }, false],
    ['case 7: reply on a paused binding', 'reply', { enabled: false, canReply: true }, false],
    // Cases 9 & 10: whatever deliver classified as initiate is held to canInitiate.
    [
      'cases 9 & 10: initiate, canReply on',
      'initiate',
      { canInitiate: false, canReply: true },
      false,
    ],
  ] as const)('%s', (_label, classification, overrides, allowed) => {
    const from = buildBridgePrincipal(classification, 'tg1', 'chat-42');
    const decision = gateFor(makeBinding(overrides))(from, HUMAN);
    expect(decision.allowed).toBe(allowed);
    if (!allowed && !('enabled' in overrides)) expect(decision.code).toBe('INITIATE_NOT_ALLOWED');
  });

  it("resolves consent from the SUBJECT, never the principal's claimed channel (confused deputy)", () => {
    const store: ConsentBindingStore = {
      resolve: (adapterId, chatId) => {
        if (adapterId === 'tg1' && chatId === 'chat-42') return makeBinding({ canReply: false });
        if (adapterId === 'tg1' && chatId === 'decoy-chat') return makeBinding({ canReply: true });
        throw new Error(`unexpected resolve(${adapterId}, ${chatId})`);
      },
    };
    const gate = createInitiateConsentGate({ bindingStore: store, resolveAgentSubject });
    expect(gate(buildBridgePrincipal('reply', 'tg1', 'decoy-chat'), HUMAN).allowed).toBe(false);
  });

  it('refuses a malformed principal before resolving any binding', () => {
    const gate = createInitiateConsentGate({
      bindingStore: {
        resolve: () => {
          throw new Error('bindingStore.resolve must not be called');
        },
      },
      resolveAgentSubject,
    });
    expect(gate('relay.bridge.delete.tg1.chat-42', HUMAN)).toMatchObject({
      allowed: false,
      code: 'MALFORMED_BRIDGE_PRINCIPAL',
    });
  });

  it('denies NO_BINDING when nothing resolves for the target channel', () => {
    const decision = gateFor(undefined)(buildBridgePrincipal('reply', 'tg1', 'chat-42'), HUMAN);
    expect(decision).toMatchObject({ allowed: false, code: 'NO_BINDING' });
  });

  it('parses a dotted chat id positionally and still checks the right switch', () => {
    const chat = 'chat.42.with.dots';
    const subject = `relay.human.telegram.tg1.${chat}`;
    const replyGate = gateFor(makeBinding({ canReply: false, canInitiate: true }), chat);
    expect(replyGate(buildBridgePrincipal('reply', 'tg1', chat), subject).allowed).toBe(false);
    const initiateGate = gateFor(makeBinding({ canReply: true, canInitiate: false }), chat);
    expect(initiateGate(buildBridgePrincipal('initiate', 'tg1', chat), subject).allowed).toBe(
      false
    );
  });

  it('does not require the sender to be a registered mesh agent', () => {
    const gate = createInitiateConsentGate({
      bindingStore: storeFor(makeBinding({ canReply: true })),
      resolveAgentSubject: () => undefined,
    });
    expect(gate(buildBridgePrincipal('reply', 'tg1', 'chat-42'), HUMAN)).toEqual({ allowed: true });
  });
});

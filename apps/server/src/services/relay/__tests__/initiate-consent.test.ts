import { describe, it, expect } from 'vitest';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
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
import { TASK_SCHEDULER_PRINCIPAL } from '@dorkos/shared/relay-schemas';

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
 * A store that resolves the given binding for the expected channel, and nothing
 * for any other.
 *
 * It used to ignore its arguments entirely, which meant every gate test passed
 * whether or not the gate looked the channel up at all — a double that cannot
 * fail the thing it exists to check.
 */
function storeFor(binding: AdapterBinding | undefined): ConsentBindingStore {
  return {
    resolve: (adapterId, chatId) => {
      expect(adapterId).toBe('tg1');
      expect(chatId).toBe('chat-42');
      return binding;
    },
  };
}

/** The canonical agent-initiated subject for tg1/chat-42. */
const HUMAN = 'relay.human.telegram.tg1.chat-42';
/** A registered agent's server-injected principal. */
const AGENT = 'relay.agent.ns.agent-1';
/** Another registered agent on the same machine — not the bound one. */
const OTHER_AGENT = 'relay.agent.ns.agent-2';

/** The mesh lookup: the bound agent `agent-1` publishes as {@link AGENT}. */
const resolveAgentSubject = (agentId: string): string | undefined =>
  agentId === 'agent-1' ? AGENT : undefined;

/**
 * Build a gate over one binding, wired to the mesh lookup above.
 *
 * @param binding - The binding the store resolves, or undefined for none.
 */
function gateFor(binding: AdapterBinding | undefined) {
  return createInitiateConsentGate({ bindingStore: storeFor(binding), resolveAgentSubject });
}

describe('bindingAllowsInitiate (shared consent predicate)', () => {
  it('is true only when enabled AND canInitiate', () => {
    expect(bindingAllowsInitiate(makeBinding({ enabled: true, canInitiate: true }))).toBe(true);
    expect(bindingAllowsInitiate(makeBinding({ enabled: true, canInitiate: false }))).toBe(false);
    expect(bindingAllowsInitiate(makeBinding({ enabled: false, canInitiate: true }))).toBe(false);
  });
});

describe('isConsentExemptPrincipal (trusted server-injected principals)', () => {
  it('exempts reply-forwarding, system, and inbound adapter-echo principals', () => {
    expect(isConsentExemptPrincipal('agent:session-abc')).toBe(true);
    expect(isConsentExemptPrincipal('relay.system.tasks.notifier')).toBe(true);
    expect(isConsentExemptPrincipal('relay.human.telegram.tg1.bot')).toBe(true);
    expect(isConsentExemptPrincipal('relay.human.slack.s1.bot')).toBe(true);
  });

  it('exempts the task scheduler — which is what stops HTTP callers spoofing it', () => {
    // Load-bearing coupling, stated because it is invisible at both ends. The
    // adapter refuses a run stop request whose `from` is not this principal
    // (DOR-808), and the only reason a curl caller cannot simply assert it is
    // that `POST /api/relay/messages` REJECTS every principal this predicate
    // exempts. That rejection holds because the name sits under
    // `relay.system.`. Rename it into a namespace this predicate does not
    // cover — `relay.control.scheduler`, say — and the route would start
    // accepting it, handing anyone with the port the ability to stop any run.
    expect(isConsentExemptPrincipal(TASK_SCHEDULER_PRINCIPAL)).toBe(true);
  });

  it('does NOT exempt the console, agents, sessions, or arbitrary human ids', () => {
    // The console is gated like any agent-initiated principal (its only exempt
    // targets are agents + relay.human.console.*, handled by the gate directly).
    expect(isConsentExemptPrincipal('relay.human.console')).toBe(false);
    expect(isConsentExemptPrincipal('relay.human.console.client-9')).toBe(false);
    expect(isConsentExemptPrincipal('relay.agent.ns.agent-1')).toBe(false);
    expect(isConsentExemptPrincipal('relay.session.scratch')).toBe(false);
    expect(isConsentExemptPrincipal('relay.external.mcp')).toBe(false);
    // A human chat identity that is not the `.bot` echo must not be exempt.
    expect(isConsentExemptPrincipal('relay.human.telegram.tg1.chat-42')).toBe(false);
  });
});

describe('createInitiateConsentGate — the DOR-277 delivery-layer gate', () => {
  describe('agent-initiated principals are GATED', () => {
    it('denies an agent send when canInitiate is off', () => {
      const gate = gateFor(makeBinding({ canInitiate: false }));
      const d = gate(AGENT, HUMAN);
      expect(d.allowed).toBe(false);
      expect(d.code).toBe('INITIATE_NOT_ALLOWED');
    });

    it('allows an agent send when the binding is enabled and canInitiate', () => {
      const gate = gateFor(makeBinding({ canInitiate: true }));
      expect(gate(AGENT, HUMAN).allowed).toBe(true);
    });

    it('denies an agent send when the binding is paused (enabled=false)', () => {
      const gate = gateFor(makeBinding({ enabled: false, canInitiate: true }));
      expect(gate(AGENT, HUMAN).allowed).toBe(false);
    });

    it('denies fail-closed when no binding resolves (guessed/unbound integration)', () => {
      const gate = gateFor(undefined);
      const d = gate(AGENT, HUMAN);
      expect(d.allowed).toBe(false);
      expect(d.code).toBe('NO_BINDING');
    });

    it('gates a non-registered session principal', () => {
      const gate = gateFor(makeBinding({ canInitiate: false }));
      expect(gate('relay.session.scratch', HUMAN).allowed).toBe(false);
    });

    it('gates the external MCP principal', () => {
      const gate = gateFor(makeBinding({ canInitiate: false }));
      expect(gate('relay.external.mcp', HUMAN).allowed).toBe(false);
    });

    it('gates the in-app console principal reaching an EXTERNAL integration', () => {
      // The console operator (or a spoofer of it) may not start a conversation
      // on a bound external integration when canInitiate is off.
      const gate = gateFor(makeBinding({ canInitiate: false }));
      expect(gate('relay.human.console', HUMAN).allowed).toBe(false);
    });
  });

  describe('trusted server-injected principals are EXEMPT', () => {
    // A canInitiate=false binding is used throughout to prove the bypass is by
    // principal, not because consent happened to be on.
    const gate = gateFor(makeBinding({ canInitiate: false }));

    it('allows the reply-forwarding principal (agent:) — replies always flow', () => {
      expect(gate('agent:session-abc', HUMAN).allowed).toBe(true);
    });

    it('allows the task-completion notifier system principal', () => {
      expect(gate('relay.system.tasks.notifier', HUMAN).allowed).toBe(true);
    });

    it('allows an inbound bot-echo human principal', () => {
      expect(gate('relay.human.telegram.tg1.bot', HUMAN).allowed).toBe(true);
    });
  });

  describe('consent belongs to the agent it was granted to', () => {
    // `canInitiate` is a switch flipped for ONE agent on ONE channel. Checking
    // only the channel made it a property of the channel: every agent and
    // session on the machine could reach that chat as the user's own bot, on a
    // permission somebody else was given.

    it('allows the agent the binding names', () => {
      expect(gateFor(makeBinding({ agentId: 'agent-1' }))(AGENT, HUMAN).allowed).toBe(true);
    });

    it('denies a different agent riding a consenting binding', () => {
      const decision = gateFor(makeBinding({ agentId: 'agent-1' }))(OTHER_AGENT, HUMAN);
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('INITIATE_NOT_ALLOWED');
      expect(decision.reason).toContain(OTHER_AGENT);
    });

    it('denies an unregistered session principal even when the channel consents', () => {
      expect(
        gateFor(makeBinding({ agentId: 'agent-1' }))('relay.session.scratch', HUMAN).allowed
      ).toBe(false);
    });

    it('denies the external MCP principal even when the channel consents', () => {
      expect(
        gateFor(makeBinding({ agentId: 'agent-1' }))('relay.external.mcp', HUMAN).allowed
      ).toBe(false);
    });

    it('denies when the bound agent is no longer in the mesh', () => {
      // Nothing can be shown to be that agent, so nothing is treated as it.
      const decision = gateFor(makeBinding({ agentId: 'ghost' }))(AGENT, HUMAN);
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('NO_BINDING');
    });

    it("lets the operator's own console through — they own every binding here", () => {
      expect(
        gateFor(makeBinding({ agentId: 'agent-1' }))('relay.human.console', HUMAN).allowed
      ).toBe(true);
      expect(
        gateFor(makeBinding({ agentId: 'agent-1' }))('relay.human.console.client-9', HUMAN).allowed
      ).toBe(true);
    });

    it('still refuses the console when the channel itself says no', () => {
      // Sender scoping exempts the console; `canInitiate` does not.
      expect(
        gateFor(makeBinding({ agentId: 'agent-1', canInitiate: false }))(
          'relay.human.console',
          HUMAN
        ).allowed
      ).toBe(false);
    });
  });

  describe('targets outside the external-human channel are not gated', () => {
    const gate = gateFor(makeBinding({ canInitiate: false }));

    it('allows agent→agent sends (relay.agent.*)', () => {
      expect(gate(AGENT, 'relay.agent.ns.other').allowed).toBe(true);
    });

    it('allows agent→console sends (relay.human.console.*) — the operator’s own UI', () => {
      expect(gate(AGENT, 'relay.human.console.client-9').allowed).toBe(true);
    });
  });
});

describe('createAgentSubjectResolver — by id, never by path', () => {
  // The id → projectPath → subject round trip is not a bijection: the mesh can
  // hold two agents whose project paths collide (DOR-790), so it can hand back
  // a different agent's subject than the one it was asked about. In a consent
  // gate that is an authorization decision made about the wrong principal.

  /** A mesh where the path round trip would cross agent-1 with agent-2. */
  const collidingMesh = {
    inspect: (agentId: string) =>
      agentId === 'agent-1' ? { relaySubject: AGENT } : { relaySubject: OTHER_AGENT },
    // Present so a resolver that reached for them would compile and be caught
    // by the assertions below rather than by a type error.
    getProjectPath: () => '/shared/path',
    getSubjectByPath: () => ({ subject: OTHER_AGENT, agentId: 'agent-2' }),
  };

  it('resolves the subject the registry holds for that id', () => {
    expect(createAgentSubjectResolver(collidingMesh)('agent-1')).toBe(AGENT);
  });

  it('is not fooled by a colliding project path', () => {
    // Via the path round trip this would be OTHER_AGENT, and the gate would
    // then allow agent-2 to send on agent-1's binding.
    const gate = createInitiateConsentGate({
      bindingStore: storeFor(makeBinding({ agentId: 'agent-1' })),
      resolveAgentSubject: createAgentSubjectResolver(collidingMesh),
    });

    expect(gate(OTHER_AGENT, HUMAN).allowed).toBe(false);
    expect(gate(AGENT, HUMAN).allowed).toBe(true);
  });

  it('denies when the agent is not registered', () => {
    const resolver = createAgentSubjectResolver({ inspect: () => undefined });
    expect(resolver('ghost')).toBeUndefined();
  });

  it('denies when the registry entry names no subject', () => {
    const resolver = createAgentSubjectResolver({ inspect: () => ({ relaySubject: null }) });
    expect(resolver('agent-1')).toBeUndefined();
  });

  it('denies when this server has no mesh at all', () => {
    expect(createAgentSubjectResolver(undefined)('agent-1')).toBeUndefined();
  });
});

describe('bindingAllowsReply (DOR-871: canReply was unenforced before this)', () => {
  it('is true only when enabled AND canReply', () => {
    expect(bindingAllowsReply(makeBinding({ enabled: true, canReply: true }))).toBe(true);
    expect(bindingAllowsReply(makeBinding({ enabled: true, canReply: false }))).toBe(false);
    expect(bindingAllowsReply(makeBinding({ enabled: false, canReply: true }))).toBe(false);
  });
});

describe('isServerOnlyPrincipal vs isConsentExemptPrincipal — pinned apart (A11.3, §13)', () => {
  // The exempt set structurally enumerated, not asserted by prose: exactly
  // these three branches, both before and after this change.
  const EXEMPT_PRINCIPALS = [
    'agent:session-abc', // reply-forwarding
    'relay.system.tasks.notifier', // system
    'relay.human.telegram.tg1.bot', // inbound adapter echo
  ];

  it('isConsentExemptPrincipal accepts exactly the three exempt principals', () => {
    for (const p of EXEMPT_PRINCIPALS) {
      expect(isConsentExemptPrincipal(p)).toBe(true);
    }
    expect(isConsentExemptPrincipal('relay.human.console')).toBe(false);
    expect(isConsentExemptPrincipal('relay.agent.ns.agent-1')).toBe(false);
  });

  it('isConsentExemptPrincipal still answers false for relay.bridge.* — the two predicates cannot be collapsed', () => {
    // This is the paired assertion the spec calls out by name: a later edit
    // that merges the two predicates (e.g. by adding the bridge branch here
    // too) breaks this test even though isServerOnlyPrincipal below would
    // still look correct.
    expect(isConsentExemptPrincipal(buildBridgePrincipal('reply', 'tg1', 'chat-42'))).toBe(false);
    expect(isConsentExemptPrincipal(buildBridgePrincipal('initiate', 'tg1', 'chat-42'))).toBe(
      false
    );
  });

  it('isServerOnlyPrincipal accepts the three exempt principals plus relay.bridge.*', () => {
    for (const p of EXEMPT_PRINCIPALS) {
      expect(isServerOnlyPrincipal(p)).toBe(true);
    }
    expect(isServerOnlyPrincipal(buildBridgePrincipal('reply', 'tg1', 'chat-42'))).toBe(true);
    expect(isServerOnlyPrincipal(buildBridgePrincipal('initiate', 'tg1', 'chat-42'))).toBe(true);
  });

  it('isServerOnlyPrincipal rejects relay.human.console and relay.agent.*', () => {
    expect(isServerOnlyPrincipal('relay.human.console')).toBe(false);
    expect(isServerOnlyPrincipal('relay.agent.ns.agent-1')).toBe(false);
  });
});

describe('createInitiateConsentGate — the relay.bridge.* branch (DOR-871, spec §6.6)', () => {
  /**
   * An asserting double, mirroring {@link storeFor} above (:41-48): resolves
   * the given binding ONLY for the exact `(adapterId, chatId)` expected, and
   * fails the test otherwise.
   *
   * A double that ignores its arguments (`resolve: () => binding`) cannot
   * fail when the gate resolves consent from the wrong channel — a security
   * review mutation (resolve from the PRINCIPAL's `(adapterId, chatId)`
   * instead of the SUBJECT's, the exact confused-deputy shape spec §6.6
   * point 2 forbids) stayed green against exactly that shape of double. This
   * one would catch it: a resolve call for any other pair throws inside the
   * `expect`, failing the test loudly rather than quietly returning the
   * wrong binding.
   */
  function storeExpecting(
    binding: AdapterBinding | undefined,
    expectedAdapterId: string,
    expectedChatId: string
  ): ConsentBindingStore {
    return {
      resolve: (adapterId, chatId) => {
        expect(adapterId).toBe(expectedAdapterId);
        expect(chatId).toBe(expectedChatId);
        return binding;
      },
    };
  }

  it('table case 1: reply, canReply true -> delivered', () => {
    const gate = createInitiateConsentGate({
      bindingStore: storeExpecting(makeBinding({ canReply: true }), 'tg1', 'chat-42'),
      resolveAgentSubject,
    });
    const from = buildBridgePrincipal('reply', 'tg1', 'chat-42');
    expect(gate(from, HUMAN)).toEqual({ allowed: true });
  });

  it('table case 2: reply, canReply false -> blocked (the test that would have passed vacuously before this spec)', () => {
    const gate = createInitiateConsentGate({
      bindingStore: storeExpecting(makeBinding({ canReply: false }), 'tg1', 'chat-42'),
      resolveAgentSubject,
    });
    const from = buildBridgePrincipal('reply', 'tg1', 'chat-42');
    const decision = gate(from, HUMAN);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('INITIATE_NOT_ALLOWED');
  });

  it('table cases 3 & 5: initiate (cockpit post or scheduled task), canInitiate true -> delivered', () => {
    const gate = createInitiateConsentGate({
      bindingStore: storeExpecting(makeBinding({ canInitiate: true }), 'tg1', 'chat-42'),
      resolveAgentSubject,
    });
    const from = buildBridgePrincipal('initiate', 'tg1', 'chat-42');
    expect(gate(from, HUMAN)).toEqual({ allowed: true });
  });

  it('table cases 4 & 6: initiate (cockpit post or scheduled task), canInitiate false -> blocked', () => {
    const gate = createInitiateConsentGate({
      bindingStore: storeExpecting(makeBinding({ canInitiate: false }), 'tg1', 'chat-42'),
      resolveAgentSubject,
    });
    const from = buildBridgePrincipal('initiate', 'tg1', 'chat-42');
    const decision = gate(from, HUMAN);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('INITIATE_NOT_ALLOWED');
  });

  it('table case 7: inbound root (reply), binding paused (enabled: false) -> blocked regardless of canReply', () => {
    const gate = createInitiateConsentGate({
      bindingStore: storeExpecting(
        makeBinding({ enabled: false, canReply: true }),
        'tg1',
        'chat-42'
      ),
      resolveAgentSubject,
    });
    const from = buildBridgePrincipal('reply', 'tg1', 'chat-42');
    expect(gate(from, HUMAN).allowed).toBe(false);
  });

  it('table cases 9 & 10: whatever deliver classified as initiate is enforced uniformly against canInitiate', () => {
    // The gate cannot see WHY deliver chose 'initiate' — not the cross-room
    // cascade root (case 9: an agent triggered in bridged chat R posting into
    // bridged chat S), not the post-restart self-rooted case (case 10). Both
    // reduce, at the gate, to "a relay.bridge.initiate.* principal against a
    // canInitiate:false binding" — the same decision as any other initiate.
    // The classifier's same-room-same-chat rule (task 1.8) is what keeps
    // deliver from asserting 'reply' in either case; THIS test pins that the
    // gate holds its side of that contract by enforcing initiate uniformly,
    // with no special case that could accidentally wave one of them through.
    const gate = createInitiateConsentGate({
      bindingStore: storeExpecting(
        makeBinding({ canInitiate: false, canReply: true }),
        'tg1',
        'chat-42'
      ),
      resolveAgentSubject,
    });
    const from = buildBridgePrincipal('initiate', 'tg1', 'chat-42');
    expect(gate(from, HUMAN).allowed).toBe(false);
  });

  it("resolves consent from the SUBJECT, never the principal's own claimed channel (confused-deputy guard, spec §6.6 point 2)", () => {
    // The principal claims chat "decoy-chat" (canReply: true); the subject
    // actually being published to is HUMAN = tg1/chat-42 (canReply: false).
    // If the gate ever resolved consent from the principal's own channel
    // instead of the subject it is actually delivering to, this would wrongly
    // allow. This is the exact mutation the security review applied
    // (resolving from `parsed.*` instead of the subject's parse) and the
    // prior storeForAny double failed to catch.
    const store: ConsentBindingStore = {
      resolve: (adapterId, chatId) => {
        if (adapterId === 'tg1' && chatId === 'chat-42') {
          return makeBinding({ canReply: false });
        }
        if (adapterId === 'tg1' && chatId === 'decoy-chat') {
          return makeBinding({ canReply: true });
        }
        throw new Error(`unexpected resolve(${adapterId}, ${chatId})`);
      },
    };
    const gate = createInitiateConsentGate({ bindingStore: store, resolveAgentSubject });
    const from = buildBridgePrincipal('reply', 'tg1', 'decoy-chat');
    // Subject's binding (chat-42, canReply:false) must decide — not the
    // decoy channel the principal itself claims.
    expect(gate(from, HUMAN).allowed).toBe(false);
  });

  it('denies MALFORMED_BRIDGE_PRINCIPAL for an unrecognized classification segment, distinct from a consent refusal (n5)', () => {
    // A malformed principal must be denied WITHOUT ever resolving the
    // binding — a `resolve` call here throws, since the gate should reject
    // the parse before reaching the store at all.
    const bindingStore: ConsentBindingStore = {
      resolve: (adapterId, chatId) => {
        throw new Error(`bindingStore.resolve(${adapterId}, ${chatId}) must not be called`);
      },
    };
    const gate = createInitiateConsentGate({ bindingStore, resolveAgentSubject });
    const decision = gate('relay.bridge.delete.tg1.chat-42', HUMAN);
    expect(decision.allowed).toBe(false);
    // Distinct from INITIATE_NOT_ALLOWED: this is a parse failure, not a
    // resolved binding's consent decision. A caller building bridge_blocked
    // copy (task 1.8/1.9) must not describe a malformed principal as "this
    // chat's consent settings say no."
    expect(decision.code).toBe('MALFORMED_BRIDGE_PRINCIPAL');
    expect(decision.code).not.toBe('INITIATE_NOT_ALLOWED');
  });

  it('denies NO_BINDING when nothing resolves for the target channel', () => {
    const gate = createInitiateConsentGate({
      bindingStore: storeExpecting(undefined, 'tg1', 'chat-42'),
      resolveAgentSubject,
    });
    const from = buildBridgePrincipal('reply', 'tg1', 'chat-42');
    const decision = gate(from, HUMAN);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('NO_BINDING');
  });

  it('parses a dot-containing chat id positionally, both classifications, and still enforces the right switch', () => {
    const dottyHuman = 'relay.human.telegram.tg1.chat.42.with.dots';

    const replyGate = createInitiateConsentGate({
      bindingStore: storeExpecting(
        makeBinding({ canReply: false, canInitiate: true }),
        'tg1',
        'chat.42.with.dots'
      ),
      resolveAgentSubject,
    });
    const replyFrom = buildBridgePrincipal('reply', 'tg1', 'chat.42.with.dots');
    // A positional-parse bug (e.g. reading the LAST dot-segment as the
    // classification) would misread this principal and could accidentally
    // check canInitiate (true) instead of canReply (false) here — this test
    // fails exactly that mistake.
    expect(replyGate(replyFrom, dottyHuman).allowed).toBe(false);

    const initiateGate = createInitiateConsentGate({
      bindingStore: storeExpecting(
        makeBinding({ canReply: true, canInitiate: false }),
        'tg1',
        'chat.42.with.dots'
      ),
      resolveAgentSubject,
    });
    const initiateFrom = buildBridgePrincipal('initiate', 'tg1', 'chat.42.with.dots');
    expect(initiateGate(initiateFrom, dottyHuman).allowed).toBe(false);
  });

  it('does not require the sender to be a registered mesh agent — the gate never sees who delivered', () => {
    // Unlike the relay.agent.* branch, the bridge branch has no sender check:
    // deliver's author check (A6.5) is a separate, later mechanism. The gate
    // only ever sees `from` and `subject`.
    const gate = createInitiateConsentGate({
      bindingStore: storeExpecting(makeBinding({ canReply: true }), 'tg1', 'chat-42'),
      resolveAgentSubject: () => undefined,
    });
    const from = buildBridgePrincipal('reply', 'tg1', 'chat-42');
    expect(gate(from, HUMAN).allowed).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import {
  bindingAllowsInitiate,
  createInitiateConsentGate,
  createAgentSubjectResolver,
  isConsentExemptPrincipal,
  type ConsentBindingStore,
} from '../initiate-consent.js';
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

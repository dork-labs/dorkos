import { describe, it, expect } from 'vitest';
import type { AdapterBinding } from '@dorkos/shared/relay-schemas';
import {
  bindingAllowsInitiate,
  createInitiateConsentGate,
  type ConsentBindingStore,
} from '../initiate-consent.js';

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

/** A store that always resolves the given binding (or none). */
function storeFor(binding: AdapterBinding | undefined): ConsentBindingStore {
  return { resolve: () => binding };
}

/** The canonical agent-initiated subject for tg1/chat-42. */
const HUMAN = 'relay.human.telegram.tg1.chat-42';
/** A registered agent's server-injected principal. */
const AGENT = 'relay.agent.ns.agent-1';

describe('bindingAllowsInitiate (shared consent predicate)', () => {
  it('is true only when enabled AND canInitiate', () => {
    expect(bindingAllowsInitiate(makeBinding({ enabled: true, canInitiate: true }))).toBe(true);
    expect(bindingAllowsInitiate(makeBinding({ enabled: true, canInitiate: false }))).toBe(false);
    expect(bindingAllowsInitiate(makeBinding({ enabled: false, canInitiate: true }))).toBe(false);
  });
});

describe('createInitiateConsentGate — the DOR-277 delivery-layer gate', () => {
  describe('agent-initiated principals are GATED', () => {
    it('denies an agent send when canInitiate is off', () => {
      const gate = createInitiateConsentGate({
        bindingStore: storeFor(makeBinding({ canInitiate: false })),
      });
      const d = gate(AGENT, HUMAN);
      expect(d.allowed).toBe(false);
      expect(d.code).toBe('INITIATE_NOT_ALLOWED');
    });

    it('allows an agent send when the binding is enabled and canInitiate', () => {
      const gate = createInitiateConsentGate({
        bindingStore: storeFor(makeBinding({ canInitiate: true })),
      });
      expect(gate(AGENT, HUMAN).allowed).toBe(true);
    });

    it('denies an agent send when the binding is paused (enabled=false)', () => {
      const gate = createInitiateConsentGate({
        bindingStore: storeFor(makeBinding({ enabled: false, canInitiate: true })),
      });
      expect(gate(AGENT, HUMAN).allowed).toBe(false);
    });

    it('denies fail-closed when no binding resolves (guessed/unbound channel)', () => {
      const gate = createInitiateConsentGate({ bindingStore: storeFor(undefined) });
      const d = gate(AGENT, HUMAN);
      expect(d.allowed).toBe(false);
      expect(d.code).toBe('NO_BINDING');
    });

    it('gates a non-registered session principal', () => {
      const gate = createInitiateConsentGate({
        bindingStore: storeFor(makeBinding({ canInitiate: false })),
      });
      expect(gate('relay.session.scratch', HUMAN).allowed).toBe(false);
    });

    it('gates the external MCP principal', () => {
      const gate = createInitiateConsentGate({
        bindingStore: storeFor(makeBinding({ canInitiate: false })),
      });
      expect(gate('relay.external.mcp', HUMAN).allowed).toBe(false);
    });
  });

  describe('non-agent-initiated principals are EXEMPT', () => {
    // A canInitiate=false binding is used throughout to prove the bypass is by
    // principal, not because consent happened to be on.
    const gate = createInitiateConsentGate({
      bindingStore: storeFor(makeBinding({ canInitiate: false })),
    });

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

  describe('targets outside the external-human channel are not gated', () => {
    const gate = createInitiateConsentGate({
      bindingStore: storeFor(makeBinding({ canInitiate: false })),
    });

    it('allows agent→agent sends (relay.agent.*)', () => {
      expect(gate(AGENT, 'relay.agent.ns.other').allowed).toBe(true);
    });

    it('allows agent→console sends (relay.human.console.*) — the operator’s own UI', () => {
      expect(gate(AGENT, 'relay.human.console.client-9').allowed).toBe(true);
    });
  });
});

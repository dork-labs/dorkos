import { describe, it, expect } from 'vitest';
import { generateAgentCard, generateFleetCard } from '../agent-card-generator.js';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { CardGeneratorConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: CardGeneratorConfig = {
  baseUrl: 'https://dorkos.example.com',
  version: '1.2.3',
};

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: '01HZB1AGENTULID0000001',
    name: 'backend-bot',
    description: 'An expert in REST API design',
    runtime: 'claude-code',
    capabilities: ['code-review', 'run_tests', 'api-design'],
    behavior: { responseMode: 'always' },
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
    namespace: 'platform',
    registeredAt: '2026-03-22T00:00:00.000Z',
    registeredBy: 'kai',
    personaEnabled: true,
    enabledToolGroups: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateAgentCard — happy path
// ---------------------------------------------------------------------------

describe('generateAgentCard', () => {
  it('maps name and description from manifest', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.name).toBe('backend-bot');
    expect(card.description).toBe('An expert in REST API design');
  });

  it('sets protocolVersion to 0.3.0', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.protocolVersion).toBe('0.3.0');
  });

  it('constructs url from baseUrl + /a2a', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.url).toBe('https://dorkos.example.com/a2a');
  });

  it('uses config.version as card version', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.version).toBe('1.2.3');
  });

  it('sets preferredTransport to JSONRPC', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.preferredTransport).toBe('JSONRPC');
  });

  it('advertises streaming=true and stateTransitionHistory=true', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.stateTransitionHistory).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(false);
  });

  it('includes default input and output modes', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.defaultInputModes).toContain('text/plain');
    expect(card.defaultOutputModes).toContain('text/plain');
  });

  it('includes apiKey security scheme on the Authorization header', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.securitySchemes?.['apiKey']).toEqual({
      type: 'apiKey',
      in: 'header',
      name: 'Authorization',
    });
    expect(card.security).toEqual([{ apiKey: [] }]);
  });

  it('sets supportsAuthenticatedExtendedCard to false', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.supportsAuthenticatedExtendedCard).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Capability → Skill mapping
  // ---------------------------------------------------------------------------

  it('maps each capability to a skill', () => {
    const manifest = makeManifest({ capabilities: ['code-review', 'run_tests', 'api-design'] });
    const card = generateAgentCard(manifest, BASE_CONFIG);

    expect(card.skills).toHaveLength(3);
  });

  it('uses capability string as skill id', () => {
    const card = generateAgentCard(makeManifest({ capabilities: ['code-review'] }), BASE_CONFIG);

    expect(card.skills[0]?.id).toBe('code-review');
  });

  it('converts hyphenated capability to title-case skill name', () => {
    const card = generateAgentCard(makeManifest({ capabilities: ['code-review'] }), BASE_CONFIG);

    expect(card.skills[0]?.name).toBe('Code Review');
  });

  it('converts underscore capability to title-case skill name', () => {
    const card = generateAgentCard(makeManifest({ capabilities: ['run_tests'] }), BASE_CONFIG);

    expect(card.skills[0]?.name).toBe('Run Tests');
  });

  it('includes capability and runtime in skill tags', () => {
    const card = generateAgentCard(
      makeManifest({ capabilities: ['api-design'], runtime: 'claude-code' }),
      BASE_CONFIG
    );

    expect(card.skills[0]?.tags).toContain('api-design');
    expect(card.skills[0]?.tags).toContain('claude-code');
  });

  it('skill description references agent name and capability', () => {
    const card = generateAgentCard(
      makeManifest({ name: 'my-agent', capabilities: ['api-design'] }),
      BASE_CONFIG
    );

    expect(card.skills[0]?.description).toContain('my-agent');
    expect(card.skills[0]?.description).toContain('api-design');
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('produces empty skills array when capabilities is empty', () => {
    const card = generateAgentCard(makeManifest({ capabilities: [] }), BASE_CONFIG);

    expect(card.skills).toHaveLength(0);
  });

  it('falls back to generated description when manifest description is empty string', () => {
    const card = generateAgentCard(makeManifest({ description: '' }), BASE_CONFIG);

    expect(card.description).toBe('DorkOS agent: backend-bot');
  });

  it('uses manifest description when present', () => {
    const card = generateAgentCard(
      makeManifest({ description: 'Expert backend engineer' }),
      BASE_CONFIG
    );

    expect(card.description).toBe('Expert backend engineer');
  });
});

// ---------------------------------------------------------------------------
// generateFleetCard — happy path
// ---------------------------------------------------------------------------

describe('generateFleetCard', () => {
  const alpha = makeManifest({
    id: '01HZB1ALPHA000000000001',
    name: 'alpha-agent',
    description: 'Alpha agent description',
    runtime: 'claude-code',
    namespace: 'platform',
    capabilities: ['task-a'],
  });

  const beta = makeManifest({
    id: '01HZB1BETA0000000000001',
    name: 'beta-agent',
    description: '',
    runtime: 'cursor',
    capabilities: ['task-b'],
  });

  it('has name "DorkOS Agent Fleet"', () => {
    const card = generateFleetCard([alpha, beta], BASE_CONFIG);

    expect(card.name).toBe('DorkOS Agent Fleet');
  });

  it('sets protocolVersion to 0.3.0', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.protocolVersion).toBe('0.3.0');
  });

  it('constructs url from baseUrl + /a2a', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.url).toBe('https://dorkos.example.com/a2a');
  });

  it('uses config.version as card version', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.version).toBe('1.2.3');
  });

  it('creates one skill per manifest', () => {
    const card = generateFleetCard([alpha, beta], BASE_CONFIG);

    expect(card.skills).toHaveLength(2);
  });

  it('uses agent id as skill id', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.skills[0]?.id).toBe('01HZB1ALPHA000000000001');
  });

  it('uses agent name as skill name', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.skills[0]?.name).toBe('alpha-agent');
  });

  it('uses agent description as skill description when present', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.skills[0]?.description).toBe('Alpha agent description');
  });

  it('falls back to generated skill description when agent description is empty', () => {
    const card = generateFleetCard([beta], BASE_CONFIG);

    expect(card.skills[0]?.description).toBe('DorkOS agent: beta-agent');
  });

  it('includes runtime and namespace in skill tags when namespace is set', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);
    const tags = card.skills[0]?.tags ?? [];

    expect(tags).toContain('claude-code');
    expect(tags).toContain('platform');
  });

  it('includes only runtime in skill tags when namespace is absent', () => {
    const noNamespace = makeManifest({ namespace: undefined, runtime: 'cursor' });
    const card = generateFleetCard([noNamespace], BASE_CONFIG);
    const tags = card.skills[0]?.tags ?? [];

    expect(tags).toContain('cursor');
    expect(tags).not.toContain('undefined');
  });

  it('includes apiKey security scheme', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.securitySchemes?.['apiKey']).toBeDefined();
    expect(card.security).toEqual([{ apiKey: [] }]);
  });

  it('advertises streaming capability', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.capabilities.streaming).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('produces empty skills array and valid card for zero manifests', () => {
    const card = generateFleetCard([], BASE_CONFIG);

    expect(card.skills).toHaveLength(0);
    expect(card.name).toBe('DorkOS Agent Fleet');
    expect(card.description).toContain('no agents registered yet');
  });

  it('uses singular "agent" in description for single manifest', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.description).toContain('1 registered agent');
    expect(card.description).not.toContain('agents.');
  });

  it('uses plural "agents" in description for multiple manifests', () => {
    const card = generateFleetCard([alpha, beta], BASE_CONFIG);

    expect(card.description).toContain('2 registered agents');
  });

  it('description mentions per-agent card path', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.description).toContain('/a2a/agents/:id/card');
  });
});

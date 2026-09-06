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

/**
 * Anything that would tell a card reader WHERE this instance's credential
 * lives: the local token's own prefix, its filename, and the data directory
 * holding it. The card may say a bearer is required; it may not say that.
 */
const CREDENTIAL_LOCATION_PATTERN = /dork_mcp_local_|mcp-local-token|\.dork\b/;

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    workspace: { mode: 'home' },
    id: '01HZB1AGENTULID0000001',
    name: 'backend-bot',
    description: 'An expert in REST API design',
    runtime: 'claude-code',
    capabilities: ['code-review', 'run_tests', 'api-design'],
    behavior: { responseMode: 'always' },
    namespace: 'platform',
    registeredAt: '2026-03-22T00:00:00.000Z',
    registeredBy: 'kai',
    personaEnabled: true,
    enabledToolGroups: {},
    mcpServers: [],
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

  it('advertises the JSON-RPC endpoint at both the current and the legacy protocol version', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    // Both entries, deliberately: the SDK refuses a protocol version the card
    // does not declare, so dropping the 0.3 entry would lock out every peer
    // that has not upgraded.
    expect(card.supportedInterfaces).toEqual([
      {
        url: 'https://dorkos.example.com/a2a/agents/01HZB1AGENTULID0000001',
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: '1.0',
      },
      {
        url: 'https://dorkos.example.com/a2a/agents/01HZB1AGENTULID0000001',
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: '0.3',
      },
    ]);
  });

  it('uses config.version as card version', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.version).toBe('1.2.3');
  });

  it('advertises streaming and no push notifications', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.capabilities?.streaming).toBe(true);
    expect(card.capabilities?.pushNotifications).toBe(false);
    expect(card.capabilities?.extendedAgentCard).toBe(false);
  });

  it('includes default input and output modes', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.defaultInputModes).toContain('text/plain');
    expect(card.defaultOutputModes).toContain('text/plain');
  });

  it('advertises the spec-standard http/bearer scheme and always requires it', () => {
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(card.securitySchemes['bearerAuth']).toEqual({
      scheme: {
        $case: 'httpAuthSecurityScheme',
        value: {
          scheme: 'bearer',
          bearerFormat: '',
          description:
            'A credential for this DorkOS instance, sent as `Authorization: Bearer <token>`. ' +
            'Obtained out of band from the operator; this endpoint issues none.',
        },
      },
    });
    // Unconditional: every JSON-RPC POST is gated in every posture (DOR-278),
    // so a card that advertised no requirement would be lying (DOR-1824).
    expect(card.securityRequirements).toEqual([{ schemes: { bearerAuth: { list: [] } } }]);
  });

  it('names no credential value or file path ANYWHERE on the card', () => {
    // The whole document, not just the scheme description: the card is the one
    // A2A artifact a stranger may read before presenting anything, and the
    // promise ("the card never says where your key is kept") is about the card,
    // so a future field that leaked a path has to red here too.
    const card = generateAgentCard(makeManifest(), BASE_CONFIG);

    expect(JSON.stringify(card)).not.toMatch(CREDENTIAL_LOCATION_PATTERN);
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

  it('advertises the fleet endpoint at both the current and the legacy protocol version', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.supportedInterfaces).toEqual([
      {
        url: 'https://dorkos.example.com/a2a',
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: '1.0',
      },
      {
        url: 'https://dorkos.example.com/a2a',
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: '0.3',
      },
    ]);
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

  it('advertises the http/bearer scheme and always requires it', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.securitySchemes['bearerAuth']?.scheme).toMatchObject({
      $case: 'httpAuthSecurityScheme',
      value: { scheme: 'bearer' },
    });
    expect(card.securityRequirements).toEqual([{ schemes: { bearerAuth: { list: [] } } }]);
  });

  it('names no credential value or file path ANYWHERE on the card', () => {
    // The fleet card is the roster a stranger reaches first — same promise.
    const card = generateFleetCard([alpha, beta], BASE_CONFIG);

    expect(JSON.stringify(card)).not.toMatch(CREDENTIAL_LOCATION_PATTERN);
  });

  it('advertises streaming capability', () => {
    const card = generateFleetCard([alpha], BASE_CONFIG);

    expect(card.capabilities?.streaming).toBe(true);
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

    expect(card.description).toContain('/a2a/agents/{agentId}/card');
  });
});

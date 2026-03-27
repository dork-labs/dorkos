/**
 * Agent Card generation from Mesh AgentManifest.
 *
 * Maps DorkOS AgentManifest fields to A2A AgentCard (v0.3.0 format).
 * Each capability on a manifest becomes an A2A skill on the card.
 *
 * @module a2a-gateway/agent-card-generator
 */
import type { AgentCard, AgentSkill } from '@a2a-js/sdk';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { CardGeneratorConfig } from './types.js';

/** MIME types supported by all DorkOS agents. */
const DEFAULT_INPUT_MODES: string[] = ['text/plain'];
const DEFAULT_OUTPUT_MODES: string[] = ['text/plain'];

/** A2A protocol version this generator targets. */
const PROTOCOL_VERSION = '0.3.0';

/**
 * Convert a raw capability string into a human-readable skill name.
 *
 * Replaces hyphens and underscores with spaces and title-cases each word.
 *
 * @param capability - Raw capability string (e.g. "code-review" or "run_tests")
 * @returns Human-readable name (e.g. "Code Review" or "Run Tests")
 */
function capabilityToSkillName(capability: string): string {
  return capability.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Map a single capability string to an A2A AgentSkill.
 *
 * @param capability - Raw capability identifier
 * @param agentName - Name of the owning agent (used in description)
 * @param agentRuntime - Runtime tag for the skill's tag list
 */
function capabilityToSkill(
  capability: string,
  agentName: string,
  agentRuntime: string
): AgentSkill {
  return {
    id: capability,
    name: capabilityToSkillName(capability),
    description: `${agentName} capability: ${capability}`,
    tags: [capability, agentRuntime],
  };
}

/**
 * Build the shared security configuration used in all Agent Cards.
 *
 * Returns the securitySchemes and security fields wired up for API key auth
 * via the Authorization header. When MCP_API_KEY is not set the server
 * accepts unauthenticated requests, but the card still advertises the scheme
 * so that clients know what to send when auth is required.
 */
function buildSecurityConfig(): Pick<AgentCard, 'securitySchemes' | 'security'> {
  return {
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'Authorization',
      },
    },
    security: [{ apiKey: [] }],
  };
}

/**
 * Generate a per-agent A2A Agent Card from a Mesh AgentManifest.
 *
 * Each capability in `manifest.capabilities` becomes a distinct A2A skill.
 * When the manifest has no capabilities the card's skills array is empty,
 * which is valid per the A2A spec.
 *
 * Mapping:
 * - `manifest.name` → `card.name`
 * - `manifest.description` (or fallback) → `card.description`
 * - `manifest.capabilities[n]` → `card.skills[n]`
 * - `config.baseUrl + "/a2a"` → `card.url`
 * - `config.version` → `card.version`
 *
 * @param manifest - Mesh agent manifest to convert
 * @param config - Base URL and version metadata for the card
 * @returns A valid A2A AgentCard object
 */
export function generateAgentCard(manifest: AgentManifest, config: CardGeneratorConfig): AgentCard {
  const skills = manifest.capabilities.map((cap) =>
    capabilityToSkill(cap, manifest.name, manifest.runtime)
  );

  return {
    protocolVersion: PROTOCOL_VERSION,
    name: manifest.name,
    description:
      manifest.description.length > 0 ? manifest.description : `DorkOS agent: ${manifest.name}`,
    url: `${config.baseUrl}/a2a`,
    preferredTransport: 'JSONRPC',
    version: config.version,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: DEFAULT_INPUT_MODES,
    defaultOutputModes: DEFAULT_OUTPUT_MODES,
    skills,
    ...buildSecurityConfig(),
    supportsAuthenticatedExtendedCard: false,
  };
}

/**
 * Generate a fleet-level A2A Agent Card aggregating all registered agents.
 *
 * Each agent manifest is represented as a single skill whose id is the agent's
 * ULID and whose description includes the agent's own description. External
 * clients use this card for initial fleet discovery, then fetch per-agent
 * cards at `/a2a/agents/:id/card` for full capability details.
 *
 * When `manifests` is empty the card is still valid — it describes a DorkOS
 * instance with zero registered agents.
 *
 * @param manifests - All registered agent manifests
 * @param config - Base URL and version metadata for the card
 * @returns A valid A2A AgentCard representing the full fleet
 */
export function generateFleetCard(
  manifests: AgentManifest[],
  config: CardGeneratorConfig
): AgentCard {
  const skills: AgentSkill[] = manifests.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description.length > 0 ? m.description : `DorkOS agent: ${m.name}`,
    tags: m.namespace != null ? [m.runtime, m.namespace] : [m.runtime],
  }));

  const agentCount = manifests.length;
  const description =
    agentCount === 0
      ? 'DorkOS agent fleet — no agents registered yet. Register agents via the Mesh API.'
      : `DorkOS agent fleet with ${agentCount} registered agent${agentCount === 1 ? '' : 's'}. Use per-agent cards at /a2a/agents/:id/card for individual agent details.`;

  return {
    protocolVersion: PROTOCOL_VERSION,
    name: 'DorkOS Agent Fleet',
    description,
    url: `${config.baseUrl}/a2a`,
    preferredTransport: 'JSONRPC',
    version: config.version,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
    },
    defaultInputModes: DEFAULT_INPUT_MODES,
    defaultOutputModes: DEFAULT_OUTPUT_MODES,
    skills,
    ...buildSecurityConfig(),
    supportsAuthenticatedExtendedCard: false,
  };
}

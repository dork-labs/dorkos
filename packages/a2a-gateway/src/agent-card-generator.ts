/**
 * Agent Card generation from Mesh AgentManifest.
 *
 * Maps DorkOS AgentManifest fields to an A2A v1.0 AgentCard. Each capability
 * on a manifest becomes an A2A skill on the card.
 *
 * Cards advertise the JSON-RPC endpoint twice — once as v1.0 and once as
 * v0.3 — via {@link duplicateInterfacesForLegacy}. The SDK serves and accepts
 * only the protocol versions a card explicitly declares, so this duplication
 * is exactly what keeps agents built against the older protocol able to talk
 * to us. See `express-handlers.ts` for the request side of the same bargain.
 *
 * @module a2a-gateway/agent-card-generator
 */
import type { AgentCard, AgentInterface, AgentSkill } from '@a2a-js/sdk';
import { A2A_PROTOCOL_VERSION } from '@a2a-js/sdk';
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { CardGeneratorConfig } from './types.js';

/** MIME types supported by all DorkOS agents. */
const DEFAULT_INPUT_MODES: string[] = ['text/plain'];
const DEFAULT_OUTPUT_MODES: string[] = ['text/plain'];

/** The protocol binding every DorkOS agent is reachable over. */
const JSONRPC_BINDING = 'JSONRPC';

/**
 * Declare a JSON-RPC endpoint at both the current and the legacy protocol
 * version, so v0.3 clients and v1.0 clients each find an interface they can use.
 *
 * @param url - The endpoint's absolute URL.
 */
function supportedInterfaces(url: string): AgentInterface[] {
  return duplicateInterfacesForLegacy(
    [{ url, protocolBinding: JSONRPC_BINDING, tenant: '', protocolVersion: A2A_PROTOCOL_VERSION }],
    [JSONRPC_BINDING]
  );
}

/** The A2A capabilities every DorkOS agent card advertises. */
function capabilities(): NonNullable<AgentCard['capabilities']> {
  return {
    streaming: true,
    pushNotifications: false,
    extensions: [],
    extendedAgentCard: false,
  };
}

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
    examples: [],
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  };
}

/**
 * Build the shared security configuration used in all Agent Cards.
 *
 * The server authenticates via `Authorization: Bearer <key>` — the
 * spec-standard `http`/`bearer` scheme. (An `apiKey`-in-header scheme naming
 * the `Authorization` header would make clients send the raw key without the
 * `Bearer ` prefix, which the server rejects.)
 *
 * The scheme is always described so clients know what to send, but a
 * `security` requirement is only advertised when the server actually enforces
 * auth ({@link CardGeneratorConfig.authRequired}) — pass-through localhost
 * mode must not claim credentials are required.
 */
function buildSecurityConfig(
  config: CardGeneratorConfig
): Pick<AgentCard, 'securitySchemes' | 'securityRequirements'> {
  return {
    securitySchemes: {
      bearerAuth: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            scheme: 'bearer',
            bearerFormat: '',
            description: 'API key sent as `Authorization: Bearer <key>`.',
          },
        },
      },
    },
    securityRequirements: config.authRequired ? [{ schemes: { bearerAuth: { list: [] } } }] : [],
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
 * - `config.baseUrl + "/a2a/agents/" + manifest.id` → `card.supportedInterfaces[*].url`
 * - `config.version` → `card.version`
 *
 * That URL is the agent's own JSON-RPC endpoint: a client that discovered this
 * card and POSTs to it talks to this agent, deterministically — no
 * `metadata.agentId` required.
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
    name: manifest.name,
    description:
      manifest.description.length > 0 ? manifest.description : `DorkOS agent: ${manifest.name}`,
    supportedInterfaces: supportedInterfaces(`${config.baseUrl}/a2a/agents/${manifest.id}`),
    provider: undefined,
    version: config.version,
    capabilities: capabilities(),
    defaultInputModes: DEFAULT_INPUT_MODES,
    defaultOutputModes: DEFAULT_OUTPUT_MODES,
    skills,
    signatures: [],
    ...buildSecurityConfig(config),
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
    examples: [],
    inputModes: [],
    outputModes: [],
    securityRequirements: [],
  }));

  const agentCount = manifests.length;
  const description =
    agentCount === 0
      ? 'DorkOS agent fleet — no agents registered yet. Register agents via the Mesh API.'
      : `DorkOS agent fleet with ${agentCount} registered agent${agentCount === 1 ? '' : 's'}. ` +
        "Every message must target one agent: POST to the url on that agent's card " +
        '(/a2a/agents/{agentId}) or set metadata.agentId on the message — each skill id below ' +
        'is an agent id, and per-agent cards live at /a2a/agents/{agentId}/card.';

  return {
    name: 'DorkOS Agent Fleet',
    description,
    supportedInterfaces: supportedInterfaces(`${config.baseUrl}/a2a`),
    provider: undefined,
    version: config.version,
    capabilities: capabilities(),
    defaultInputModes: DEFAULT_INPUT_MODES,
    defaultOutputModes: DEFAULT_OUTPUT_MODES,
    skills,
    signatures: [],
    ...buildSecurityConfig(config),
  };
}

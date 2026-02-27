/**
 * Zod schemas for the Mesh agent discovery and registry.
 *
 * Defines schemas for agent manifests, discovery candidates, hints,
 * and denial records. All schemas include `.openapi()` metadata
 * for OpenAPI generation.
 *
 * @module shared/mesh-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// === Enums ===

export const AgentRuntimeSchema = z
  .enum(['claude-code', 'cursor', 'codex', 'other'])
  .openapi('AgentRuntime');

export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

// === Agent Configuration ===

export const AgentBehaviorSchema = z
  .object({
    responseMode: z.enum(['always', 'direct-only', 'mention-only', 'silent']).default('always'),
    escalationThreshold: z.number().optional(),
  })
  .openapi('AgentBehavior');

export type AgentBehavior = z.infer<typeof AgentBehaviorSchema>;

export const AgentBudgetSchema = z
  .object({
    maxHopsPerMessage: z.number().int().min(1).default(5),
    maxCallsPerHour: z.number().int().min(1).default(100),
  })
  .openapi('AgentBudget');

export type AgentBudget = z.infer<typeof AgentBudgetSchema>;

// === Agent Manifest ===

export const AgentManifestSchema = z
  .object({
    id: z.string().min(1).describe('ULID assigned at registration'),
    name: z.string().min(1),
    description: z.string().default(''),
    runtime: AgentRuntimeSchema,
    capabilities: z.array(z.string()).default([]),
    behavior: AgentBehaviorSchema.default({ responseMode: 'always' }),
    budget: AgentBudgetSchema.default({ maxHopsPerMessage: 5, maxCallsPerHour: 100 }),
    namespace: z.string().max(64).optional(),
    registeredAt: z.string().datetime(),
    registeredBy: z.string().min(1),
  })
  .openapi('AgentManifest');

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

// === Discovery ===

export const AgentHintsSchema = z
  .object({
    suggestedName: z.string(),
    detectedRuntime: AgentRuntimeSchema,
    inferredCapabilities: z.array(z.string()).optional(),
    description: z.string().optional(),
  })
  .openapi('AgentHints');

export type AgentHints = z.infer<typeof AgentHintsSchema>;

export const DiscoveryCandidateSchema = z
  .object({
    path: z.string().min(1),
    strategy: z.string().min(1),
    hints: AgentHintsSchema,
    discoveredAt: z.string().datetime(),
  })
  .openapi('DiscoveryCandidate');

export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;

// === Denial ===

export const DenialRecordSchema = z
  .object({
    path: z.string().min(1),
    strategy: z.string().min(1),
    reason: z.string().optional(),
    deniedBy: z.string().min(1),
    deniedAt: z.string().datetime(),
  })
  .openapi('DenialRecord');

export type DenialRecord = z.infer<typeof DenialRecordSchema>;

// === Topology ===

export const NamespaceInfoSchema = z
  .object({
    namespace: z.string(),
    agentCount: z.number().int(),
    agents: z.array(AgentManifestSchema),
  })
  .openapi('NamespaceInfo');

export type NamespaceInfo = z.infer<typeof NamespaceInfoSchema>;

export const CrossNamespaceRuleSchema = z
  .object({
    sourceNamespace: z.string(),
    targetNamespace: z.string(),
    action: z.enum(['allow', 'deny']),
  })
  .openapi('CrossNamespaceRule');

export type CrossNamespaceRule = z.infer<typeof CrossNamespaceRuleSchema>;

export const TopologyViewSchema = z
  .object({
    callerNamespace: z.string(),
    namespaces: z.array(NamespaceInfoSchema),
    accessRules: z.array(CrossNamespaceRuleSchema),
  })
  .openapi('TopologyView');

export type TopologyView = z.infer<typeof TopologyViewSchema>;

// === HTTP Request/Response Schemas ===

/** Request body for POST /api/mesh/discover */
export const DiscoverRequestSchema = z
  .object({
    roots: z.array(z.string().min(1)).min(1),
    maxDepth: z.number().int().min(1).optional(),
  })
  .openapi('DiscoverRequest');

export type DiscoverRequest = z.infer<typeof DiscoverRequestSchema>;

/** Request body for POST /api/mesh/agents */
export const RegisterAgentRequestSchema = z
  .object({
    path: z.string().min(1),
    overrides: AgentManifestSchema.partial().optional(),
    approver: z.string().optional(),
  })
  .openapi('RegisterAgentRequest');

export type RegisterAgentRequest = z.infer<typeof RegisterAgentRequestSchema>;

/** Request body for POST /api/mesh/deny */
export const DenyRequestSchema = z
  .object({
    path: z.string().min(1),
    reason: z.string().optional(),
    denier: z.string().optional(),
  })
  .openapi('DenyRequest');

export type DenyRequest = z.infer<typeof DenyRequestSchema>;

/** Request body for PATCH /api/mesh/agents/:id */
export const UpdateAgentRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
  })
  .openapi('UpdateAgentRequest');

export type UpdateAgentRequest = z.infer<typeof UpdateAgentRequestSchema>;

/** Request body for PUT /api/mesh/topology/access */
export const UpdateAccessRuleRequestSchema = z
  .object({
    sourceNamespace: z.string().min(1),
    targetNamespace: z.string().min(1),
    action: z.enum(['allow', 'deny']),
  })
  .openapi('UpdateAccessRuleRequest');

export type UpdateAccessRuleRequest = z.infer<typeof UpdateAccessRuleRequestSchema>;

/** Query params for GET /api/mesh/agents */
export const AgentListQuerySchema = z
  .object({
    runtime: AgentRuntimeSchema.optional(),
    capability: z.string().optional(),
    callerNamespace: z.string().optional(),
  })
  .openapi('AgentListQuery');

export type AgentListQuery = z.infer<typeof AgentListQuerySchema>;

// === Health & Observability Schemas ===

/** Health status enum — computed from last_seen_at timestamp. */
export const AgentHealthStatusSchema = z
  .enum(['active', 'inactive', 'stale'])
  .openapi('AgentHealthStatus');

export type AgentHealthStatus = z.infer<typeof AgentHealthStatusSchema>;

/** Agent health detail — extends manifest with health tracking fields. */
export const AgentHealthSchema = z
  .object({
    agentId: z.string(),
    name: z.string(),
    status: AgentHealthStatusSchema,
    lastSeenAt: z.string().nullable(),
    lastSeenEvent: z.string().nullable(),
    registeredAt: z.string(),
    runtime: AgentRuntimeSchema,
    capabilities: z.array(z.string()),
  })
  .openapi('AgentHealth');

export type AgentHealth = z.infer<typeof AgentHealthSchema>;

/** Aggregate mesh status — counts by health status plus groupings. */
export const MeshStatusSchema = z
  .object({
    totalAgents: z.number(),
    activeCount: z.number(),
    inactiveCount: z.number(),
    staleCount: z.number(),
    unreachableCount: z.number(),
    byRuntime: z.record(z.string(), z.number()),
    byProject: z.record(z.string(), z.number()),
  })
  .openapi('MeshStatus');

export type MeshStatus = z.infer<typeof MeshStatusSchema>;

/** Detailed agent inspection — full manifest + health + relay info. */
export const MeshInspectSchema = z
  .object({
    agent: AgentManifestSchema,
    health: AgentHealthSchema,
    relaySubject: z.string().nullable(),
  })
  .openapi('MeshInspect');

export type MeshInspect = z.infer<typeof MeshInspectSchema>;

/** Lifecycle event — emitted as Relay signals on registration, unregistration, health change. */
export const MeshLifecycleEventSchema = z
  .object({
    agentId: z.string(),
    agentName: z.string(),
    event: z.enum(['registered', 'unregistered', 'health_changed']),
    previousStatus: AgentHealthStatusSchema.optional(),
    currentStatus: AgentHealthStatusSchema.optional(),
    timestamp: z.string(),
  })
  .openapi('MeshLifecycleEvent');

export type MeshLifecycleEvent = z.infer<typeof MeshLifecycleEventSchema>;

/** Request body for POST /api/mesh/agents/:id/heartbeat */
export const HeartbeatRequestSchema = z
  .object({
    event: z.string().optional().default('heartbeat'),
  })
  .openapi('HeartbeatRequest');

export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

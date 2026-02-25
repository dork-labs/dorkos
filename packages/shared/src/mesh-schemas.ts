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

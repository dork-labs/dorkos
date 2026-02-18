/**
 * Zod schemas for the roadmap data model.
 *
 * Defines schemas for roadmap items, metadata, and request/response types.
 * All schemas include `.openapi()` metadata for future OpenAPI generation.
 *
 * @module shared/roadmap-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

// === Enums ===

export const RoadmapItemTypeSchema = z
  .enum(['feature', 'bugfix', 'technical-debt', 'research', 'epic'])
  .openapi('RoadmapItemType');

export type RoadmapItemType = z.infer<typeof RoadmapItemTypeSchema>;

export const MoscowSchema = z
  .enum(['must-have', 'should-have', 'could-have', 'wont-have'])
  .openapi('Moscow');

export type Moscow = z.infer<typeof MoscowSchema>;

export const RoadmapStatusSchema = z
  .enum(['not-started', 'in-progress', 'completed', 'on-hold'])
  .openapi('RoadmapStatus');

export type RoadmapStatus = z.infer<typeof RoadmapStatusSchema>;

export const HealthSchema = z
  .enum(['on-track', 'at-risk', 'off-track', 'blocked'])
  .openapi('Health');

export type Health = z.infer<typeof HealthSchema>;

export const TimeHorizonSchema = z
  .enum(['now', 'next', 'later'])
  .openapi('TimeHorizon');

export type TimeHorizon = z.infer<typeof TimeHorizonSchema>;

// === Item Schema ===

export const LinkedArtifactsSchema = z
  .object({
    specSlug: z.string().optional(),
    ideationPath: z.string().optional(),
    specPath: z.string().optional(),
    tasksPath: z.string().optional(),
    implementationPath: z.string().optional(),
  })
  .openapi('LinkedArtifacts');

export type LinkedArtifacts = z.infer<typeof LinkedArtifactsSchema>;

export const IdeationContextSchema = z
  .object({
    targetUsers: z.array(z.string()).optional(),
    painPoints: z.array(z.string()).optional(),
    successCriteria: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
  })
  .openapi('IdeationContext');

export type IdeationContext = z.infer<typeof IdeationContextSchema>;

export const WorkflowStateSchema = z
  .object({
    phase: z
      .enum([
        'not-started',
        'ideating',
        'specifying',
        'decomposing',
        'implementing',
        'testing',
        'committing',
        'releasing',
        'completed',
      ])
      .optional(),
    specSlug: z.string().optional(),
    tasksTotal: z.number().int().min(0).optional(),
    tasksCompleted: z.number().int().min(0).optional(),
    lastSession: z.string().datetime().optional(),
    attempts: z.number().int().min(0).optional(),
    blockers: z.array(z.string()).optional(),
  })
  .openapi('WorkflowState');

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export const RoadmapItemSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(3).max(200),
    description: z.string().max(2000).optional(),
    type: RoadmapItemTypeSchema,
    moscow: MoscowSchema,
    status: RoadmapStatusSchema,
    health: HealthSchema,
    timeHorizon: TimeHorizonSchema,
    effort: z.number().min(0).optional(),
    dependencies: z.array(z.string().uuid()).optional(),
    labels: z.array(z.string()).optional(),
    order: z.number().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    linkedArtifacts: LinkedArtifactsSchema.optional(),
    ideationContext: IdeationContextSchema.optional(),
    workflowState: WorkflowStateSchema.optional(),
  })
  .openapi('RoadmapItem');

export type RoadmapItem = z.infer<typeof RoadmapItemSchema>;

// === Request Schemas ===

export const CreateItemRequestSchema = RoadmapItemSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).openapi('CreateItemRequest');

export type CreateItemRequest = z.infer<typeof CreateItemRequestSchema>;

export const UpdateItemRequestSchema = RoadmapItemSchema.partial()
  .omit({ id: true, createdAt: true })
  .openapi('UpdateItemRequest');

export type UpdateItemRequest = z.infer<typeof UpdateItemRequestSchema>;

export const ReorderRequestSchema = z
  .object({
    orderedIds: z.array(z.string().uuid()),
  })
  .openapi('ReorderRequest');

export type ReorderRequest = z.infer<typeof ReorderRequestSchema>;

// === Meta Schema ===

export const TimeHorizonConfigSchema = z
  .object({
    label: z.string(),
    description: z.string(),
  })
  .openapi('TimeHorizonConfig');

export type TimeHorizonConfig = z.infer<typeof TimeHorizonConfigSchema>;

export const RoadmapMetaSchema = z
  .object({
    projectName: z.string().min(1).max(100),
    projectSummary: z.string().max(500),
    lastUpdated: z.string().datetime(),
    timeHorizons: z.object({
      now: TimeHorizonConfigSchema,
      next: TimeHorizonConfigSchema,
      later: TimeHorizonConfigSchema,
    }),
  })
  .openapi('RoadmapMeta');

export type RoadmapMeta = z.infer<typeof RoadmapMetaSchema>;

// === Health Stats ===

export const HealthStatsSchema = z
  .object({
    totalItems: z.number(),
    mustHavePercent: z.number(),
    inProgressCount: z.number(),
    atRiskCount: z.number(),
    blockedCount: z.number(),
    completedCount: z.number(),
  })
  .openapi('HealthStats');

export type HealthStats = z.infer<typeof HealthStatsSchema>;

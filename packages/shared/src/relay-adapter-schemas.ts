/**
 * Zod schemas for Relay adapters, bindings, and catalog entries.
 *
 * @module shared/relay-adapter-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

import { ChannelTypeSchema } from './relay-envelope-schemas.js';

extendZodWithOpenApi(z);

// === Adapter Configuration Schemas ===

export const AdapterTypeSchema = z
  .enum(['telegram', 'webhook', 'claude-code', 'plugin'])
  .openapi('AdapterType');

export type AdapterType = z.infer<typeof AdapterTypeSchema>;

export const PluginSourceSchema = z
  .object({
    /** npm package name (e.g., 'dorkos-relay-slack') */
    package: z.string().optional(),
    /** Local file path (absolute or relative to config dir) */
    path: z.string().optional(),
  })
  .refine(
    (data) => data.package || data.path,
    { message: 'Plugin source must specify either package or path' },
  )
  .openapi('PluginSource');

export type PluginSource = z.infer<typeof PluginSourceSchema>;

export const TelegramAdapterConfigSchema = z
  .object({
    token: z.string().min(1),
    mode: z.enum(['polling', 'webhook']).default('polling'),
    webhookUrl: z.string().url().optional(),
    webhookPort: z.number().int().positive().optional(),
    webhookSecret: z.string().min(1).optional(),
  })
  .openapi('TelegramAdapterConfig');

export type TelegramAdapterConfig = z.infer<typeof TelegramAdapterConfigSchema>;
/** @deprecated Use {@link TelegramAdapterConfig} */
export type TelegramAdapterConfigZ = TelegramAdapterConfig;

export const WebhookInboundConfigSchema = z
  .object({
    subject: z.string().min(1),
    secret: z.string().min(16),
    previousSecret: z.string().optional(),
  })
  .openapi('WebhookInboundConfig');

export type WebhookInboundConfig = z.infer<typeof WebhookInboundConfigSchema>;

export const WebhookOutboundConfigSchema = z
  .object({
    url: z.string().url(),
    secret: z.string().min(16),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .openapi('WebhookOutboundConfig');

export type WebhookOutboundConfig = z.infer<typeof WebhookOutboundConfigSchema>;

export const WebhookAdapterConfigSchema = z
  .object({
    inbound: WebhookInboundConfigSchema,
    outbound: WebhookOutboundConfigSchema,
  })
  .openapi('WebhookAdapterConfig');

export type WebhookAdapterConfig = z.infer<typeof WebhookAdapterConfigSchema>;
/** @deprecated Use {@link WebhookAdapterConfig} */
export type WebhookAdapterConfigZ = WebhookAdapterConfig;

export const AdapterConfigSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'Must be lowercase alphanumeric with hyphens'),
    type: AdapterTypeSchema,
    enabled: z.boolean().default(true),
    /** Built-in adapter flag — when true, adapter is loaded from @dorkos/relay */
    builtin: z.boolean().optional(),
    /** Plugin source — required when type is 'plugin' */
    plugin: PluginSourceSchema.optional(),
    /** Adapter-specific configuration (passed to adapter constructor/factory) */
    config: z.union([
      TelegramAdapterConfigSchema,
      WebhookAdapterConfigSchema,
      z.record(z.string(), z.unknown()),
    ]),
  })
  .openapi('AdapterConfig');

export type AdapterConfig = z.infer<typeof AdapterConfigSchema>;
/** @deprecated Use {@link AdapterConfig} */
export type AdapterConfigZ = AdapterConfig;

export const AdapterStatusSchema = z
  .object({
    id: z.string(),
    type: AdapterTypeSchema,
    displayName: z.string(),
    state: z.enum(['connected', 'disconnected', 'error', 'starting', 'stopping']),
    messageCount: z.object({
      inbound: z.number().int().nonnegative(),
      outbound: z.number().int().nonnegative(),
    }),
    errorCount: z.number().int().nonnegative(),
    lastError: z.string().optional(),
    lastErrorAt: z.string().datetime().optional(),
    startedAt: z.string().datetime().optional(),
  })
  .openapi('AdapterStatus');

export type AdapterStatus = z.infer<typeof AdapterStatusSchema>;
/** @deprecated Use {@link AdapterStatus} */
export type AdapterStatusZ = AdapterStatus;

export const AdaptersConfigFileSchema = z
  .object({
    adapters: z.array(AdapterConfigSchema),
  })
  .openapi('AdaptersConfigFile');

export type AdaptersConfigFile = z.infer<typeof AdaptersConfigFileSchema>;

// === Adapter Catalog Schemas ===

export const ConfigFieldTypeSchema = z
  .enum(['text', 'password', 'number', 'boolean', 'select', 'textarea', 'url'])
  .openapi('ConfigFieldType');

export type ConfigFieldType = z.infer<typeof ConfigFieldTypeSchema>;

export const ConfigFieldOptionSchema = z
  .object({
    label: z.string(),
    value: z.string(),
  })
  .openapi('ConfigFieldOption');

export type ConfigFieldOption = z.infer<typeof ConfigFieldOptionSchema>;

export const ConfigFieldSchema = z
  .object({
    key: z.string(),
    label: z.string(),
    type: ConfigFieldTypeSchema,
    required: z.boolean(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    placeholder: z.string().optional(),
    description: z.string().optional(),
    options: z.array(ConfigFieldOptionSchema).optional(),
    section: z.string().optional(),
    showWhen: z
      .object({
        field: z.string(),
        equals: z.union([z.string(), z.boolean(), z.number()]),
      })
      .optional(),
  })
  .openapi('ConfigField');

export type ConfigField = z.infer<typeof ConfigFieldSchema>;

export const AdapterSetupStepSchema = z
  .object({
    stepId: z.string(),
    title: z.string(),
    description: z.string().optional(),
    fields: z.array(z.string()),
  })
  .openapi('AdapterSetupStep');

export type AdapterSetupStep = z.infer<typeof AdapterSetupStepSchema>;

export const AdapterCategorySchema = z
  .enum(['messaging', 'automation', 'internal', 'custom'])
  .openapi('AdapterCategory');

export type AdapterCategory = z.infer<typeof AdapterCategorySchema>;

export const AdapterManifestSchema = z
  .object({
    type: z.string(),
    displayName: z.string(),
    description: z.string(),
    iconEmoji: z.string().optional(),
    category: AdapterCategorySchema,
    docsUrl: z.string().url().optional(),
    builtin: z.boolean(),
    configFields: z.array(ConfigFieldSchema),
    setupSteps: z.array(AdapterSetupStepSchema).optional(),
    setupInstructions: z.string().optional(),
    multiInstance: z.boolean().default(false),
    /** Relay adapter API version this adapter targets (e.g., '0.1.0'). */
    apiVersion: z.string().optional(),
  })
  .openapi('AdapterManifest');

export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;

export const CatalogInstanceSchema = z
  .object({
    id: z.string(),
    enabled: z.boolean(),
    status: AdapterStatusSchema,
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('CatalogInstance');

export type CatalogInstance = z.infer<typeof CatalogInstanceSchema>;

export const CatalogEntrySchema = z
  .object({
    manifest: AdapterManifestSchema,
    instances: z.array(CatalogInstanceSchema),
  })
  .openapi('CatalogEntry');

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

// === Adapter Bindings ===

export const SessionStrategySchema = z
  .enum(['per-chat', 'per-user', 'stateless'])
  .openapi('SessionStrategy');

export type SessionStrategy = z.infer<typeof SessionStrategySchema>;

export const AdapterBindingSchema = z
  .object({
    id: z.string().uuid(),
    adapterId: z.string(),
    agentId: z.string(),
    projectPath: z.string(),
    chatId: z.string().optional(),
    channelType: ChannelTypeSchema.optional(),
    sessionStrategy: SessionStrategySchema.default('per-chat'),
    label: z.string().default(''),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('AdapterBinding');

export type AdapterBinding = z.infer<typeof AdapterBindingSchema>;

export const CreateBindingRequestSchema = AdapterBindingSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).openapi('CreateBindingRequest');

export type CreateBindingRequest = z.infer<typeof CreateBindingRequestSchema>;

export const BindingListResponseSchema = z
  .object({
    bindings: z.array(AdapterBindingSchema),
  })
  .openapi('BindingListResponse');

export const BindingResponseSchema = z
  .object({
    binding: AdapterBindingSchema,
  })
  .openapi('BindingResponse');

// === Adapter HTTP Request Schemas ===

export const AdapterTestRequestSchema = z
  .object({
    type: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
  })
  .openapi('AdapterTestRequest');

export type AdapterTestRequest = z.infer<typeof AdapterTestRequestSchema>;

export const AdapterCreateRequestSchema = z
  .object({
    type: z.string().min(1),
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'Must be lowercase alphanumeric with hyphens'),
    config: z.record(z.string(), z.unknown()),
    enabled: z.boolean().optional(),
  })
  .openapi('AdapterCreateRequest');

export type AdapterCreateRequest = z.infer<typeof AdapterCreateRequestSchema>;

export const AdapterConfigUpdateSchema = z
  .object({
    config: z.record(z.string(), z.unknown()),
  })
  .openapi('AdapterConfigUpdate');

export type AdapterConfigUpdate = z.infer<typeof AdapterConfigUpdateSchema>;

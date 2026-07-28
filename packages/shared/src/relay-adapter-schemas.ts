/**
 * Zod schemas for Relay adapters, bindings, and catalog entries.
 *
 * @module shared/relay-adapter-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

import { ChannelTypeSchema } from './relay-envelope-schemas.js';
import { PermissionModeSchema } from './schemas.js';

extendZodWithOpenApi(z);

// === Adapter Configuration Schemas ===

/**
 * A secret-bearing adapter field — a bot token (Telegram, Slack) or other
 * sensitive credential.
 *
 * The value is one of two things depending on where it lives (DOR-280):
 *
 * - **At rest** (`~/.dork/relay/adapters.json`): always a credential
 *   *reference* — `keychain:<id>`, `env:<VAR>`, or `file:<name>` (see
 *   {@link CredentialReferenceSchema}), never a raw secret. The server
 *   materializes any pasted token into an encrypted `file:` reference before
 *   the config touches disk, so a bot token is never persisted in cleartext.
 * - **In transit** (the create/test API, or a legacy pre-DOR-280 file): may be
 *   a raw secret. The schema stays permissive so a founder can paste a token
 *   and so an already-bound bot's cleartext file still parses and can be
 *   migrated — the server converts it to a reference on the next write and
 *   resolves references back to the real secret only in memory at adapter
 *   construction.
 *
 * A reference *is* a non-empty string, so the schema is a plain
 * `z.string().min(1)`: making it reject cleartext would break both the
 * paste-a-token flow and the migration of an existing cleartext config.
 */
export const AdapterSecretSchema = z.string().min(1);

export type AdapterSecret = z.infer<typeof AdapterSecretSchema>;

export const AdapterTypeSchema = z
  .enum(['telegram', 'webhook', 'claude-code', 'slack', 'plugin'])
  .openapi('AdapterType');

export type AdapterType = z.infer<typeof AdapterTypeSchema>;

export const PluginSourceSchema = z
  .object({
    /** npm package name (e.g., 'dorkos-relay-slack') */
    package: z.string().optional(),
    /** Local file path (absolute or relative to config dir) */
    path: z.string().optional(),
  })
  .refine((data) => data.package || data.path, {
    message: 'Plugin source must specify either package or path',
  })
  .openapi('PluginSource');

export type PluginSource = z.infer<typeof PluginSourceSchema>;

/**
 * When a chat integration answers a message in a group conversation.
 *
 * DMs are outside this decision on every platform: a direct message is
 * addressed to the bot by construction, so this never gates one. What does gate
 * a DM is per-platform and not implied here — Slack has `dmPolicy`, Telegram
 * has no such field and answers every direct message. These values only decide
 * group behavior.
 *
 * - `'always'` — answer every message in the group. An agent wins every race
 *   for the next turn, so this is the setting that produces the bot nobody can
 *   hear over.
 * - `'mention-only'` — answer only when the message names the bot.
 * - `'thread-aware'` — answer when the message names the bot, and keep
 *   answering inside a conversation the bot already joined without needing to
 *   be named again. Each platform supplies its own notion of "already joined":
 *   Slack tracks thread participation, Telegram treats a reply to one of the
 *   bot's own messages as the same thing.
 *
 * Shared by every adapter on purpose. A second enum with the same three
 * meanings is how two integrations drift into behaving differently for the
 * same words.
 */
export const RespondModeSchema = z.enum(['always', 'mention-only', 'thread-aware']);

export type RespondMode = z.infer<typeof RespondModeSchema>;

/**
 * The one place the respond-mode default is stated.
 *
 * Every adapter schema below defaults to this, and any code that has to resolve
 * a respond mode outside the schema reads this constant rather than restating a
 * literal. It used to be restated: the Slack schema said `'thread-aware'` while
 * three call sites in the Slack adapter's inbound handler fell back to
 * `'always'`, so whether an unconfigured integration flooded a channel depended
 * on whether its config had happened to travel through the schema (DOR-623).
 */
export const DEFAULT_RESPOND_MODE: RespondMode = 'thread-aware';

export const TelegramAdapterConfigSchema = z
  .object({
    /** Bot token — a credential reference at rest (see {@link AdapterSecretSchema}). */
    token: AdapterSecretSchema,
    mode: z.enum(['polling', 'webhook']).default('polling'),
    webhookUrl: z.string().url().optional(),
    webhookPort: z.number().int().positive().optional(),
    /** Webhook validation secret — a credential reference at rest (see {@link AdapterSecretSchema}). */
    webhookSecret: AdapterSecretSchema.optional(),
    streaming: z.boolean().default(true),
    /**
     * When the bot answers in a group or supergroup — see
     * {@link RespondModeSchema}. Private chats always get an answer and are
     * unaffected by this.
     *
     * Telegram had no such setting and answered every message in every group,
     * which is how two bots in one group answered each other without end
     * (DOR-619). `'thread-aware'` here means: the message names the bot
     * (`@botname`, a `/command@botname`, or a direct user mention), or it
     * replies to a message the bot itself sent.
     *
     * Unlike `dmPolicy`, this deliberately has **no carry-forward and no
     * startup warning** (`services/relay/safe-defaults.ts`). Both of those
     * exist to preserve, and then confess, a permissive value an operator had
     * implicitly chosen. Neither applies here: Telegram never exposed this
     * setting, so nobody chose the old behavior, and every stored integration
     * moves to the *safer* value rather than keeping a risky one. There is no
     * preserved exposure to warn about — and the property that actually keeps
     * the room safe, the bot-loop guard, is a mechanism no setting can reach.
     */
    respondMode: RespondModeSchema.default(DEFAULT_RESPOND_MODE),
    /**
     * Telegram user IDs who may approve a tool call this agent asks about.
     * Empty by default, and empty authorizes nobody (DOR-609).
     */
    approverAllowlist: z.array(z.string()).default([]),
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

export const SlackAdapterConfigSchema = z
  .object({
    /** Bot token (`xoxb-…`) — a credential reference at rest (see {@link AdapterSecretSchema}). */
    botToken: AdapterSecretSchema,
    /** App-level token (`xapp-…`) — a credential reference at rest (see {@link AdapterSecretSchema}). */
    appToken: AdapterSecretSchema,
    /** Signing secret — a credential reference at rest (see {@link AdapterSecretSchema}). */
    signingSecret: AdapterSecretSchema,
    streaming: z.boolean().default(true),
    nativeStreaming: z.boolean().default(true),
    typingIndicator: z.enum(['none', 'reaction']).default('reaction'),
    /**
     * When the bot answers in a channel — see {@link RespondModeSchema}. DMs
     * are gated by {@link SlackAdapterConfigSchema.shape.dmPolicy} instead.
     */
    respondMode: RespondModeSchema.default(DEFAULT_RESPOND_MODE),
    /**
     * Who may DM the bot. A direct message starts an agent turn on the
     * operator's machine, so this defaults to `'allowlist'` — an integration
     * nobody configured answers nobody, rather than answering the whole
     * workspace (DOR-604, ADR 260727-181825). Integrations that predate this
     * default keep `'open'`; see `services/relay/safe-defaults.ts`.
     *
     * This stays a strict enum on purpose. The form shapes that used to slip
     * past it — `''` from a field nobody touched — are normalized at the write
     * boundary (`relay/adapter-config.ts`), and an unreadable stored value is
     * closed on load (`relay/safe-defaults.ts`). Only the literal `'open'`
     * opens it; everything else resolves to `'allowlist'` before it gets here.
     */
    dmPolicy: z.enum(['open', 'allowlist']).default('allowlist'),
    dmAllowlist: z.array(z.string()).default([]),
    /**
     * Slack user IDs who may approve a tool call this agent asks about.
     * Empty by default, and empty authorizes nobody — see
     * `@dorkos/relay` `adapters/approver-allowlist.ts` (DOR-609). Deliberately
     * separate from {@link SlackAdapterConfigSchema.shape.dmAllowlist}: talking
     * to an agent and authorizing a shell command are different privileges.
     */
    approverAllowlist: z.array(z.string()).default([]),
    channelOverrides: z
      .record(
        z.string(),
        z.object({
          enabled: z.boolean().optional(),
          respondMode: RespondModeSchema.optional(),
        })
      )
      .default({}),
  })
  .openapi('SlackAdapterConfig');

export type SlackAdapterConfig = z.infer<typeof SlackAdapterConfigSchema>;

export const AdapterConfigSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, 'Must be lowercase alphanumeric with hyphens'),
    type: AdapterTypeSchema,
    enabled: z.boolean().default(true),
    /** User-facing label to distinguish multiple instances of the same adapter type. */
    label: z.string().optional(),
    /** Built-in adapter flag — when true, adapter is loaded from @dorkos/relay */
    builtin: z.boolean().optional(),
    /** Plugin source — required when type is 'plugin' */
    plugin: PluginSourceSchema.optional(),
    /** Adapter-specific configuration (passed to adapter constructor/factory) */
    config: z.union([
      TelegramAdapterConfigSchema,
      WebhookAdapterConfigSchema,
      SlackAdapterConfigSchema,
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
    state: z.enum(['connected', 'disconnected', 'error', 'starting', 'stopping', 'reconnecting']),
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
    /** Body text shown beneath the label when rendered as radio-cards. */
    description: z.string().optional(),
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
    /** Regex pattern string for client-side blur validation (e.g. `'^\\d+:[\\w-]{35}$'`). */
    pattern: z.string().optional(),
    /** Error message shown when `pattern` does not match. */
    patternMessage: z.string().optional(),
    /** For `password` fields: show the value in plaintext by default (useful for pasted tokens). */
    visibleByDefault: z.boolean().optional(),
    /** When 'radio-cards', renders select options as selectable card buttons instead of a dropdown. */
    displayAs: z.literal('radio-cards').optional(),
    /** Markdown help content shown in a collapsible disclosure below the field. */
    helpMarkdown: z.string().optional(),
    /**
     * How a `textarea` field's text relates to the value stored on disk.
     *
     * A textarea always edits text, but some fields persist as something else:
     * `id-list` stores one entry per line as an array, `json-object` stores the
     * text parsed as an object. Both ends read this one declaration — the form
     * turns a stored value into editable text, and the server turns the text
     * back — so neither side keeps its own list of which key is which shape.
     * Omit it for a textarea that stores plain text.
     */
    valueShape: z.enum(['id-list', 'json-object']).optional(),
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
    iconId: z.string().optional(),
    category: AdapterCategorySchema,
    docsUrl: z.string().url().optional(),
    builtin: z.boolean(),
    configFields: z.array(ConfigFieldSchema),
    setupSteps: z.array(AdapterSetupStepSchema).optional(),
    setupInstructions: z.string().optional(),
    multiInstance: z.boolean().default(false),
    /**
     * When true, the adapter is hidden from the "Add Adapter" catalog.
     * Existing configured instances continue to function normally.
     */
    deprecated: z.boolean().optional(),
    /** Relay adapter API version this adapter targets (e.g., '0.1.0'). */
    apiVersion: z.string().optional(),
    /** Deep-link button shown in the Configure step banner (e.g. to open @BotFather). */
    actionButton: z.object({ label: z.string(), url: z.string() }).optional(),
    /** Full setup guide markdown content, rendered in a side panel Sheet. */
    setupGuide: z.string().optional(),
  })
  .openapi('AdapterManifest');

export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;

export const CatalogInstanceSchema = z
  .object({
    id: z.string(),
    enabled: z.boolean(),
    /** User-facing label to distinguish multiple instances of the same adapter type. */
    label: z.string().optional(),
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
    adapterId: z.string().min(1),
    agentId: z.string().min(1),
    chatId: z.string().optional(),
    channelType: ChannelTypeSchema.optional(),
    sessionStrategy: SessionStrategySchema.default('per-chat'),
    label: z.string().default(''),
    /**
     * The permission mode turns from this binding run in. Defaults to
     * `'default'` — the prompting mode — because a binding carries messages from
     * off this machine and nobody picked a mode for it (DOR-604,
     * ADR 260727-181825). Non-optional in the parsed shape, so there is exactly
     * one place this value is decided; bindings that predate the field are
     * carried forward at `'acceptEdits'` in `services/relay/safe-defaults.ts`.
     */
    permissionMode: PermissionModeSchema.default('default'),
    /**
     * When false, the binding is paused — the router skips it for both
     * inbound delivery and agent-initiated publishes. The binding remains
     * persisted so the user can resume it without reconfiguration.
     *
     * Race-condition note: pausing takes effect at the next routing decision.
     * In-flight messages already past the router filter are not retroactively cancelled.
     */
    enabled: z.boolean().default(true),
    canInitiate: z.boolean().default(false),
    canReply: z.boolean().default(true),
    canReceive: z.boolean().default(true),
    /**
     * When true, a scheduled/manual Task run that finishes on this agent sends
     * an automatic completion message to this channel (DOR-240) — no agent
     * cooperation, no tool call. Failures always notify; successes notify only
     * when this is true. Defaults **true**, but `canInitiate` (default false) is
     * the real gate: nothing reaches the user until they turn a channel's
     * "Agent can start conversations" on, so a fresh binding never sends an
     * unsolicited message despite this default.
     */
    notifyOnTaskComplete: z.boolean().default(true),
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

export type CreateBindingRequest = z.input<typeof CreateBindingRequestSchema>;

/**
 * PATCH body for updating a binding's mutable fields. This is the single
 * source of truth for what the server accepts and what clients may send —
 * `adapterId` and `agentId` are intentionally absent (bindings are re-created,
 * not re-pointed). `chatId` and `channelType` accept `null` to clear the
 * chat filter (JSON drops `undefined`, so `null` is the only wire-safe clear).
 */
export const UpdateBindingRequestSchema = z
  .object({
    sessionStrategy: SessionStrategySchema.optional(),
    label: z.string().optional(),
    chatId: z.string().optional().nullable(),
    channelType: ChannelTypeSchema.optional().nullable(),
    canInitiate: z.boolean().optional(),
    canReply: z.boolean().optional(),
    canReceive: z.boolean().optional(),
    notifyOnTaskComplete: z.boolean().optional(),
    permissionMode: PermissionModeSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .openapi('UpdateBindingRequest');

export type UpdateBindingRequest = z.infer<typeof UpdateBindingRequestSchema>;

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

// === Observed Chats ===

/**
 * A chat observed by an adapter, derived from trace metadata.
 *
 * Used by the BindingDialog chatId picker to show real chats
 * the adapter has seen in trace data.
 */
export const ObservedChatSchema = z
  .object({
    chatId: z.string(),
    displayName: z.string().optional(),
    channelType: ChannelTypeSchema.optional(),
    lastMessageAt: z.string().datetime(),
    messageCount: z.number(),
  })
  .openapi('ObservedChat');

export type ObservedChat = z.infer<typeof ObservedChatSchema>;

export const ObservedChatsResponseSchema = z
  .object({
    chats: z.array(ObservedChatSchema),
  })
  .openapi('ObservedChatsResponse');

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
    /** User-facing label to distinguish multiple instances of the same adapter type. */
    label: z.string().optional(),
  })
  .openapi('AdapterCreateRequest');

export type AdapterCreateRequest = z.infer<typeof AdapterCreateRequestSchema>;

export const AdapterConfigUpdateSchema = z
  .object({
    config: z.record(z.string(), z.unknown()),
  })
  .openapi('AdapterConfigUpdate');

export type AdapterConfigUpdate = z.infer<typeof AdapterConfigUpdateSchema>;

// === Binding Test Result ===

/**
 * Response shape for `POST /api/relay/bindings/:id/test`.
 *
 * Returned by the synthetic test probe endpoint. The probe exercises the
 * full binding resolution pipeline without invoking the agent runtime.
 */
export const BindingTestResultSchema = z
  .object({
    /** Whether the synthetic test probe succeeded in resolving a binding. */
    ok: z.boolean(),
    /** Whether the probe resolved to a valid binding. */
    resolved: z.boolean(),
    /** Round-trip latency in milliseconds. */
    latencyMs: z.number(),
    /** Agent ID that would have received the message if this were real. */
    wouldDeliverTo: z.string().optional(),
    /** Human-readable failure reason when ok=false. */
    reason: z.string().optional(),
    /** Human-readable detail when ok=true. */
    details: z.string().optional(),
  })
  .openapi('BindingTestResult');

export type BindingTestResult = z.infer<typeof BindingTestResultSchema>;

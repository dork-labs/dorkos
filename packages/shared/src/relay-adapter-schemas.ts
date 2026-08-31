/**
 * Zod schemas for Relay adapters, bindings, and catalog entries.
 *
 * @module shared/relay-adapter-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

import { ChannelTypeSchema } from './relay-envelope-schemas.js';
import { PermissionModeSchema } from './schemas.js';

extendZodWithOpenApiOnce();

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
 * addressed to the bot by construction, so this never gates one. What gates a
 * DM is `dmPolicy`, which both Slack and Telegram now carry with identical
 * meaning. These values only decide group behavior.
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
     * Unlike {@link TelegramAdapterConfigSchema.shape.dmPolicy}, this
     * deliberately has **no carry-forward and no startup warning**
     * (`services/relay/safe-defaults.ts`). Both of those
     * exist to preserve, and then confess, a permissive value an operator had
     * implicitly chosen. Neither applies here: Telegram never exposed this
     * setting, so nobody chose the old behavior, and every stored integration
     * moves to the *safer* value rather than keeping a risky one. There is no
     * preserved exposure to warn about — and the property that actually keeps
     * the room safe, the bot-loop guard, is a mechanism no setting can reach.
     */
    respondMode: RespondModeSchema.default(DEFAULT_RESPOND_MODE),
    /**
     * Who may message the bot privately. Same field name, same values and the
     * same meaning as {@link SlackAdapterConfigSchema.shape.dmPolicy} — one
     * vocabulary, so the two integrations cannot drift into meaning different
     * things by the same word.
     *
     * A private message starts an agent turn in the binding's project
     * directory, and a Telegram bot handle is public: anybody who finds it
     * could open a chat and run turns on the operator's machine. Group chats
     * were gated (`respondMode`); private chats were not gated at all. Defaults
     * to `'allowlist'` for the reason Slack does — an integration nobody
     * configured answers nobody, rather than answering the whole world
     * (DOR-604, ADR 260727-181825).
     *
     * Integrations that predate this field keep `'open'` so a working bot does
     * not go silent on upgrade; see `services/relay/safe-defaults.ts`, which
     * also folds an unreadable stored value to `'allowlist'`.
     */
    dmPolicy: z.enum(['open', 'allowlist']).default('allowlist'),
    /** Telegram user IDs allowed to message the bot privately. */
    dmAllowlist: z.array(z.string()).default([]),
    /**
     * Telegram user IDs who may approve a tool call this agent asks about.
     * Empty by default, and empty authorizes nobody (DOR-609). Deliberately
     * separate from {@link TelegramAdapterConfigSchema.shape.dmAllowlist}:
     * talking to an agent and authorizing a shell command are different
     * privileges.
     */
    approverAllowlist: z.array(z.string()).default([]),
  })
  .openapi('TelegramAdapterConfig');

export type TelegramAdapterConfig = z.infer<typeof TelegramAdapterConfigSchema>;
/** @deprecated Use {@link TelegramAdapterConfig} */
export type TelegramAdapterConfigZ = TelegramAdapterConfig;

/**
 * A non-text Telegram message's minimal, byte-free description.
 *
 * Every field but `type` is optional because most kinds carry none of the
 * others — a sticker or a shared location has no duration or filename to
 * report. No media bytes are downloaded, stored, or given to a model in phase
 * 1 (`specs/chats-as-channels/02-specification.md` §5.5); this is exactly what
 * the server-side placeholder builder (`[photo]`, `[voice message, 0:14]`,
 * `[document: report.pdf]`) needs and nothing more.
 *
 * `photo`, `sticker`, `voice`, `document`, `video`, and `location` are the six
 * kinds §5.5 names. `audio` (a music file, distinct from `voice`) and
 * `video_note` (a round video message) are added beyond that list so the same
 * §5.5 property — a non-text message publishes with a descriptor instead of
 * vanishing — holds for every common Telegram media kind, not only the ones
 * the spec happened to enumerate.
 */
export const TelegramMediaDescriptorSchema = z
  .object({
    type: z.enum([
      'photo',
      'sticker',
      'voice',
      'document',
      'video',
      'location',
      'audio',
      'video_note',
    ]),
    /** Playback length in seconds — `voice`, `video`, `audio`, and `video_note` only. */
    durationSec: z.number().optional(),
    /** Original filename, as Telegram reports it — `document`, `video`, and `audio` only. */
    fileName: z.string().optional(),
    /** MIME type, when Telegram supplies one. */
    mimeType: z.string().optional(),
  })
  .openapi('TelegramMediaDescriptor');

export type TelegramMediaDescriptor = z.infer<typeof TelegramMediaDescriptorSchema>;

/**
 * The Telegram adapter's own shape for `StandardPayload.platformData`.
 *
 * `platformData` itself stays `z.unknown()` on `StandardPayloadSchema` —
 * every adapter shapes it differently, and every consumer that reads out of
 * it already parses rather than casts (`binding-router.ts`'s
 * `PlatformIdentitySchema` is the existing example). This schema documents
 * and validates the Telegram adapter's own shape for its own tests and for
 * any downstream reader that wants a typed, optional parse instead of a cast.
 *
 * `replyToMessageId`, `messageThreadId` + `threadName`, and `media` are the
 * four additive fields named in spec §11.2 — all optional, so a fixture or a
 * reader that predates them keeps parsing unchanged
 * (`specs/chats-as-channels/02-specification.md` §11.2).
 */
export const TelegramPlatformDataSchema = z
  .object({
    chatId: z.number(),
    messageId: z.number(),
    chatType: z.string(),
    fromId: z.number().optional(),
    username: z.string().optional(),
    /** The id of the message being replied to (spec §5.4's reply-as-addressing, §6.5's reply targeting). */
    replyToMessageId: z.number().optional(),
    /** The forum topic id a message belongs to, so outbound delivery can target it (spec §5.6). */
    messageThreadId: z.number().optional(),
    /** The forum topic's name, when Telegram supplied it cheaply, sanitized before render (spec §5.6, §9.2). */
    threadName: z.string().optional(),
    /** A non-text message's descriptor (spec §5.5). */
    media: TelegramMediaDescriptorSchema.optional(),
    /** The bound bot's own `@`-handle, for a bridged room's mention translation (spec §5.4). */
    botUsername: z.string().optional(),
  })
  .openapi('TelegramPlatformData');

export type TelegramPlatformData = z.infer<typeof TelegramPlatformDataSchema>;

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
    /**
     * `.strict()` on the inner object is deliberate (DOR-655): a plain
     * `z.object()` silently strips unrecognized keys, so
     * `{"C01ABC": {"bogusKey": 1}}` used to parse to `{"C01ABC": {}}` — a
     * successful save that discarded the person's rule with no signal at any
     * layer. Strict refuses it instead, naming the offending key, matching
     * the loud failure the DOR-640 work already gives a malformed
     * `respondMode`.
     */
    channelOverrides: z
      .record(
        z.string(),
        z
          .object({
            enabled: z.boolean().optional(),
            respondMode: RespondModeSchema.optional(),
          })
          .strict()
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

/**
 * The reason a wildcard binding cannot carry `bridge: 'room'` (chats-as-channels
 * spec §3.1). A binding with no `chatId` matches every chat on its adapter
 * (`BindingStore.resolve`, `initiate-consent.ts:196-203`), so bridging one would
 * mean one room silently receiving — and answering into — an unbounded set of
 * platform chats. Exported so the PATCH route can raise the identical message
 * for the merged-state case {@link AdapterBindingObjectSchema}'s refinement
 * cannot see (a wildcard-clearing update and a bridge-flip update can land in
 * separate PATCH calls).
 */
export const BRIDGE_REQUIRES_CHAT_ID_MESSAGE =
  'A bridge cannot be attached to a wildcard binding — one room cannot honestly be the channel for an unbounded set of chats.';

/**
 * Whether a `(bridge, chatId)` pair is valid: `bridge: 'room'` requires a
 * non-empty `chatId` (spec §3.1). Shared between
 * {@link AdapterBindingObjectSchema}'s refinement (the create path, which
 * always has the full object) and the PATCH route (which must check the
 * MERGED state, since an update may set `bridge` without resending `chatId`).
 *
 * @param binding - The `bridge` and `chatId` fields to check together.
 */
export function bridgeAllowsChatId(binding: { bridge: string; chatId?: string | null }): boolean {
  return binding.bridge !== 'room' || Boolean(binding.chatId);
}

/**
 * The RAW platform chat type a message arrived from, exactly as the adapter's
 * own API reported it (Telegram's `chat.type`): a two-way `private` chat, a
 * `group` or `supergroup`, or a one-way broadcast `channel`.
 *
 * Distinct from {@link ChannelTypeSchema}: that is the subject-level routing
 * classification (`dm`/`group`/…), which deliberately folds a broadcast into
 * `group` and so cannot tell the two apart. This preserves the distinction the
 * subject throws away, so a stored binding can be bridged as a channel when it
 * is a real group and refused precisely when it is a broadcast (DOR-907, spec
 * §3.3). `channel` is the value that must never be bridged; `group`/`supergroup`
 * are the values DOR-878 could not safely allow before this field existed.
 */
export const PlatformChatTypeSchema = z
  .enum(['private', 'group', 'supergroup', 'channel'])
  .openapi('PlatformChatType');

export type PlatformChatType = z.infer<typeof PlatformChatTypeSchema>;

/**
 * The bare object shape, split out from {@link AdapterBindingSchema} so
 * `CreateBindingRequestSchema` can still `.omit()` fields — `.omit` is a
 * `ZodObject` method and is not carried by the `ZodEffects` wrapper `.refine()`
 * returns, so the refinement has to be applied AFTER the omit on each derived
 * schema rather than once here.
 *
 * Exported (rather than kept module-private) so a future derived schema can
 * `.omit()`/`.extend()` it the same way `CreateBindingRequestSchema` does,
 * without having to duplicate the whole shape to get back a `ZodObject`.
 */
export const AdapterBindingObjectSchema = z.object({
  id: z.string().uuid(),
  adapterId: z.string().min(1),
  agentId: z.string().min(1),
  chatId: z.string().optional(),
  channelType: ChannelTypeSchema.optional(),
  /**
   * The RAW platform chat type this binding's chat is, captured at creation
   * from the sighting that produced it (`platformData.chatType`) and never
   * re-derived. Unlike {@link ChannelTypeSchema}'s `channelType`, this keeps a
   * broadcast `channel` distinct from a `group`, which is what lets the
   * "Bridge to a channel" action bridge a real group and refuse a broadcast
   * precisely (DOR-907, spec §3.3).
   *
   * Optional, so it is additive and back-compatible: a binding that predates
   * this field (or was created outside the claim flow, which carries no
   * platform type) parses with it absent, and the bridge action falls back to
   * the conservative DM-only rule for any binding whose platform type is
   * unknown — it never bridges a non-DM it cannot prove is a group.
   */
  platformChatType: PlatformChatTypeSchema.optional(),
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
  /**
   * The chats-as-channels feature flag, per chat (spec §3.1). Defaults `'off'`,
   * which IS what makes the feature shippable without a global flag or a
   * `~/.dork/config.json` migration: every binding that predates this field
   * parses as `'off'` and routes exactly as it did before (A11.2).
   */
  bridge: z.enum(['off', 'room']).default('off'),
  /**
   * The room this binding is bridged to, set iff `bridge === 'room'`. Null
   * rather than optional so a client clearing a bridge can say so explicitly
   * (JSON drops `undefined`, so `null` is the only wire-safe clear — the same
   * reasoning `UpdateBindingRequestSchema`'s doc comment gives for `chatId`).
   */
  roomId: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const AdapterBindingSchema = AdapterBindingObjectSchema.refine(bridgeAllowsChatId, {
  message: BRIDGE_REQUIRES_CHAT_ID_MESSAGE,
  path: ['chatId'],
}).openapi('AdapterBinding');

export type AdapterBinding = z.infer<typeof AdapterBindingSchema>;

export const CreateBindingRequestSchema = AdapterBindingObjectSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
  .refine(bridgeAllowsChatId, {
    message: BRIDGE_REQUIRES_CHAT_ID_MESSAGE,
    path: ['chatId'],
  })
  .openapi('CreateBindingRequest');

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
    /**
     * See {@link AdapterBindingObjectSchema}. Not refined against `chatId`
     * here — a PATCH body is partial, so `bridge: 'room'` may arrive without
     * `chatId` when the binding already has one. The route checks the MERGED
     * state with {@link bridgeAllowsChatId} instead.
     */
    bridge: z.enum(['off', 'room']).optional(),
    roomId: z.string().optional().nullable(),
  })
  .openapi('UpdateBindingRequest');

export type UpdateBindingRequest = z.infer<typeof UpdateBindingRequestSchema>;

/**
 * Body for `POST /api/relay/bindings/:id/move` (connection-scoping spec
 * `specs/connection-scoping/` §Part 2 Move semantics) — re-point an existing
 * binding to a different agent, the one narrow exception to
 * `UpdateBindingRequestSchema`'s "bindings are re-created, not re-pointed."
 */
export const MoveBindingRequestSchema = z
  .object({
    agentId: z.string().min(1),
  })
  .openapi('MoveBindingRequest');

export type MoveBindingRequest = z.infer<typeof MoveBindingRequestSchema>;

// === Unclaimed chats (the claim feed) ===

/** Lifecycle status of one unclaimed-chat row (connection-scoping spec §Part 3). */
export const UnclaimedChatStatusSchema = z
  .enum(['pending', 'claimed', 'ignored', 'blocked'])
  .openapi('UnclaimedChatStatus');

/** One claim-feed row's lifecycle state. See {@link UnclaimedChatStatusSchema}. */
export type UnclaimedChatStatus = z.infer<typeof UnclaimedChatStatusSchema>;

/**
 * A chat an adapter heard from with no binding to route it to
 * (connection-scoping spec `specs/connection-scoping/` §Part 3). Carries only
 * subject-derived routing fields and sender-identity metadata — NEVER the
 * message body.
 */
/**
 * Longest stranger-controlled display string this schema admits —
 * `senderName`/`chatTitle` are set by whoever is on the other end of an
 * unbound chat, never the operator (adversarial review MINOR 11). Truncated
 * at the store, not rejected here — this bound documents the wire contract;
 * `UnclaimedChatStore.recordSighting`'s own truncation is what actually
 * enforces it before a row is ever written.
 */
const MAX_UNCLAIMED_DISPLAY_NAME_LENGTH = 200;

export const UnclaimedChatSchema = z
  .object({
    id: z.string(),
    adapterId: z.string(),
    chatId: z.string(),
    channelType: ChannelTypeSchema.nullable(),
    chatKind: z.enum(['dm', 'group']),
    /**
     * The RAW platform chat type (DOR-907), kept distinct from the folded
     * {@link chatKind} so a broadcast `channel` stays tellable apart from a
     * real `group`/`supergroup` on THIS card, not only on a binding a claim
     * later creates. `null` for an adapter that reports none (Slack) or a
     * sighting recorded before this column existed. The group-add claim flow
     * (DOR-883) is what reads it: a broadcast offers only Ignore/Leave, never
     * Join, because there is no one in a one-way feed for an agent to answer.
     */
    platformChatType: PlatformChatTypeSchema.nullable(),
    senderName: z.string().max(MAX_UNCLAIMED_DISPLAY_NAME_LENGTH).nullable(),
    senderId: z.string().nullable(),
    /** Group/channel display title (`payload.channelName`), when the adapter carried one. */
    chatTitle: z.string().max(MAX_UNCLAIMED_DISPLAY_NAME_LENGTH).nullable(),
    status: UnclaimedChatStatusSchema,
    /** Damping counter — bumped, not re-inserted, on repeat sightings. */
    messageCount: z.number().int().nonnegative(),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    decidedAt: z.string().datetime().nullable(),
    decidedAgentId: z.string().nullable(),
  })
  .openapi('UnclaimedChat');

export type UnclaimedChat = z.infer<typeof UnclaimedChatSchema>;

/** Response of `GET /api/relay/unclaimed-chats`. */
export const UnclaimedChatListResponseSchema = z
  .object({
    chats: z.array(UnclaimedChatSchema),
  })
  .openapi('UnclaimedChatListResponse');

/** Body for `POST /api/relay/unclaimed-chats/:id/claim`. */
export const ClaimUnclaimedChatRequestSchema = z
  .object({
    agentId: z.string().min(1),
    sessionStrategy: SessionStrategySchema.optional(),
    permissionMode: PermissionModeSchema.optional(),
    label: z.string().optional(),
    /**
     * The claim card's primary/secondary split (chats-as-channels spec §3.1,
     * D-1 Move 2). `true` is "Answer in a channel" — claim, bind, and bridge
     * atomically through the same path the "Bridge to a channel" action uses
     * (DOR-878), landing the person in a room. Omitted or `false` is "Answer
     * privately" — today's session-per-chat behaviour, no room.
     */
    bridge: z.boolean().optional(),
  })
  .openapi('ClaimUnclaimedChatRequest');

/** Body of a claim call. See {@link ClaimUnclaimedChatRequestSchema}. */
export type ClaimUnclaimedChatRequest = z.infer<typeof ClaimUnclaimedChatRequestSchema>;

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

/**
 * Response of `POST /api/relay/unclaimed-chats/:id/claim`. The claim and the
 * binding always succeed together — `binding` is always present. When
 * "Answer in a channel" was requested and the bridge step could not complete,
 * the claim still stands (the chat is answered privately, `binding.bridge`
 * stays `'off'`) and `bridgeError` names why, so nothing is silently
 * half-built (chats-as-channels spec §3.1, task 2.1).
 */
export const ClaimUnclaimedChatResponseSchema = z
  .object({
    binding: AdapterBindingSchema,
    bridgeError: z.string().optional(),
  })
  .openapi('ClaimUnclaimedChatResponse');

/** Response of a claim call. See {@link ClaimUnclaimedChatResponseSchema}. */
export type ClaimUnclaimedChatResponse = z.infer<typeof ClaimUnclaimedChatResponseSchema>;

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

import { z } from 'zod';
import { EXTENSION_EVENT_DECLARATIONS } from './extension-events.js';

/**
 * Declares which host events an extension may subscribe to via
 * `api.events.subscribe`. Each entry is either a specific event kind
 * (e.g. `'turn.completed'`) or a whole category (e.g. `'session'`), matching
 * the {@link EXTENSION_EVENT_DECLARATIONS} set. Subscriptions to undeclared
 * kinds are rejected at runtime — this is the capability gate.
 */
const ExtensionCapabilitiesSchema = z.object({
  /** Event kinds or categories this extension is allowed to subscribe to. */
  events: z.array(z.enum(EXTENSION_EVENT_DECLARATIONS)).optional(),
});

/** Declares a secret an extension needs (e.g., an API key). */
const SecretDeclarationSchema = z.object({
  /** Secret key name (lowercase snake_case). */
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  /** Human-readable label for the settings UI. */
  label: z.string().min(1),
  /** Help text shown in the settings UI. */
  description: z.string().optional(),
  /** Custom placeholder hint for the password input (e.g., 'lin_api_xxxx'). */
  placeholder: z.string().optional(),
  /** Whether the extension cannot function without this secret. */
  required: z.boolean().default(false),
  /** Group name for collapsible section organization. */
  group: z.string().optional(),
});

/** Option for select-type settings. */
export const SettingOptionSchema = z.object({
  label: z.string().min(1),
  value: z.union([z.string(), z.number()]),
});

/** Non-secret configuration field declared in the manifest. */
export const SettingDeclarationSchema = z.object({
  /** Field type: text, number, boolean, or select. */
  type: z.enum(['text', 'number', 'boolean', 'select']),
  /** Setting key name (lowercase snake_case). */
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  /** Human-readable label for the settings UI. */
  label: z.string().min(1),
  /** Help text shown in the settings UI. */
  description: z.string().optional(),
  /** Placeholder text for text and number inputs. */
  placeholder: z.string().optional(),
  /** Default value used when no user override is stored. */
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Whether the extension cannot function without this setting. */
  required: z.boolean().default(false),
  /** Group name for collapsible section organization. */
  group: z.string().optional(),
  /** Options for select-type fields. */
  options: z.array(SettingOptionSchema).optional(),
  /** Minimum value for number-type fields. */
  min: z.number().optional(),
  /** Maximum value for number-type fields. */
  max: z.number().optional(),
});

/** Declarative proxy configuration for zero-code API passthrough (Tier 1). */
const DataProxySchema = z.object({
  /** Base URL of the upstream API. */
  baseUrl: z.string().url(),
  /** HTTP header name for the auth credential. */
  authHeader: z.string().default('Authorization'),
  /** How the secret value is formatted in the header. */
  authType: z.enum(['Bearer', 'Basic', 'Token', 'Custom']).default('Bearer'),
  /** Key name in the extension's secret store to use for auth. */
  authSecret: z.string(),
  /** Optional path rewriting rules (from -> to). */
  pathRewrite: z.record(z.string(), z.string()).optional(),
});

/** Server-side capability declarations for data-provider extensions. */
const ServerCapabilitiesSchema = z.object({
  /** Path to the server entry point relative to extension directory. */
  serverEntry: z.string().default('./server.ts'),
  /** Allowlisted external hosts this extension will contact. */
  externalHosts: z.array(z.string().url()).optional(),
  /** Secrets this extension requires (drives auto-generated settings UI). */
  secrets: z.array(SecretDeclarationSchema).optional(),
  /** Non-secret configuration fields (drives auto-generated settings UI). */
  settings: z.array(SettingDeclarationSchema).optional(),
});

/**
 * One forward-only schema migration for an extension's database.
 *
 * `.strict()` rejects unknown keys so a typo (e.g. `down`) fails validation
 * rather than being silently ignored — migrations are append-only and never
 * edited once shipped, so the envelope must be exact.
 */
export const StorageMigrationSchema = z
  .object({
    /** Monotonic, 1-based version. Must equal its array index + 1 (enforced by the declaration). */
    version: z.number().int().positive(),
    /** Optional human note surfaced in migration errors/logs. */
    name: z.string().optional(),
    /**
     * The migration body: one or more DDL/DML statements applied in a single
     * SQLite transaction. DDL (CREATE/ALTER/DROP TABLE|INDEX, CREATE TRIGGER)
     * is allowed HERE and only here — the runtime query API forbids it.
     */
    up: z.string().min(1),
  })
  .strict();

/**
 * Per-extension storage declaration: the byte quota and the ordered,
 * append-only list of schema migrations that build the extension's database.
 *
 * `.strict()` rejects unknown keys; the refinement enforces that migrations are
 * numbered `1..N` in order with no gaps or duplicates, so a mis-numbered
 * migration set fails at manifest-parse time rather than at apply time.
 */
export const StorageDeclarationSchema = z
  .object({
    /**
     * Requested byte quota for this extension's database. Clamped to the host
     * maximum (`extensions.dataQuotaBytes`, config-manager). Omitted = host default.
     */
    quotaBytes: z.number().int().positive().optional(),
    /** Ordered, append-only migrations. Versions must be 1..N with no gaps. */
    migrations: z.array(StorageMigrationSchema),
  })
  .strict()
  .refine((s) => s.migrations.every((m, i) => m.version === i + 1), {
    message: 'storage.migrations must be numbered 1..N in order with no gaps',
  });

/** Zod schema for `extension.json` manifest files. */
export const ExtensionManifestSchema = z.object({
  /** Unique extension identifier (kebab-case). Used as directory name and registry key. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Human-readable display name. */
  name: z.string().min(1),
  /** Semver version string. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** Short description shown in settings UI. */
  description: z.string().optional(),
  /** Author name or identifier. */
  author: z.string().optional(),
  /** Minimum DorkOS version required (semver). If host is older, extension cannot be enabled. */
  minHostVersion: z.string().optional(),
  /** Declares which slots this extension contributes to. Informational only — not enforced. */
  contributions: z.record(z.string(), z.boolean()).optional(),
  /** Reserved for future permission model. */
  permissions: z.array(z.string()).optional(),
  /** Client-side capability declarations (e.g. which host events to subscribe to). */
  capabilities: ExtensionCapabilitiesSchema.optional(),
  /** Server-side capability declarations. Present if the extension has server.ts. */
  serverCapabilities: ServerCapabilitiesSchema.optional(),
  /** Declarative proxy config for zero-code API passthrough. */
  dataProxy: DataProxySchema.optional(),
  /** Per-extension SQLite storage declaration: byte quota + versioned schema migrations. */
  storage: StorageDeclarationSchema.optional(),
  /** For core extensions: whether this ships enabled. Omitted/true = on, false = off. Ignored for user extensions. */
  defaultEnabled: z.boolean().optional(),
  /** Whether the user may disable this extension. Defaults to true. false = always on, no toggle shown. */
  canDisable: z.boolean().optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
export type SecretDeclaration = z.infer<typeof SecretDeclarationSchema>;
export type SettingOption = z.infer<typeof SettingOptionSchema>;
export type SettingDeclaration = z.infer<typeof SettingDeclarationSchema>;
export type DataProxyConfig = z.infer<typeof DataProxySchema>;
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
export type ExtensionCapabilities = z.infer<typeof ExtensionCapabilitiesSchema>;
export type StorageMigration = z.infer<typeof StorageMigrationSchema>;
export type StorageDeclaration = z.infer<typeof StorageDeclarationSchema>;

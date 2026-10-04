import { z } from 'zod';
import {
  CAPABILITY_TIERS,
  EXTENSION_MCP_TOOL_NAME_MAX,
  EXTENSION_TOOL_NAME_PATTERN,
  EXTENSION_TOOL_TITLE_MAX,
  extensionMcpToolName,
} from '@dorkos/shared/capabilities';
import { EXTENSION_ID_REGEX } from '@dorkos/shared/extension-id';
import { validateSlug } from '@dorkos/skills/slug';
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

/** The longest a tool may run before DorkOS stops waiting, in seconds. */
export const EXTENSION_TOOL_TIMEOUT_MAX_SECONDS = 300;

/** How long a tool may run when its declaration does not say, in seconds. */
export const EXTENSION_TOOL_TIMEOUT_DEFAULT_SECONDS = 60;

/**
 * One tool an extension gives the person's agents (DOR-2685).
 *
 * Declared here, handled in `server.ts` with `ctx.tools.handle(name, handler)`.
 * Agents see it as `ext_<extension id>__<name>`. The input schema is checked
 * again by DorkOS when the extension is discovered: it must be a closed JSON
 * Schema (every object says `"additionalProperties": false`), because one
 * open-ended schema would hide every DorkOS tool from Claude Code agents.
 */
export const ExtensionToolDeclarationSchema = z.object({
  /**
   * The tool's name inside this extension, e.g. `send_message`: lowercase
   * words joined by single underscores.
   */
  name: z
    .string()
    .regex(
      EXTENSION_TOOL_NAME_PATTERN,
      'Use lowercase letters and digits, with single underscores between words'
    ),
  /** The label a person reads on approval cards and the permissions page. One line. */
  title: z.string().min(1).max(EXTENSION_TOOL_TITLE_MAX),
  /** What the tool does and when an agent should use it. */
  description: z.string().min(1).max(1024),
  /**
   * `observe` only reads; `act` changes something and can be set to ask first;
   * `destructive` deletes or removes something and asks a person every time.
   */
  tier: z.enum(CAPABILITY_TIERS),
  /** The input as a JSON Schema object. DorkOS checks the full rules at discovery. */
  inputSchema: z.object({ type: z.literal('object') }).passthrough(),
  /**
   * Top-level input fields the approval card shows, most important first.
   * Required for `act` and `destructive` tools.
   */
  approvalDisplayFields: z.array(z.string()).optional(),
  /**
   * How long one call may run before DorkOS stops waiting, in seconds
   * (1 to {@link EXTENSION_TOOL_TIMEOUT_MAX_SECONDS}, default
   * {@link EXTENSION_TOOL_TIMEOUT_DEFAULT_SECONDS}). There is no way to turn
   * the limit off.
   */
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(EXTENSION_TOOL_TIMEOUT_MAX_SECONDS)
    .default(EXTENSION_TOOL_TIMEOUT_DEFAULT_SECONDS),
});

/**
 * One skill an extension ships: the name of a folder under `<extension>/skills/`
 * holding a `SKILL.md`, following the SKILL.md naming rule.
 */
export const ExtensionSkillDeclarationSchema = z
  .string()
  .refine(validateSlug, 'Use 1-64 lowercase letters, digits and single hyphens');

/**
 * Re-exported from `@dorkos/shared/extension-id`, which owns the single
 * definition: the stores that name a file after an extension id sit below this
 * package, so the rule has to live below them both.
 */
export { EXTENSION_ID_REGEX };

/**
 * The fields of `extension.json`, before the checks that span several fields
 * ({@link ExtensionManifestSchema} adds those).
 */
const ExtensionManifestObjectSchema = z.object({
  /** Unique extension identifier (kebab-case). Used as directory name and registry key. */
  id: z.string().min(1).regex(EXTENSION_ID_REGEX),
  /** Human-readable display name. */
  name: z.string().min(1),
  /** Semver version string. */
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  /** Short description shown in settings UI. */
  description: z.string().optional(),
  /**
   * What the extension does, written to finish the sentence "This adds a Flow
   * tab that …" (e.g. "shows what your agents are working on"). DorkOS uses it
   * in the one line that asks a person to turn the extension on, so keep it
   * plain and short.
   */
  purpose: z.string().max(120).optional(),
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
  /**
   * Tools this extension gives the person's agents while it runs (DOR-2685).
   * Needs a server entry (`serverCapabilities`), where `ctx.tools.handle`
   * binds each one. Not the same as
   * `capabilities`, which declares the host events the extension may subscribe to.
   */
  tools: z.array(ExtensionToolDeclarationSchema).optional(),
  /** Skills this extension ships, by folder name under `<extension>/skills/`. */
  skills: z.array(ExtensionSkillDeclarationSchema).optional(),
});

/**
 * Check the rules that span fields: tool names are unique, tools need a server
 * entry, every approval display field is a top-level input property, and every
 * tool's full MCP name fits the model API's limit.
 */
function checkToolDeclarations(
  manifest: z.infer<typeof ExtensionManifestObjectSchema>,
  ctx: z.RefinementCtx
): void {
  const tools = manifest.tools ?? [];
  if (tools.length > 0 && !manifest.serverCapabilities) {
    ctx.addIssue({
      code: 'custom',
      path: ['tools'],
      message: 'Tools need a server entry: add "serverCapabilities" and handle them in server.ts',
    });
  }
  const seen = new Set<string>();
  tools.forEach((tool, index) => {
    if (seen.has(tool.name)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tools', index, 'name'],
        message: `Tool "${tool.name}" is declared more than once`,
      });
    }
    seen.add(tool.name);
    const properties = tool.inputSchema.properties;
    const keys =
      properties && typeof properties === 'object' && !Array.isArray(properties)
        ? Object.keys(properties)
        : [];
    (tool.approvalDisplayFields ?? []).forEach((field, fieldIndex) => {
      if (!keys.includes(field)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tools', index, 'approvalDisplayFields', fieldIndex],
          message: `Tool "${tool.name}" shows "${field}" on its approval card, but its input has no such property`,
        });
      }
    });
    const mcpName = extensionMcpToolName(manifest.id, tool.name);
    if (mcpName.length > EXTENSION_MCP_TOOL_NAME_MAX) {
      ctx.addIssue({
        code: 'custom',
        path: ['tools', index, 'name'],
        message: `Tool "${tool.name}" makes the name ${mcpName} (${mcpName.length} characters); agents allow at most ${EXTENSION_MCP_TOOL_NAME_MAX}`,
      });
    }
  });
  const skills = new Set<string>();
  (manifest.skills ?? []).forEach((skill, index) => {
    if (skills.has(skill)) {
      ctx.addIssue({
        code: 'custom',
        path: ['skills', index],
        message: `Skill "${skill}" is listed more than once`,
      });
    }
    skills.add(skill);
  });
}

/** Zod schema for `extension.json` manifest files. */
export const ExtensionManifestSchema =
  ExtensionManifestObjectSchema.superRefine(checkToolDeclarations);

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
export type SecretDeclaration = z.infer<typeof SecretDeclarationSchema>;
export type SettingOption = z.infer<typeof SettingOptionSchema>;
export type SettingDeclaration = z.infer<typeof SettingDeclarationSchema>;
export type DataProxyConfig = z.infer<typeof DataProxySchema>;
export type ServerCapabilities = z.infer<typeof ServerCapabilitiesSchema>;
export type ExtensionCapabilities = z.infer<typeof ExtensionCapabilitiesSchema>;
export type StorageMigration = z.infer<typeof StorageMigrationSchema>;
export type StorageDeclaration = z.infer<typeof StorageDeclarationSchema>;
export type ExtensionToolDeclaration = z.infer<typeof ExtensionToolDeclarationSchema>;

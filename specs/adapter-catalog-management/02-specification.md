---
slug: adapter-catalog-management
number: 67
created: 2026-02-27
status: draft
---

# Specification: Adapter Catalog & Management UI

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-27
**Ideation:** [01-ideation.md](./01-ideation.md)
**Research:** [research/20260227_adapter_catalog_patterns.md](../../research/20260227_adapter_catalog_patterns.md)

---

## Overview

Add a declarative adapter metadata system and management UI to DorkOS's Relay subsystem. Each adapter (built-in or npm plugin) declares its own metadata — config schema descriptors, display info, setup instructions — via an `AdapterManifest`. The server aggregates manifests into a browsable catalog. The client renders catalog cards, setup wizards with dynamic forms, and CRUD controls for adapter instances. Users can add a Telegram adapter entirely through the UI with zero JSON editing. Developers creating new adapters export a manifest alongside their `RelayAdapter` implementation and get automatic setup wizards for free.

## Background / Problem Statement

Today, the Relay Adapters tab only shows adapters already configured in `~/.dork/relay/adapters.json`. The default config contains only the `claude-code` adapter. Users cannot discover that Telegram and Webhook adapters exist without reading documentation. Adding an adapter requires manually editing a JSON file with the correct schema. There is no way to configure, test, or remove adapters through the UI.

This creates two problems:
1. **Poor user experience** — users don't know what adapters are available and must edit JSON to use them
2. **Poor developer experience** — adapter authors have no way to declare their config schema for automatic form generation; the UI treats all adapters as opaque

## Goals

- Users can browse all available adapter types (built-in + installed plugins) without reading docs
- Users can add, configure, test, enable/disable, and remove adapters entirely through the UI
- Adapter developers declare metadata once (manifest + config fields) and get setup wizards automatically
- Sensitive fields (tokens, secrets) are never returned in API GET responses
- npm plugin adapters that export manifests participate in the catalog seamlessly
- Existing adapter functionality (messaging, routing, lifecycle, hot-reload) is unchanged

## Non-Goals

- Building specific new adapters (Slack, Discord, etc.) — separate effort per adapter
- CLI scaffolding tools for adapter developers (`create-dorkos-adapter`)
- Marketplace or remote registry for discovering npm packages not already installed
- OS keychain integration for secret storage (future hardening)
- Adapter versioning or multi-version support
- Migrating the Adapters tab to a standalone top-level panel

## Technical Dependencies

- **Existing:** `@dorkos/relay` (adapter system), `@dorkos/shared` (Zod schemas, Transport), `@slack/bolt` is NOT required (Slack adapter is out of scope)
- **No new external libraries required** — all form rendering uses existing shadcn/ui primitives (Input, Select, Switch, Textarea, Dialog, DropdownMenu, Badge, Button)
- **Zod** remains the server-side validation layer; ConfigField[] descriptors are a parallel, client-facing data structure

## Detailed Design

### 1. ConfigField Type (`packages/shared`)

A plain, JSON-serializable descriptor for a single form field. Lives in `packages/shared/src/relay-schemas.ts` alongside the existing adapter schemas.

```typescript
export const ConfigFieldTypeSchema = z.enum([
  'text',       // Standard string input
  'password',   // Masked input — value never echoed in GET responses
  'number',     // Numeric input
  'boolean',    // Toggle/checkbox
  'select',     // Dropdown from options[]
  'textarea',   // Multi-line text
  'url',        // URL input with format hint
]);

export const ConfigFieldOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
});

export const ConfigFieldSchema = z.object({
  /** Key in the adapter config object (must match Zod schema key) */
  key: z.string(),
  /** Human-readable label displayed above the input */
  label: z.string(),
  /** Input type — drives the rendered component */
  type: ConfigFieldTypeSchema,
  /** Whether the field is required */
  required: z.boolean(),
  /** Default value (pre-fills the form) */
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Placeholder shown in empty inputs */
  placeholder: z.string().optional(),
  /** Help text shown below the input */
  description: z.string().optional(),
  /** For type === 'select': the dropdown options */
  options: z.array(ConfigFieldOptionSchema).optional(),
  /** Visual section grouping (e.g., 'Authentication', 'Advanced') */
  section: z.string().optional(),
  /** Conditional visibility: only show when another field has a specific value */
  showWhen: z.object({
    field: z.string(),
    equals: z.union([z.string(), z.boolean(), z.number()]),
  }).optional(),
});

export type ConfigField = z.infer<typeof ConfigFieldSchema>;
export type ConfigFieldType = z.infer<typeof ConfigFieldTypeSchema>;
```

### 2. AdapterManifest Type (`packages/shared`)

Static metadata declared by each adapter. Also in `relay-schemas.ts`.

```typescript
export const AdapterSetupStepSchema = z.object({
  stepId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  /** Config field keys to show on this step */
  fields: z.array(z.string()),
});

export const AdapterCategorySchema = z.enum([
  'messaging',    // Telegram, Slack, Discord
  'automation',   // Webhooks, HTTP integrations
  'internal',     // Claude Code, system adapters
  'custom',       // Community/plugin adapters
]);

export const AdapterManifestSchema = z.object({
  /** Canonical adapter type string (matches AdapterConfig.type for built-ins) */
  type: z.string(),
  /** Human-readable name shown in catalog */
  displayName: z.string(),
  /** Short description for catalog card (1-2 sentences) */
  description: z.string(),
  /** Emoji icon for catalog display */
  iconEmoji: z.string().optional(),
  /** Category for catalog filtering */
  category: AdapterCategorySchema,
  /** External docs URL linked from catalog */
  docsUrl: z.string().url().optional(),
  /** Whether this is a built-in adapter shipped with DorkOS */
  builtin: z.boolean(),
  /** Config field descriptors for the setup wizard */
  configFields: z.array(ConfigFieldSchema),
  /** Optional multi-step wizard definition */
  setupSteps: z.array(AdapterSetupStepSchema).optional(),
  /** Markdown instructions shown at the top of the setup wizard */
  setupInstructions: z.string().optional(),
  /** Whether multiple instances of this adapter type are allowed */
  multiInstance: z.boolean().default(false),
});

export type AdapterManifest = z.infer<typeof AdapterManifestSchema>;
```

### 3. CatalogEntry Type (`packages/shared`)

Returned by the catalog endpoint — pairs a manifest with its configured instances.

```typescript
export const CatalogInstanceSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  status: AdapterStatusSchema,
});

export const CatalogEntrySchema = z.object({
  manifest: AdapterManifestSchema,
  instances: z.array(CatalogInstanceSchema),
});

export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
```

### 4. Built-in Adapter Manifests (`packages/relay`)

Each adapter file exports a static manifest constant alongside the class.

**TelegramAdapter manifest** (`adapters/telegram-adapter.ts`):

```typescript
export const TELEGRAM_MANIFEST: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Send and receive messages via a Telegram bot.',
  iconEmoji: '✈️',
  category: 'messaging',
  docsUrl: 'https://core.telegram.org/bots',
  builtin: true,
  multiInstance: false,
  configFields: [
    {
      key: 'token',
      label: 'Bot Token',
      type: 'password',
      required: true,
      placeholder: '123456789:ABCDefGHijklMNOpqrSTUvwxYZ',
      description: 'Token from @BotFather on Telegram.',
    },
    {
      key: 'mode',
      label: 'Receiving Mode',
      type: 'select',
      required: true,
      default: 'polling',
      options: [
        { label: 'Long Polling', value: 'polling' },
        { label: 'Webhook', value: 'webhook' },
      ],
      description: 'Polling requires no public URL. Webhook is recommended for production.',
    },
    {
      key: 'webhookUrl',
      label: 'Webhook URL',
      type: 'url',
      required: true,
      placeholder: 'https://your-domain.com/relay/webhooks/telegram',
      description: 'Public HTTPS URL where Telegram sends updates.',
      showWhen: { field: 'mode', equals: 'webhook' },
    },
    {
      key: 'webhookPort',
      label: 'Webhook Port',
      type: 'number',
      required: false,
      default: 8443,
      description: 'Port for the webhook HTTP server.',
      showWhen: { field: 'mode', equals: 'webhook' },
    },
  ],
  setupInstructions: 'Open Telegram and search for **@BotFather**. Send `/newbot`, choose a name and username. Copy the token provided.',
};
```

**WebhookAdapter manifest** (`adapters/webhook-adapter.ts`):

```typescript
export const WEBHOOK_MANIFEST: AdapterManifest = {
  type: 'webhook',
  displayName: 'Webhook',
  description: 'Send and receive messages via HMAC-signed HTTP webhooks.',
  iconEmoji: '🔗',
  category: 'automation',
  builtin: true,
  multiInstance: true,
  configFields: [
    {
      key: 'inbound.subject',
      label: 'Inbound Subject',
      type: 'text',
      required: true,
      placeholder: 'relay.webhook.my-service',
      description: 'Relay subject to publish inbound messages to.',
      section: 'Inbound',
    },
    {
      key: 'inbound.secret',
      label: 'Inbound Secret',
      type: 'password',
      required: true,
      description: 'HMAC-SHA256 secret for verifying inbound webhooks (min 16 characters).',
      section: 'Inbound',
    },
    {
      key: 'outbound.url',
      label: 'Outbound URL',
      type: 'url',
      required: true,
      placeholder: 'https://api.example.com/webhook',
      description: 'URL to POST outbound messages to.',
      section: 'Outbound',
    },
    {
      key: 'outbound.secret',
      label: 'Outbound Secret',
      type: 'password',
      required: true,
      description: 'HMAC-SHA256 secret for signing outbound requests (min 16 characters).',
      section: 'Outbound',
    },
    {
      key: 'outbound.headers',
      label: 'Custom Headers',
      type: 'textarea',
      required: false,
      placeholder: '{"Authorization": "Bearer xxx"}',
      description: 'JSON object of custom HTTP headers for outbound requests.',
      section: 'Outbound',
    },
  ],
};
```

**ClaudeCodeAdapter manifest** (`adapters/claude-code-adapter.ts`):

```typescript
export const CLAUDE_CODE_MANIFEST: AdapterManifest = {
  type: 'claude-code',
  displayName: 'Claude Code',
  description: 'Routes messages to Claude Agent SDK sessions. Auto-configured.',
  iconEmoji: '🤖',
  category: 'internal',
  builtin: true,
  multiInstance: false,
  configFields: [
    {
      key: 'maxConcurrent',
      label: 'Max Concurrent Sessions',
      type: 'number',
      required: false,
      default: 3,
      description: 'Maximum number of concurrent agent sessions.',
    },
    {
      key: 'defaultTimeoutMs',
      label: 'Default Timeout (ms)',
      type: 'number',
      required: false,
      default: 300000,
      description: 'Default timeout for agent sessions in milliseconds.',
    },
  ],
};
```

All manifests are re-exported from `packages/relay/src/index.ts`.

### 5. Plugin Manifest Discovery (`packages/relay`)

Extend `adapter-plugin-loader.ts` to extract manifests from plugin modules.

**Updated `AdapterPluginModule` interface:**

```typescript
export interface AdapterPluginModule {
  default: (config: Record<string, unknown>) => RelayAdapter;
  getManifest?: () => AdapterManifest;
}
```

**Updated `loadAdapters` return type:**

```typescript
export interface LoadedAdapter {
  adapter: RelayAdapter;
  manifest?: AdapterManifest;
}

export async function loadAdapters(
  configs: PluginAdapterConfig[],
  builtinMap: Map<string, (config: Record<string, unknown>) => RelayAdapter>,
  configDir: string,
): Promise<LoadedAdapter[]> {
  // ...same loading logic, but also call module.getManifest?.()
  // Validate manifest with AdapterManifestSchema.safeParse()
  // Return {adapter, manifest} pairs
}
```

**Manifest discovery order:**
1. Call `module.getManifest()` if it exists — preferred, TypeScript-typed
2. If not, generate minimal manifest: `{ type: config.type, displayName: config.id, description: 'Custom adapter', configFields: [], builtin: false, category: 'custom' }`

### 6. Server-Side Catalog (`apps/server`)

#### AdapterManager Changes

Add to `AdapterManager`:

```typescript
/** Map of adapter type → manifest (populated from built-ins + loaded plugins) */
private manifests = new Map<string, AdapterManifest>();
```

**New methods:**

- `getCatalog(): CatalogEntry[]` — iterates `manifests`, pairs each with matching instances from `this.configs`, masks sensitive fields
- `addAdapter(type: string, id: string, config: Record<string, unknown>): void` — validates `id` uniqueness, validates config against Zod schema for the type, appends to `this.configs`, saves to disk, starts if enabled
- `removeAdapter(id: string): void` — stops adapter via `registry.unregister()`, removes from `this.configs`, saves to disk
- `updateConfig(id: string, config: Record<string, unknown>): void` — merges config (empty password fields preserve existing values using manifest's `configFields` to identify password keys), saves, restarts adapter
- `testConnection(type: string, config: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>` — creates a transient adapter instance via `createAdapter()`, calls `start()` in a try block, returns `{ ok: true }` on success or `{ ok: false, error }` on failure, always calls `stop()` in finally

**Sensitive field masking:**

When `listAdapters()` or `getCatalog()` returns config data, iterate the manifest's `configFields` and replace any field with `type: 'password'` with the string `"***"`. This prevents tokens/secrets from being sent to the client.

```typescript
private maskSensitiveFields(
  config: Record<string, unknown>,
  manifest?: AdapterManifest,
): Record<string, unknown> {
  if (!manifest) return config;
  const masked = { ...config };
  for (const field of manifest.configFields) {
    if (field.type === 'password' && field.key in masked) {
      masked[field.key] = '***';
    }
  }
  return masked;
}
```

For nested keys like `inbound.secret`, the masking traverses dot-separated paths.

**Manifest population on initialize:**

```typescript
private populateBuiltinManifests(): void {
  this.manifests.set('telegram', TELEGRAM_MANIFEST);
  this.manifests.set('webhook', WEBHOOK_MANIFEST);
  this.manifests.set('claude-code', CLAUDE_CODE_MANIFEST);
}
```

Plugin manifests are added during `startEnabledAdapters()` when plugin modules are loaded.

#### Relay Routes Changes

Add to `apps/server/src/routes/relay.ts`:

```
GET  /api/relay/adapters/catalog         → adapterManager.getCatalog()
POST /api/relay/adapters                 → adapterManager.addAdapter(type, id, config)
  Body: { type: string, id: string, config: Record<string, unknown>, enabled?: boolean }
  Returns: 201 { ok: true, id }
  Errors: 400 (validation), 409 (id exists)

DELETE /api/relay/adapters/:id           → adapterManager.removeAdapter(id)
  Returns: 200 { ok: true }
  Errors: 404 (not found), 400 (cannot remove built-in claude-code)

PATCH  /api/relay/adapters/:id/config    → adapterManager.updateConfig(id, config)
  Body: { config: Record<string, unknown> }
  Returns: 200 { ok: true }
  Errors: 404, 400 (validation)

POST /api/relay/adapters/test            → adapterManager.testConnection(type, config)
  Body: { type: string, config: Record<string, unknown> }
  Returns: 200 { ok: true } or 200 { ok: false, error: string }
  Timeout: 15 seconds (transient adapter must connect within this window)
```

**Route ordering note:** `GET /adapters/catalog` must be defined before `GET /adapters/:id` to avoid the param route matching "catalog" as an ID.

### 7. Transport Interface Changes (`packages/shared`)

Add to the `Transport` interface in `transport.ts`:

```typescript
// --- Relay Adapter Catalog ---
getAdapterCatalog(): Promise<CatalogEntry[]>;
addRelayAdapter(type: string, id: string, config: Record<string, unknown>): Promise<{ ok: boolean }>;
removeRelayAdapter(id: string): Promise<{ ok: boolean }>;
updateRelayAdapterConfig(id: string, config: Record<string, unknown>): Promise<{ ok: boolean }>;
testRelayAdapterConnection(type: string, config: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
```

**HttpTransport implementation** — standard `fetchJSON` calls to the new endpoints.

**DirectTransport stubs** — return empty catalog, throw "not supported in embedded mode" for mutations. Same pattern as existing adapter stubs.

### 8. Client Entity Hooks (`apps/client/entities/relay`)

Add to `use-relay-adapters.ts` (or a new `use-adapter-catalog.ts`):

```typescript
const CATALOG_KEY = ['relay', 'adapters', 'catalog'] as const;

export function useAdapterCatalog(enabled = true) {
  const transport = useTransport();
  return useQuery<CatalogEntry[]>({
    queryKey: [...CATALOG_KEY],
    queryFn: () => transport.getAdapterCatalog(),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useAddAdapter() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ type, id, config }: { type: string; id: string; config: Record<string, unknown> }) =>
      transport.addRelayAdapter(type, id, config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...CATALOG_KEY] });
      queryClient.invalidateQueries({ queryKey: [...ADAPTERS_KEY] });
    },
  });
}

export function useRemoveAdapter() { /* same pattern, invalidates catalog + adapters */ }
export function useUpdateAdapterConfig() { /* same pattern */ }

export function useTestAdapterConnection() {
  const transport = useTransport();
  return useMutation({
    mutationFn: ({ type, config }: { type: string; config: Record<string, unknown> }) =>
      transport.testRelayAdapterConnection(type, config),
    // No invalidation — test is side-effect-free
  });
}
```

### 9. Client UI Components (`apps/client/features/relay`)

#### Upgraded AdaptersTab

Replace the current flat list with two sections:

```
┌─────────────────────────────────────────┐
│  Configured Adapters                    │
│  ┌─────────────────────────────────┐    │
│  │ 🤖 Claude Code  [internal] ● ──│──  │  (AdapterCard with ... menu)
│  └─────────────────────────────────┘    │
│                                         │
│  Available Adapters                     │
│  ┌──────────────┐  ┌──────────────┐     │
│  │ ✈️ Telegram   │  │ 🔗 Webhook   │     │  (CatalogCard with Add button)
│  │ messaging    │  │ automation   │     │
│  │    [Add]     │  │    [Add]     │     │
│  └──────────────┘  └──────────────┘     │
└─────────────────────────────────────────┘
```

Data source switches from `useRelayAdapters` to `useAdapterCatalog`. The catalog response provides both configured instances and available types.

#### New: CatalogCard Component

```
apps/client/src/layers/features/relay/ui/CatalogCard.tsx
```

Displays an available (unconfigured) adapter type:
- Icon emoji + display name
- Category badge
- Short description
- "Add" button that opens `AdapterSetupWizard`

#### New: AdapterSetupWizard Component

```
apps/client/src/layers/features/relay/ui/AdapterSetupWizard.tsx
```

A Dialog-based wizard with these states:

**Add mode (new adapter):**
1. **Configure** — Dynamic form from `manifest.configFields`. If `manifest.setupSteps` is defined, show one step at a time with next/back navigation. Otherwise, show all fields on one page. `setupInstructions` shown as an info callout at the top.
2. **Test** — "Test Connection" button. Shows spinner during test, success/error result. "Skip" link to proceed without testing.
3. **Confirm** — Summary of entered values (passwords shown as "***"). Save button.

**Edit mode (existing adapter):**
- Same form, pre-filled with current config values
- Password fields show placeholder "Leave blank to keep current" and are NOT pre-filled
- No "Test" step by default (user can trigger test from the form)
- Save merges new values over existing (empty passwords preserve old values)

**Wizard state management:** Local React state (useState). Not Zustand — wizard is ephemeral.

**ID generation:** For new adapters, auto-generate ID from type (e.g., `telegram`, `webhook-github`). If `multiInstance` is true, append a suffix (`webhook-1`, `webhook-2`). User can override via an ID field.

#### New: ConfigFieldInput Component

```
apps/client/src/layers/features/relay/ui/ConfigFieldInput.tsx
```

Generic form field renderer. Maps `ConfigField.type` to shadcn/ui:

| ConfigField type | Component | Notes |
|---|---|---|
| `text` | `<Input type="text" />` | |
| `url` | `<Input type="url" />` | |
| `password` | `<Input type="password" />` | With eye toggle to reveal |
| `number` | `<Input type="number" />` | |
| `boolean` | `<Switch />` | |
| `select` | `<Select>` | Options from `field.options` |
| `textarea` | `<Textarea />` | |

Each field renders:
- Label (from `field.label`)
- Input component
- Description (from `field.description`, muted text below input)
- Error message (red text below input, from server validation errors matched by `field.key`)

**Conditional visibility:** Fields with `showWhen` are hidden when the condition is not met. The parent form passes current values and the component checks `values[field.showWhen.field] === field.showWhen.equals`.

**Section grouping:** Fields are grouped by `field.section`. Each section gets a heading. Fields without a section appear first.

#### Enhanced: AdapterCard

Add a kebab menu (`...` button using `DropdownMenu`) to the existing `AdapterCard`:

- **Configure** — opens `AdapterSetupWizard` in edit mode
- **Remove** — shows confirmation dialog (`AlertDialog`), then calls `useRemoveAdapter` mutation

The `claude-code` adapter's Remove option is disabled with tooltip "Built-in adapter cannot be removed."

### 10. Nested Config Key Handling

The Webhook adapter uses nested config keys (`inbound.subject`, `outbound.url`). The system handles these uniformly:

**ConfigField keys** use dot notation: `key: 'inbound.subject'`

**Form state** is a flat `Record<string, unknown>` using dot-notation keys. When submitting to the server, the client converts to nested objects:

```typescript
function unflattenConfig(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      current[parts[i]] ??= {};
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts.at(-1)!] = value;
  }
  return result;
}
```

**Sensitive field masking** uses the same dot-path traversal.

## User Experience

### Adding a Telegram Adapter (Primary User Journey)

1. User navigates to Relay panel > Adapters tab
2. User sees "Available Adapters" section showing Telegram and Webhook cards
3. User clicks "Add" on the Telegram card
4. Setup wizard opens with instructions: "Open Telegram and search for @BotFather..."
5. User enters their bot token (masked input) and selects "Long Polling" mode
6. User clicks "Test Connection" — wizard shows spinner, then green checkmark
7. User clicks "Save" — adapter appears in "Configured Adapters" section as connected
8. The adapter begins receiving Telegram messages immediately

### Editing an Adapter

1. User clicks "..." on an existing adapter card > "Configure"
2. Wizard opens pre-filled with current values (passwords show "Leave blank to keep current")
3. User changes the mode from polling to webhook, fills in webhook URL
4. User saves — adapter restarts with new config

### Removing an Adapter

1. User clicks "..." on an adapter card > "Remove"
2. Confirmation dialog: "Remove Telegram adapter? This will stop the adapter and delete its configuration."
3. User confirms — adapter is stopped and removed from config

### Error States

- **Bad token on test:** Wizard shows "Connection failed: 401 Unauthorized" with red styling. User can fix and retry.
- **Duplicate ID:** Server returns 409, wizard shows "An adapter with this ID already exists."
- **Adapter fails to start after save:** Adapter appears in configured list with red status dot and error message. User can reconfigure.

## Testing Strategy

### Server Tests

**AdapterManager catalog tests** (`apps/server/src/services/relay/__tests__/adapter-manager.test.ts`):
- `getCatalog()` returns built-in manifests with their configured instances
- `getCatalog()` masks password fields in instance configs
- `addAdapter()` validates config against Zod schema, rejects invalid configs
- `addAdapter()` rejects duplicate IDs
- `removeAdapter()` stops the adapter and persists removal
- `removeAdapter()` rejects removing built-in claude-code when it's the only one
- `updateConfig()` preserves password fields when empty strings are submitted
- `updateConfig()` restarts the adapter after config change
- `testConnection()` returns `{ ok: true }` for valid config
- `testConnection()` returns `{ ok: false, error }` for invalid credentials
- `testConnection()` always calls `stop()` (even on failure)
- Sensitive field masking handles dot-notation keys (e.g., `inbound.secret`)

**Route tests** (`apps/server/src/routes/__tests__/relay-adapters.test.ts`):
- `GET /adapters/catalog` returns 200 with CatalogEntry[]
- `POST /adapters` returns 201 on success, 400 on bad config, 409 on duplicate ID
- `DELETE /adapters/:id` returns 200 on success, 404 on missing
- `PATCH /adapters/:id/config` returns 200 on success, 400 on bad config
- `POST /adapters/test` returns 200 with ok: true/false

### Client Tests

**ConfigFieldInput tests** (`apps/client/src/layers/features/relay/ui/__tests__/ConfigFieldInput.test.tsx`):
- Renders correct input type for each ConfigField.type
- Shows/hides fields based on showWhen condition
- Displays description text and error messages
- Password toggle reveals/hides text

**AdapterSetupWizard tests** (`apps/client/src/layers/features/relay/ui/__tests__/AdapterSetupWizard.test.tsx`):
- Wizard opens in add mode with empty form
- Wizard opens in edit mode with pre-filled values (passwords empty)
- Multi-step navigation works when setupSteps defined
- Test connection button calls mutation and shows result
- Save button submits unflattened config

**AdapterCard tests** — kebab menu opens, Configure and Remove actions trigger correctly

### Relay Package Tests

**Manifest export tests** (`packages/relay/src/__tests__/manifests.test.ts`):
- Each built-in manifest validates against `AdapterManifestSchema`
- Each manifest's configFields keys match the corresponding Zod config schema keys
- Plugin loader returns manifest alongside adapter when available

## Performance Considerations

- Catalog endpoint aggregates in-memory data (manifests + configs + registry status) — no database queries, sub-millisecond response
- Catalog polling interval is 30 seconds (not 10 like the current adapter list) since catalog data changes rarely
- Connection test has a 15-second timeout to prevent hanging adapter starts from blocking the server
- Manifest map is populated once on startup and updated only when plugins are loaded/unloaded

## Security Considerations

- **Sensitive field masking**: All config values where `ConfigField.type === 'password'` are replaced with `"***"` in API responses. The server never sends actual tokens/secrets to the client.
- **Password preservation on update**: When a password field is submitted as empty string, the server preserves the existing stored value rather than overwriting with empty. This prevents accidental credential deletion.
- **Connection test isolation**: Transient adapter instances created by `testConnection()` are always cleaned up in a `finally` block. They are not registered in the adapter registry and cannot receive messages.
- **Config file permissions**: `adapters.json` stores secrets in plaintext. The file is created with default permissions (user-only on most systems). OS keychain integration is deferred to a future hardening pass.
- **Input validation**: All adapter creation/update requests are validated against the type's Zod schema before persisting. Invalid configs are rejected with 400.

## Documentation

### Updates Required

- **`contributing/relay-adapters.md`** — Add "Adapter Manifest" section documenting the `AdapterManifest` type, `ConfigField` descriptors, and how to export manifests from custom adapters. Update the "Creating a Custom Adapter" section to include manifest declaration.
- **`contributing/api-reference.md`** — Document the new catalog, CRUD, and test endpoints.
- **`docs/` (external)** — Add user-facing guide for managing adapters through the UI.

## Implementation Phases

### Phase 1: Types & Server Catalog

- Add `ConfigField`, `AdapterManifest`, `CatalogEntry` Zod schemas to `relay-schemas.ts`
- Add manifest types to `packages/relay/src/types.ts`
- Export built-in manifests from each adapter file
- Re-export manifests from `packages/relay/src/index.ts`
- Add `getCatalog()` and sensitive field masking to `AdapterManager`
- Add `GET /adapters/catalog` route
- Add `getAdapterCatalog()` to Transport + HttpTransport + DirectTransport
- Tests for all server-side changes

### Phase 2: Server CRUD & Connection Test

- Add `addAdapter()`, `removeAdapter()`, `updateConfig()`, `testConnection()` to AdapterManager
- Add POST/DELETE/PATCH/POST routes
- Add Transport methods + HttpTransport implementations
- Update plugin loader to extract manifests
- Tests for CRUD operations and connection testing

### Phase 3: Client Catalog UI

- Add `useAdapterCatalog()` and CRUD/test mutation hooks
- Build `ConfigFieldInput` component
- Build `CatalogCard` component
- Build `AdapterSetupWizard` component
- Upgrade `AdaptersTab` in `RelayPanel` to use catalog
- Enhance `AdapterCard` with configure/remove menu
- Re-export new components from feature barrel
- Client component and hook tests

### Phase 4: Polish & Documentation

- Update `contributing/relay-adapters.md` with manifest documentation
- Add user-facing adapter management guide to `docs/`
- Edge case handling (network errors, concurrent edits, hot-reload during wizard)

## Open Questions

None — all decisions were resolved during ideation (see [01-ideation.md](./01-ideation.md) Section 6).

## Related ADRs

- **ADR #19** — Use grammY for Telegram Bot Integration (relay-external-adapters)
- **ADR #20** — Use Adapter Registry Pattern with Promise.allSettled for Error Isolation (relay-external-adapters)
- **ADR #28** — Replace MessageReceiver with Claude Code Adapter (relay-runtime-adapters)
- **ADR #29** — Dynamic Import for Adapter Plugins (relay-runtime-adapters)
- **ADR #30** — Default Export Factory for Adapter Plugins (relay-runtime-adapters)

## References

- [Ideation Document](./01-ideation.md)
- [Research: Adapter Catalog Patterns](../../research/20260227_adapter_catalog_patterns.md)
- [Research: Slack vs Telegram Comparison](../../research/20260227_slack_vs_telegram_relay_adapter.md)
- [Spec 53: Relay External Adapters](../relay-external-adapters/02-specification.md)
- [Spec 57: Relay Runtime Adapters](../relay-runtime-adapters/02-specification.md)
- [n8n INodeProperties pattern](https://docs.n8n.io/integrations/creating-nodes/build/reference/credentials-files/)
- [Raycast manifest preferences](https://developers.raycast.com/information/manifest)
- [Backstage configSchema visibility](https://backstage.io/docs/conf/defining/)

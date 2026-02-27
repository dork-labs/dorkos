# Adapter Catalog & Manifests

The adapter catalog system provides structured metadata for each adapter type, enabling the UI to render dynamic configuration forms, setup wizards, and adapter browsing. This guide covers the `AdapterManifest` schema, `ConfigField` types, plugin manifest authoring, and the built-in adapter manifests.

## AdapterManifest Reference

An `AdapterManifest` describes an adapter type's identity, configuration shape, and setup guidance. Defined in `packages/shared/src/relay-schemas.ts` as `AdapterManifestSchema`.

| Field               | Type                    | Required | Description                                                                 |
| ------------------- | ----------------------- | -------- | --------------------------------------------------------------------------- |
| `type`              | `string`                | Yes      | Adapter type identifier (e.g., `'telegram'`, `'webhook'`, `'claude-code'`)  |
| `displayName`       | `string`                | Yes      | Human-readable name shown in the UI                                         |
| `description`       | `string`                | Yes      | Short description of what this adapter does                                 |
| `iconEmoji`         | `string`                | No       | Emoji icon for visual identification                                        |
| `category`          | `AdapterCategory`       | Yes      | One of `'messaging'`, `'automation'`, `'internal'`, `'custom'`              |
| `docsUrl`           | `string` (URL)          | No       | Link to external documentation                                              |
| `builtin`           | `boolean`               | Yes      | Whether this adapter ships with DorkOS                                      |
| `configFields`      | `ConfigField[]`         | Yes      | Array of configuration field definitions (see below)                        |
| `setupSteps`        | `AdapterSetupStep[]`    | No       | Ordered steps for a multi-step setup wizard                                 |
| `setupInstructions` | `string`                | No       | Markdown-formatted setup instructions (shown above the config form)         |
| `multiInstance`      | `boolean`               | Yes      | Whether multiple instances of this adapter type can coexist (default false) |

**Notes:**

- `multiInstance: true` means the user can create multiple instances (e.g., multiple webhook endpoints). When false, only one instance per type is allowed.
- `setupSteps` groups config fields into an ordered wizard flow. Each step references field keys from `configFields`.
- `setupInstructions` supports Markdown and is rendered before the configuration form in the UI.

### AdapterSetupStep

| Field         | Type       | Required | Description                                          |
| ------------- | ---------- | -------- | ---------------------------------------------------- |
| `stepId`      | `string`   | Yes      | Unique step identifier                               |
| `title`       | `string`   | Yes      | Step heading shown in the wizard                     |
| `description` | `string`   | No       | Explanatory text for this step                       |
| `fields`      | `string[]` | Yes      | Array of `configField.key` values to show in this step |

### Example Manifest

From `packages/relay/src/adapters/telegram-adapter.ts`:

```typescript
export const TELEGRAM_MANIFEST: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Send and receive messages via a Telegram bot.',
  iconEmoji: '\u2708\ufe0f',
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
    },
    {
      key: 'webhookUrl',
      label: 'Webhook URL',
      type: 'url',
      required: true,
      showWhen: { field: 'mode', equals: 'webhook' },
    },
  ],
  setupInstructions:
    'Open Telegram and search for **@BotFather**. Send `/newbot`, choose a name and username. Copy the token provided.',
};
```

## ConfigField Reference

Each `ConfigField` defines a single configuration input. The UI renders the appropriate form control based on `type`. Schema: `ConfigFieldSchema` in `packages/shared/src/relay-schemas.ts`.

| Field         | Type                              | Required | Description                                              |
| ------------- | --------------------------------- | -------- | -------------------------------------------------------- |
| `key`         | `string`                          | Yes      | Dot-notation config path (e.g., `'token'`, `'inbound.subject'`) |
| `label`       | `string`                          | Yes      | Human-readable label                                     |
| `type`        | `ConfigFieldType`                 | Yes      | Input control type (see table below)                     |
| `required`    | `boolean`                         | Yes      | Whether the field must have a value                      |
| `default`     | `string \| number \| boolean`     | No       | Default value if not provided                            |
| `placeholder` | `string`                          | No       | Placeholder text for text-like inputs                    |
| `description` | `string`                          | No       | Help text shown below the input                          |
| `options`     | `ConfigFieldOption[]`             | No       | Options for `select` type fields                         |
| `section`     | `string`                          | No       | Group label for visually grouping related fields         |
| `showWhen`    | `{ field: string; equals: ... }`  | No       | Conditional visibility based on another field's value    |

### Field Types

| Type         | Renders As           | Notes                                                        |
| ------------ | -------------------- | ------------------------------------------------------------ |
| `text`       | Text input           | General-purpose string input                                 |
| `password`   | Password input       | Value is masked in UI; **never returned in API responses**   |
| `number`     | Number input         | Numeric value with increment/decrement controls              |
| `boolean`    | Toggle/checkbox      | True/false switch                                            |
| `select`     | Dropdown             | Requires `options` array with `{ label, value }` pairs       |
| `textarea`   | Multi-line text area | For longer text or JSON input                                |
| `url`        | URL input            | Validated as a URL; may show link preview                    |

### Conditional Visibility (`showWhen`)

Fields can be conditionally shown based on another field's value:

```typescript
{
  key: 'webhookUrl',
  label: 'Webhook URL',
  type: 'url',
  required: true,
  showWhen: { field: 'mode', equals: 'webhook' },
}
```

This field is only visible when `mode` equals `'webhook'`. The UI hides the field entirely when the condition is not met. Required validation is only enforced when the field is visible.

### Sections

Use the `section` field to visually group related fields:

```typescript
{ key: 'inbound.subject', section: 'Inbound', ... },
{ key: 'inbound.secret', section: 'Inbound', ... },
{ key: 'outbound.url', section: 'Outbound', ... },
{ key: 'outbound.secret', section: 'Outbound', ... },
```

The UI renders section headers and groups fields under them.

### Password Fields and Security

Fields with `type: 'password'` receive special treatment:

- Values are masked in the UI input
- **API responses never include password field values** — the server strips them before returning config to the client
- Password fields are always transmitted over the API but never echoed back

## Writing a Plugin Manifest

External adapter plugins (npm packages or local files) can export a `getManifest()` function alongside their default factory export. This allows the catalog to discover and display plugin adapter metadata.

### Module Export Shape

```typescript
// my-adapter-plugin/index.ts
import type { AdapterManifest, RelayAdapter } from '@dorkos/relay';

/** Factory function — required default export. */
export default function createAdapter(
  config: Record<string, unknown>,
): RelayAdapter {
  return new MyAdapter(config);
}

/** Optional manifest export for catalog integration. */
export function getManifest(): AdapterManifest {
  return {
    type: 'my-custom',
    displayName: 'My Custom Adapter',
    description: 'Integrates with My Custom Service.',
    category: 'messaging',
    builtin: false,
    multiInstance: true,
    configFields: [
      {
        key: 'apiKey',
        label: 'API Key',
        type: 'password',
        required: true,
      },
    ],
  };
}
```

### Plugin Loading Behavior

The plugin loader (`packages/relay/src/adapter-plugin-loader.ts`) handles manifest extraction:

1. If the module exports `getManifest()`, it is called and validated against `AdapterManifestSchema.safeParse()`
2. If validation fails, a warning is logged and the loader falls back to a minimal auto-generated manifest
3. If `getManifest()` is not exported, a fallback manifest is generated with `category: 'custom'`, empty `configFields`, and the adapter ID as `displayName`

Plugins are loaded from two sources:

- **npm packages**: `plugin: { package: 'dorkos-relay-slack' }` in `adapters.json`
- **Local files**: `plugin: { path: './my-adapter.js' }` (resolved relative to `~/.dork/relay/`)

## Built-in Adapter Manifests

Three adapters ship with DorkOS. Their manifests are defined as static constants in the adapter source files.

### Telegram (`TELEGRAM_MANIFEST`)

- **File**: `packages/relay/src/adapters/telegram-adapter.ts`
- **Category**: `messaging`
- **Multi-instance**: No
- **Config fields**: `token` (password), `mode` (select: polling/webhook), `webhookUrl` (url, conditional), `webhookPort` (number, conditional)
- **Setup instructions**: Guides user through BotFather token creation

### Webhook (`WEBHOOK_MANIFEST`)

- **File**: `packages/relay/src/adapters/webhook-adapter.ts`
- **Category**: `automation`
- **Multi-instance**: Yes
- **Config fields**: `inbound.subject` (text), `inbound.secret` (password), `outbound.url` (url), `outbound.secret` (password), `outbound.headers` (textarea)
- **Sections**: Fields grouped into "Inbound" and "Outbound"

### Claude Code (`CLAUDE_CODE_MANIFEST`)

- **File**: `packages/relay/src/adapters/claude-code-adapter.ts`
- **Category**: `internal`
- **Multi-instance**: No
- **Config fields**: `maxConcurrent` (number, default 3), `defaultTimeoutMs` (number, default 300000)
- **Note**: Auto-configured; typically not modified by users

## CatalogEntry and Instances

The catalog API returns `CatalogEntry[]`, where each entry pairs a manifest with its active instances:

```typescript
interface CatalogEntry {
  manifest: AdapterManifest;
  instances: CatalogInstance[];
}

interface CatalogInstance {
  id: string;
  enabled: boolean;
  status: AdapterStatus;
}
```

This allows the UI to show both "available adapter types" and "running instances" in a single view.

## Related

- `packages/shared/src/relay-schemas.ts` — Zod schemas for all catalog types
- `packages/relay/src/adapter-plugin-loader.ts` — Plugin loading and manifest extraction
- `packages/relay/src/adapters/` — Built-in adapter implementations and manifests
- `apps/server/src/routes/relay.ts` — Adapter management API endpoints
- `contributing/relay-adapters.md` — Adapter interface, lifecycle, and authoring guide
- `contributing/api-reference.md` — Full endpoint documentation

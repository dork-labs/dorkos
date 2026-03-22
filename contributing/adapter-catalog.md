# Adapter Catalog & Manifests

The adapter catalog system provides structured metadata for each adapter type, enabling the UI to render dynamic configuration forms, setup wizards, and adapter browsing. This guide covers the `AdapterManifest` schema, `ConfigField` types, plugin manifest authoring, and the built-in adapter manifests.

## AdapterManifest Reference

An `AdapterManifest` describes an adapter type's identity, configuration shape, and setup guidance. Defined in `packages/shared/src/relay-schemas.ts` as `AdapterManifestSchema`.

| Field               | Type                 | Required | Description                                                                 |
| ------------------- | -------------------- | -------- | --------------------------------------------------------------------------- |
| `type`              | `string`             | Yes      | Adapter type identifier (e.g., `'telegram'`, `'webhook'`, `'claude-code'`)  |
| `displayName`       | `string`             | Yes      | Human-readable name shown in the UI                                         |
| `description`       | `string`             | Yes      | Short description of what this adapter does                                 |
| `iconEmoji`         | `string`             | No       | Emoji icon for visual identification                                        |
| `category`          | `AdapterCategory`    | Yes      | One of `'messaging'`, `'automation'`, `'internal'`, `'custom'`              |
| `docsUrl`           | `string` (URL)       | No       | Link to external documentation                                              |
| `builtin`           | `boolean`            | Yes      | Whether this adapter ships with DorkOS                                      |
| `configFields`      | `ConfigField[]`      | Yes      | Array of configuration field definitions (see below)                        |
| `setupSteps`        | `AdapterSetupStep[]` | No       | Ordered steps for a multi-step setup wizard                                 |
| `setupInstructions` | `string`             | No       | Markdown-formatted setup instructions (shown above the config form)         |
| `setupGuide`        | `string`             | No       | Full setup guide markdown, rendered in a slide-out Sheet panel in the UI    |
| `multiInstance`     | `boolean`            | Yes      | Whether multiple instances of this adapter type can coexist (default false) |

**Notes:**

- `multiInstance: true` means the user can create multiple instances (e.g., multiple webhook endpoints). When false, only one instance per type is allowed.
- `setupSteps` groups config fields into an ordered wizard flow. Each step references field keys from `configFields`.
- `setupInstructions` supports Markdown and is rendered before the configuration form in the UI.
- `setupGuide` contains full markdown documentation loaded from `docs/setup.md` files (built-in adapters) or provided inline by plugin adapters via `getManifest()`. The client renders this content in a slide-out Sheet panel. See `contributing/relay-adapters.md` for the documentation convention.

### AdapterSetupStep

| Field         | Type       | Required | Description                                            |
| ------------- | ---------- | -------- | ------------------------------------------------------ |
| `stepId`      | `string`   | Yes      | Unique step identifier                                 |
| `title`       | `string`   | Yes      | Step heading shown in the wizard                       |
| `description` | `string`   | No       | Explanatory text for this step                         |
| `fields`      | `string[]` | Yes      | Array of `configField.key` values to show in this step |

### Example Manifest

From `packages/relay/src/adapters/telegram/telegram-adapter.ts`:

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

| Field          | Type                             | Required | Description                                                        |
| -------------- | -------------------------------- | -------- | ------------------------------------------------------------------ |
| `key`          | `string`                         | Yes      | Dot-notation config path (e.g., `'token'`, `'inbound.subject'`)    |
| `label`        | `string`                         | Yes      | Human-readable label                                               |
| `type`         | `ConfigFieldType`                | Yes      | Input control type (see table below)                               |
| `required`     | `boolean`                        | Yes      | Whether the field must have a value                                |
| `default`      | `string \| number \| boolean`    | No       | Default value if not provided                                      |
| `placeholder`  | `string`                         | No       | Placeholder text for text-like inputs                              |
| `description`  | `string`                         | No       | Help text shown below the input                                    |
| `options`      | `ConfigFieldOption[]`            | No       | Options for `select` type fields                                   |
| `section`      | `string`                         | No       | Group label for visually grouping related fields                   |
| `showWhen`     | `{ field: string; equals: ... }` | No       | Conditional visibility based on another field's value              |
| `helpMarkdown` | `string`                         | No       | Markdown content shown in a collapsible disclosure below the field |

### Field Types

| Type       | Renders As           | Notes                                                      |
| ---------- | -------------------- | ---------------------------------------------------------- |
| `text`     | Text input           | General-purpose string input                               |
| `password` | Password input       | Value is masked in UI; **never returned in API responses** |
| `number`   | Number input         | Numeric value with increment/decrement controls            |
| `boolean`  | Toggle/checkbox      | True/false switch                                          |
| `select`   | Dropdown             | Requires `options` array with `{ label, value }` pairs     |
| `textarea` | Multi-line text area | For longer text or JSON input                              |
| `url`      | URL input            | Validated as a URL; may show link preview                  |

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
export default function createAdapter(config: Record<string, unknown>): RelayAdapter {
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

Five adapters ship with DorkOS. Their manifests are defined as static constants in the adapter source files.

### Telegram (`TELEGRAM_MANIFEST`)

- **File**: `packages/relay/src/adapters/telegram/telegram-adapter.ts`
- **Category**: `messaging`
- **Multi-instance**: No
- **Config fields**: `token` (password), `mode` (select: polling/webhook), `webhookUrl` (url, conditional), `webhookPort` (number, conditional)
- **Setup instructions**: Guides user through BotFather token creation

### Telegram Chat SDK (`TELEGRAM_CHATSDK_MANIFEST`)

- **File**: `packages/relay/src/adapters/telegram-chatsdk/manifest.ts`
- **Category**: `messaging`
- **Multi-instance**: Yes
- **Config fields**: `token` (password), `mode` (select: polling/webhook)
- **Setup instructions**: Same BotFather flow as native Telegram adapter
- **Note**: Experimental. Uses the Chat SDK (`chat` + `@chat-adapter/telegram`) instead of grammy. Supports `deliverStream()` via Chat SDK's `thread.post(asyncIterable)`. Streaming quality is lower than the native adapter (post+edit at ~500ms vs sendMessageDraft at 200ms).

### Slack (`SLACK_MANIFEST`)

- **File**: `packages/relay/src/adapters/slack/slack-adapter.ts`
- **Category**: `messaging`
- **Multi-instance**: Yes
- **Config fields**: `botToken` (password), `appToken` (password), `signingSecret` (password), `streaming` (boolean), `nativeStreaming` (boolean), `typingIndicator` (select: reaction/none)
- **Setup steps**: Multi-step wizard for Slack App creation, OAuth scopes, and Socket Mode configuration

### Webhook (`WEBHOOK_MANIFEST`)

- **File**: `packages/relay/src/adapters/webhook/webhook-adapter.ts`
- **Category**: `automation`
- **Multi-instance**: Yes
- **Config fields**: `inbound.subject` (text), `inbound.secret` (password), `outbound.url` (url), `outbound.secret` (password), `outbound.headers` (textarea)
- **Sections**: Fields grouped into "Inbound" and "Outbound"

### Claude Code (`CLAUDE_CODE_MANIFEST`)

- **File**: `packages/relay/src/adapters/claude-code/claude-code-adapter.ts`
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
  status: AdapterStatus; // Runtime state including id, type, displayName (added by AdapterManager)
  config?: Record<string, unknown>; // Masked config — password fields replaced with '***'
}
```

This allows the UI to show both "available adapter types" and "running instances" in a single view. The `config` field is masked by `maskSensitiveFields()` before being returned.

## Config File Hot-Reload

`AdapterManager.initialize()` watches `~/.dork/relay/adapters.json` via chokidar. When the file changes externally (e.g., manually edited), `reload()` is called automatically:

1. Adapters no longer in the config (or now disabled) are stopped via `registry.unregister(id)`.
2. Newly enabled adapters are started via `registry.register(adapter)`.
3. Changed configs trigger a stop + restart of the affected adapter instance.

The API-driven path (`PATCH /api/relay/adapters/:id/config`) calls `updateConfig()` directly, which merges the patch with password field preservation and restarts the adapter in-place. Both paths ultimately converge on the same `register()`/`unregister()` lifecycle.

## AdapterManagerDeps

`AdapterManager` accepts a `AdapterManagerDeps` object for dependency injection:

```typescript
interface AdapterManagerDeps {
  agentManager: ClaudeCodeAgentRuntimeLike;
  traceStore: TraceStoreLike;
  pulseStore?: PulseStoreLike;
  /** Optional RelayCore for binding subsystem initialization */
  relayCore?: RelayCoreLike;
  /** Optional MeshCore for CWD resolution via getProjectPath(agentId) */
  meshCore?: AdapterMeshCoreLike;
}
```

- `agentManager` and `traceStore` are required. `pulseStore` is optional but needed for Pulse-aware adapters (e.g., `ClaudeCodeAdapter` schedule dispatching).
- When `relayCore` is provided, `AdapterManager` initializes the full binding subsystem (`BindingStore` + `BindingRouter`) during `initialize()`. When omitted, the binding subsystem is skipped and binding API endpoints return 503.
- `meshCore` is optional; when provided, `buildContext()` resolves the agent's `projectPath` via `meshCore.getProjectPath(agentId)` and enriches the `AdapterContext` passed to each adapter's `deliver()` call.
- `AdapterMeshCoreLike` requires only `getProjectPath(agentId: string): string | undefined`.

## Adapter-Agent Bindings

Bindings route inbound adapter messages to specific agent sessions. They are the mechanism by which external messages (e.g., a Telegram chat) are directed to a particular Claude Code session.

### AdapterBinding Schema

Defined as `AdapterBindingSchema` in `packages/shared/src/relay-schemas.ts`.

| Field             | Type              | Required | Description                                                          |
| ----------------- | ----------------- | -------- | -------------------------------------------------------------------- |
| `id`              | `string` (UUID)   | Yes      | Auto-generated binding identifier                                    |
| `adapterId`       | `string`          | Yes      | ID of the adapter instance this binding applies to                   |
| `agentId`         | `string`          | Yes      | ID of the target agent (from `.dork/agent.json`)                     |
| `projectPath`     | `string`          | Yes      | Filesystem path used as the working directory for new agent sessions |
| `chatId`          | `string`          | No       | Narrow to a specific chat/conversation ID (e.g., Telegram chat ID)   |
| `channelType`     | `string`          | No       | Narrow to a channel type: `'dm'`, `'group'`, or `'channel'`          |
| `sessionStrategy` | `SessionStrategy` | No       | How agent sessions are reused (default: `'per-chat'`)                |
| `label`           | `string`          | No       | Human-readable label shown in the topology graph (default: `''`)     |
| `createdAt`       | `string`          | Yes      | ISO 8601 timestamp (set by server on creation)                       |
| `updatedAt`       | `string`          | Yes      | ISO 8601 timestamp (set by server on creation)                       |

### Session Strategies

The `sessionStrategy` field controls how `BindingRouter` maps inbound messages to Claude Code sessions:

| Strategy    | Behavior                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `per-chat`  | One session per `chatId`. Messages from the same chat always resume the same session. **Default.**                            |
| `per-user`  | One session per `userId` (from envelope metadata). Multiple chats from the same user share a single session.                  |
| `stateless` | A new session is created for every inbound message. No session state is reused. Useful for stateless command-style workflows. |

Sessions are persisted across server restarts in `~/.dork/relay/sessions.json`. The session map uses LRU eviction when the size exceeds 10,000 entries.

### Binding Resolution (Most-Specific-First)

`BindingStore.resolve()` scores all bindings for an adapter and returns the highest-scoring match:

| Match criteria                                  | Score |
| ----------------------------------------------- | ----- |
| `adapterId` + `chatId` + `channelType`          | 7     |
| `adapterId` + `chatId`                          | 5     |
| `adapterId` + `channelType`                     | 3     |
| `adapterId` only (wildcard — matches all chats) | 1     |
| No match                                        | —     |

An explicit `chatId` or `channelType` that does not match the inbound message is an immediate disqualifier (score 0). This means a wildcard binding (adapterId only) will match all messages from an adapter unless a more-specific binding applies.

### BindingRouter Service

`BindingRouter` (`apps/server/src/services/relay/binding-router.ts`) is the central routing service for adapter-to-agent message delivery. It:

1. Subscribes to `relay.human.>` (all inbound human messages, including multi-token subjects like `relay.human.telegram.123456`).
2. Parses the subject to extract `platformType`, `chatId`, and `channelType`.
3. Resolves the platform type to an adapter instance ID via the optional `resolveAdapterInstanceId` dependency.
4. Calls `BindingStore.resolve()` with the extracted components.
5. Determines or creates the target agent session based on `sessionStrategy`.
6. Republishes the envelope to `relay.agent.{sessionId}` for `ClaudeCodeAdapter` to handle.

Agent response messages (where `envelope.from` starts with `'agent:'`) are ignored to prevent feedback loops.

Subject format parsed by BindingRouter:

```
relay.human.{platformType}.{chatId}              # DM
relay.human.{platformType}.group.{chatId}        # group chat
```

### Binding HTTP API

All binding endpoints are mounted under `/api/relay` and require `DORKOS_RELAY_ENABLED=true`.

| Method   | Path                      | Description                                    |
| -------- | ------------------------- | ---------------------------------------------- |
| `GET`    | `/api/relay/bindings`     | List all bindings                              |
| `POST`   | `/api/relay/bindings`     | Create a new binding                           |
| `GET`    | `/api/relay/bindings/:id` | Get a single binding by ID                     |
| `DELETE` | `/api/relay/bindings/:id` | Delete a binding (cleans up orphaned sessions) |

**Create binding request body** (`CreateBindingRequest`):

```json
{
  "adapterId": "telegram-1",
  "agentId": "my-agent",
  "projectPath": "/home/user/my-project",
  "chatId": "123456789",
  "channelType": "dm",
  "sessionStrategy": "per-chat",
  "label": "My Telegram binding"
}
```

Fields `chatId`, `channelType`, and `label` are optional. `sessionStrategy` defaults to `'per-chat'`.

When a binding is deleted, `BindingRouter.cleanupOrphanedSessions()` is called automatically to remove stale session map entries for the deleted binding.

### Topology Graph (UI)

Bindings are visualised in the Mesh Topology Graph (`features/mesh/`) as `BindingEdge` components connecting adapter nodes to agent nodes. The `BindingDialog` component provides a form for creating and deleting bindings directly from the graph view. Client-side hooks are in `entities/binding/`.

## Adapter Delivery Observability

### Publish Pipeline Fan-Out

When `RelayCore.publish()` is called, delivery proceeds through the following steps in order:

1. Envelope assembly (ID, timestamps, budget)
2. Endpoint validation and rate-limit check (per-sender, before fan-out)
3. Maildir delivery to all matching registered endpoints in parallel
4. Adapter delivery (step 7) — always attempted in parallel with Maildir delivery
5. Subscription handler dispatch (step 7b) — fires for subjects with no registered Maildir endpoints, enabling `BindingRouter` to intercept `relay.human.*` messages
6. Dead-letter if no delivery targets matched
7. Trace span insertion (best-effort)

### Adapter Delivery Timeout

Adapter `deliver()` calls are wrapped in a 30-second timeout by `AdapterDelivery` (`packages/relay/src/adapter-delivery.ts`):

```typescript
static readonly TIMEOUT_MS = 30_000; // 30 seconds
```

If the adapter does not resolve within 30 seconds, the promise is rejected with `'adapter delivery timeout (30s)'` and a `DeliveryResult` with `success: false` is returned. This result propagates back through the `PublishResult` as `adapterResult` for observability.

### DeliveryResult

Adapters return `DeliveryResult` from their `deliver()` method:

```typescript
interface DeliveryResult {
  success: boolean;
  /** Error message if delivery failed */
  error?: string;
  /** Whether a dead letter was created for this failure */
  deadLettered?: boolean;
  /** Response message ID if the adapter published a reply */
  responseMessageId?: string;
  /** Delivery duration in milliseconds */
  durationMs?: number;
}
```

The `PublishResult` returned by `RelayCore.publish()` includes `adapterResult` when adapter delivery was attempted, giving callers full visibility into the adapter delivery outcome alongside the Maildir endpoint delivery counts.

Adapter delivery is indexed in SQLite (`~/.dork/relay/index.db`) under the subject hash prefixed with `adapter:` for audit-trail purposes — separate from Maildir endpoint entries.

## Related

- `packages/shared/src/relay-schemas.ts` — Zod schemas for all catalog types (`AdapterBindingSchema`, `SessionStrategySchema`, `CreateBindingRequestSchema`)
- `packages/relay/src/adapter-plugin-loader.ts` — Plugin loading and manifest extraction
- `packages/relay/src/adapters/` — Built-in adapter implementations and manifests
- `packages/relay/src/adapter-delivery.ts` — Adapter delivery with 30s timeout and SQLite indexing
- `packages/relay/src/delivery-pipeline.ts` — Maildir endpoint delivery pipeline
- `apps/server/src/services/relay/binding-store.ts` — Binding CRUD and most-specific-first resolution
- `apps/server/src/services/relay/binding-router.ts` — Inbound message routing service
- `apps/server/src/services/relay/adapter-manager.ts` — Adapter lifecycle and binding subsystem init
- `apps/server/src/routes/relay.ts` — Adapter management and binding API endpoints
- `contributing/relay-adapters.md` — Adapter interface, lifecycle, and authoring guide
- `contributing/api-reference.md` — Full endpoint documentation

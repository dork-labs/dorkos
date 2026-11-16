---
slug: extension-manifest-settings
number: 209
created: 2026-03-29
status: specified
---

# Extension Manifest Settings

## Status

Specified

## Authors

Claude Code — 2026-03-29

## Overview

Extend the DorkOS extension manifest schema so extension authors can declare non-secret configuration fields (text, number, boolean, select) alongside secrets. The host auto-generates a polished, unified settings panel from these declarations — zero UI code required. Additionally, add `placeholder` hints to secret inputs and `group`-based collapsible sections for extensions that connect to multiple APIs.

## Background / Problem Statement

The extension system currently supports `serverCapabilities.secrets` — an array of secret declarations that auto-generate a password-input settings tab. This works well for API keys, but extensions also need non-secret configuration: refresh intervals, display toggles, filter selections, label prefixes. Today, extension authors must hand-code settings UI using `api.registerSettingsTab()` with raw `React.createElement` calls (extensions cannot import host Shadcn components). This produces inconsistent, unstyled UI.

Additionally, the current secret inputs show no format hints (the placeholder is always the key name), and extensions connecting to multiple services (GitHub + Linear) have all secrets in one flat list with no visual grouping.

## Goals

- Auto-generate full settings forms from manifest declarations — text, number, boolean, select fields
- Render secrets and settings in one unified, grouped settings tab per extension
- Add `placeholder` to `SecretDeclaration` for custom input hints (e.g., `lin_api_xxxx`)
- Add `group` to both secrets and settings for collapsible section organization
- Provide server-side `ctx.settings` API for extensions to read configuration values
- Store non-secret settings as plaintext JSON (separate from encrypted secrets)
- Maintain full backward compatibility — existing manifests work unchanged

## Non-Goals

- Complex field types (file upload, color picker, multi-select, textarea)
- Conditional/dependent fields (show field B only when field A is true)
- Per-field validation rules beyond min/max for numbers
- Client-side extension access to settings (server-only for v1)
- Settings migration/versioning when manifest schema changes
- Real-time settings sync (SSE push when settings change)
- Settings UI for extensions without `serverCapabilities`

## Technical Dependencies

- **Zod** (existing) — Schema validation for manifest parsing
- **React 19** (existing) — Settings panel rendering (host-side, not extension-side)
- **Shadcn/ui** (existing) — `FieldCard`, `CollapsibleFieldCard`, `SettingRow`, `Input`, `Switch`, `Select`, `PasswordInput`, `Badge`, `Button`
- **Express** (existing) — Settings CRUD endpoints
- No new external dependencies required

## Detailed Design

### 1. Manifest Schema Changes

**File:** `packages/extension-api/src/manifest-schema.ts`

Add `SettingOptionSchema` and `SettingDeclarationSchema`, extend `SecretDeclarationSchema` with `placeholder` and `group`, add `settings` to `ServerCapabilitiesSchema`:

```typescript
/** Option for select-type settings. */
export const SettingOptionSchema = z.object({
  label: z.string().min(1),
  value: z.union([z.string(), z.number()]),
});

/** Non-secret configuration field declared in the manifest. */
export const SettingDeclarationSchema = z.object({
  type: z.enum(['text', 'number', 'boolean', 'select']),
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().default(false),
  group: z.string().optional(),
  options: z.array(SettingOptionSchema).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});
```

Update `SecretDeclarationSchema`:

```typescript
export const SecretDeclarationSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  description: z.string().optional(),
  placeholder: z.string().optional(), // NEW
  required: z.boolean().default(false),
  group: z.string().optional(), // NEW
});
```

Update `ServerCapabilitiesSchema`:

```typescript
export const ServerCapabilitiesSchema = z.object({
  serverEntry: z.string().default('./server.ts'),
  externalHosts: z.array(z.string().url()).optional(),
  secrets: z.array(SecretDeclarationSchema).optional(),
  settings: z.array(SettingDeclarationSchema).optional(), // NEW
});
```

**Inferred TypeScript types** (via `z.infer`):

```typescript
export type SettingOption = z.infer<typeof SettingOptionSchema>;
export type SettingDeclaration = z.infer<typeof SettingDeclarationSchema>;
// SecretDeclaration and ServerCapabilities types update automatically
```

### 2. Server Extension API Types

**File:** `packages/extension-api/src/server-extension-api.ts`

Add `SettingsStore` interface and extend `DataProviderContext`:

```typescript
/** Read/write access to non-secret extension configuration. */
export interface SettingsStore {
  get<T extends string | number | boolean = string | number | boolean>(
    key: string
  ): Promise<T | null>;
  set(key: string, value: string | number | boolean): Promise<void>;
  delete(key: string): Promise<void>;
  getAll(): Promise<Record<string, string | number | boolean>>;
}

export interface DataProviderContext {
  secrets: SecretStore;
  settings: SettingsStore; // NEW
  storage: {
    loadData<T>(): Promise<T | null>;
    saveData<T>(data: T): Promise<void>;
  };
  schedule(seconds: number, fn: () => Promise<void>): () => void;
  emit(event: string, data: unknown): void;
  extensionId: string;
  extensionDir: string;
}
```

### 3. Extension Settings Store

**File (NEW):** `packages/shared/src/extension-settings.ts`

Plaintext JSON storage following the `ExtensionSecretStore` pattern but without encryption:

```typescript
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SettingsStore } from '@dorkos/extension-api/server';

export class ExtensionSettingsStore implements SettingsStore {
  private readonly filePath: string;

  constructor(dorkHome: string, extensionId: string) {
    const dir = join(dorkHome, 'extension-settings');
    this.filePath = join(dir, `${extensionId}.json`);
  }

  async get<T extends string | number | boolean>(key: string): Promise<T | null> {
    const data = await this.loadAll();
    return (data[key] as T) ?? null;
  }

  async set(key: string, value: string | number | boolean): Promise<void> {
    const data = await this.loadAll();
    data[key] = value;
    await this.saveAll(data);
  }

  async delete(key: string): Promise<void> {
    const data = await this.loadAll();
    delete data[key];
    await this.saveAll(data);
  }

  async getAll(): Promise<Record<string, string | number | boolean>> {
    return this.loadAll();
  }

  private async loadAll(): Promise<Record<string, string | number | boolean>> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private async saveAll(data: Record<string, string | number | boolean>): Promise<void> {
    const dir = join(this.filePath, '..');
    await mkdir(dir, { recursive: true });
    // Atomic write: write to temp, then rename
    const tmp = this.filePath + '.tmp';
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, this.filePath);
  }
}
```

### 4. API Endpoints

**File:** `apps/server/src/routes/extensions.ts`

Add settings CRUD endpoints alongside existing secrets endpoints:

```
GET  /api/extensions/:id/settings        → settings with current values + defaults
PUT  /api/extensions/:id/settings/:key   → store a setting value
DELETE /api/extensions/:id/settings/:key → reset to default (remove override)
```

**GET response shape:**

```typescript
// Response: SettingStatus[]
interface SettingStatus {
  key: string;
  type: 'text' | 'number' | 'boolean' | 'select';
  label: string;
  description?: string;
  placeholder?: string;
  group?: string;
  value: string | number | boolean | null; // current value or default
  isDefault: boolean; // true if using manifest default
  options?: Array<{ label: string; value: string | number }>;
  min?: number;
  max?: number;
}
```

**PUT body validation:**

```typescript
const SetSettingBody = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
});
```

The GET endpoint merges stored values with manifest defaults: for each declared setting, return the stored value if present, otherwise the manifest `default`, otherwise `null`.

### 5. Server API Factory Update

**File:** `apps/server/src/services/extensions/extension-server-api-factory.ts`

Add `ExtensionSettingsStore` to the context construction:

```typescript
import { ExtensionSettingsStore } from '@dorkos/shared/extension-settings';

export function createDataProviderContext(deps: {
  extensionId: string;
  extensionDir: string;
  dorkHome: string;
  eventFanOut: EventFanOut;
}): { ctx: DataProviderContext; getScheduledCleanups: () => Array<() => void> } {
  // ... existing code ...
  const settings = new ExtensionSettingsStore(deps.dorkHome, deps.extensionId);

  const ctx: DataProviderContext = {
    secrets,
    settings, // NEW
    storage: { loadData, saveData },
    schedule,
    emit,
    extensionId: deps.extensionId,
    extensionDir: deps.extensionDir,
  };
  // ...
}
```

### 6. Unified Settings Panel (Client)

**File:** `apps/client/src/layers/features/extensions/ui/ManifestSettingsPanel.tsx` (rename from ManifestSecretsPanel.tsx)

The panel evolves to render both secrets and settings in a unified view with grouping:

**Grouping algorithm:**

```typescript
type ConfigItem =
  | { kind: 'secret'; declaration: SecretDeclaration; isSet: boolean }
  | { kind: 'setting'; declaration: SettingDeclaration; value: SettingValue; isDefault: boolean };

function groupItems(
  secrets: ConfigItem[],
  settings: ConfigItem[]
): Map<string | undefined, ConfigItem[]> {
  const all = [...secrets, ...settings];
  const grouped = new Map<string | undefined, ConfigItem[]>();
  for (const item of all) {
    const group = item.declaration.group;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group)!.push(item);
  }
  return grouped;
}
```

**Rendering order:**

1. Ungrouped items (group = `undefined`) render in a `FieldCard` at the top
2. Each named group renders as a `CollapsibleFieldCard` with the group name as the section title
3. Within each group, items render in manifest declaration order (secrets first, then settings)

**Field renderers by type:**

| Type    | Component                            | Save Behavior                                |
| ------- | ------------------------------------ | -------------------------------------------- |
| Secret  | `PasswordInput` + Save/Clear buttons | Explicit save button click                   |
| Text    | `Input` + Save button                | Explicit save button click                   |
| Number  | `Input type="number"` + Save button  | Explicit save button click, min/max enforced |
| Boolean | `Switch`                             | Immediate save on toggle                     |
| Select  | `Select` dropdown                    | Immediate save on change                     |

All field renderers use `SettingRow` for consistent layout and show toast notifications on save/clear/error.

### 7. Extension Loader Update

**File:** `apps/client/src/layers/features/extensions/model/extension-loader.ts`

Rename `autoRegisterSecretsTab` → `autoRegisterConfigTab`. The method now checks for `secrets` OR `settings`:

```typescript
private autoRegisterConfigTab(
  rec: ExtensionRecordPublic,
  cleanups: Array<() => void>,
): void {
  const secrets = rec.manifest.serverCapabilities?.secrets;
  const settings = rec.manifest.serverCapabilities?.settings;
  if (!secrets?.length && !settings?.length) return;

  const extensionId = rec.id;
  const tabId = `${extensionId}:settings`;
  const frozenSecrets: SecretDeclaration[] = secrets ?? [];
  const frozenSettings: SettingDeclaration[] = settings ?? [];

  const unsub = this.deps.registry.register('settings.tabs', {
    id: tabId,
    label: rec.manifest.name,
    icon: ManifestSettingsIcon,
    component: function AutoConfigTab() {
      return createElement(ManifestSettingsPanel, {
        extensionId,
        secrets: frozenSecrets,
        settings: frozenSettings,
      });
    },
    priority: 90,
  });
  cleanups.push(unsub);
}
```

### 8. Barrel Export Update

**File:** `packages/extension-api/src/index.ts`

Add new type exports:

```typescript
export type { SettingOption, SettingDeclaration } from './manifest-schema.js';

export type { SettingsStore } from './server-extension-api.js';
```

### 9. Template Updates

**File:** `apps/server/src/services/extensions/extension-templates.ts`

Update data-provider manifest template to include example settings:

```typescript
if (template === 'data-provider') {
  manifest.serverCapabilities = {
    serverEntry: './server.ts',
    secrets: [
      {
        key: 'api_key',
        label: `${toTitleCase(name)} API Key`,
        description: `API key for the ${toTitleCase(name)} integration`,
        placeholder: 'your-api-key-here',
        required: true,
      },
    ],
    settings: [
      {
        type: 'number',
        key: 'refresh_interval',
        label: 'Refresh Interval',
        description: 'How often to poll for updates (seconds)',
        default: 60,
        min: 10,
        max: 3600,
      },
    ],
  };
}
```

Update server template to reference `ctx.settings`:

```typescript
// In the schedule callback comment:
// const refreshInterval = await ctx.settings.get<number>('refresh_interval') ?? 60;
```

## User Experience

### Extension Author Journey

1. **Declare settings in `extension.json`** — Add a `settings` array inside `serverCapabilities` with typed field declarations. Add `placeholder` and `group` to secrets.
2. **No UI code needed** — The host auto-generates a settings tab using the design system.
3. **Read settings in `server.ts`** — Use `ctx.settings.get('key')` to read values.
4. **Users configure via Settings** — Open DorkOS Settings → Extensions → click extension name → see unified form.

### End User Journey

1. **Open Settings** → Click extension name in sidebar
2. **See unified form** — Secrets and settings organized by groups
3. **Configure secrets** — Enter API keys in password fields, click Save
4. **Adjust settings** — Toggle booleans (instant), change selects (instant), type text/numbers and Save
5. **Clear/reset** — Clear button for secrets, Delete to reset settings to defaults

### Error States

- **API key not set** — PasswordInput shows placeholder hint (e.g., `lin_api_xxxx`)
- **Invalid number** — Input enforces min/max via HTML attributes; server validates on save
- **Save failure** — Toast notification with error message
- **Extension disabled** — Settings tab not shown (auto-registration only for active extensions)

## Testing Strategy

### Unit Tests: Manifest Schema

**File:** `packages/extension-api/src/__tests__/manifest-schema.test.ts`

```typescript
// Purpose: Verify SettingDeclaration accepts all valid field types
describe('SettingDeclarationSchema', () => {
  it('accepts a text setting with all fields', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'text',
      key: 'label_prefix',
      label: 'Label Prefix',
      description: 'Prefix for labels',
      placeholder: 'gh:',
      default: 'gh:',
      group: 'GitHub',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a number setting with min/max', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'number',
      key: 'refresh_interval',
      label: 'Refresh',
      default: 60,
      min: 10,
      max: 3600,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a boolean setting with default', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'boolean',
      key: 'show_archived',
      label: 'Show Archived',
      default: false,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a select setting with options', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'select',
      key: 'theme',
      label: 'Theme',
      options: [
        { label: 'Dark', value: 'dark' },
        { label: 'Light', value: 'light' },
      ],
      default: 'dark',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid key format (uppercase)', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'text',
      key: 'InvalidKey',
      label: 'X',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid type', () => {
    const result = SettingDeclarationSchema.safeParse({
      type: 'password',
      key: 'foo',
      label: 'X',
    });
    expect(result.success).toBe(false);
  });
});

// Purpose: Verify SecretDeclaration accepts new placeholder and group fields
describe('SecretDeclarationSchema — new fields', () => {
  it('accepts placeholder and group', () => {
    const result = SecretDeclarationSchema.safeParse({
      key: 'api_key',
      label: 'API Key',
      placeholder: 'sk_xxxx',
      group: 'Service',
    });
    expect(result.success).toBe(true);
  });

  it('still works without placeholder and group (backward compat)', () => {
    const result = SecretDeclarationSchema.safeParse({
      key: 'api_key',
      label: 'API Key',
      required: true,
    });
    expect(result.success).toBe(true);
  });
});

// Purpose: Verify ServerCapabilities accepts settings array
describe('ServerCapabilitiesSchema — settings', () => {
  it('accepts settings alongside secrets', () => {
    const result = ServerCapabilitiesSchema.safeParse({
      secrets: [{ key: 'token', label: 'Token' }],
      settings: [{ type: 'boolean', key: 'enabled', label: 'Enabled' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts settings without secrets', () => {
    const result = ServerCapabilitiesSchema.safeParse({
      settings: [{ type: 'text', key: 'prefix', label: 'Prefix' }],
    });
    expect(result.success).toBe(true);
  });
});
```

### Unit Tests: Extension Settings Store

**File:** `packages/shared/src/__tests__/extension-settings.test.ts`

```typescript
// Purpose: Verify CRUD operations on plaintext JSON settings
describe('ExtensionSettingsStore', () => {
  it('returns null for missing key', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    expect(await store.get('missing')).toBeNull();
  });

  it('stores and retrieves a string value', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('prefix', 'gh:');
    expect(await store.get('prefix')).toBe('gh:');
  });

  it('stores and retrieves a number value', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('interval', 300);
    expect(await store.get('interval')).toBe(300);
  });

  it('stores and retrieves a boolean value', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('enabled', true);
    expect(await store.get('enabled')).toBe(true);
  });

  it('deletes a key', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('key', 'val');
    await store.delete('key');
    expect(await store.get('key')).toBeNull();
  });

  it('getAll returns all stored values', async () => {
    const store = new ExtensionSettingsStore(tmpDir, 'test-ext');
    await store.set('a', 1);
    await store.set('b', 'two');
    expect(await store.getAll()).toEqual({ a: 1, b: 'two' });
  });

  it('isolates extensions by ID', async () => {
    const store1 = new ExtensionSettingsStore(tmpDir, 'ext-a');
    const store2 = new ExtensionSettingsStore(tmpDir, 'ext-b');
    await store1.set('key', 'a');
    await store2.set('key', 'b');
    expect(await store1.get('key')).toBe('a');
    expect(await store2.get('key')).toBe('b');
  });
});
```

### Unit Tests: Extension Loader

**File:** `apps/client/src/layers/features/extensions/__tests__/extension-loader.test.ts`

```typescript
// Purpose: Verify auto-registration triggers for settings-only extensions
it('auto-registers config tab when extension has settings but no secrets', () => {
  const deps = makeDeps();
  const rec = makeRecord({
    manifest: {
      ...baseManifest,
      serverCapabilities: {
        settings: [{ type: 'boolean', key: 'enabled', label: 'Enabled' }],
      },
    },
  });
  // ... trigger initialize with rec, verify registry.register called with 'settings.tabs'
});

// Purpose: Verify auto-registration triggers for extensions with both secrets and settings
it('auto-registers unified config tab when extension has both secrets and settings', () => {
  // ... verify single tab registration, not two separate tabs
});

// Purpose: Verify no tab when extension has neither secrets nor settings
it('does not auto-register config tab when extension has no secrets or settings', () => {
  // ... verify registry.register NOT called with 'settings.tabs'
});
```

### Integration Tests: Settings API

```typescript
// Purpose: Verify settings CRUD via HTTP endpoints
describe('GET /api/extensions/:id/settings', () => {
  it('returns settings with default values for new extension');
  it('returns stored values overriding defaults');
});

describe('PUT /api/extensions/:id/settings/:key', () => {
  it('stores a string setting value');
  it('stores a number setting value');
  it('stores a boolean setting value');
  it('rejects undeclared setting keys');
});

describe('DELETE /api/extensions/:id/settings/:key', () => {
  it('removes stored value, GET returns default');
});
```

## Performance Considerations

- **Settings file I/O**: Reads on every `GET /api/extensions/:id/settings` request. Acceptable for single-user app; each file is tiny (< 1KB). If needed, add in-memory cache with file-watcher invalidation in v2.
- **Manifest parsing**: `SettingDeclarationSchema` adds ~10 Zod validations per extension during discovery. Negligible compared to esbuild compilation time.
- **UI rendering**: Settings panel renders at most ~20 fields per extension. No performance concern.
- **Atomic writes**: Same temp-file-then-rename pattern used by secrets store. Safe for concurrent reads during write.

## Security Considerations

- **Secrets remain encrypted**: No changes to the AES-256-GCM encryption pipeline. Settings and secrets use separate storage paths and separate files.
- **Settings are plaintext**: By design. Only non-sensitive configuration belongs in `settings`. API keys, tokens, and passwords must use `secrets`.
- **No settings in browser**: Settings values are fetched from the server via API endpoints. Extensions running in the browser cannot directly access the settings file.
- **Path traversal prevention**: Existing `SAFE_EXT_ID` regex check applies to settings endpoints.
- **Key validation**: Setting keys validated against manifest declarations — cannot write arbitrary keys.

## Documentation

### Files to Update

| File                                  | Changes                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contributing/extension-authoring.md` | Add "Settings Declaration" section documenting `settings` array, field types, placeholder, group. Update "Secrets" section with `placeholder` and `group` fields. Add complete example manifest. |
| `contributing/extension-authoring.md` | Update `DataProviderContext` quick reference to include `ctx.settings`                                                                                                                           |

### New Documentation Sections

**Settings Declaration** section in extension authoring guide:

- Field types table (text, number, boolean, select) with properties
- Grouping explanation with example manifest
- Server-side access via `ctx.settings.get(key)`
- Best practice: secrets for credentials, settings for everything else

## Implementation Phases

### Phase 1: Schema + Placeholder + Group (Foundation)

- Add `SettingDeclarationSchema` and `SettingOptionSchema` to manifest schema
- Add `placeholder` and `group` to `SecretDeclarationSchema`
- Add `settings` to `ServerCapabilitiesSchema`
- Export new types from `packages/extension-api/src/index.ts`
- Update `ManifestSecretsPanel` to render `placeholder` on PasswordInput
- Update `ManifestSecretsPanel` to group secrets by `group` using `CollapsibleFieldCard`
- Add manifest schema tests
- **Delivers:** Placeholder hints and grouped secrets — visible improvement with minimal blast radius

### Phase 2: Settings Storage + API (Server)

- Create `ExtensionSettingsStore` in `packages/shared/src/extension-settings.ts`
- Add `SettingsStore` interface to `packages/extension-api/src/server-extension-api.ts`
- Add settings CRUD endpoints to `apps/server/src/routes/extensions.ts`
- Update `extension-server-api-factory.ts` to include `settings` in `DataProviderContext`
- Add storage and API tests
- **Delivers:** Server-side settings infrastructure — extensions can read settings via `ctx.settings`

### Phase 3: Unified Settings Panel (Client)

- Rename `ManifestSecretsPanel` → `ManifestSettingsPanel`
- Add field renderers for text, number, boolean, select
- Implement grouping algorithm (ungrouped first, then named groups)
- Update `extension-loader.ts` auto-register to check both secrets and settings
- Update imports across codebase
- Add component tests
- **Delivers:** Full unified settings panel — extension authors get complete forms from manifest

### Phase 4: Templates + Documentation

- Update data-provider template manifest with example settings
- Update server template comments referencing `ctx.settings`
- Update `contributing/extension-authoring.md`
- Update Linear Issues example extension manifest with `placeholder`
- **Delivers:** Documentation and DX polish

## Open Questions

None — all architectural decisions resolved during ideation.

## Related ADRs

- **ADR-0214**: AES-256-GCM Encrypted Per-Extension Secret Storage — Establishes the encrypted secrets pattern that settings complement (plaintext counterpart)
- **ADR-0213**: Directus-Style register(router, ctx) for Server Extensions — Defines the `DataProviderContext` that gains a `settings` field
- **ADR-0215**: Unified SSE Stream for Extension Events — Future consideration if settings changes need real-time push

## References

- `specs/extension-manifest-settings/01-ideation.md` — Ideation document with research findings and decisions
- `research/20260329_extension_manifest_settings_schema.md` — Raycast, VS Code, Grafana, Shopify patterns
- `research/20260329_extension_server_side_capabilities.md` — Extension system architecture research
- Raycast Manifest Preferences — Reference model for typed field declarations
- Grafana `jsonData`/`secureJsonData` — Principle for separating non-secret config from encrypted credentials

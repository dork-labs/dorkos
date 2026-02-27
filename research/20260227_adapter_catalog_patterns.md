# Adapter Catalog Management: Research Findings

**Date**: 2026-02-27
**Feature Slug**: adapter-catalog-management
**Research Depth**: Deep

---

## Research Summary

Mature developer tools (VS Code, Grafana, n8n, Home Assistant, Raycast, Slack, Backstage) have converged on a consistent three-layer pattern for plugin/adapter catalogs: (1) a static manifest that declares metadata and capabilities, (2) a config schema that drives dynamic form generation, and (3) a multi-step setup wizard with connection testing. The winning approach for DorkOS is a `ConfigField[]` descriptor array declared alongside each adapter's Zod schema — serialized at runtime to the client — rather than shipping raw Zod schemas or doing full JSON Schema generation. This gives the UI all the information it needs to render forms without coupling the client to server-only schema logic.

---

## Key Findings

### 1. Plugin Metadata is a Static Manifest + Runtime Schema

Every major system separates two concerns that should never be merged:

- **Static metadata** (display name, description, icon, version, categories, docs URL) — declared once, never changes per-instance
- **Runtime config schema** (field definitions per adapter instance) — determines what the setup wizard renders

VS Code puts both in `package.json` under `contributes.configuration`. Grafana uses a separate `plugin.json` file. Raycast extends npm's `package.json` with Raycast-specific fields. The pattern that works best for DorkOS is closest to Raycast's: extend an existing type with a dedicated metadata block rather than inventing a new file format.

### 2. Config Schemas Must Express Field-Level Semantics Beyond Type

Every system that does this well adds metadata that JSON Schema alone does not capture:

- **Sensitive flag** (`password`, `secret`, `typePassword`): tells the UI to use a password input and the server to encrypt at rest. VS Code calls this `password: true`. Raycast has a `password` type. n8n uses `typeOptions: { password: true }`. Backstage uses `@visibility secret` in JSDoc.
- **Placeholder text**: shown in empty inputs to guide users.
- **Help text / description**: inline guidance below the field.
- **Section grouping**: fields belong to named sections (e.g., "Authentication", "Advanced").
- **Conditional visibility**: a field is only shown when another field has a specific value (e.g., `webhookUrl` is only shown when `mode === 'webhook'`).
- **Validation hints**: error messages when pattern validation fails.

None of these can be derived from a Zod schema alone without `.meta()` annotations.

### 3. The ConfigField Descriptor Approach Outperforms JSON Schema Serialization

There are three approaches to making server-side schema available to the client:

**Option A — Serialize Zod to JSON Schema at runtime** (`z.toJSONSchema()` in Zod v4): Pro: no duplication. Con: JSON Schema has no concept of `sensitive`, `placeholder`, `sectionLabel`, or conditional visibility. The client would still need a mapping layer, and `z.toJSONSchema()` cannot serialize custom metadata added via `.meta()` in a standard way. Also fails for Zod types like `z.union()` with complex discriminants.

**Option B — Define a parallel `ConfigField[]` descriptor array** alongside the Zod schema: Pro: the descriptor is a plain serializable object with exactly the fields the UI needs. Con: slight duplication between Zod schema and descriptor. This is the pattern used by n8n (`INodeProperties[]`), Raycast (preferences array in manifest), and Home Assistant (voluptuous schema + strings.json). It wins because the descriptor is the single source of truth for the UI, and the Zod schema is the single source of truth for validation — they serve different masters.

**Option C — Render forms server-side**: not applicable for DorkOS's React client architecture.

**Recommendation**: Option B. Define a `ConfigField` type in `@dorkos/shared` and require each adapter to export both its Zod validation schema and a `configFields: ConfigField[]` descriptor. The server aggregates descriptors into the catalog endpoint. The client renders forms from descriptors.

### 4. Adapter Metadata Structure from Real Systems

#### VS Code Extension (`package.json` → `contributes.configuration`)

```json
{
  "contributes": {
    "configuration": {
      "title": "My Extension",
      "properties": {
        "myext.apiKey": {
          "type": "string",
          "description": "API key for the service",
          "markdownDescription": "Get your key at [example.com](https://example.com)",
          "default": ""
        },
        "myext.mode": {
          "type": "string",
          "enum": ["polling", "webhook"],
          "enumDescriptions": ["Poll every N seconds", "Receive webhooks"],
          "default": "polling"
        }
      }
    }
  }
}
```

Key learnings: enum fields get per-option descriptions. `markdownDescription` enables docs links inline. No native `sensitive` concept — VS Code stores secrets separately via the credential store API.

#### Grafana Data Source Plugin (`plugin.json`)

```json
{
  "id": "my-datasource",
  "type": "datasource",
  "name": "My Data Source",
  "info": {
    "description": "Connect to MyService",
    "logos": { "small": "img/logo.svg", "large": "img/logo.svg" },
    "links": [{ "name": "Documentation", "url": "https://..." }]
  },
  "dependencies": { "grafanaDependency": ">=9.0.0" }
}
```

Config UI for Grafana datasources is rendered by the plugin's own React component (not declared in `plugin.json`). The plugin renders its own form. This is the "plugin owns its UI" model — unsuitable for DorkOS where the UI needs to be generic.

#### n8n Credential Type (TypeScript class)

```typescript
class MyApiCredentials implements ICredentialType {
  name = 'myApi';
  displayName = 'My API';
  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://api.example.com',
      placeholder: 'https://api.example.com',
    },
  ];
}
```

n8n's `INodeProperties[]` is the best reference model for DorkOS's `ConfigField[]`. It is: a plain array, serializable to JSON, field-type-driven (not JSON Schema derived), and has first-class support for `password: true` via `typeOptions`. The class wraps the array in a typed container with `name` and `displayName`.

#### Home Assistant Integration (manifest.json + config_flow)

```json
{
  "domain": "myintegration",
  "name": "My Integration",
  "config_flow": true,
  "iot_class": "cloud_polling",
  "version": 1
}
```

HA's config flow is a multi-step Python wizard: each step is a method like `async_step_user`, `async_step_reauth`. Strings come from `strings.json` (localized labels). Validation errors return to the same step with error keys. The pattern: **step function returns either "show form again with errors" or "proceed to next step"**. The abort/error/success branching is the key insight for wizard design.

#### Raycast Extension (package.json → preferences array)

```json
{
  "preferences": [
    {
      "name": "apiToken",
      "title": "API Token",
      "description": "Your personal access token",
      "type": "password",
      "required": true
    },
    {
      "name": "serverUrl",
      "title": "Server URL",
      "description": "Base URL of your instance",
      "type": "textfield",
      "placeholder": "https://app.example.com",
      "required": false,
      "default": ""
    },
    {
      "name": "mode",
      "title": "Connection Mode",
      "type": "dropdown",
      "required": true,
      "data": [
        { "title": "Polling", "value": "polling" },
        { "title": "Webhook", "value": "webhook" }
      ]
    }
  ]
}
```

Raycast's preferences array is the cleanest reference for DorkOS. It directly maps to form fields, supports password/textfield/checkbox/dropdown types, is fully serializable, and is declared alongside the extension's other manifest data. The `type` field drives the input component. `required`, `default`, `placeholder`, `description`, and `data` (for dropdowns) cover 95% of real-world needs.

#### Backstage (`package.json` → `configSchema`)

```json
{
  "configSchema": {
    "$schema": "https://backstage.io/schema/config-v1",
    "type": "object",
    "properties": {
      "apiKey": {
        "type": "string",
        "visibility": "secret",
        "description": "Service API key"
      }
    }
  }
}
```

Backstage adds a `visibility` keyword to JSON Schema: `frontend`, `backend`, or `secret`. This is relevant for DorkOS: sensitive fields should never be echoed back to the client in GET responses. The schema is discovered from `package.json` automatically during build. This is the only system that does schema discovery from npm packages — directly applicable to DorkOS's npm plugin loader.

---

## Detailed Analysis

### Section 1: The Recommended ConfigField Descriptor Type

Based on the cross-system analysis, here is a proposed `ConfigField` type for `@dorkos/shared`:

```typescript
export type ConfigFieldType =
  | 'text'       // Standard string input
  | 'password'   // Masked string input — never echoed to client
  | 'number'     // Numeric input
  | 'boolean'    // Toggle/checkbox
  | 'select'     // Dropdown from options[]
  | 'textarea'   // Multi-line text
  | 'url';       // URL input with validation hint

export interface ConfigFieldOption {
  label: string;
  value: string;
}

export interface ConfigField {
  /** Key used in the adapter config object (matches Zod schema key) */
  key: string;
  /** Human-readable label displayed above the input */
  label: string;
  /** Input type, drives the rendered component */
  type: ConfigFieldType;
  /** Whether the field is required for the adapter to function */
  required: boolean;
  /** Default value (pre-fills the form) */
  default?: string | number | boolean;
  /** Placeholder shown in empty inputs */
  placeholder?: string;
  /** Help text shown below the input */
  description?: string;
  /** For type === 'select': the options to render */
  options?: ConfigFieldOption[];
  /** Visual section grouping (e.g., 'Authentication', 'Advanced') */
  section?: string;
  /** Conditional visibility: only show when another field equals a value */
  showWhen?: { field: string; equals: string | boolean | number };
}
```

This type has no import-time dependencies on Zod — it is a plain data type that is fully JSON-serializable and can live in `@dorkos/shared/relay-schemas` or a new `@dorkos/shared/adapter-schemas` file.

### Section 2: The AdapterManifest Static Metadata Type

Each adapter (built-in or npm plugin) should export a static `AdapterManifest` object:

```typescript
export interface AdapterManifest {
  /** Canonical adapter type string (matches AdapterConfig.type) */
  type: string;
  /** Human-readable name shown in catalog */
  displayName: string;
  /** Short description for catalog card */
  description: string;
  /** URL to adapter icon (SVG or PNG, 64x64 recommended) */
  iconUrl?: string;
  /** Emoji fallback when no icon is provided */
  iconEmoji?: string;
  /** Category for catalog filtering */
  category: 'messaging' | 'automation' | 'internal' | 'custom';
  /** Docs URL linked from catalog */
  docsUrl?: string;
  /** Whether this is a built-in adapter (affects display) */
  builtin: boolean;
  /** Config fields for the setup wizard */
  configFields: ConfigField[];
  /** Optional multi-step setup: if provided, wizard shows steps in order */
  setupSteps?: Array<{
    stepId: string;
    title: string;
    description?: string;
    /** Field keys to show on this step */
    fields: string[];
  }>;
  /** Human-readable setup instructions shown at the top of the wizard */
  setupInstructions?: string;
}
```

Built-in adapters export this from their source file. npm plugin adapters declare it in their `package.json` under a `dorkos.adapterManifest` key (following Backstage's `configSchema` pattern) or export it from their module entry point.

### Section 3: Server Catalog Endpoint Design

The server aggregates adapter manifests into a catalog endpoint:

```
GET /api/relay/adapters/catalog
```

Response shape:

```typescript
interface CatalogEntry {
  manifest: AdapterManifest;
  /** Instances of this adapter type currently configured */
  instances: Array<{
    id: string;
    enabled: boolean;
    status: AdapterStatus;
  }>;
}

type CatalogResponse = CatalogEntry[];
```

This separates "what adapter types are available" (manifest) from "which instances exist" (configs + statuses). The client can display a "Browse" view (all catalog entries) and an "Installed" view (entries where `instances.length > 0`).

For npm plugins, the server reads the plugin's `package.json` at load time to extract the manifest. For built-in adapters, the manifest is imported directly from the TypeScript source.

### Section 4: Dynamic Form Generation from ConfigField[]

The client-side form rendering is straightforward given `ConfigField[]`:

```typescript
function AdapterConfigForm({
  fields,
  values,
  errors,
  onChange,
}: {
  fields: ConfigField[];
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
}) {
  // Group fields by section
  const sections = groupFieldsBySection(fields);

  return sections.map(({ sectionLabel, fields }) => (
    <div key={sectionLabel}>
      {sectionLabel && <SectionHeader>{sectionLabel}</SectionHeader>}
      {fields
        .filter((f) => !f.showWhen || evaluateCondition(f.showWhen, values))
        .map((field) => (
          <ConfigFieldInput
            key={field.key}
            field={field}
            value={values[field.key]}
            error={errors[field.key]}
            onChange={(v) => onChange(field.key, v)}
          />
        ))}
    </div>
  ));
}
```

`ConfigFieldInput` renders the appropriate shadcn/ui component based on `field.type`:
- `text` / `url` → `<Input type="text" />`
- `password` → `<Input type="password" />` with unmask toggle
- `number` → `<Input type="number" />`
- `boolean` → `<Switch />` or `<Checkbox />`
- `select` → `<Select>` with `field.options`
- `textarea` → `<Textarea />`

Validation runs on the server using the adapter's Zod schema (not the descriptor). The descriptor is for rendering only. Errors returned from the server are displayed below the corresponding field by matching the Zod error path to `field.key`.

### Section 5: Multi-Step Setup Wizard Pattern

The Home Assistant config_flow pattern maps cleanly to a shadcn Dialog-based wizard:

**Step flow:**
1. **Select adapter type** — browse catalog, click adapter card
2. **Name the instance** — set `id` (slug), review `setupInstructions` if present
3. **Configure fields** — one step per `setupSteps[n]`, or all fields on one page if no steps defined
4. **Test connection** — POST to `/api/relay/adapters/:id/test` with the config; server instantiates adapter transiently and returns `{ ok: boolean; error?: string }`
5. **Confirm** — shows success state; adapter is written to `adapters.json`

**Key UX decisions from research:**
- The "Test Connection" step is critical for credential-based adapters (Telegram, Webhook). IntelliJ and Grafana both make this a prominent action.
- The wizard should be re-entrant: clicking "Configure" on an existing adapter opens the wizard pre-filled with current config values.
- Password fields should never be pre-filled from the server (send empty string + a `hasExistingValue: true` hint so the UI shows "leave blank to keep current").
- Abort conditions (e.g., invalid bot token) should show inline error with a link to the adapter's docs URL.
- Enable/disable is a toggle on the adapter card, not part of the wizard. This separates configuration from activation (same distinction WordPress and Grafana make).

### Section 6: Sensitive Field Handling

Based on the Backstage visibility pattern and Raycast's `password` type:

1. **At descriptor level**: `type: 'password'` marks a field as sensitive. The client renders it as a masked input.
2. **At API level**: GET `/api/relay/adapters` returns configs with all password-type fields replaced by `"***"` (or omitted entirely). The client never receives actual secrets.
3. **At storage level**: `adapters.json` stores secrets in plaintext currently (same as `~/.dork/config.json`). A future hardening pass could use OS keychain via the `keytar` package. For now, the file is user-owned with 600 permissions.
4. **At validation level**: when the user submits a form with a password field containing `""` (empty, meaning "keep existing"), the server merges the new config over the existing config, preserving the stored secret.

### Section 7: npm Plugin Manifest Discovery

For npm adapter packages (type `plugin` in `AdapterConfig`), the server should:

1. After `import(pluginPackage)`, call `module.getManifest?.()` to get the `AdapterManifest`.
2. Fall back to reading the package's `package.json` for a `dorkos.adapterManifest` field.
3. If neither exists, generate a minimal manifest with `displayName: config.id` and `configFields: []`.

This mirrors how Backstage discovers `configSchema` from `package.json` and how VS Code reads `contributes` from extension manifests. The module export approach is preferred because it allows manifests to be typed and validated at load time.

The npm plugin loader (`loadAdapters` in `@dorkos/relay`) should be extended to also return the manifest alongside the adapter instance.

### Section 8: Catalog UI Architecture (FSD)

Within DorkOS's FSD layer structure, the catalog feature maps to:

- **`entities/adapter/`** — new entity layer: `useAdapterCatalog`, `useAdapterInstances`, `useAdapterStatus`
- **`features/adapter-catalog/`** — new feature: `AdapterCatalogPanel`, `AdapterCard`, `AdapterSetupWizard`, `AdapterConfigForm`, `ConnectionTestStep`
- **Server routes** — new `routes/adapters.ts` (catalog GET, instance CRUD, test POST)

The `RelayPanel` feature would gain a tab or section linking to the catalog, similar to how Grafana's Plugins page is a top-level nav item in Administration.

---

## Sources & Evidence

- VS Code extension `contributes.configuration` structure — [Contribution Points | Visual Studio Code Extension API](https://code.visualstudio.com/api/references/contribution-points)
- Grafana `plugin.json` mandatory structure — [Metadata (plugin.json) | Grafana Plugin Tools](https://grafana.com/developers/plugin-tools/reference/plugin-json)
- Grafana plugin install/update/uninstall flow — [Plugin management | Grafana documentation](https://grafana.com/docs/grafana/latest/administration/plugin-management/)
- n8n credential type `INodeCredentialType` with `displayName` and `properties[]` — [Credentials files | n8n Docs](https://docs.n8n.io/integrations/creating-nodes/build/reference/credentials-files/)
- n8n custom credential walkthrough — [How to add custom credentials in n8n? | n8n tutorials](https://www.rapidevelopers.com/n8n-tutorial/how-to-add-custom-credentials-in-n8n)
- Home Assistant `config_flow` wizard pattern — [Config flow | Home Assistant Developer Docs](https://developers.home-assistant.io/docs/config_entries_config_flow_handler/)
- Raycast preferences array with `password` type and `dropdown` data — [Manifest | Raycast API](https://developers.raycast.com/information/manifest)
- Slack app manifest modular sections pattern — [App manifest reference | Slack Developer Docs](https://docs.slack.dev/reference/app-manifest/)
- Backstage `configSchema` in `package.json` with `visibility: secret` — [Defining Configuration for your Plugin | Backstage](https://backstage.io/docs/conf/defining/)
- Zod v4 native `z.toJSONSchema()` and `.meta()` — [JSON Schema | Zod](https://zod.dev/json-schema)
- `zod-to-json-schema` deprecation (Zod v4 natively supports it as of late 2025) — [zod-to-json-schema - npm](https://www.npmjs.com/package/zod-to-json-schema)
- shadcn multi-step wizard patterns — [Shadcn UI Multi Form](https://shadcn-ui-multi-form.vercel.app/)
- React multi-step form with shadcn Sheet — [React Multi-Step Form Sheet | shadcn.io](https://www.shadcn.io/patterns/sheet-form-5)
- Dynamic Backstage plugin config discovery — [Backstage Dynamic Plugins with Red Hat Developer Hub](https://piotrminkowski.com/2025/06/13/backstage-dynamic-plugins-with-red-hat-developer-hub/)

---

## Research Gaps & Limitations

- **n8n's exact `typeOptions.password` implementation** was not confirmed from official TypeScript type definitions. The `INodeProperties` type structure was inferred from tutorial sources rather than the canonical `@n8n/workflow` package types. Before implementing, validate against the actual n8n source.
- **Grafana's datasource instance configuration** (the per-instance config form after the plugin is installed) is rendered by the plugin's own React component, not by a generic form renderer. This means Grafana's approach is not a direct model for DorkOS's generic wizard — it's the "plugin owns its UI" model. The Raycast and n8n models are the correct reference.
- **Keychain / secret storage** was not researched in depth. The `keytar` npm package is the standard Node.js interface to OS keychains, but it has Electron compatibility concerns similar to those DorkOS already handles for the Obsidian plugin. This warrants a separate research spike if secret storage hardening is prioritized.
- **Plugin discovery from npm registry** (browsing available, not-yet-installed adapters) was not researched. For a v1, the catalog can be limited to adapters the server already knows about (built-ins + locally installed npm packages). A future registry/marketplace is out of scope here.

---

## Contradictions & Disputes

- **Zod serialization vs. ConfigField descriptors**: One could argue Zod v4's `.meta({ title, description })` approach should be used to enrich Zod schemas and then serialize them, avoiding the duplicate descriptor. The counter-argument is that `z.toJSONSchema()` still produces JSON Schema, which has no `sensitive`, `placeholder`, `showWhen`, or `section` concepts. You end up adding the same custom fields back anyway — and now they live in two places (Zod metadata and JSON Schema extensions). The `ConfigField[]` descriptor keeps the UI contract explicit and separate from validation.
- **Enable/disable vs. install/uninstall**: Grafana and WordPress distinguish between these clearly. DorkOS's current architecture doesn't have an "uninstall" concept for built-in adapters — they are always present in the registry. A pragmatic resolution: built-in adapters show a toggle (enable/disable that persists to `adapters.json`); npm plugin adapters could show a remove button that removes the config entry entirely. Both actions hot-reload the `AdapterManager`.

---

## Search Methodology

- Number of searches performed: 16
- Number of pages fetched: 9
- Most productive search terms: `n8n credential type INodeCredentialType`, `Raycast manifest preferences password type`, `Backstage configSchema package.json visibility secret`, `Grafana plugin.json metadata descriptor`
- Primary information sources: official documentation (VS Code, Grafana, n8n, Home Assistant, Raycast, Slack, Backstage, Zod), codebase reading (`adapter-manager.ts`, `relay-schemas.ts`)

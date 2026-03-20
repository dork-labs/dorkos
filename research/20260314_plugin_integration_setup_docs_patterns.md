---
title: 'Plugin & Integration Setup Documentation Patterns'
date: 2026-03-14
type: external-best-practices
status: active
tags:
  [
    adapter,
    setup,
    documentation,
    onboarding,
    manifest,
    slack,
    vscode,
    home-assistant,
    raycast,
    obsidian,
    wizard,
    one-click,
    deep-link,
  ]
feature_slug: adapter-catalog-management
searches_performed: 15
sources_count: 32
---

# Plugin & Integration Setup Documentation Patterns

**Date**: 2026-03-14
**Research Depth**: Focused Investigation
**Companion to**: `research/20260227_adapter_catalog_patterns.md`, `research/20260311_adapter_binding_configuration_ux_patterns.md`

---

## Research Summary

This report covers three complementary areas: (1) the Slack App Manifest format and the specific URL mechanism for pre-populating app creation — a confirmed deep link pattern analogous to the Heroku Deploy Button; (2) how major integration platforms surface rich setup documentation to users during and after the configuration flow; and (3) the canonical patterns for one-click/guided setup buttons across developer tools. The strongest findings are: Slack has a confirmed URL scheme (`https://api.slack.com/apps?new_app=1&manifest_yaml=...`) for pre-populating manifests; VS Code's walkthrough system is the most complete multi-step guided setup primitive available in any plugin ecosystem; and Raycast's README-driven onboarding screen is the simplest credible pattern for "show setup docs before the user touches a config field."

---

## Key Findings

### 1. Slack App Manifest — URL Pre-population Is Real and Documented

Slack provides two confirmed URL formats for jumping users directly into app creation with a pre-populated manifest:

```
https://api.slack.com/apps?new_app=1&manifest_yaml=<URL-encoded-YAML>
https://api.slack.com/apps?new_app=1&manifest_json=<URL-encoded-JSON>
```

Both formats are documented in the official Slack developer docs. The URL drops the user into the "Create New App → From a manifest" flow with the manifest pre-filled in the text area. The user still selects their workspace and reviews the configuration summary before creation is finalized — it is not a fully headless/automatic creation.

**The programmatic alternative**: `apps.manifest.create` (a Web API method) creates an app entirely via API without any UI flow. This requires an app configuration access token. It is the CI/CD path; the URL approach is the human-friendly sharing path.

**The full Slack App Manifest format** has these top-level sections:

| Section               | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `_metadata`           | Schema versioning                                              |
| `display_information` | Name (max 35 chars), description (max 140), background_color   |
| `settings`            | Socket mode, event subscriptions, IP allowlists, interactivity |
| `features`            | Bot user, app home, shortcuts, slash commands, unfurl domains  |
| `oauth_config`        | Redirect URLs, bot scopes (max 255), user scopes (max 255)     |
| `functions`           | Custom workflow steps                                          |
| `workflows`           | Automation sequences                                           |
| `datastores`          | Data persistence for hosted apps                               |
| `outgoing_domains`    | Egress configuration                                           |
| `app_directory`       | Marketplace listing fields (optional)                          |

**Applied to DorkOS**: DorkOS could provide a "Deploy this adapter in Slack" button for the Slack adapter that encodes a minimal manifest (socket mode enabled, correct scopes for the relay adapter) and links to `https://api.slack.com/apps?new_app=1&manifest_yaml=...`. This gives users a one-click jump into Slack app creation with the right configuration pre-filled.

A minimal Slack relay adapter manifest looks like:

```yaml
display_information:
  name: DorkOS Relay
  description: Routes Slack messages to your AI agents via DorkOS
settings:
  socket_mode_enabled: true
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - message.mpim
features:
  bot_user:
    display_name: DorkOS Relay
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - im:history
      - mpim:history
```

URL-encoding this and appending it to `https://api.slack.com/apps?new_app=1&manifest_yaml=` gives users a shareable "Create Your Slack App" button.

---

### 2. VS Code Walkthroughs — The Most Complete Multi-Step Guided Setup Primitive

VS Code's `contributes.walkthroughs` contribution point is the most sophisticated guided setup system in any plugin ecosystem. It contributes to the "Getting Started" page and opens automatically on extension install.

**Walkthrough structure:**

```json
{
  "contributes": {
    "walkthroughs": [
      {
        "id": "my-setup",
        "title": "Set Up My Extension",
        "description": "Get connected in 3 steps",
        "when": "!myExtension.configured",
        "steps": [
          {
            "id": "get-api-key",
            "title": "Get Your API Key",
            "description": "Visit your dashboard and copy your API key.\n[Open Dashboard](https://example.com/dashboard)",
            "media": {
              "markdown": "media/step1.md"
            },
            "completionEvents": ["onSettingChanged:myExtension.apiKey"]
          },
          {
            "id": "configure",
            "title": "Enter Your Key",
            "description": "Paste your key into the settings.\n[Open Settings](command:workbench.action.openSettings?%5B%22myExtension%22%5D)",
            "media": {
              "image": "media/settings-screenshot.png",
              "altText": "The settings panel with the API key field highlighted"
            },
            "completionEvents": ["onCommand:myExtension.connect"]
          }
        ]
      }
    ]
  }
}
```

**Key capabilities:**

- **Completion events**: Steps auto-check when specific conditions are met. `onSettingChanged:id` fires when a setting is changed; `onCommand:id` fires when a command runs; `onContext:expression` evaluates VS Code context keys. Steps with no `completionEvents` complete when clicked.
- **Media types**: Steps support either `image` (PNG/SVG, with alt text) or `markdown` (a `.md` file rendered inline). SVG is recommended for theme-awareness.
- **`when` clause**: The entire walkthrough or individual steps can be conditionally shown using VS Code context expressions. This enables "show only if not configured yet."
- **Step descriptions**: Markdown with support for bold, inline code, links, and `command:` URI links that invoke VS Code commands inline.
- **Auto-open on install**: The walkthrough opens on first install unless the user has dismissed it. Subsequent opens require the user to navigate to "Help → Get Started."

**Why this matters for DorkOS**: The VS Code walkthrough is the gold standard because it: (a) auto-opens on first install, (b) tracks completion state per step, (c) supports both static images and rich markdown per step, (d) provides inline command links that execute actions directly, and (e) hides itself once all steps are complete. DorkOS's adapter setup wizard could adopt a similar "steps with completion events" model.

---

### 3. Raycast — README-Driven Onboarding with Required Preferences Gate

Raycast's setup documentation pattern is the simplest and most integrated approach for a preference-gated extension:

**The flow:**

1. User installs extension from the Store
2. User tries to run a command
3. If the extension has required preferences not yet set, Raycast shows the **preferences onboarding screen** before the command runs
4. If a `README.md` is present in the extension root, the onboarding screen shows an "About This Extension" button
5. Clicking the button opens the README in a rich viewer with full markdown rendering and media support

**Store requirements for setup documentation:**

- README must cover: API token acquisition, preference enablement in other apps, any non-trivial setup steps
- Media files go in a top-level `media/` folder (referenced from README as `./media/screenshot.png`)
- Screenshots for the store listing: up to 6 screenshots, min 3 recommended, 2000x1250px (16:10), PNG, light theme

**Required preferences gate:**

```json
{
  "preferences": [
    {
      "name": "apiToken",
      "title": "API Token",
      "description": "Get yours at https://example.com/tokens",
      "type": "password",
      "required": true
    }
  ]
}
```

With `required: true`, Raycast blocks command execution and shows the preferences form. The user cannot bypass this gate. The README button appears alongside the preferences form so users can find setup instructions contextually.

**The critical insight**: Raycast's pattern works because the README is surfaced at the moment of maximum user intent — right before they use the extension for the first time, not during install when they may not be paying attention. The preferences gate ensures they cannot ignore the setup step.

---

### 4. Home Assistant Config Flow — Rich Inline Documentation Components

Home Assistant's integration setup documentation uses MDX-style custom components within their documentation site (not inline in the UI itself). The integration setup UI is driven by `strings.json` (localized labels and descriptions) and `config_flow` step definitions.

**Documentation site components available for integration setup guides:**

| Component              | Syntax                                           | Use                          |
| ---------------------- | ------------------------------------------------ | ---------------------------- |
| Expandable sections    | `{% details "Title" %} content {% enddetails %}` | Hide verbose instructions    |
| Tip box                | Custom shortcode                                 | Non-critical recommendations |
| Note box               | Custom shortcode                                 | General highlights           |
| Important box          | Custom shortcode                                 | Critical warnings            |
| Screenshot (captioned) | `<p class='img'><img src="..." /></p>`           | Illustrated steps            |
| My links               | `{% my integrations title="..." %}`              | Deep links into HA UI        |
| Inline icons           | `{% icon "mdi:dots-vertical" %}`                 | UI element reference         |
| Glossary tooltips      | Custom shortcode                                 | Terminology explanation      |
| Embedded video         | `lite-YouTube` component                         | Tutorial videos              |
| Config blocks          | Custom shortcode                                 | YAML/UI config display       |

**The config flow UI itself** is data-driven from `strings.json`:

```json
{
  "config": {
    "step": {
      "user": {
        "title": "Set up Your Integration",
        "description": "Enter your API credentials. Get them at [example.com](https://example.com).",
        "data": {
          "api_key": "API Key",
          "host": "Host"
        },
        "data_description": {
          "api_key": "Found in your account settings under 'API Access'",
          "host": "The hostname or IP address of your device"
        }
      }
    }
  }
}
```

The `description` field at the step level supports Markdown links. The `data_description` field provides per-field helper text displayed below each input. This is the HA equivalent of DorkOS's `ConfigField.description`.

**Key HA pattern**: Step descriptions include Markdown links to the external service where users get their credentials. This is the minimal viable "setup guide" — a single sentence with a link, shown at the top of the form.

---

### 5. n8n Credential Setup — External Docs URL with Per-Credential Guide Pages

n8n's credential documentation pattern is worth noting because it's a hybrid: the credential type definition includes a `docsUrl` field pointing to an external documentation page, and n8n generates a per-credential documentation page on docs.n8n.io with a consistent format:

**Credential type `docsUrl` field:**

```typescript
class GithubCredentialsApi implements ICredentialType {
  name = 'githubApi';
  displayName = 'GitHub';
  documentationUrl = 'github';  // resolves to docs.n8n.io/integrations/builtin/credentials/github/
  properties: INodeProperties[] = [...];
}
```

**Per-credential documentation page structure** (consistent across all credentials):

1. **Supported authentication methods** — upfront summary of all auth options
2. **Prerequisites** — separate heading before instructions begin
3. **Related resources** — links to the node docs, n8n's HTTP request node, etc.
4. **Method-specific instructions** — one section per auth method:
   - Step-by-step with action-oriented subheadings (e.g., "Generate personal access token")
   - Sequential organization guiding users progressively
   - Links to external service (e.g., "Go to GitHub Developer Settings")

For complex OAuth credentials (e.g., Google), there are five explicitly numbered steps:

1. Create a Google Cloud Console project
2. Enable APIs
3. Configure your OAuth consent screen
4. Create your Google OAuth client credentials
5. Finish your n8n credential

**The n8n credential form** shows a "Documentation" link in the corner of the credential dialog, linking to the `documentationUrl`. The setup instructions live externally, not inline.

---

### 6. Heroku Deploy Button — The Template for "One-Click Setup Buttons"

The Heroku Deploy Button is the canonical pattern for "encode configuration in a URL, let the user deploy with one click." It uses `app.json` as the configuration manifest:

**Button URL format:**

```
https://www.heroku.com/deploy?template=https://github.com/user/repo
```

**Environment variable pre-population:**

```
https://www.heroku.com/deploy?template=https://github.com/user/repo&env[API_KEY]=myvalue&env[REGION]=us-east-1
```

This is directly analogous to Slack's `manifest_yaml=` parameter — both allow the creator of the button to pre-populate specific fields, reducing what the user has to type.

**`app.json` schema for config requirements:**

```json
{
  "name": "My App",
  "description": "What this app does",
  "repository": "https://github.com/user/repo",
  "env": {
    "SECRET_KEY": {
      "description": "A secret key for verifying webhooks",
      "generator": "secret"
    },
    "API_ENDPOINT": {
      "description": "The URL of your API server",
      "value": "https://api.example.com",
      "required": true
    },
    "DEBUG": {
      "description": "Enable debug logging",
      "value": "false",
      "required": false
    }
  },
  "addons": ["heroku-postgresql"],
  "scripts": {
    "postdeploy": "bundle exec rake db:migrate"
  }
}
```

Key `env` field properties:

- `description`: Shown to the user in the deploy UI (like `ConfigField.description`)
- `value`: Default value pre-filled in the form
- `generator: "secret"`: Auto-generates a random secret (user doesn't type it)
- `required`: Whether the deploy is blocked until this is filled

**The "generator" concept** is worth borrowing: for adapter fields that need random tokens or keys that the user doesn't supply (e.g., a webhook secret used to verify incoming requests), auto-generating a value is better than showing an empty field.

---

### 7. GitHub Apps Setup URL — Post-Install Redirect Pattern

GitHub Apps support a `setup_url` field in the app registration. After a user installs the app (selects repositories, grants permissions), GitHub redirects to this URL with an `installation_id` query parameter.

**Use cases:**

- Redirect to a configuration page where the user sets adapter-specific options
- Show "What happens next" instructions
- Collect additional configuration not captured in the install flow

**Security note**: GitHub explicitly warns that `installation_id` can be spoofed — apps must verify it by generating a user access token and checking the installation is associated with that user before trusting the parameter.

**The `Redirect on update` option**: GitHub can also redirect to the setup URL when users update an installation (add/remove repos). This enables reconfiguration flows triggered by the platform, not just initial install.

**Applied to DorkOS**: For OAuth-based adapters (if any are added — e.g., a Notion or GitHub adapter), the `setup_url` pattern is the right model: complete OAuth on the provider's side, then redirect back to DorkOS with the token as a query parameter that pre-fills the adapter configuration form.

---

### 8. Common Patterns Across All Systems — Taxonomy

Synthesizing across all platforms, there are six distinct setup documentation patterns that appear repeatedly:

#### Pattern A: Inline Step Description with External Link

Used by: Home Assistant, n8n (docsUrl), Raycast (description field)

The adapter/credential form shows a one-sentence description above or below the form with a Markdown link to external documentation. Minimal surface area. Zero learning curve.

```
"Enter your Telegram bot token. Get one from @BotFather."
```

This is the lowest-friction version. Suitable for adapters where setup is genuinely simple (Telegram: one field, one step).

#### Pattern B: README / External Docs Tab

Used by: Raycast ("About This Extension"), n8n (docs sidebar link), Grafana (external docs link in plugin metadata)

A button or tab opens full documentation in a separate view (modal, tab, or external browser). Works well for complex adapters with many steps. The tradeoff: the user has to switch contexts.

For DorkOS: an "Open Setup Guide" link in the adapter wizard that opens the adapter's `docsUrl` in a new browser tab or a modal with embedded markdown rendering.

#### Pattern C: Multi-Step Wizard with Per-Step Content

Used by: VS Code walkthroughs, Home Assistant config flow, Stripe onboarding embedded components

Each wizard step shows only the fields and instructions relevant to that step. Step completion is tracked. Steps can conditionally show/hide based on state. This is the richest pattern and the most appropriate for adapters with genuinely multi-step setup (e.g., a Slack adapter: create app → get token → configure scopes → install to workspace → paste token into DorkOS).

For DorkOS, this maps to `AdapterManifest.setupSteps[]` (already designed in `20260227_adapter_catalog_patterns.md`).

#### Pattern D: Expandable/Collapsible Sections

Used by: Home Assistant docs (`{% details %}`), GitHub README collapsible sections, many documentation sites

Long instructions are hidden behind a "Click to expand" disclosure. Users who know what they're doing skip it; users who need help expand it. Works well for optional advanced configuration or troubleshooting steps.

For DorkOS: an "How do I get this?" disclosure below complex fields like the Telegram bot token field, which expands to show 3-4 step instructions.

#### Pattern E: One-Click Create / Deploy Button

Used by: Slack (`api.slack.com/apps?new_app=1&manifest_yaml=...`), Heroku (Deploy button), Netlify (Deploy to Netlify button)

A button or link encodes configuration in a URL query parameter. Clicking it pre-populates a creation form on the target platform. Reduces what the user has to type. Requires: the configuration is known ahead of time (or partially known), and the target platform supports the URL parameter.

For DorkOS: applicable to the Slack adapter specifically. DorkOS could show a "Create Slack App" button that opens the Slack manifest URL with the correct scopes pre-filled. After the user creates the app and copies the bot token, they return to DorkOS to paste it.

#### Pattern F: Required Field Gate (Block Until Complete)

Used by: Raycast (`required: true` preferences), VS Code settings validation

The user cannot proceed with the primary workflow until required fields are filled. This is appropriate for fields where the adapter literally cannot function without them (e.g., the bot token for Telegram). Gates should be field-level, not step-level — blocking the entire wizard is too heavy.

---

## Detailed Analysis

### Applying the Patterns to DorkOS Adapter Setup

Given the patterns above and DorkOS's existing `AdapterManifest` design, here is a recommended enhancement to the setup wizard UX:

#### Enhancement 1: setupInstructions as Markdown (Not Plain Text)

The existing `AdapterManifest.setupInstructions?: string` field should be promoted to support Markdown rendering. This enables:

- Bold for emphasis
- Inline code for tokens/values users need to copy
- Links to external services
- Numbered lists for multi-step instructions

The wizard header area becomes a Markdown renderer (e.g., using `streamdown` per DorkOS conventions) that shows the adapter's setup narrative.

**Example for the Slack adapter:**

```markdown
### Create a Slack App

1. Click **[Create Slack App](https://api.slack.com/apps?new_app=1&manifest_yaml=...)** to open Slack with the right settings pre-filled.
2. Select your workspace and click **Create**.
3. Under **Install App**, click **Install to Workspace** and authorize.
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`) and paste it below.
```

This uses Pattern E (one-click create button) inside Pattern C (multi-step wizard).

#### Enhancement 2: Field-Level "How do I get this?" Disclosure

Add an optional `helpUrl` or `helpText` field to `ConfigField` (or expand the existing `description` field to support Markdown):

```typescript
export interface ConfigField {
  // ... existing fields ...
  /** Optional expanded help content (Markdown). Shown in a collapsible below the field. */
  helpMarkdown?: string;
  /** Optional link shown as "Where do I find this?" below the field */
  helpUrl?: string;
}
```

The rendered form shows: `[input field] [?]` where clicking `[?]` expands `helpMarkdown` inline, or opens `helpUrl` in a new tab.

**Example for Telegram bot token field:**

```typescript
{
  key: 'botToken',
  label: 'Bot Token',
  type: 'password',
  required: true,
  placeholder: '123456789:ABCdefGhijKlmnoPQRstuvwXYZ',
  description: 'Your Telegram bot token',
  helpUrl: 'https://core.telegram.org/bots/tutorial#obtain-your-bot-token',
  helpMarkdown: `
**How to get your bot token:**

1. Open Telegram and search for **@BotFather**
2. Send \`/newbot\` and follow the prompts
3. Copy the token that BotFather sends you (format: \`1234567890:ABC...\`)
  `
}
```

#### Enhancement 3: "One-Click Create" Button Field Type

Add a `button` field type to `ConfigField` for adapter-specific one-click actions:

```typescript
export type ConfigFieldType =
  | 'text'
  | 'password'
  | 'number'
  | 'boolean'
  | 'select'
  | 'textarea'
  | 'url'
  | 'button'; // NEW: renders a call-to-action button

export interface ConfigField {
  // ... for type === 'button':
  /** URL to open when the button is clicked */
  buttonUrl?: string;
  /** Label for the button */
  buttonLabel?: string;
  /** Optional: a field key to populate with a URL query parameter after redirect */
  buttonFillsField?: string;
}
```

This enables the Slack adapter to declare:

```typescript
{
  key: '_createSlackApp',
  label: 'Step 1: Create Your Slack App',
  type: 'button',
  buttonLabel: 'Create Slack App on api.slack.com',
  buttonUrl: 'https://api.slack.com/apps?new_app=1&manifest_yaml=...',
  description: 'Opens Slack with the correct configuration pre-filled. Copy the Bot Token after installation.',
}
```

This field renders as a prominent button in the wizard, not a text input. It has no validation — it's a navigation action.

#### Enhancement 4: setupSteps with Per-Step Completion Tracking

The existing `AdapterManifest.setupSteps[]` design should add completion tracking:

```typescript
interface SetupStep {
  stepId: string;
  title: string;
  description?: string;
  fields: string[];
  /** Field key that, when non-empty, marks this step as complete */
  completionField?: string;
}
```

Steps with a `completionField` auto-advance when the user fills that field. This mirrors VS Code's `completionEvents` pattern.

---

## Sources & Evidence

### Slack App Manifest

- [Configuring apps with app manifests | Slack Developer Docs](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/) — URL format `?new_app=1&manifest_yaml=...` confirmed
- [App manifest reference | Slack Developer Docs](https://docs.slack.dev/reference/app-manifest/) — Complete manifest schema: display_information, settings, features, oauth_config sections
- [apps.manifest.create method | Slack Developer Docs](https://docs.slack.dev/reference/methods/apps.manifest.create/) — Programmatic app creation API

### VS Code Walkthroughs

- [Contribution Points | Visual Studio Code Extension API](https://code.visualstudio.com/api/references/contribution-points) — `contributes.walkthroughs` specification, completionEvents, media types

### Raycast Extension Onboarding

- [Prepare an Extension for Store | Raycast API](https://developers.raycast.com/basics/prepare-an-extension-for-store) — README requirement, "About This Extension" button, screenshot specs (2000x1250, 6 max)
- [Preferences | Raycast API](https://developers.raycast.com/api-reference/preferences) — `required: true` preference gate

### Home Assistant

- [Documentation structure and example text | Home Assistant Developer Docs](https://developers.home-assistant.io/docs/documenting/integration-docs-examples/) — Full component list: `{% details %}`, My links, inline icons, embedded video, config blocks
- [Config flow | Home Assistant Developer Docs](https://developers.home-assistant.io/docs/config_entries_config_flow_handler/) — `strings.json` per-field `data_description` pattern

### n8n

- [Credentials files | n8n Docs](https://docs.n8n.io/integrations/creating-nodes/build/reference/credentials-files/) — `documentationUrl` field in credential type, resolves to docs.n8n.io path
- [Credentials library | n8n Docs](https://docs.n8n.io/integrations/builtin/credentials/) — Per-credential documentation page structure

### Heroku Deploy Button

- [Creating a 'Deploy to Heroku' Button | Heroku Dev Center](https://devcenter.heroku.com/articles/heroku-button) — URL format, `env[NAME]=value` pre-population, `app.json` `generator: "secret"` concept

### GitHub Apps

- [About the setup URL | GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url) — Post-install redirect, `installation_id` parameter, "Redirect on update" option

### Grafana

- [Plugin management | Grafana documentation](https://grafana.com/docs/grafana/latest/administration/plugin-management/) — Plugin setup; datasource plugin UI is plugin-owned React component

### Existing DorkOS Research (Incorporated)

- `research/20260227_adapter_catalog_patterns.md` — `ConfigField[]` descriptor, `AdapterManifest`, `setupSteps[]`, `setupInstructions` (existing design this report extends)
- `research/20260311_adapter_binding_configuration_ux_patterns.md` — Multi-step wizard, progressive disclosure, Stripe/Home Assistant patterns

---

## Research Gaps & Limitations

- **Obsidian plugin setup patterns**: The Obsidian `obsidian://` deep link URI scheme was researched but no established pattern for plugin setup guides was found. Obsidian plugins do not have a dedicated onboarding screen — they rely entirely on their settings tab UI and external documentation. The `obsidian://open?vault=...` URL scheme opens files/vaults but is not used for plugin setup flows.
- **Grafana datasource plugin UI**: Grafana's datasource configuration UI is rendered by the plugin's own React component, not a generic form. The plugin provides its own setup instructions within its configuration page. Grafana does not have a generic "setup instructions" field in `plugin.json`. This reinforces the DorkOS decision to use the `ConfigField[]` generic form approach rather than plugin-owned UIs.
- **Netlify Deploy button `fullConfiguration=true` parameter**: Netlify has an additional URL parameter that enables an extra configuration step (choosing site name, installing extensions). This was noted as an analogue to DorkOS's multi-step wizard but not researched in depth.
- **Zapier Integration Documentation**: Zapier's "How to Connect" integration documentation pattern for third-party services was not confirmed in detail. Zapier appears to use externally hosted documentation pages per integration, similar to n8n's model.
- **Video tutorials as embedded content**: Home Assistant's documentation supports embedded YouTube videos via `lite-YouTube`. Whether this is practical for DorkOS adapter setup instructions (which are in-app, not documentation site) was not evaluated. Likely out of scope for v1.

---

## Contradictions & Disputes

- **Inline instructions vs external docs**: Raycast surfaces instructions in a modal viewer (README); n8n links to docs.n8n.io externally; VS Code renders instructions inline in the walkthrough panel. The correct choice for DorkOS depends on complexity: simple adapters (Telegram, Webhook) should use inline Markdown in the wizard; complex adapters (Slack with its multi-step app creation flow) may warrant an external docs link or a richer step-by-step wizard.
- **One-click create vs manual setup**: The Slack manifest URL approach is powerful but creates an implicit dependency: if Slack changes the manifest format or URL parameters, the one-click button breaks. For v1, a simpler approach — showing a direct link to `https://api.slack.com/apps/new` with instructions nearby — may be more maintainable. The manifest URL can be added later when the manifest is stable.
- **Required field gating**: Raycast blocks command execution for unfilled required preferences. VS Code walkthroughs do not block extension usage. The right choice for DorkOS is field-level validation (can't save the adapter without required fields) but not wizard-level blocking (the user can navigate away and return later).

---

## Search Methodology

- Searches performed: 15
- Pages fetched: 8
- Most productive search terms: "Slack app manifest URL pre-populate new_app manifest_yaml", "VS Code extension walkthrough getting started contribution points", "Raycast extension README About This Extension preferences onboarding", "Heroku deploy button app.json env pre-populate URL parameter"
- Primary information sources: Slack Developer Docs, VS Code Extension API Reference, Raycast Developer Docs, Home Assistant Developer Docs, n8n Docs, Heroku Dev Center, GitHub Docs
- Existing DorkOS research heavily leveraged to avoid re-covering ConfigField, AdapterManifest, and wizard architecture already documented in prior reports

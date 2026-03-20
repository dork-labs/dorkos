---
slug: adapter-setup-experience
number: 128
created: 2026-03-14
status: specification
authors: Claude Code
ideation: specs/adapter-setup-experience/01-ideation.md
research: research/20260314_plugin_integration_setup_docs_patterns.md
---

# Adapter Setup Experience

## Status

Specification

## Overview

Enhance the adapter setup wizard with a layered documentation system: (1) one-click Slack App creation via manifest URL, (2) per-field help disclosures with `helpMarkdown`, (3) adapter docs folder with setup guide panel, and (4) markdown rendering for setup instructions. Implemented across all three existing adapters (Slack, Telegram, Webhook).

The current setup wizard has a small info box that renders plain text -- inadequate for complex adapters like Slack, where users need detailed multi-step guidance with links, formatting, and contextual help.

## Background / Problem Statement

During live testing of the Slack adapter setup, we discovered that:

1. **Setup instructions render as plain text** -- `ConfigureStep.tsx` uses `<p>{manifest.setupInstructions}</p>`, losing all formatting (links, bold, lists, code)
2. **The info box is too small** for complex adapters -- Slack requires navigating multiple pages (Socket Mode, Event Subscriptions, OAuth, App-Level Tokens) with critical pitfalls (the "Agents & AI Apps" feature silently adds user scopes that cause `invalid_scope` errors)
3. **No contextual help per field** -- users must read the full setup instructions to find where each credential lives (e.g., Bot Token is on OAuth & Permissions, Signing Secret is on Basic Information)
4. **Slack app creation is error-prone** -- users must manually configure scopes, socket mode, and events, any of which can be misconfigured

Research at `research/20260314_plugin_integration_setup_docs_patterns.md` analyzed setup patterns across VS Code walkthroughs, Raycast, Home Assistant, n8n, Heroku, and Slack's own manifest URL system.

## Goals

- Users can set up any adapter without leaving the wizard for documentation
- Complex adapters (Slack) have one-click app creation that pre-fills all configuration
- Every credential field has contextual help explaining exactly where to find it
- Adapter developers author docs in real `.md` files with full IDE support
- Existing adapters without new fields continue working (backward compatible)
- Plugin adapter developers get the same documentation system via `getManifest()`

## Non-Goals

- Multi-file docs navigation (setup.md + troubleshooting.md + advanced.md) -- v1 is single file per adapter
- Video tutorials or embedded media
- OAuth redirect flows for automatic credential capture
- Plugin adapter marketplace or discovery
- Config migration system
- Interactive completion tracking (VS Code walkthrough `completionEvents` pattern)

## Technical Dependencies

- **streamdown** (^2.4.0) -- Already in client dependencies, used for chat message markdown rendering
- **@radix-ui/react-collapsible** -- Already installed, shadcn Collapsible component at `layers/shared/ui/collapsible.tsx`
- **@radix-ui/react-dialog** -- Already installed, shadcn Sheet component at `layers/shared/ui/sheet.tsx`
- **Slack App Manifest URL** -- `https://api.slack.com/apps?new_app=1&manifest_yaml=<encoded>` (confirmed in research)

## Related ADRs

- **ADR-0044** -- ConfigField Descriptor Over Zod Serialization (defines the ConfigField pattern we're extending)
- **ADR-0045** -- Adapters Self-Declare Metadata via AdapterManifest (merged into 0044; establishes manifest self-declaration pattern)
- **ADR-0030** -- Dynamic Import for Adapter Plugins (relevant for plugin adapter docs loading)
- **ADR-0109** -- Optional BaseRelayAdapter Abstract Class (establishes adapter DX patterns)

## Detailed Design

### 1. Schema Extensions

**File:** `packages/shared/src/relay-adapter-schemas.ts`

Add two new optional fields:

```typescript
// Add to ConfigFieldSchema (after 'displayAs'):
helpMarkdown: z.string().optional(),

// Add to AdapterManifestSchema (after 'setupInstructions'):
setupGuide: z.string().optional(),
```

Both fields are optional strings containing markdown content. The `helpMarkdown` field on ConfigField provides per-field contextual help. The `setupGuide` field on AdapterManifest provides a full setup guide rendered in a side panel.

**Type exports** -- The inferred types (`ConfigField`, `AdapterManifest`) automatically include the new fields via Zod inference. No manual type updates needed.

### 2. Markdown Rendering for Setup Content

**Problem:** The codebase uses `streamdown` for chat messages via `StreamingText`, but that component includes chat-specific features (streaming cursor, link safety modal). Setup content needs a simpler static markdown renderer.

**Solution:** Create a lightweight `MarkdownContent` component that wraps Streamdown for static (non-streaming) markdown rendering.

**File:** `apps/client/src/layers/shared/ui/markdown-content.tsx`

```typescript
/**
 * Static markdown renderer for non-chat content.
 *
 * Wraps streamdown's Streamdown component for rendering markdown
 * in setup guides, help disclosures, and info boxes. Unlike
 * StreamingText, this has no streaming cursor or link safety modal.
 */
import { Streamdown } from 'streamdown';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

export function MarkdownContent({ content, className }: MarkdownContentProps) {
  return (
    <div className={cn('prose prose-sm dark:prose-invert max-w-none', className)}>
      <Streamdown content={content} />
    </div>
  );
}
```

This component lives in the shared UI layer since it's a generic primitive usable by any feature.

### 3. Enhanced setupInstructions Rendering

**File:** `apps/client/src/layers/features/relay/ui/wizard/ConfigureStep.tsx`

**Current** (lines 40-45): Renders `setupInstructions` as plain `<p>` text in a blue info box.

**Change:** Replace the `<p>` tag with `<MarkdownContent>`:

```typescript
// Before:
<p>{manifest.setupInstructions}</p>

// After:
<MarkdownContent content={manifest.setupInstructions} className="text-sm text-blue-800 dark:text-blue-200" />
```

This enables links, bold, numbered lists, inline code in the info box with zero schema changes. The `setupInstructions` field is already a string.

### 4. Setup Guide Sheet Panel

**New file:** `apps/client/src/layers/features/relay/ui/SetupGuideSheet.tsx`

A slide-out Sheet from the right that renders the full `manifest.setupGuide` markdown content alongside the wizard dialog.

```typescript
/**
 * Slide-out setup guide panel for adapter configuration.
 *
 * Renders the adapter's setupGuide markdown content in a Sheet
 * that opens from the right side of the viewport, alongside the
 * wizard dialog. Triggered by a "Setup Guide" button in ConfigureStep.
 */
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/layers/shared/ui/sheet';
import { MarkdownContent } from '@/layers/shared/ui/markdown-content';
import { BookOpen } from 'lucide-react';

interface SetupGuideSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  content: string;
}

export function SetupGuideSheet({ open, onOpenChange, title, content }: SetupGuideSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[480px] overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <BookOpen className="size-4" />
            {title} Setup Guide
          </SheetTitle>
          <SheetDescription>
            Step-by-step instructions for configuring this adapter.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4">
          <MarkdownContent content={content} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

**Integration in ConfigureStep.tsx:**

Add a "Setup Guide" button next to the action button when `manifest.setupGuide` is present:

```typescript
{manifest.setupGuide && (
  <Button variant="outline" size="sm" onClick={() => setGuideOpen(true)}>
    <BookOpen className="mr-1.5 size-3.5" />
    Setup Guide
  </Button>
)}
```

**State management:** The `guideOpen` state lives in `AdapterSetupWizard.tsx` and is passed down to ConfigureStep. The `SetupGuideSheet` renders at the wizard level (not inside the Dialog) to avoid z-index conflicts.

### 5. Per-Field Help Disclosures

**File:** `apps/client/src/layers/features/relay/ui/ConfigFieldInput.tsx`

When `field.helpMarkdown` is present, render a collapsible "Where do I find this?" disclosure below the field description.

```typescript
import {
  Collapsible, CollapsibleTrigger, CollapsibleContent,
} from '@/layers/shared/ui/collapsible';
import { HelpCircle, ChevronDown } from 'lucide-react';

// Inside the field rendering, after the description <p> tag:
{field.helpMarkdown && (
  <Collapsible>
    <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-1">
      <HelpCircle className="size-3" />
      Where do I find this?
      <ChevronDown className="size-3 transition-transform [[data-state=open]_&]:rotate-180" />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div className="mt-2 rounded-md border bg-muted/50 p-3">
        <MarkdownContent
          content={field.helpMarkdown}
          className="text-xs"
        />
      </div>
    </CollapsibleContent>
  </Collapsible>
)}
```

**Design principles:**

- Collapsed by default -- zero visual noise for experts
- Trigger text is "Where do I find this?" -- action-oriented, not generic "Help"
- Content renders in a subtle bordered box below the field
- Markdown supports links, bold, code, numbered lists

### 6. Slack Manifest URL

**File:** `packages/relay/src/adapters/slack/slack-adapter.ts`

Generate a YAML manifest with all required configuration and URL-encode it as the `actionButton.url`:

```yaml
display_information:
  name: DorkOS Relay
settings:
  socket_mode_enabled: true
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - app_mention
features:
  bot_user:
    display_name: DorkOS Relay
    always_online: false
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - app_mentions:read
      - users:read
```

**Implementation:** Define the manifest as a string constant, URL-encode it, and construct the button URL:

```typescript
const SLACK_APP_MANIFEST_YAML = `display_information:
  name: DorkOS Relay
settings:
  socket_mode_enabled: true
  event_subscriptions:
    bot_events:
      - message.channels
      - message.groups
      - message.im
      - app_mention
features:
  bot_user:
    display_name: DorkOS Relay
    always_online: false
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - app_mentions:read
      - users:read`;

const SLACK_CREATE_APP_URL = `https://api.slack.com/apps?new_app=1&manifest_yaml=${encodeURIComponent(SLACK_APP_MANIFEST_YAML)}`;
```

Update the `actionButton`:

```typescript
actionButton: {
  label: 'Create Slack App',
  url: SLACK_CREATE_APP_URL,
},
```

**Critical:** Do NOT include `user` scopes in the manifest. The "Agents & AI Apps" feature in Slack silently adds user-level scopes that cause `invalid_scope` errors on most workspace plans.

### 7. Docs Content Loading

**File:** `apps/server/src/services/relay/adapter-manager.ts`

After `populateBuiltinManifests()` loads the static manifests, enrich them with docs content from disk:

```typescript
private async enrichManifestsWithDocs(): Promise<void> {
  for (const [type, manifest] of this.manifests) {
    if (manifest.setupGuide) continue; // Already has inline guide (plugin adapters)
    try {
      const docsPath = this.resolveAdapterDocsPath(type);
      const setupGuide = await readFile(
        path.join(docsPath, 'setup.md'),
        'utf-8',
      );
      this.manifests.set(type, { ...manifest, setupGuide });
    } catch {
      // No docs/setup.md -- that's fine, setupGuide stays undefined
    }
  }
}
```

**Resolving docs path:** For built-in adapters, docs are in the relay package's `dist/adapters/<type>/docs/`. The adapter-manager can resolve this relative to the relay package:

```typescript
private resolveAdapterDocsPath(adapterType: string): string {
  // Resolve from the relay package's dist directory
  const relayDistDir = path.dirname(
    require.resolve('@dorkos/relay/package.json'),
  );
  return path.join(relayDistDir, 'dist', 'adapters', adapterType, 'docs');
}
```

**Call site:** Add `await this.enrichManifestsWithDocs()` after `this.populateBuiltinManifests()` in the `initialize()` method.

**Plugin adapter docs:** The plugin loader in `adapter-plugin-loader.ts` already checks for `getManifest()`. If the returned manifest includes `setupGuide`, it's used directly. For plugins with docs files, the loader can check for a `docs/` directory relative to the plugin's resolved path.

### 8. Build Copy Step

**File:** `packages/relay/package.json`

Add a copy step after tsc to include `.md` files in the build output:

```json
{
  "scripts": {
    "build": "tsc && cp -r src/adapters/*/docs dist/adapters/ 2>/dev/null || true"
  }
}
```

**Why `cp -r` with `|| true`:** The copy may fail if an adapter doesn't have a `docs/` folder yet (the claude-code adapter has no docs). The `|| true` ensures the build doesn't fail.

**Alternative (more robust):** Use a small script:

```json
{
  "scripts": {
    "build": "tsc && node -e \"const{cpSync}=require('fs');const{globSync}=require('glob');globSync('src/adapters/*/docs').forEach(d=>cpSync(d,d.replace('src/','dist/'),{recursive:true}))\""
  }
}
```

**Simpler preferred approach:** Use shell globbing which is available on macOS and Linux:

```json
{
  "scripts": {
    "build": "tsc && for d in src/adapters/*/docs; do [ -d \"$d\" ] && mkdir -p \"${d/src/dist}\" && cp \"$d\"/*.md \"${d/src/dist}/\"; done"
  }
}
```

The turbo.json `outputs: ["dist/**"]` already caches the `dist/` directory including `.md` files. No turbo config changes needed.

### 9. Adapter Documentation Content

#### Slack (`packages/relay/src/adapters/slack/docs/setup.md`)

Content covers:

- **Quick Start** -- Click "Create Slack App" button (manifest URL) which pre-fills all settings
- **Manual Setup** (if user prefers or needs custom configuration):
  1. Create app at api.slack.com/apps (From Scratch, not From Manifest)
  2. Enable Socket Mode (Settings -> Socket Mode)
  3. Enable Event Subscriptions with bot events: `message.channels`, `message.groups`, `message.im`, `app_mention`
  4. Add bot token scopes under OAuth & Permissions (all 11 scopes listed)
  5. Install the app to workspace
  6. Copy Bot User OAuth Token (`xoxb-...`)
  7. Generate App-Level Token with `connections:write` scope
  8. Copy Signing Secret from Basic Information
- **Critical Warning** -- Do NOT enable "Agents & AI Apps" (adds user scopes causing `invalid_scope` errors)
- **Troubleshooting** -- Common errors: `invalid_scope` (user scopes present), `not_authed` (wrong token type), `missing_scope` (scope not added)

#### Telegram (`packages/relay/src/adapters/telegram/docs/setup.md`)

Content covers:

- **Create a Bot** -- Open Telegram, search for @BotFather, send `/newbot`, follow prompts
- **Get Your Token** -- Copy the token BotFather sends (format: `123456789:ABC...`)
- **Connection Modes** -- Polling (works everywhere, recommended for dev) vs Webhook (requires public HTTPS URL)
- **Webhook Setup** -- HTTPS requirement, self-signed cert limitations, DorkOS webhook endpoint format
- **Testing** -- Send a message to the bot, verify it appears in DorkOS

#### Webhook (`packages/relay/src/adapters/webhook/docs/setup.md`)

Content covers:

- **Overview** -- How inbound/outbound webhooks work in DorkOS Relay
- **Inbound Webhooks** -- Subject naming (`relay.webhook.<service>`), HMAC-SHA256 verification, request format
- **Outbound Webhooks** -- URL requirements, HMAC-SHA256 signing, custom headers
- **Secret Generation** -- How to generate secure HMAC secrets (e.g., `openssl rand -hex 32`)
- **Testing** -- curl examples for sending test inbound webhooks, expected response format

### 10. Per-Field helpMarkdown Content

#### Slack Config Fields

```typescript
// botToken
helpMarkdown: `1. Go to your [Slack App Settings](https://api.slack.com/apps)
2. Select your app
3. Navigate to **OAuth & Permissions** in the sidebar
4. Copy the **Bot User OAuth Token** (starts with \`xoxb-\`)`,

// appToken
helpMarkdown: `1. Go to your [Slack App Settings](https://api.slack.com/apps)
2. Select your app
3. Navigate to **Basic Information** in the sidebar
4. Scroll to **App-Level Tokens**
5. Click **Generate Token and Scopes**
6. Add the \`connections:write\` scope
7. Click **Generate** and copy the token (starts with \`xapp-\`)`,

// signingSecret
helpMarkdown: `1. Go to your [Slack App Settings](https://api.slack.com/apps)
2. Select your app
3. Navigate to **Basic Information** in the sidebar
4. Scroll to **App Credentials**
5. Click **Show** next to **Signing Secret** and copy it`,
```

#### Telegram Config Fields

```typescript
// token
helpMarkdown: `1. Open Telegram and search for **@BotFather**
2. Send \`/newbot\` to start creating a bot
3. Choose a display name and username for your bot
4. BotFather will send you the token (format: \`123456789:ABCDefGHijklMNOpqrSTUvwxYZ\`)
5. If you already have a bot, send \`/myBots\` to BotFather to find existing tokens`,

// webhookUrl
helpMarkdown: `Your webhook URL must be:
- **HTTPS** (Telegram requires TLS)
- **Publicly accessible** from the internet
- Pointing to: \`https://your-domain.com/relay/webhooks/telegram\`

For local development, use a tunnel service (e.g., ngrok, Cloudflare Tunnel).`,
```

#### Webhook Config Fields

```typescript
// inbound.secret
helpMarkdown: `Generate a secure random secret (minimum 16 characters):

\`\`\`bash
openssl rand -hex 32
\`\`\`

This secret is used to verify that incoming webhook requests are authentic. Share it with the service sending webhooks to your DorkOS instance.`,

// outbound.url
helpMarkdown: `The URL where DorkOS sends outbound messages. Requirements:
- Must accept **POST** requests with JSON body
- Should return **2xx** status for success
- Response body is ignored`,

// outbound.headers
helpMarkdown: `JSON object of custom HTTP headers sent with every outbound request. Example:

\`\`\`json
{
  "Authorization": "Bearer your-api-key",
  "X-Custom-Header": "value"
}
\`\`\`

Leave empty if no custom headers are needed.`,
```

## User Experience

### Setup Flow (Slack Example)

1. User opens Relay settings, clicks "Add Adapter", selects Slack
2. **Configure step** appears with:
   - Blue info box with **markdown-formatted** setup instructions (brief summary)
   - **"Create Slack App"** button -- opens Slack with pre-filled manifest
   - **"Setup Guide"** button -- opens side panel with full step-by-step guide
   - Three credential fields, each with:
     - Standard input/label/description
     - **"Where do I find this?"** collapsible with step-by-step instructions and links
3. User clicks "Create Slack App" -- Slack opens with correct scopes, socket mode, events
4. User installs app, copies tokens, pastes into form
5. If stuck on any field, expands the help disclosure for that specific field
6. If stuck on the overall process, opens the Setup Guide panel for the full walkthrough
7. Proceeds to Test step, then Confirm, then optional Bind

### Backward Compatibility

- Adapters without `setupGuide` -- no "Setup Guide" button appears
- Fields without `helpMarkdown` -- no collapsible appears
- `setupInstructions` still works as before, now rendered as markdown
- Plugin adapters that return manifests without new fields continue working

## Testing Strategy

### Unit Tests

**Schema tests** (`packages/shared/src/__tests__/relay-adapter-schemas.test.ts`):

- `setupGuide` field is optional and accepts string
- `helpMarkdown` field is optional and accepts string
- Manifests without new fields still validate (backward compat)
- Existing manifest fixtures still pass validation

**Manifest validation tests** (`packages/relay/src/__tests__/manifests.test.ts`):

- All built-in manifests pass schema validation after adding new fields
- Slack manifest URL is properly URL-encoded and starts with expected prefix

### Component Tests

**MarkdownContent** (`apps/client/src/layers/shared/ui/__tests__/markdown-content.test.tsx`):

- Renders markdown content (headings, lists, links, code)
- Handles empty string gracefully
- Applies className prop

**ConfigFieldInput** (extend existing tests):

- Field without helpMarkdown renders without collapsible
- Field with helpMarkdown renders collapsible trigger
- Clicking trigger expands help content
- Help content renders markdown (links, code blocks)

**SetupGuideSheet** (`apps/client/src/layers/features/relay/ui/__tests__/SetupGuideSheet.test.tsx`):

- Renders when open=true
- Hidden when open=false
- Displays title and markdown content
- Close button works

**ConfigureStep** (extend existing tests):

- setupInstructions renders as markdown (check for HTML output, not plain text)
- "Setup Guide" button visible when manifest.setupGuide present
- "Setup Guide" button hidden when manifest.setupGuide absent

### Integration Tests

**Docs loading** (`apps/server/src/services/relay/__tests__/adapter-manager.test.ts`):

- Built-in adapter manifests include setupGuide after initialization (when docs exist)
- Missing docs/setup.md results in undefined setupGuide (no error)
- Catalog API response includes setupGuide content

### Build Tests

- Verify `pnpm build` copies `.md` files to `dist/adapters/*/docs/`
- Verify `dist/` contains expected setup.md files after build

## Performance Considerations

- **Payload size:** `setupGuide` adds ~2-5 KB of markdown per adapter to the catalog API response. For 4 built-in adapters, this is ~20 KB total -- negligible compared to typical API responses.
- **Rendering:** Sheet content is lazily rendered (only when opened). Collapsible content is in the DOM but hidden. Markdown parsing happens on mount, not on every render.
- **Build time:** The copy step adds <1 second to the relay package build.
- **Server startup:** Reading 3-4 small `.md` files is <10ms and happens once during initialization.

## Security Considerations

- **Slack manifest URL** contains no secrets -- only scope/feature configuration that's public knowledge
- **Markdown content** from built-in adapters is trusted (it ships with the codebase)
- **Plugin adapter docs** could contain arbitrary markdown -- Streamdown should sanitize HTML by default, but verify no raw HTML injection is possible
- **External links** in markdown should open in new tabs with `rel="noopener noreferrer"` -- verify Streamdown handles this

## Documentation Updates

- **`contributing/relay-adapters.md`** -- Add section on adapter documentation: `docs/setup.md` convention, `setupGuide` field, `helpMarkdown` on ConfigField, build copy step
- **`contributing/adapter-catalog.md`** -- Update ConfigField reference table with `helpMarkdown` field, update AdapterManifest reference with `setupGuide` field

## Implementation Phases

### Phase 1: Schema & Markdown Rendering Foundation

1. Add `setupGuide` to AdapterManifestSchema and `helpMarkdown` to ConfigFieldSchema
2. Create `MarkdownContent` shared component
3. Upgrade `setupInstructions` rendering from plain text to markdown in ConfigureStep
4. Update schema tests

### Phase 2: Setup Guide Panel & Per-Field Help

5. Create `SetupGuideSheet` component
6. Integrate Sheet into `AdapterSetupWizard` (state management, button in ConfigureStep)
7. Add per-field help disclosure (Collapsible) in `ConfigFieldInput`
8. Component tests for Sheet and Collapsible

### Phase 3: Build Pipeline & Docs Loading

9. Add build copy step to `packages/relay/package.json`
10. Add docs enrichment to `adapter-manager.ts` (`enrichManifestsWithDocs`)
11. Update plugin loader to check for docs in plugin packages
12. Integration tests for docs loading

### Phase 4: Adapter Content & Manifest URL

13. Generate Slack manifest YAML and construct manifest URL
14. Update Slack `actionButton` with manifest URL
15. Write `docs/setup.md` for Slack adapter
16. Write `docs/setup.md` for Telegram adapter
17. Write `docs/setup.md` for Webhook adapter
18. Add `helpMarkdown` to all config fields across three adapters

### Phase 5: Documentation & Polish

19. Update `contributing/relay-adapters.md` with docs convention
20. Update `contributing/adapter-catalog.md` with new fields
21. Verify all adapters render correctly in the wizard
22. Verify backward compatibility with adapters missing new fields

## Open Questions

_None -- all decisions resolved during ideation._

## References

- [Ideation document](../adapter-setup-experience/01-ideation.md)
- [Research: Plugin Integration Setup Docs Patterns](../../research/20260314_plugin_integration_setup_docs_patterns.md)
- [Configuring apps with app manifests | Slack Developer Docs](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)
- [App manifest reference | Slack Developer Docs](https://docs.slack.dev/reference/app-manifest/)
- [Contribution Points: Walkthroughs | VS Code API](https://code.visualstudio.com/api/references/contribution-points)
- [ADR-0044: ConfigField Descriptor Over Zod Serialization](../../decisions/0044-configfield-descriptor-over-zod-serialization.md)
- [ADR-0109: Optional BaseRelayAdapter Abstract Class](../../decisions/0109-optional-base-relay-adapter-class.md)

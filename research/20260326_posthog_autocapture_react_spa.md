---
title: 'PostHog Autocapture Best Practices for React SPAs'
date: 2026-03-26
type: external-best-practices
status: active
tags: [posthog, analytics, autocapture, react, tanstack-router, vite, privacy, tracking]
searches_performed: 16
sources_count: 22
---

# PostHog Autocapture Best Practices for React SPAs

## Research Summary

PostHog provides a layered analytics model for React SPAs: autocapture handles clicks, form interactions, and page navigation with zero instrumentation code, while `posthog.capture()` fills in the state-change events autocapture cannot see (dialog opened, tab changed, etc.). The recommended approach for Vite + React 19 + TanStack Router is to use the `@posthog/react` `PostHogProvider`, enable `capture_pageview: 'history_change'` via the `defaults` parameter, annotate elements with `data-ph-capture-attribute-*` for contextual metadata, add `ph-no-capture` to high-noise or sensitive areas, and instrument meaningful UI state changes with focused `posthog.capture()` calls.

---

## Key Findings

1. **Autocapture scope is broad but configurable** — by default it captures clicks, form changes, and submissions on `a`, `button`, `form`, `input`, `select`, `textarea`, and `label` tags plus `$pageview`/`$pageleave`. Every captured element includes its CSS classes, `data-attr`, tag name, text content, and parent context as event properties.

2. **SPA pageview tracking requires explicit opt-in** — without `capture_pageview: 'history_change'`, only the initial page load fires a `$pageview`. The modern fix is a single `defaults: '2026-01-30'` init option; no router listener code is needed for the `history_change` mode. For TanStack Router, the `beforeLoad` hook is a reliable fallback if you want manual control.

3. **`data-ph-capture-attribute-*` is the canonical enrichment pattern** — any `data-ph-capture-attribute-{key}="{value}"` on an element (or any ancestor) becomes `{key}: value` on the autocapture event. `data-attr` is the PostHog-recommended stable identifier for targeting elements in Actions.

4. **Custom `posthog.capture()` is the only way to track UI state changes** — autocapture fires on DOM interactions, not React state transitions. Dialog opens, tab switches, accordion expansions, and modal closes must be explicit captures.

5. **Privacy defaults are conservative but incomplete** — password and credit card fields are automatically excluded; everything else is opt-out via `ph-no-capture` class or `element_attribute_ignorelist`. `mask_all_text: true` (or session-replay masking) is needed for high-privacy contexts.

6. **Over-instrumentation is the primary anti-pattern** — PostHog's own guidance is to start with autocapture + a handful of business-critical custom events, then add more as analysis reveals gaps. Capturing every UI micro-interaction creates noise that degrades funnel quality.

---

## Detailed Analysis

### 1. Autocapture — What It Captures

PostHog autocapture instruments the DOM directly and fires events for:

| Interaction              | Event name     | Default elements                                              |
| ------------------------ | -------------- | ------------------------------------------------------------- |
| Click                    | `$autocapture` | `a`, `button`, `form`, `input`, `select`, `textarea`, `label` |
| Input change             | `$autocapture` | `input`, `select`, `textarea`                                 |
| Form submit              | `$autocapture` | `form`                                                        |
| Copy to clipboard        | `$autocapture` | any                                                           |
| Rage click (3+ in 1 sec) | `$rageclick`   | any                                                           |
| Page load                | `$pageview`    | —                                                             |
| Page exit                | `$pageleave`   | —                                                             |

Each `$autocapture` event includes these properties automatically:

- `$event_type` — `click`, `change`, `submit`
- `$el_text` — visible text content of the element
- `$elements` — array of the element and up to 5 ancestors, each with tag name, classes, `data-attr`, `id`, `href`, `nth-child` index
- `$current_url`, `$host`, `$pathname`
- Any `data-ph-capture-attribute-*` values from the element or ancestors

**Disabling autocapture does NOT stop `$pageview`/`$pageleave`** — those are controlled separately by `capture_pageview` and `capture_pageleave`.

### 2. `data-*` Attributes for Element Identification

#### `data-attr` — Stable Element Identity

Add `data-attr` to any interactive element to give it a stable, readable identifier that survives class and layout changes:

```tsx
// PostHog uses data-attr as the primary identity key in $elements
<button data-attr="start-agent-btn">Start agent</button>
<a data-attr="nav-agents-link" href="/agents">Agents</a>
<input data-attr="filter-search-input" />
```

In the PostHog UI, `data-attr` appears as the "attribute" field when defining Actions. It is far more reliable than CSS class selectors (especially with Tailwind where class names are unstable).

**Naming convention:** `{component-context}-{element-role}` in kebab-case. Examples:

- `data-attr="agent-card-start-btn"`
- `data-attr="filter-bar-status-select"`
- `data-attr="session-header-stop-btn"`

#### `data-ph-capture-attribute-*` — Contextual Metadata

Use `data-ph-capture-attribute-{key}="{value}"` to attach arbitrary properties to any autocapture event from that element or its descendants:

```tsx
// Autocapture click includes: { "agent-id": "abc123", "agent-status": "idle" }
<button
  data-attr="agent-card-start-btn"
  data-ph-capture-attribute-agent-id={agent.id}
  data-ph-capture-attribute-agent-status={agent.status}
>
  Start
</button>
```

The attribute names after `data-ph-capture-attribute-` become property keys on the event, with hyphens preserved. This can also be placed on a container element to enrich all clicks within it:

```tsx
// All clicks inside this card get agent_id and project_slug attached
<div
  data-ph-capture-attribute-agent-id={agent.id}
  data-ph-capture-attribute-project-slug={project.slug}
>
  <button data-attr="start-btn">Start</button>
  <button data-attr="stop-btn">Stop</button>
</div>
```

**Property naming convention:** Use `kebab-case` in the attribute (it becomes the property key as-is). Keep names readable and specific: `agent-id`, `filter-type`, `unread-count`, not `id`, `type`, `n`.

### 3. Custom Events for UI State Changes

Autocapture only fires on DOM events (clicks, inputs). React state transitions — dialog opening, tab switching, accordion toggling — are invisible to it. Use `posthog.capture()` for these.

#### Pattern: `usePostHog()` hook in event handlers

```tsx
import { usePostHog } from '@posthog/react';

function AgentFilterBar() {
  const posthog = usePostHog();

  const handleTabChange = (tab: string) => {
    posthog.capture('filter_tab_changed', {
      tab_name: tab,
      previous_tab: activeTab,
    });
    setActiveTab(tab);
  };

  const handleDialogOpen = (dialogName: string) => {
    posthog.capture('dialog_opened', {
      dialog_name: dialogName,
    });
  };

  // ...
}
```

#### Pattern: Extract into a custom hook for reuse

```tsx
// layers/shared/lib/use-track.ts
import { usePostHog } from '@posthog/react';
import { useCallback } from 'react';

export function useTrack() {
  const posthog = usePostHog();
  return useCallback(
    (event: string, properties?: Record<string, unknown>) => {
      posthog?.capture(event, properties);
    },
    [posthog]
  );
}
```

```tsx
// In any component
const track = useTrack();

const onDialogOpen = () => {
  track('session_detail_opened', { session_id: session.id });
  setOpen(true);
};
```

#### Events worth capturing manually

Focus on state changes that represent meaningful user intent — not every micro-interaction:

| UI event           | Event name         | Key properties                |
| ------------------ | ------------------ | ----------------------------- |
| Dialog opened      | `dialog_opened`    | `dialog_name`                 |
| Tab changed        | `tab_changed`      | `tab_name`, `previous_tab`    |
| Filter applied     | `filter_applied`   | `filter_type`, `filter_value` |
| Accordion expanded | `section_expanded` | `section_name`                |
| Search performed   | `search_performed` | `query`, `results_count`      |
| Agent started      | `agent_started`    | `agent_id`, `project_slug`    |
| Session viewed     | `session_viewed`   | `session_id`, `duration`      |

Skip: tooltip shown, dropdown opened (unless business-critical), hover states, focus events.

#### Event naming convention

PostHog recommends `[object]_[verb]` in `snake_case`, present tense:

- `agent_start` not `agent_was_started` or `StartAgent`
- `filter_apply` not `applied_filter`
- `session_view` not `SessionViewed`

For property names use `noun_adjective`: `agent_id`, `session_duration_ms`, `filter_count`, `is_active`, `has_errors`.

### 4. Autocapture Configuration

Full `AutocaptureConfig` interface with all options:

```typescript
posthog.init('<token>', {
  api_host: 'https://us.i.posthog.com',
  defaults: '2026-01-30', // Enables history_change pageview mode

  autocapture: {
    // Only capture on these URL patterns (regex supported)
    url_allowlist: ['https://app.example.com/.*'],

    // Never capture on these URLs
    url_ignorelist: ['https://app.example.com/admin/.*'],

    // Only fire for these DOM event types
    dom_event_allowlist: ['click'], // skip 'change', 'submit' if noisy

    // Only capture these HTML element types
    element_allowlist: ['button', 'a'], // restrict from default broad set

    // Only capture elements matching these CSS selectors
    // Use this to OPT-IN rather than capturing everything
    css_selector_allowlist: ['[data-attr]', '[ph-capture]'],

    // Strip these attributes from captured element data
    element_attribute_ignorelist: ['aria-label', 'data-sensitive-id'],

    // Capture clipboard copy events (default: false)
    capture_copied_text: false,
  },
});
```

**The `css_selector_allowlist` strategy** is the most focused approach for production: only elements with explicit `[data-attr]` annotations get autocaptured. This turns autocapture from "capture everything" into "capture explicitly annotated elements":

```typescript
autocapture: {
  css_selector_allowlist: ['[data-attr]'],
}
```

**Key standalone config options:**

```typescript
posthog.init('<token>', {
  // Pageview strategy:
  capture_pageview: 'history_change', // best for SPAs; or true/false
  capture_pageleave: true, // default; set false to reduce events

  // Privacy:
  mask_all_text: false, // true = no text content in autocapture events

  // Session recording:
  disable_session_recording: false, // or true to turn off

  // Disable ALL interaction capture (pageviews still fire):
  autocapture: false,
});
```

### 5. React-Specific Patterns

#### Provider Setup (Vite + React 19)

```tsx
// apps/client/src/main.tsx or App.tsx
import posthog from 'posthog-js';
import { PostHogProvider } from '@posthog/react';

posthog.init(import.meta.env.VITE_POSTHOG_KEY, {
  api_host: import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com',
  defaults: '2026-01-30', // enables history_change + other current defaults
  capture_pageview: 'history_change',
  capture_pageleave: true,
  autocapture: {
    css_selector_allowlist: ['[data-attr]'], // only annotated elements
  },
  loaded: (ph) => {
    if (import.meta.env.DEV) {
      // Silence in dev, or opt out entirely
      ph.opt_out_capturing();
    }
  },
});

export function App() {
  return <PostHogProvider client={posthog}>{/* rest of your app */}</PostHogProvider>;
}
```

**Environment variables** — in Vite, prefix with `VITE_` to expose to the client:

```
VITE_POSTHOG_KEY=phc_xxxxxxxxxxxx
VITE_POSTHOG_HOST=https://us.i.posthog.com
```

#### Pageview Tracking with TanStack Router

**Option A (recommended): `defaults: '2026-01-30'` with `history_change`**

The `defaults` parameter enables `capture_pageview: 'history_change'` which hooks into `window.history.pushState/replaceState`. This works transparently with TanStack Router's client-side navigation — no router code needed.

```tsx
posthog.init(token, {
  defaults: '2026-01-30', // history_change is included in this snapshot
});
```

**Option B: TanStack Router `beforeLoad` hook**

For explicit control, capture `$pageview` in the root route's `beforeLoad`:

```tsx
// router.tsx
import { createRootRoute } from '@tanstack/react-router';
import posthog from 'posthog-js';

const rootRoute = createRootRoute({
  beforeLoad: (ctx) => {
    posthog.capture('$pageview', {
      $current_url: window.location.href,
      path: ctx.location.pathname,
    });
  },
});
```

**Option C: Route-aware component**

A dedicated component that watches TanStack Router's location and fires pageviews:

```tsx
// layers/shared/lib/posthog-page-tracker.tsx
import { useEffect } from 'react';
import { useLocation } from '@tanstack/react-router';
import { usePostHog } from '@posthog/react';

export function PostHogPageTracker() {
  const posthog = usePostHog();
  const location = useLocation();

  useEffect(() => {
    posthog?.capture('$pageview', {
      $current_url: window.location.href,
    });
  }, [location.pathname, location.search]);

  return null;
}
```

Then render it once inside the router outlet at the root layout level. Note: if using Option A (`history_change`), you do NOT want this component — it will double-count pageviews.

#### Excluding Dev/Test Traffic

```typescript
loaded: (ph) => {
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    ph.opt_out_capturing();
  }
};
```

Or filter by email domain in PostHog's team settings (Properties → filter `$geoip_country_code` or email contains `@yourcompany.com`).

### 6. User Identification and Group Analytics

#### Identify on login

```typescript
// Call immediately after successful authentication
posthog.identify(user.id, {
  // $set — mutable properties, updated every time
  email: user.email,
  name: user.name,
  plan: user.subscription.plan,
  // $set_once — immutable, only written on first identify
  initial_referrer: document.referrer,
  signup_date: user.createdAt,
});
```

Rules:

- Use your backend's stable unique ID (UUID, database ID), not email alone
- Never use `"anonymous"`, `"guest"`, `"undefined"` as distinct IDs — PostHog rejects these
- Call `identify` before the first meaningful event after login, not after every event
- The JS SDK is stateful: once identified, all subsequent events automatically include the user ID

#### `$set` vs `$set_once`

```typescript
// Use in posthog.capture() to update person properties alongside an event
posthog.capture('settings_saved', {
  $set: { plan: 'pro', notification_preference: 'email' },
  $set_once: { first_settings_save_date: new Date().toISOString() },
});
```

- `$set` — overwrites existing value; use for mutable state (plan, email, name)
- `$set_once` — no-op if property already exists; use for first-occurrence data

#### Group analytics

```typescript
// Associate session with a group (e.g., workspace or organization)
posthog.group('workspace', workspace.id, {
  name: workspace.name,
  created_at: workspace.createdAt,
  agent_count: workspace.agents.length,
});

// All subsequent events in this session automatically include workspace group
```

The JS SDK is session-scoped: call `group()` once after login/workspace-switch; you don't need to pass group info with every `capture()`.

#### Reset on logout

```typescript
// Always call this on logout to prevent session bleed between users
const handleLogout = () => {
  posthog.reset(); // Clears identification and starts new anonymous session
  // Navigate to login...
};
```

**Super properties** — attach to every event globally for the session:

```typescript
// Set once after identifying, persists through the session
posthog.register({
  app_version: import.meta.env.VITE_APP_VERSION,
  deployment_env: import.meta.env.MODE,
});

// Clear when no longer relevant
posthog.unregister('app_version');
```

### 7. Privacy Configuration

#### Elements automatically excluded

PostHog's SDK automatically excludes these fields even with autocapture enabled:

- `input[type="password"]`
- Credit card number fields (heuristic detection)
- OTP / verification code fields
- Elements PostHog detects as PII-sensitive via heuristics

#### Opt-out via class names

```html
<!-- Exclude a specific element -->
<input class="ph-no-capture" data-attr="api-key-display" />

<!-- Exclude an entire section — all children are excluded too -->
<div class="ph-no-capture">
  <form>...</form>
</div>
```

Add `ph-no-capture` to:

- Navigation bars (high-volume clicks with low signal)
- Admin-only sections
- Any element showing API keys, tokens, or secrets
- Rich text editors / code editors (captures sensitive content)

#### Text and input masking

```typescript
posthog.init(token, {
  // Prevent any text content from being included in autocapture event properties
  mask_all_text: true,

  // Session replay specific (different from autocapture masking):
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: '.ph-mask, [data-sensitive]',
    blockSelector: '.ph-block, [data-ph-block]',
  },
});
```

**`mask_all_text: true`** strips `$el_text` from all autocapture events — recommended if users type arbitrary content that may appear as button/link text in your UI.

#### Element attribute exclusions

```typescript
autocapture: {
  // Strip these attributes from captured element data
  // Use to prevent IDs or attributes containing PII from being recorded
  element_attribute_ignorelist: [
    'data-user-email',
    'data-api-key',
    'aria-label',  // if labels contain user data
  ],
}
```

### 8. What NOT to Do — Anti-Patterns

#### Anti-pattern: Capturing every click manually

```typescript
// BAD — autocapture already handles this
<button onClick={() => {
  posthog.capture('button_clicked', { button: 'Save' })
  handleSave()
}}>
  Save
</button>
```

Use autocapture + `data-attr` instead. Reserve `posthog.capture()` for semantic state changes that have no DOM-event equivalent.

#### Anti-pattern: Event names with unstable identifiers

```typescript
// BAD — contains database ID; can't aggregate across users
posthog.capture('agent_abc123_started');

// GOOD — clean name, ID goes in properties
posthog.capture('agent_started', { agent_id: 'abc123' });
```

#### Anti-pattern: Stuffing data into the event name

```typescript
// BAD — impossible to query; breaks funnels
posthog.capture('filter_applied_status_running_project_myapp');

// GOOD
posthog.capture('filter_applied', {
  filter_type: 'status',
  filter_value: 'running',
  project_slug: 'myapp',
});
```

#### Anti-pattern: Calling `identify()` without a stable ID

```typescript
// BAD — email can change; merge issues arise
posthog.identify(user.email);

// GOOD — use internal UUID or database ID
posthog.identify(user.id, { email: user.email });
```

#### Anti-pattern: Using autocapture-only for business metrics

PostHog's own docs note: "Many users have tracking disabled or blocked on their browsers." For events that represent business outcomes (agent created, subscription started), use server-side `posthog-node` capture in addition to client-side, or instead of it. Frontend analytics are best-effort.

#### Anti-pattern: Not calling `reset()` on logout

Shared-device scenarios will merge multiple users into one PostHog person profile. Always call `posthog.reset()` on logout.

#### Anti-pattern: Tracking internal users

Without filtering, dev/staging traffic pollutes production analytics. Use the `loaded` callback to opt out in development:

```typescript
loaded: (ph) => {
  if (import.meta.env.DEV) ph.opt_out_capturing();
};
```

And filter internal team emails in PostHog's project settings.

#### Anti-pattern: Registering super properties that contain user PII

```typescript
// BAD — PII in every single event forever
posthog.register({ user_email: user.email });

// GOOD — PII in the person profile via identify(), not super props
posthog.identify(user.id, { email: user.email });
posthog.register({ user_plan: user.plan }); // non-PII super prop is fine
```

---

## Recommended Init Template for DorkOS Client

```typescript
// apps/client/src/lib/posthog.ts
import posthog from 'posthog-js';

const key = import.meta.env.VITE_POSTHOG_KEY;
const host = import.meta.env.VITE_POSTHOG_HOST ?? 'https://us.i.posthog.com';

if (key) {
  posthog.init(key, {
    api_host: host,

    // SPA pageview via history API — works with TanStack Router
    defaults: '2026-01-30',
    capture_pageview: 'history_change',
    capture_pageleave: true,

    // Only autocapture elements with data-attr annotation
    autocapture: {
      css_selector_allowlist: ['[data-attr]'],
      element_attribute_ignorelist: ['data-api-key', 'data-token'],
    },

    // Strip text in autocaptured events (agents may render user content)
    mask_all_text: true,

    loaded: (ph) => {
      if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
        ph.opt_out_capturing();
      }
    },
  });
}

export { posthog };
```

```tsx
// apps/client/src/main.tsx
import { PostHogProvider } from '@posthog/react';
import { posthog } from '@/lib/posthog';

createRoot(document.getElementById('root')!).render(
  <PostHogProvider client={posthog}>
    <RouterProvider router={router} />
  </PostHogProvider>
);
```

---

## Sources & Evidence

- PostHog autocapture documentation: [Autocapture - Docs - PostHog](https://posthog.com/docs/product-analytics/autocapture)
- React SDK docs: [React - Docs - PostHog](https://posthog.com/docs/libraries/react)
- SPA pageview tracking tutorial: [Tracking pageviews in single-page apps (SPA)](https://posthog.com/tutorials/single-page-app-pageviews)
- TanStack Start integration: [TanStack Start - Docs - PostHog](https://posthog.com/docs/libraries/tanstack-start)
- JS configuration reference: [JavaScript web configuration - Docs - PostHog](https://posthog.com/docs/libraries/js/config)
- `AutocaptureConfig` type reference: [AutocaptureConfig - PostHog](https://posthog.com/docs/references/posthog-js/types/AutocaptureConfig)
- `PostHogConfig` type reference: [PostHogConfig - PostHog](https://posthog.com/docs/references/posthog-js/types/PostHogConfig)
- Data collection / privacy controls: [Controlling data collection - Docs - PostHog](https://posthog.com/docs/privacy/data-collection)
- Session replay privacy: [Privacy controls - Docs - PostHog](https://posthog.com/docs/session-replay/privacy)
- User identification: [Identifying users - Docs - PostHog](https://posthog.com/docs/product-analytics/identify)
- Group analytics: [Group analytics - Docs - PostHog](https://posthog.com/docs/product-analytics/group-analytics)
- Capturing events: [Capturing events - Docs - PostHog](https://posthog.com/docs/product-analytics/capture-events)
- Event tracking guide: [Complete guide to event tracking - PostHog](https://posthog.com/tutorials/event-tracking-guide)
- Best practices: [Product analytics best practices - Docs - PostHog](https://posthog.com/docs/product-analytics/best-practices)
- Naming conventions: [Best Practices Naming Convention for Event Names & Properties](https://posthog.com/questions/best-practices-naming-convention-for-event-names-and-properties)
- Fewer unwanted events: [How to capture fewer unwanted events - PostHog](https://posthog.com/tutorials/fewer-unwanted-events)
- Autocapture analysis blog: [Is autocapture 'still' bad? - PostHog](https://posthog.com/blog/is-autocapture-still-bad)
- CSS selectors for Actions: [Creating actions using CSS selectors - PostHog](https://posthog.com/tutorials/css-selectors-for-actions)
- TanStack Router discussion: [Is it best practice to do page view tracking in beforeLoad?](https://github.com/TanStack/router/discussions/994)
- How to analyze autocapture with SQL: [How to analyze autocapture events with SQL - PostHog](https://posthog.com/tutorials/hogql-autocapture)

## Research Gaps & Limitations

- PostHog's website serves CSS bundles when fetched as a browser would, making direct page extraction unreliable. Most content was gathered from GitHub source files and search result excerpts.
- The `defaults: '2026-01-30'` snapshot content is not fully documented publicly — the specific feature flags it enables beyond `history_change` are not enumerated. Always verify the current recommended date string from PostHog docs.
- TanStack Router (without Start/SSR) has no official PostHog integration guide — the TanStack Start docs are the closest proxy. The `beforeLoad` and `history_change` approaches both work.
- PostHog's `session_recording` masking options (`maskAllInputs`, `maskTextSelector`) are distinct from autocapture masking (`mask_all_text`) and are configured in a nested `session_recording` object — exact schema was not fully verified against the current SDK version.

## Search Methodology

- Searches performed: 16
- Most productive search terms: `PostHog autocapture AutocaptureConfig`, `PostHog data-ph-capture-attribute element identification`, `PostHog TanStack Router pageview tracking`, `PostHog fewer unwanted events`, `PostHog identify $set $set_once reset logout`
- Primary information sources: posthog.com documentation, PostHog GitHub (posthog.com repo MDX files), TanStack Router GitHub discussions

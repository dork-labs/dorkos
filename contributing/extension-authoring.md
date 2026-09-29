# Extension Authoring

Extensions add UI components, commands, and behavior to DorkOS. This guide covers everything you need to create, install, and debug a custom extension.

## Concepts & naming

DorkOS reuses a few words that sound interchangeable but name different things. Keep them straight:

- **Extension** (what this guide is about) — a runtime module: a flat directory with an `extension.json` manifest and an `index.ts` exporting `activate()`, compiled on demand by esbuild and discovered by scanning. Identified by its manifest **`id`**, never an npm package name. It is **not** a workspace package and never lives in `packages/`.
- **Package** — a build-time npm unit in `packages/` (e.g. `@dorkos/extension-api`, `@dorkos/relay`). Extensions _import_ packages; they are not packages. The shared contract every extension imports is **`@dorkos/extension-api`**.
- **Core extension** — a first-party extension that ships in the repo at `apps/server/src/core-extensions/<id>/` and is staged to `~/.dork/extensions/<id>/` at startup (ADR-0271). Same manifest, compiler, and lifecycle as a user extension — only the origin differs. Today: `hello-world`, `linear-issues`, `marketplace`.
- **Marketplace package** — a _distributable_ unit with a `.dork/manifest.json` whose `type` is one of five: `agent`, `plugin`, `skill-pack`, `adapter`, `shape` (ADR-0230). **"Extension" is not one of the five.** A `plugin`-type package can _bundle_ extensions, declared via the `.claude-plugin/dorkos.json` sidecar (ADR-0236) — so an extension is a _layer inside_ a plugin, not a package type.

Rule of thumb: **extensions are flat directories keyed by manifest `id`; the things they `import` are the npm packages.**

Two name collisions worth flagging:

- **"marketplace"** names three things — the **`@dorkos/marketplace`** library (schemas / validator / scaffolder), the **`marketplace` core extension** (display name **"Marketplace"**, the browse UI), and the **install runtime** at `apps/server/src/services/marketplace/`. This guide's "marketplace" is the extension; the package and the install runtime are separate layers it sits on top of.
- **"Linear Loop"** is the _display name_ of the **`linear-issues`** core extension — not to be confused with the `linear-loop` _skill_ bundle retired in spec #257. Both the display name and the `linear-issues` id are provisional and may be renamed.

## Quick Start

**See a live example.** Hello World ships with DorkOS as a core extension (source at `apps/server/src/core-extensions/hello-world/`). It is staged automatically at server startup but ships disabled:

1. Open DorkOS Settings > Extensions
2. Under **Core extensions**, enable "Hello World" and reload the page
3. The Activity tab shows a new section under "From your extensions"; the command palette has a "Hello World: Show Greeting" command

Hello World is the canonical authoring skeleton — read its `extension.json`, `index.ts`, and `server.ts` to see the smallest working extension.

**Create your own.** New extensions are scaffolded with the `create_extension` MCP tool (see [Agent-Built Extensions](#agent-built-extensions)), which writes the directory, compiles, and enables it in one step. The extension lands in one of two locations:

- **Global** — `~/.dork/extensions/{id}/` (available in every project)
- **Local** — `{cwd}/.dork/extensions/{id}/` (scoped to the current project; overrides global when IDs match)

> **No server restart required.** The extension system discovers new directories on page reload. For extensions with `server.ts`, the server side initializes automatically when the client activates the extension.

## Directory Structure

An extension is a directory with at least two files:

```
my-extension/
├── extension.json   # Required — manifest
├── index.ts         # Required — client entry point (or index.js for pre-compiled)
└── server.ts        # Optional — server-side data provider (see Server-Side Data Providers)
```

**Global extensions** live in `~/.dork/extensions/{id}/`. **Local extensions** (project-scoped) live in `{projectDir}/.dork/extensions/{id}/`. Local overrides global when IDs match.

**Extensions inside a plugin.** A marketplace plugin can carry extensions in its own `.dork/extensions/{id}/`. Discovery reads them where the installer put the plugin: `~/.dork/plugins/{plugin}/.dork/extensions/{id}/` (global) and `{projectDir}/.dork/plugins/{plugin}/.dork/extensions/{id}/` (project). The record's `sourcePlugin` names the plugin. When one id turns up in more than one place, precedence is: a core extension, then one installed directly under `~/.dork/extensions/`, then the copy a person approved to run, then a plugin-carried copy by sorted plugin name (global plugins before project ones), with one warning. A project copy never takes a core id or an id approved for another copy (DOR-2383, `extension-discovery.ts`).

**Every known project, not just the working folder (spec `flow-multiproject` §9.2).** Discovery scans `.dork/extensions` and `.dork/plugins/*/.dork/extensions` in the server's working folder **and** in every project the project registry has seen (sessions, agents, workspaces, installs), plus every project the installer put a package into. A root only an extension reported through `ctx.projects.report` is never a scan root, so an extension cannot widen where core looks for code. The scan is bounded to those two folders per root, a gone folder is skipped silently, and every re-scan runs one at a time and, where it can, off the request path: debounced when the registry learns a project, and after `POST /api/extensions/reload`, an install, or a trust change has already answered (clients learn what changed from `extension_reloaded`). `POST /api/extensions/cwd-changed` still waits for its scan, because its answer (which extensions the new folder added or removed) is what the app remounts from. Every re-scan, including that one, moves an id whose running copy changed onto the new copy: its server half is stopped and started again there, and one that may no longer run is stopped. An extension's server `register()` gets 15 seconds (`REGISTER_TIMEOUT_MS`): one that never finishes is marked as unable to start (`serverError.code: 'server_start_timeout'`), everything it set up is released, and the queue moves on, so one hung extension cannot stall every later scan or install. So which copy runs no longer depends on the folder the server started in.

**Newest copy from one trusted source wins.** A plugin-carried copy has a _trusted origin_ only when this machine's installer can prove where it came from: a plugin under `~/.dork/plugins/` from its own install sidecar's `sourceRepo`, or a project plugin from the `source` the installer wrote into `~/.dork/marketplace/project-installs.json` at install time. It is the GitHub `owner/repo`, lowercased (https, ssh and bare forms all reduce to it; `installedFrom` is never used). A sidecar inside a project proves nothing: anyone can commit one. More conditions hold (two security reviews of DOR-2527). **The whole plugin folder is what is vouched for**, because a bundle can import any file in its plugin (flow imports `../../../../scripts/*`): the installer digests the whole staged install folder (every file, `.git` and DorkOS's own runtime state left out) just before moving it into place, and keeps that `installDigest` in a project install's record; a project copy has an origin only while its plugin folder still hashes to it, so an agent, a `git pull` or a re-clone changing any file in the plugin gets no origin. **No symbolic link anywhere in the plugin folder**, global or project: the installer strips links, and a loader follows one (`index.js → evil.js`) that a hash of files would skip. Such a copy is marked `originProblem` (`changed` for a project copy, `linked` for a global plugin), and its Settings card says so. **Only a branch or tag counts**: the install must have been fetched at the default branch, a branch or a tag, never at another `refs/…` name or a bare commit id, because GitHub serves every pull request's head (`refs/pull/N/head`) and any fork's commits through the parent repository's URL (`isTrustableRef` in `lib/trusted-source.ts`). Uninstalling a project install forgets its record.

**The code that runs is the code that was checked** (`extension-plugin-guard.ts`). A plugin-carried extension's bundle may import only files inside its own plugin folder: an import that resolves anywhere else, including a bare package found in the project's `node_modules` rather than the plugin's own, fails the build (host externals and Node built-ins excepted). A copy whose trust was judged against a folder digest carries it as `pinnedDigest`, and the compiler re-hashes the plugin folder immediately before every client or server bundle is built or served and again right after, so files swapped between the scan and the load, or during the build (`reload_extensions --id` included), never run; the record loses its origin on the spot. What runs is the bundle held in memory and the cache, so later edits on disk do nothing until the next checked load.

**A changed copy never keeps running on an old yes.** A project copy whose plugin changed after DorkOS installed it is not approved by its path alone: a person's yes to it records the folder's digest (`approvedSources[id].digest`), so it runs as those exact files, and any further change asks again. A changed copy of an id the person approved for a different copy is not listed at all and never runs. Approving a copy with a trusted origin records it (`extensions.approvedSources[id].origin`), and every other copy with the same plugin and source counts as approved too. Among those, the **highest manifest version** runs everywhere, with no new approval; a tie goes to the global copy, then the sorted project root. Each older copy is still listed by `GET /api/extensions` with `shadowedBy` set to the path of the copy that runs (the app's own lists hide it), so an extension can tell a person "this project has an older copy, update it". A clone that carries a copy claiming the same source has no trusted origin, so it never joins that family and must be approved by its own path. Copies from different sources keep the rules above. Full table: `apps/server/src/services/extensions/extension-precedence.ts`.

**A copy that runs by origin runs from a snapshot** (`extension-snapshots.ts`, third security review of DOR-2527). A project copy that runs because of its trusted origin — the person approved another copy from the same source, or trusts that source — was never approved in its own folder, and its server half may run plugin files at runtime (flow runs `<extensionDir>/../../../scripts/*.ts` with node) long after the load was checked. So it never runs from the project: DorkOS copies its whole plugin folder (what the digest covers) into `{dorkHome}/extension-snapshots/<digest>/`, re-hashes the copy, and moves it into place atomically only if it matches. The record's `runPath` points into the snapshot, and compiling, the server half and `ctx.extensionDir` all use it, so everything the extension reaches relative to itself (`scripts/`, `node_modules/`) is the snapshot's; later edits in the project never run, and the next scan sees them and takes the origin away. Snapshots are content-addressed (written once, never re-hashed, shared by identical copies), read-only by convention (an extension's data, settings and secrets live elsewhere under `{dorkHome}`, keyed by its id), and removed once no discovered copy runs from them. A yes pinned to a digest (a changed copy's fresh yes, or "Stop trusting" keeping a running copy) runs from a snapshot in the same way. A copy the person approved by its own path alone, and every global plugin under `{dorkHome}`, runs where it is.

**What it costs.** Whole-folder digests are cached per file by `(inode, size, mtime, ctime)` and per folder by the whole walk (every stamp plus every directory listing): a file's bytes are read again only when one of those changes, so a warm scan walks and `lstat`s and reads nothing. Each plugin folder is inspected once per scan however many extensions it carries, and a global plugin is only walked for links, never digested. On a laptop, a warm scan of five flow-sized copies (about 1,200 files each) takes about 150ms (`extension-discovery-perf.test.ts`).

**A server half that never finishes starting is let go completely.** On the `register()` timeout its context is disposed: what it scheduled is cancelled, what it registered is released, and any later `ctx.schedule` or listener registration from the still-running `register()` is a no-op, logged once. A retry starts a fresh instance; nothing of the abandoned one keeps running beside it.

## Manifest (`extension.json`)

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "What this extension does",
  "author": "Your Name",
  "minHostVersion": "0.1.0",
  "contributions": {
    "dashboard.sections": true,
    "command-palette.items": true
  },
  "permissions": []
}
```

| Field                | Required | Description                                                                                                                                                                                                        |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                 | Yes      | Unique kebab-case identifier. Must match the directory name.                                                                                                                                                       |
| `name`               | Yes      | Display name shown in Settings.                                                                                                                                                                                    |
| `version`            | Yes      | Semver string (e.g. `1.0.0`).                                                                                                                                                                                      |
| `description`        | No       | Short description for the settings UI.                                                                                                                                                                             |
| `author`             | No       | Author name or identifier.                                                                                                                                                                                         |
| `minHostVersion`     | No       | Minimum DorkOS version. Extension won't load on older hosts; a development build (`0.0.0`) loads it regardless.                                                                                                    |
| `contributions`      | No       | Declares which UI slots the extension contributes to (informational).                                                                                                                                              |
| `permissions`        | No       | Reserved for future use.                                                                                                                                                                                           |
| `capabilities`       | No       | Client-side capability declarations. Today: `capabilities.events` — the host events this extension may subscribe to. See [Events](#events).                                                                        |
| `defaultEnabled`     | No       | **Core extensions only.** Whether the extension ships enabled. Omitted or `true` = ships on; `false` = ships off (user opts in). Ignored for user/marketplace extensions. See [Core Extensions](#core-extensions). |
| `canDisable`         | No       | **Core extensions only.** Defaults to `true`. `false` = always on, renders no toggle ("Required"). Reserved — no core extension uses `false` today. See [Core Extensions](#core-extensions).                       |
| `serverCapabilities` | No       | Server-side declarations: entry point, external hosts, secrets, settings. See [Secrets](#secrets) and [Settings Declaration](#settings-declaration).                                                               |
| `dataProxy`          | No       | Declarative API proxy config. See [Declarative Proxy](#declarative-proxy).                                                                                                                                         |

## Entry Point (`activate`)

The entry point must export an `activate` function:

```typescript
import type { ExtensionAPI } from '@dorkos/extension-api';

export function activate(api: ExtensionAPI): void | (() => void) {
  // Register UI components, commands, subscriptions...

  // Optionally return a cleanup function
  return () => {
    // Called when the extension is disabled or the page unloads
  };
}
```

Cleanup is automatic: any registrations made through `api.registerComponent`, `api.registerCommand`, etc. are unregistered when the extension deactivates, whether or not you return a cleanup function.

## API Reference

### UI Registration

```typescript
// Add a React component to a UI slot
api.registerComponent(slot, id, Component, { priority?, label?, icon?, visibleWhen? }): () => void

// Add a command palette item
api.registerCommand(id, label, callback, { icon?, shortcut? }): () => void

// Register a dialog
api.registerDialog(id, Component): { open: () => void; close: () => void }

// Add a tab to the settings dialog
api.registerSettingsTab(id, label, Component, { group? }): () => void

// Mount a full page at /x/<your-id>/<path>
api.registerPage(path, Page, { title, icon?, menu? }): () => void

// Add an item to the chat status bar
api.registerStatusBarItem(id, Item, { label, priority?, when?, urgent? }): () => void
```

`registerComponent` options:

- **`priority?`** — orders the contribution within its slot; lower sorts earlier (leftward in a tab strip). Defaults to a mid value.
- **`label?`** — the human name shown where the slot has a label or tab (the `right-panel` tab strip, `settings.tabs`, `sidebar.footer`). Defaults to the namespaced id, so set it for any tabbed or labelled slot.
- **`icon?`** — the tab-strip glyph for slots that render one (today, `right-panel`). It is any component the host renders with a `className` (a `{ className?: string }` component). Omit it and the strip falls back to a default puzzle-piece. Note: extensions can only import `react`, `react-dom`, and `@dorkos/extension-api` at runtime, so you cannot import a `lucide-react` icon here — supply your own inline-SVG component instead.
- **`visibleWhen?`** — `dashboard.sections` only: a predicate the host re-evaluates on every render. Return false to hide your section without unregistering it (useful when it has nothing to say). Omit it and the section is always visible.
- **`group?`** — `settings.tabs` only: names the sidebar section the tab sits under in the Settings dialog (e.g. `'Agents & sessions'`, `'Access & privacy'`). Omit it and the tab lands under "Add-ons", the section reserved for contributed tabs, so a tab written before this field existed still files itself somewhere honest. Same option on `registerSettingsTab`.

`registerPage` and `registerStatusBarItem` have sections of their own under [UI Slots](#ui-slots): [Pages](#pages-x) and [The status bar](#the-status-bar).

### UI Control

```typescript
// Execute a UI command (open panel, show toast, etc.)
api.executeCommand(command: UiCommand): void

// Open the canvas with content
api.openCanvas(content: UiCanvasContent): void

// Navigate in-app: a core route, or one of your own pages
api.navigate(path: string): void

// Put a dot on one of your right-panel tabs, or clear it
api.setTabMarker(tabId: string, marker: 'attention' | null): void
```

**`navigate`** takes a core route (`/team`, `/session?dir=…`) or one of **your own** pages (`/x/<your-id>/p/dorkos?view=list`). Anything else is refused with a console warning: another extension's page, another origin (`https://…`, `//host`), or a scheme like `javascript:`.

**`setTabMarker`** marks a tab you registered with `registerComponent('right-panel', tabId, …)`. Core draws a small amber dot after the tab's label and adds "something needs you" to its accessible name ("Flow, something needs you"). You choose only whether the tab is marked; you cannot change how the dot looks. Marking a tab you did not register does nothing and logs a warning. Marks clear when your extension deactivates. Use it for "something here needs the person", not for "something changed": no counts, and clear it once the person has seen what needed them.

```typescript
api.registerComponent('right-panel', 'flow-tab', FlowTab, { label: 'Flow' });
api.subscribe(
  (state) => state.currentProject?.name ?? null,
  () => api.setTabMarker('flow-tab', decisionsWaiting() > 0 ? 'attention' : null)
);
```

### State

```typescript
// Read-only snapshot: { currentCwd, activeSessionId, agentId, currentProject, requireLogin }
api.getState(): ExtensionReadableState

// Subscribe to state changes (returns unsubscribe function)
api.subscribe(selector, callback): () => void
```

**`currentProject`** is the project the selected folder belongs to: `{ root, name }`, where `root` is the git main checkout (a worktree or a subfolder belongs to its main checkout) and `name` is a short name that is safe in a URL and never changes once given. It is `null` when the folder is in no repository, and **also `null` while core is still asking**, so treat `null` as "not known yet or none" rather than "definitely none". Subscribe to it the same way as `currentCwd`:

```typescript
api.subscribe(
  (state) => state.currentProject,
  (project) => console.log('Now in', project?.name ?? 'no project')
);
```

The server half has the same registry as `ctx.projects` (see [`ctx.projects`](#ctxprojects)).

`requireLogin` is whether Require login is on. When it is false, anyone on this computer can pass the person bar, so a setting only a person should change says so under it: "Anyone on this computer can change this. Turn on Require login so only you can."

### Inbox decisions and per-project settings

```typescript
// This extension's open decisions (the ones its server half raised with ctx.inbox)
api.listDecisions(): Promise<ExtensionDecisionView[]>

// Answer one from your own page. Recorded as "answered in <your name>", never as the person.
api.answerDecision(decisionId, { action: 'approve' }): Promise<DecisionAnswerResult>

// Settings only a person writes, per project (an autonomy dial lives here)
api.projectSettings.get(projectRoot): Promise<T | null>
api.projectSettings.set(projectRoot, value): Promise<void> // JSON, at most 16 KiB
```

- **Scoped to you.** Every call goes to `/api/extensions/<your id>/…`, and the server answers only your own rows: another extension's decision is a 404.
- **Attributed to the extension.** An answer given on your page is history's "… · answered in Flow at 2:14pm". Only an answer in DorkOS's own inbox is credited to the person, and only that one can carry a one-time "next time, on its own?" offer.
- **`projectSettings.set` is the only writer.** Your server half reads them (`ctx.projectSettings`) and has no way to write them, so neither it nor any agent it runs can turn a dial up. It sits behind the person bar, with the residual the bar documents: your own page code can call it too, so it is recorded as written from the extension's page.
- **A refusal throws** an `Error` carrying the server's sentence and `code` (`not_running`, `already_resolved`, `extension_timeout`).

### Feature detection

Hosts gain seams over time, and one build of your extension should run on hosts from before and after each one. **Probe for a seam; never compare host versions:**

```typescript
if (typeof api.registerPage === 'function') api.registerPage('', Home, { title: 'Flow' });
if (api.isSlotAvailable('status-bar'))
  api.registerStatusBarItem('run', RunChip, { label: 'Flow run' });
if (typeof api.setTabMarker === 'function') api.setTabMarker('flow-tab', 'attention');
const project = 'currentProject' in api.getState() ? api.getState().currentProject : null;
```

On the server half, probe `ctx.projects !== undefined` the same way. The inbox seams probe the same way: `typeof api.answerDecision === 'function'`, `'requireLogin' in api.getState()`, and `ctx.inbox !== undefined`.

### Events

`api.events.subscribe(kinds, handler)` pushes a **curated, privacy-safe** subset of host activity to your extension — no more polling for "did a turn finish?". This is deliberately **not** the raw session stream.

```typescript
// Subscribe to specific event kinds (returns unsubscribe function)
const unsub = api.events.subscribe(['turn.completed', 'tool.activity'], (event) => {
  if (event.kind === 'turn.completed') {
    console.log(`Turn took ${event.durationMs}ms and made ${event.toolCallCount} tool calls`);
  }
});
```

**Event kinds** (grouped by category):

| Kind               | Category  | Payload (beyond `kind`)                                          |
| ------------------ | --------- | ---------------------------------------------------------------- |
| `session.started`  | `session` | `sessionId`                                                      |
| `session.ended`    | `session` | `sessionId`                                                      |
| `session.switched` | `session` | `sessionId`, `previousSessionId` (either may be `null`)          |
| `turn.started`     | `turn`    | `sessionId`                                                      |
| `turn.completed`   | `turn`    | `sessionId`, `durationMs`, `toolCallCount`, `terminalReason?`    |
| `tool.activity`    | `tool`    | `sessionId`, `toolName`, `status` (`'started'` \| `'completed'`) |
| `relay.message`    | `relay`   | `messageId`, `from`, `subject`                                   |

**Scoping** differs per category:

- `turn.*` and `tool.*` are delivered for the **active (foreground) session** only — a background agent's activity is not pushed to your extension.
- `session.started` / `session.ended` are **global**: session lifecycle spans the whole host, so they fire for every session the host observes, foreground or not. Note that `session.started` means _first observed_, not _created_ — every pre-existing session fires one `session.started` when the client's session-list stream connects, so expect a burst at startup.
- `session.switched` describes the foreground itself: which session the operator has active.
- `relay.message` is **global**: declaring `relay` means you observe routing metadata for all relay traffic on the console stream, not just your own.

**Privacy boundary (by design):** these events carry **no conversation content**. There is no message text, no thinking output, no tool **arguments** or **results**, and no relay message **body**. An extension learns _that_ a tool ran and _which_ tool — never _what it did_. This boundary is intentional and enforced host-side; do not expect it to widen.

**You must declare what you listen to.** Add a `capabilities.events` array to your manifest listing the kinds (or whole categories) you subscribe to. A `subscribe` call for an undeclared kind is rejected (logged as a warning, silently dropped) — declaring a category grants every kind under it:

```json
{
  "id": "turn-timer",
  "name": "Turn Timer",
  "version": "1.0.0",
  "capabilities": {
    "events": ["turn", "tool.activity"]
  }
}
```

Subscriptions are cleaned up automatically when your extension deactivates, like every other `api.*` registration.

### Storage

```typescript
// Load persistent data (returns null if nothing saved)
const data = await api.loadData<MyData>();

// Save persistent data (scoped to this extension)
await api.saveData({ key: 'value' });
```

Storage is JSON-serialized and persisted at `~/.dork/extensions/{id}/data.json`.

### Notifications

```typescript
api.notify('Something happened', { type: 'info' | 'success' | 'error' });
```

### Introspection

```typescript
// Check if a slot is rendered in the current context
api.isSlotAvailable('dashboard.sections'): boolean

// The extension's own ID
api.id: string
```

## UI Slots

| Slot ID                 | Where it renders                                       |
| ----------------------- | ------------------------------------------------------ |
| `sidebar.footer`        | Bottom of the sidebar                                  |
| `dashboard.sections`    | "From your extensions", at the top of the Activity tab |
| `command-palette.items` | Command palette entries                                |
| `dialog`                | Modal dialog layer                                     |
| `settings.tabs`         | Settings dialog tabs                                   |
| `right-panel`           | Shell-level right panel (contextual inspector) tabs    |
| `status-bar`            | The chat status bar, beside the runtime and account    |

Pages are not a slot: `registerPage` mounts a route (see [Pages](#pages-x)).

> The `sidebar.tabs` and `header.actions` slots were removed when the web cockpit
> retired the sidebar tab strip. Contribute a contextual inspector tab via
> `right-panel`, or a card via `dashboard.sections`, instead.

### `dashboard.sections` moved to the Activity tab

The home surface IS the #team room now, and the dashboard page that
`dashboard.sections` used to fill is gone. **The slot id has not changed**
— your manifest and your `registerComponent('dashboard.sections', ...)` call
work exactly as before. Your section now renders in a **"From your extensions"**
group at the top of the Activity tab (`/activity`), in the same priority order,
with `visibleWhen` honoured the same way. When no extension has contributed, the
group renders nothing at all.

A purpose-built room-widget surface — sections that live inside a room rather
than above a feed — is designed but deliberately deferred; until it exists,
`dashboard.sections` is the place to put a card.

### Right-panel tabs

The `right-panel` slot adds a tab to the shell's right panel — the contextual inspector beside the chat. It is the headline surface for at-a-glance context, so it is worth a full example. Scaffold this shape directly with the `right-panel-tab` template (see [Template Types](#template-types)).

```typescript
import type { ExtensionAPI } from '@dorkos/extension-api';

// The tab-strip icon is a component the host renders with a `className` for sizing.
// You cannot import a lucide-react icon in an extension (only react, react-dom, and
// @dorkos/extension-api are available at runtime), so ship your own inline SVG.
// `currentColor` makes it inherit the strip's theme color.
function InspectorTabIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </svg>
  );
}

// Only the tab body — the panel container owns the shared header (tab strip + close button).
function InspectorPanel() {
  return <div style={{ padding: '16px' }}>Your contextual view goes here.</div>;
}

export function activate(api: ExtensionAPI): void {
  api.registerComponent('right-panel', 'inspector', InspectorPanel, {
    label: 'Inspector', // tab name (tooltip + accessibility); defaults to the id if omitted
    icon: InspectorTabIcon, // omit for the host's default puzzle-piece glyph
    priority: 50, // lower sorts earlier (leftward) in the tab strip
  });
}
```

**When the tab appears.** Your tab is added to the right panel's tab strip and stays available wherever the panel shows: the public `registerComponent` API accepts `visibleWhen` only for `dashboard.sections`, not for the route/transport/agent predicate built-in right-panel tabs use to scope themselves, so an **extension tab is always visible**. It registers as a _contextual_ tab (never the global fallback). That has a real consequence — the panel auto-selects the first contextual tab when the active one isn't showing, so on routes where no built-in contextual tab is visible (home, activity, tasks), **your tab can become the default and open on its own**, ahead of the global Pulse tab. Because it can auto-open in any context, always render a useful empty state when there is nothing relevant to show.

### Pages (`/x/…`)

`api.registerPage(path, Page, options)` mounts a full page at **`/x/<your-id>/<path>`**. The `x/` prefix means no core route can ever take your address, now or later.

- **`path`** is `''` for your home (`/x/flow`), or `/`-separated segments that are lowercase words or `:param` placeholders (`'settings'`, `'p/:name'`). Anything else throws. Registering the same path twice replaces the first, with a console warning. When two paths could answer an address, the one with more fixed words before its first `:param` wins (`p/new` beats `p/:name`).
- **`options.title`** (required, non-empty text; a page without one is refused with a console warning) names the page in its bar, its tab, the command palette and the phone menu. **`options.icon`** is a component the host sizes with `className` (an inline SVG; you cannot import `lucide-react`). **`options.menu: false`** keeps a page out of the palette and the phone menu. Pages with a `:param` are never listed there: a menu cannot fill in the value.
- **Your page gets** `params` (the `:param` values, decoded), `search` (the URL's query, every value exactly the text the address holds: `?v=1.10` is `'1.10'`) and `setSearch(next)`, which writes keys into the URL (`null` removes one). `setSearch` replaces the history entry rather than adding one, so writing a filter box on every keystroke leaves one Back press, not one per letter; two calls in a row both land. Keep state a person would bookmark there: `/x/flow?project=dorkos` opens the same view for whoever it is sent to.
- **Core gives the page the whole content area and scrolls it.** Layout and padding are yours. If the page throws while drawing, core shows a "ran into a problem" message in its place, not a broken app.
- **A reload on your page's address works.** It arrives before your extension has loaded, so core shows a skeleton until you register the page. If your extension is not installed, not allowed to run, turned off, or has no page at that address, core says which, in plain words, with a way to fix it where there is one.
- **Where people find it:** the command palette lists your pages under "Add-ons" (type part of the title), and on a phone they are listed under "Add-ons" in the You tab. There is no sidebar entry: extensions add no app chrome of their own.

```typescript
function FlowHome({ search, setSearch }: ExtensionPageProps) {
  return (
    <div style={{ padding: '24px 16px' }}>
      <h1>Flow</h1>
      <button onClick={() => setSearch({ project: 'dorkos' })}>Show dorkos</button>
      <p>Showing {search.project ?? 'every project'}</p>
    </div>
  );
}

function ProjectLens({ params }: ExtensionPageProps) {
  return <h1>Project {params.name}</h1>;
}

export function activate(api: ExtensionAPI): void {
  api.registerPage('', FlowHome, { title: 'Flow' });
  api.registerPage('p/:name', ProjectLens, { title: 'Project' });
  // Elsewhere: api.navigate('/x/flow/p/dorkos');
}
```

### The status bar

`api.registerStatusBarItem(id, Item, options)` adds an item to the status bar under a chat's composer, beside the runtime and account chips. Your component receives the chat's `StatusBarSlotContext` as props:

| Field          | What it is                                                                   |
| -------------- | ---------------------------------------------------------------------------- |
| `sessionId`    | The chat's session id                                                        |
| `cwd`          | The chat's folder, or `null`                                                 |
| `project`      | The project of `cwd` (`{ root, name }`), or `null`                           |
| `trackerItems` | Every tracker item the chat works on, newest first                           |
| `compact`      | `true` at phone width: draw your short form (an id and a state, not a title) |

Options:

- **`label`** is the accessible name of your item's region.
- **`priority?`** orders your item among other extensions' items (lower first, default 100).
- **`when?(ctx)`** says whether to show the item for this chat (default: always). **`urgent?(ctx)`** says whether it needs attention.
- **`when` and `urgent` must be pure and read only `ctx`.** They run while the status bar works out what fits, many times, before your component is drawn: no fetching, no reading your extension's own state, no subscribing. Anything you need to decide belongs in `ctx`, which is why `trackerItems` is on it. Core cannot enforce this beyond calling them synchronously, but anything other than `true` or `false` (a Promise, an object) reads as `false` and logs a warning once. A rule that throws hides the item (logged once), and an item that throws while drawing disappears on its own; neither takes the status bar down.

All extension items share **one slot** in the bar's width budget, called "Add-ons". It shows when any item's `when` says so. It ranks with live work (like running subagents) when slots are contested, and with an account that needs you when any shown item is `urgent`. It cannot be pinned. When the bar has no room for it, it counts in the `+N` beside the `⋯`, and the Session panel behind the `⋯` lists every shown item under "Add-ons".

```typescript
api.registerStatusBarItem('run', RunChip, {
  label: 'Flow run',
  when: (ctx) => ctx.trackerItems.length > 0,
  urgent: (ctx) => ctx.trackerItems.some((item) => item.runStatus === 'needs-you'),
});

function RunChip({ trackerItems, compact }: StatusBarSlotContext) {
  const first = trackerItems[0]!;
  if (trackerItems.length > 1) return <span>{trackerItems.length} items</span>;
  return <span>{compact ? first.id : `${first.id} · ${first.stage ?? 'Working'}`}</span>;
}
```

## TypeScript vs JavaScript

**TypeScript** (`index.ts`): Compiled automatically by the host using esbuild. JSX is supported in `.ts` files. Type against `@dorkos/extension-api` for full autocompletion.

**Pre-compiled JavaScript** (`index.js`): Served directly with no compilation step. Use `React.createElement` for components since JSX isn't available without a build step.

If both `index.js` and `index.ts` exist, the pre-compiled JS takes priority.

## React Components

React is provided by the host on the global scope (`globalThis.React`). **Do not import React yourself** — the extension is compiled as ESM with `react` externalized, so a bare `import React from 'react'` produces a module specifier the browser cannot resolve and causes a runtime error.

```typescript
// WRONG — causes "Failed to resolve module specifier 'react'" at runtime
import React from 'react';

// CORRECT — type-only imports are erased at compile time (safe)
import type { ExtensionAPI } from '@dorkos/extension-api';

// CORRECT — use React from the global scope
function MySection() {
  const [count, setCount] = React.useState(0);
  return React.createElement('div', null, `Count: ${count}`);
}
```

In TypeScript extensions, JSX works out of the box (the compiler uses the global `React`):

```typescript
function MySection() {
  return <div style={{ padding: '16px' }}>Hello</div>;
}
```

In JavaScript extensions, use `React.createElement`:

```javascript
function MySection() {
  return React.createElement('div', { style: { padding: '16px' } }, 'Hello');
}
```

Use CSS custom properties (`var(--border)`, `var(--muted-foreground)`) from the host theme for consistent styling.

## Debugging

- **Console**: Extensions run in the browser. Use `console.log` and inspect in browser devtools.
- **Source maps**: TypeScript extensions include inline source maps. Set breakpoints in the original `.ts` file via the Sources panel.
- **Compilation errors**: Check Settings > Extensions for error details if your extension fails to compile.
- **State inspection**: Call `api.getState()` from a command callback to inspect host state.

## Core Extensions

Some extensions ship with DorkOS itself. These **core extensions** are first-party — but they are not special-cased: they reuse the exact same manifest schema, esbuild compiler, and lifecycle as user extensions. DorkOS dogfoods its own public extension API. They are toggleable in the UI just like user extensions (matching Obsidian core plugins or VS Code built-in extensions), each shipping with a configurable default state.

Core extension source lives in `apps/server/src/core-extensions/{id}/` and follows the same `extension.json` + `index.ts` + optional `server.ts` structure as user extensions. The source ships as TypeScript and is compiled at runtime by esbuild — the server's tsc does not compile it.

### Staging at startup

At server startup, `ensureCoreExtensions(dorkHome)` (in `apps/server/src/services/core-extensions/ensure-core-extensions.ts`, called from `apps/server/src/index.ts`) scans the core-extension source tree and version-stages every subdirectory with a valid `extension.json` into `{dorkHome}/extensions/<id>/` — the **same** runtime directory user extensions use. From that point on, the standard `extensionManager.initialize()` discovery pass treats them identically to user extensions; the only difference is provenance.

`ensureCoreExtensions()` returns `CoreExtensionInfo[]` (`{ id, defaultEnabled, canDisable }`), which the extension manager uses to resolve each extension's enabled state and to render the Settings UI. Extension records carry `origin: 'core' | 'user'`, derived from this startup staging set (it is not a manifest claim).

### Settings UI

Core extensions appear in Settings → Extensions under a **"Core extensions"** section; user-installed extensions appear under **"Installed extensions"**. Each core extension has a working enable/disable toggle. Whether it ships on or off is controlled by `defaultEnabled` in its manifest; whether the user can toggle it at all is controlled by `canDisable`.

### Manifest fields

Core extensions may set two optional manifest fields (ignored for user/marketplace extensions):

| Field            | Default | Semantics                                                                                                                               |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultEnabled` | `true`  | Whether the extension ships enabled. Omitted or `true` = ships on; `false` = ships off (user opts in).                                  |
| `canDisable`     | `true`  | Whether the user may turn it off. `false` = always on, renders no toggle ("Required"). Reserved — no core extension uses `false` today. |

The user's deviations from these defaults are stored in `config.extensions` as two lists (`enabled` for opt-ins, `disabled` for opt-outs). See [Configuration → extensions](./configuration.md#settings-reference) for the resolution model and the hand-edit caveat.

### The initial core set

| id              | Name        | `defaultEnabled` | `canDisable` |
| --------------- | ----------- | ---------------- | ------------ |
| `marketplace`   | Marketplace | `true` (on)      | `true`       |
| `hello-world`   | Hello World | `false` (off)    | `true`       |
| `linear-issues` | Linear Loop | `false` (off)    | `true`       |

Marketplace backs the `/marketplace` UI and ships on. Hello World ships off as the canonical authoring skeleton and a live toggleable demo. Linear Loop incubates here (off by default) until `@dorkos/extension-api` is published, after which it migrates to the marketplace.

### Writing a New Core Extension

1. Create a directory `apps/server/src/core-extensions/{id}/` with `extension.json`, `index.ts`, and optionally `server.ts`
2. Follow the same manifest format as user extensions (see [Manifest](#manifest-extensionjson))
3. Set `defaultEnabled` and `canDisable` in the manifest as desired (both default to `true`)
4. Add or extend tests in `apps/server/src/services/core-extensions/__tests__/ensure-core-extensions.test.ts`

The generalized `ensureCoreExtensions()` scanner picks the new directory up automatically at startup — there is **no** per-extension `ensure-{id}.ts` function to write. (That one-off pattern is gone.)

**Conventions:**

- The extension `id` in `extension.json` must be unique and kebab-cased, and match the directory name
- `ensureCoreExtensions()` is version-staged and idempotent — it runs on every server start without clobbering user state

## Limitations (v1)

- No sandboxing: client-side extensions run in the browser with full DOM access; server-side extensions run in the Node.js host process.
- The `hello-world` core extension (`apps/server/src/core-extensions/hello-world/`) is the worked example of a page, a status-bar item and a tab marker. It ships turned off.
- No extension marketplace or auto-update mechanism.
- Storage is local-only (no sync across machines).

---

## Server-Side Data Providers

Extensions can run code on the DorkOS server. A **data provider** extension adds a `server.ts` file alongside `index.ts`, giving it Express routes, encrypted secrets, persistent storage, background scheduling, and SSE event emission — all scoped and isolated per extension.

The three tiers of server-side capability, from simplest to most powerful:

| Tier                  | What it does                                            | Requires code?                        |
| --------------------- | ------------------------------------------------------- | ------------------------------------- |
| **Declarative proxy** | Forward requests to an upstream API with auth injection | No (`dataProxy` in manifest only)     |
| **Data provider**     | Custom Express routes with full `DataProviderContext`   | Yes (`server.ts`)                     |
| **Background tasks**  | Scheduled polling with storage and SSE events           | Yes (`ctx.schedule()` in `server.ts`) |

### Creating `server.ts`

Create a `server.ts` file in your extension directory that default-exports a `register` function:

```typescript
import type { ServerExtensionRegister } from '@dorkos/extension-api/server';

const register: ServerExtensionRegister = (router, ctx) => {
  // Register routes on the scoped Express router
  router.get('/data', async (_req, res) => {
    const items = await ctx.storage.loadData();
    res.json({ data: items ?? [] });
  });

  // Optionally return a cleanup function
  return () => {
    // Called when the extension is disabled or reloaded
  };
};

export default register;
```

The `register` function receives two arguments:

- **`router`** — A scoped Express `Router` mounted at `/api/ext/{id}/`. A route registered as `router.get('/data', ...)` is reachable at `GET /api/ext/my-extension/data`.
- **`ctx`** — A `DataProviderContext` with secrets, settings, storage, scheduling, and event emission (see below).

Server-side code is compiled to CommonJS (Node.js target) by the host using esbuild. TypeScript is supported out of the box.

### `DataProviderContext` API Reference

The `ctx` object passed to `register` provides isolated, per-extension capabilities:

#### `ctx.secrets`

Encrypted per-extension secret store. Secrets are encrypted with AES-256-GCM and stored at `{dorkHome}/extension-secrets/{id}.json`.

```typescript
// Read a secret (returns null if not set)
const apiKey = await ctx.secrets.get('api_key');

// Store a secret (encrypted, written to disk immediately)
await ctx.secrets.set('api_key', 'sk-...');

// Delete a secret
await ctx.secrets.delete('api_key');

// Check if set without decrypting
const exists = await ctx.secrets.has('api_key');
```

#### `ctx.settings`

Read/write access to non-secret extension configuration. Settings are stored as plaintext JSON at `{dorkHome}/extension-data/{id}/settings.json`.

```typescript
// Read a setting value (returns null if not set)
const interval = await ctx.settings.get<number>('refresh_interval');

// Store a setting value (string, number, or boolean)
await ctx.settings.set('refresh_interval', 120);

// Delete a setting (reverts to manifest default)
await ctx.settings.delete('refresh_interval');

// Read all stored settings as a key-value record
const all = await ctx.settings.getAll();
```

#### `ctx.storage`

Persistent JSON storage scoped to this extension. Data is stored at `{dorkHome}/extension-data/{id}/data.json` with atomic writes (tmp file + rename).

```typescript
// Load previously saved data (returns null if nothing stored)
const data = await ctx.storage.loadData<MyData>();

// Save data (overwrites previous)
await ctx.storage.saveData({ items, updatedAt: Date.now() });
```

Storage is shared between server-side `ctx.storage` and client-side `api.loadData()`/`api.saveData()` — they read and write the same file.

#### `ctx.schedule(intervalSeconds, fn)`

Schedule a recurring background function. Returns a cancel function.

```typescript
const cancel = ctx.schedule(60, async () => {
  const data = await fetchExternalApi();
  await ctx.storage.saveData(data);
  ctx.emit('data-updated', data);
});

// To stop the scheduled task:
cancel();
```

- **Minimum interval**: 5 seconds. Values below 5 are clamped to 5.
- **Error handling**: Errors thrown by `fn` are caught and logged, never propagated. The schedule continues running.
- **Cleanup**: All scheduled tasks are automatically cancelled when the extension is disabled or reloaded.

#### `ctx.emit(event, data)`

Broadcast an SSE event to all connected clients. Events are namespaced as `ext:{id}:{event}` on the unified SSE stream.

```typescript
ctx.emit('issues.updated', { count: 42 });
// Client receives event type: "ext:my-extension:issues.updated"
```

#### `ctx.extensionId` / `ctx.extensionDir`

```typescript
ctx.extensionId; // "my-extension" — from the manifest
ctx.extensionDir; // "/Users/kai/.dork/extensions/my-extension" — absolute path
```

#### `ctx.dorkHome`

The resolved DorkOS data directory (`~/.dork` in production, `apps/server/.temp/.dork` in dev, or whatever `DORK_HOME` names). Use it for a file another tool also reads, such as the Flow extension's `<dorkHome>/flow/fleet.json`. A project-local extension's `extensionDir` is not under it, so never derive it from `extensionDir`. Data only your extension reads belongs in `ctx.storage`.

#### `ctx.accounts`

Read access to the agent accounts DorkOS knows, and the account advisor seam (spec `claude-account-fleet` §6 X1-X3). Every type is exported from `@dorkos/extension-api/server`.

```typescript
const accounts = await ctx.accounts.list();
// [{ runtime: 'claude-code', id: 'work', label: 'Work', color: '#…', implicit: false },
//  { runtime: 'codex', id: 'default', label: null, color: '#…', implicit: true }, …]

const usage = await ctx.accounts.usage('claude-code'); // AccountUsage[]; omit the runtime for all

const stop = ctx.accounts.onUsage((u) => ctx.emit('usage', u)); // throttled per account

await ctx.accounts.markContinued(sourceSessionId, { sessionId, runtime, accountId });
```

- **`list()`** covers every runtime: the registered rows, then each runtime's implicit `default` (`implicit: true`) when it is an account of its own. When `default` is the same folder as a registered row, that row is the one entry.
- **`usage(runtime?)`** and **`onUsage(listener)`** read the usage store. The `AccountUsage` they hand you is the shared one without `path`: an account's config folder never leaves the server, so name accounts by `runtime` and `id`. Usage listeners are removed automatically when the extension shuts down or reloads.
- **After shutdown or reload the old `ctx.accounts` is closed.** `onUsage` and `registerAdvisor` throw and register nothing, and `markContinued` rejects, so a late `.then(() => ctx.accounts.registerAdvisor(…))` from a previous instance cannot replace the new instance's advisor. `list` and `usage` keep answering.
- **`markContinued`** tells DorkOS that your extension moved a session it claimed (see `claims` below) to a new session, so the source session points at where its work went. It rejects a malformed call, and rejects while this server tracks no session limits.

**The account advisor.** `ctx.accounts.registerAdvisor(advisor)` lets an extension decide which accounts work may go to. Core never reads any routing policy itself; it asks the advisor.

```typescript
const unregister = ctx.accounts.registerAdvisor({
  rank(candidates, rankCtx) {
    // rankCtx: { purpose: 'launch' | 'continue', caller, cwd, runtime, sessionId?, excludeAccountId? }
    return {
      accounts: candidates.map((c) => ({ id: c.id, eligible: true, reason: 'Allowed' })),
      recommendedId: candidates[0]?.id ?? null,
    };
  },
  // Optional: onLimited, modelFallback, carryOver, claims, move, cancelAuto, wait
});
```

The rules an advisor lives by:

- **One advisor at a time.** A second registration replaces the first, and the server log warns naming both extensions. The function `registerAdvisor` returns removes only your own advisor, and shutdown or reload removes it for you.
- **Every call is bounded at 2 seconds, and every answer is checked.** A ranking keeps only ids DorkOS knows (and never the excluded account); an id you leave out is hidden; a `reason` over 200 characters is cut to fit; `recommendedId` counts only when it names an eligible account of the context's runtime. An `auto` plan's `delaySeconds` is clamped to 0..3600, and its target must be a registered account other than the one that ran out. A `carryOver` seed longer than the seed-context limit is refused. A throw, a timeout or an invalid answer means core's default for that call.
- **A person's own pick is never refused by the advisor.** Its ranking is advice for anything a person does.
- **Agents and relay messages need it.** When an agent (`session_start`) or a relay message names an account, core allows it only when the advisor's `launch` ranking marks that account eligible. With no advisor registered, such a pick is refused ("Agents can pick an account only after Flow is set up to say which accounts they may use."), and an advisor that fails refuses it too ("The account policy could not be checked."). Without an advisor everything else uses core's defaults: accounts ranked by weekly headroom, and a person asked what to do when an account runs out.

#### `ctx.projects`

The projects core knows. A project is a git main checkout: a worktree or a subfolder belongs to its main checkout, and a folder in no repository belongs to none. Each project has a short `name` that is safe in a URL and never changes once given (the folder's name, or `name~parent` when another project already had it), so `/x/<your-id>/p/<name>` stays a good bookmark.

```typescript
if (ctx.projects !== undefined) {
  const here = await ctx.projects.resolve(someFolder); // { root, name } | null
  const mine = await ctx.projects.list(); // ProjectInfo[]: { root, name, originRepo, lastSeenAt }
  await ctx.projects.report('/Users/kai/dev/client-app'); // tell core about one it has not seen
  const stop = ctx.projects.onChange(() => ctx.emit('projects-changed', null));
}
```

- **`list()` is scoped to you.** It answers the projects that hold a copy of your extension (`.dork/extensions/<id>` or a plugin's `.dork/plugins/*/.dork/extensions/<id>`) and the ones you reported. You do not learn every folder the person works in.
- **`resolve` and `report` pass the directory boundary and need a git repository**, else they answer `null` and record nothing. The boundary is checked twice: on the folder you name and on the repository it belongs to, so a worktree or a `.git` file inside the boundary that points at a repository outside it answers `null`. Only `report` adds a project to your own `list()`.
- **A project only extensions named is second-class.** Core never looks for extension code there, and it stays out of the person's own project list until a session, agent, workspace or install is seen in it.
- **At most 200 new projects per extension.** Each project core had not seen that you `report` or `resolve` counts once; past 200, naming another new one answers `null` and records nothing. Projects core already knows, and ones you named before, do not count.
- **Probe before use.** `ctx.projects` is absent on hosts from before it; check `ctx.projects !== undefined` rather than a host version. Change listeners are removed on shutdown and reload.

#### `ctx.inbox`

Ask a person something in the Activity inbox. You decide **when** to ask (your own conditions and time limits); core owns the rest: one live row per key, the bell count, the push to a phone when nobody answers (`extension.decision` is `blocking`), the question's deadline, who decided, and the one history row.

```typescript
if (ctx.inbox !== undefined) {
  ctx.inbox.onAction(async (event) => {
    // event: { key, action, choiceId, decidedBy: 'person' | 'deadline', note, text, pendingActionId, offerId, project }
    if (event.action === 'offer')
      return { resolve: 'approved', message: 'Done. Change it any time in Flow settings.' };
    await ship(event.key);
    return {
      resolve: 'approved',
      offer: {
        text: 'Shipped. Next time, ship on its own when the reviewer agent approves?',
        offerId: 'auto-ship',
        settingsPatch: { project: event.project!.root, patch: { ship: 'tell-me-after' } },
      },
    };
  });

  await ctx.inbox.raise({
    key: `ship:${item.id}`, // yours; core keeps it apart from every other extension's
    title: 'Ship the new out-of-usage banner?', // a question or an outcome, never a command or an id
    why: "It's built, tests pass, and the reviewer agent found nothing. Shipping merges it into the app.",
    project: checkoutPath, // any folder inside the project; the row groups under its name
    projectLabel: 'Linear DOR',
    actions: {
      kind: 'yes-no',
      approveLabel: 'Ship it',
      rejectLabel: 'Send it back',
      rejectAsksForNote: true,
    },
    link: '/x/flow/p/dorkos',
  });

  // A question with the agent's pick and a deadline core runs
  await ctx.inbox.raise({
    key: 'old-api',
    title: 'Should the old API keep working?',
    why: 'Removing it breaks two scripts. If nobody answers, it stays: the safer choice.',
    actions: {
      kind: 'choice',
      choices: [
        { id: 'keep', label: 'Keep it' },
        { id: 'remove', label: 'Remove it' },
      ],
      defaultChoice: 'keep',
      decideBy: fivePmToday,
      allowReply: true,
    },
  });

  await ctx.inbox.resolve('linear-down:dorkos', { outcome: 'cleared' }); // "Resolved on its own"
  await ctx.inbox.record({
    // decided without asking: history only ("While you were away")
    key: 'ship:DOR-2400',
    title: 'Shipped the calmer red',
    why: 'The reviewer agent approved it.',
    outcome: 'approved',
    by: { kind: 'rule', label: "your 'Tell me after' setting" },
    choiceLabel: 'Shipped',
    tell: true,
  });
}
```

- **Every ask says why.** `why` is required: plain text, 1 to 300 characters. Write it by three rules: say what will happen and why, in plain words, never a command, a stage name or an id as the headline; say why now and what a "no" means; and let every kind of ask be something the person can hand off. Buttons read as outcomes ("Ship it", "Send it back"), not yes and no.
- **A budget per extension.** At most 60 new decisions an hour, raised or recorded, counted over a sliding hour; past it `raise` and `record` throw `InboxLimitError` with `limit: 'rate'`. Updating an open key does not count. Activity keeps at most your newest 100 history rows, so a busy extension never pushes other things out of the person's history.
- **Re-raising never moves a deadline.** A re-raise with the same actions keeps the deadline first set, its timer, and what a person already answered, even when its `decideBy` differs (a deadline asked as "an hour from now" moves every time you raise). Only different choices, labels or options start the question over. To set a new deadline, resolve the old question and raise a new one.
- **A person's answer ends the deadline.** Once somebody answers (whatever your handler does with it, `keepOpen` included), the agent's pick no longer applies. While your handler has a person's answer, the deadline waits; if the handler fails, the deadline stands as before.
- **Crediting must agree.** `resolve(key, { answering })` throws when the outcome contradicts what the person chose (👍 is `approved`, 👎 is `rejected`, a word or a choice is `answered`).
- **One live row per key.** Raising an open key updates it in place and never pushes twice. At most 50 open decisions per extension; title ≤ 120, detail ≤ 500, a note or typed answer ≤ 2000. Breaking a limit throws `InboxLimitError` (match on `err.code === 'inbox_limit'` and `err.limit`, not `instanceof`: your bundle carries its own copy of the class) and writes nothing.
- **Links stay in the app.** `link`, a word action's `href` and a handler's `navigate` must be a DorkOS route or `/x/<your id>/…`; anything else throws `InboxLinkError` (`inbox_link`), or, from a handler, counts as a handler error. A push opens `link`, or home.
- **The handler has 5 seconds.** Answer `{ resolve }`, `{ keepOpen: true }` (the row stays; call `resolve(key, { outcome, answering: event.pendingActionId })` later and history credits the person), or `{ settled: true }`. A throw or a timeout keeps the row and the person sees "Flow couldn't take that. Try again."
- **Deadlines run in core.** At `decideBy` core calls your handler with `choiceId: defaultChoice` and `decidedBy: 'deadline'`. `{ resolve }` settles it ("decided by the agent"); `{ keepOpen: true }` stops the clock with no retry; a failure retries after 1 and 5 minutes and then leaves the row with the person, saying "The agent couldn't go ahead. It needs you." A `decideBy` sooner than 5 minutes is moved to 5 minutes; more than 7 days ahead throws. A deadline fires only while you are running and have registered `onAction`, including one that passed while the server was down.
- **Who decided.** `resolve(key, { outcome, by })` takes `{ kind: 'agent' | 'rule', label }` (history shows the label) or `{ kind: 'deadline' }`. With no `by`, it is yours: "Resolved on its own" for `cleared`, "No longer needed" for `cancelled`.
- **"Next time, on its own?"** An `offer` on your answer is shown once, only to the person who answered in DorkOS, as a green line with Yes. Its `settingsPatch` is merged into your per-project settings as the person before your handler hears `action: 'offer'`. A patch for a project you cannot see is refused.
- **Hidden while you are not running.** While your extension is off, or a decision's project folder is missing, its rows are hidden and kept and their clocks stop; they come back when you run again.
- **The push says little.** A phone, a desktop banner and a chat message see "Flow needs you in 2 projects", never your title, key or project name, and at most once an hour per extension however many decisions stand; one still waiting when the hour is up gets its own push then.

#### `ctx.requirePerson`

Express middleware that admits only a person: the same bar as approving an extension. Put it in front of every route that changes state on a person's behalf (settings, pause and resume):

```typescript
router.put('/settings', ctx.requirePerson, saveSettings);
router.use('/admin', ctx.requirePerson); // a whole sub-router
```

An agent that names itself is refused with "Only a person can change Flow's settings." (`extension_person_required`), and so is a request from another site. With Require login on it needs the person's cookie. Say the residual honestly: with Require login off, a local caller that does not name itself an agent passes, and in any posture your own page code does. Routes without it stay open. Decisions are not answered through your own routes: use `ctx.inbox`.

#### `ctx.projectSettings`

The read side of `api.projectSettings`: `get(projectRoot)` and `onChange(listener)`, called with the project root when a person changes it. There is no setter here on purpose.

#### Feature detection

Probe for a seam instead of checking the host version, so one build runs on hosts from before and after it: `ctx.inbox !== undefined`, `typeof ctx.requirePerson === 'function'`, `ctx.projectSettings !== undefined`, `typeof api.answerDecision === 'function'`, `'requireLogin' in api.getState()`.

### Route Conventions

Routes registered on the `router` are mounted at `/api/ext/{id}/`:

```typescript
router.get('/status', handler); // GET  /api/ext/my-ext/status
router.post('/action', handler); // POST /api/ext/my-ext/action
router.get('/deep/path', handler); // GET  /api/ext/my-ext/deep/path
```

From the client-side `index.ts`, call your server routes via `fetch`:

```typescript
const res = await fetch('/api/ext/my-extension/status');
const data = await res.json();
```

---

## Secrets

Extensions that contact external APIs need credentials. DorkOS provides an encrypted per-extension secret store with automatic settings UI generation.

### Declaring Secrets

Add a `serverCapabilities` block to `extension.json`:

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "serverCapabilities": {
    "serverEntry": "./server.ts",
    "secrets": [
      {
        "key": "api_key",
        "label": "API Key",
        "description": "Get your key at https://example.com/settings",
        "placeholder": "sk_live_xxxxxxxxxxxx",
        "required": true,
        "group": "Authentication"
      }
    ]
  }
}
```

| Secret field  | Required | Description                                                                     |
| ------------- | -------- | ------------------------------------------------------------------------------- |
| `key`         | Yes      | Lowercase alphanumeric with underscores. Must match `^[a-z][a-z0-9_]*$`.        |
| `label`       | Yes      | Human-readable name for the settings UI.                                        |
| `description` | No       | Help text shown below the input field.                                          |
| `placeholder` | No       | Custom placeholder hint for the password input (e.g., `lin_api_xxxx`).          |
| `required`    | No       | Whether the extension cannot function without this secret. Defaults to `false`. |
| `group`       | No       | Group name for collapsible section organization in the settings UI.             |

### Security Properties

- **Encrypted at rest**: AES-256-GCM with a per-host derived key (scrypt). Stored at `{dorkHome}/extension-secrets/{id}.json`.
- **Per-extension isolation**: Each extension has its own encrypted file. Extensions cannot read other extensions' secrets.
- **Write-only settings UI**: The settings panel shows a masked placeholder when a secret is set. Secret values are never sent to the browser.
- **Server-only access**: Secrets are only accessible via `ctx.secrets` in `server.ts`. Client-side `index.ts` cannot read secrets.

### Settings UI Auto-Generation

When an extension declares secrets in `serverCapabilities.secrets`, DorkOS automatically generates a settings tab. Each secret gets:

- A label and optional description from the manifest
- A password input field (never displays the stored value)
- A masked indicator when a secret is set
- A clear button to remove the secret

You can also build a custom settings tab using `api.registerSettingsTab` in `index.ts` and manage secrets via the REST API:

```typescript
// List secrets (returns isSet status, never values)
GET /api/extensions/{id}/secrets

// Set a secret
PUT /api/extensions/{id}/secrets/{key}
Body: { "value": "sk-..." }

// Delete a secret
DELETE /api/extensions/{id}/secrets/{key}
```

---

## Settings Declaration

Declare non-secret configuration fields in `serverCapabilities.settings`. The host auto-generates a settings form — no UI code required.

> **Secrets vs Settings**: Use `secrets` for credentials, API keys, and tokens — these are encrypted at rest and never sent to the browser. Use `settings` for everything else: refresh intervals, display toggles, filter selections, label prefixes. Settings are stored as plaintext JSON.

### Setting Types

| Type      | Input Component | Save Behavior          | Extra Properties            |
| --------- | --------------- | ---------------------- | --------------------------- |
| `text`    | Text input      | Explicit save button   | `placeholder`               |
| `number`  | Number input    | Explicit save button   | `placeholder`, `min`, `max` |
| `boolean` | Toggle switch   | Immediate on toggle    | —                           |
| `select`  | Dropdown        | Immediate on selection | `options` (required)        |

### Setting Fields

| Field         | Type                  | Required   | Description                                   |
| ------------- | --------------------- | ---------- | --------------------------------------------- |
| `type`        | string                | Yes        | One of: `text`, `number`, `boolean`, `select` |
| `key`         | string                | Yes        | Setting key (lowercase snake_case)            |
| `label`       | string                | Yes        | Human-readable label for the settings UI      |
| `description` | string                | No         | Help text shown below the input               |
| `placeholder` | string                | No         | Placeholder text for text/number inputs       |
| `default`     | string/number/boolean | No         | Default value used when no override is stored |
| `required`    | boolean               | No         | Whether the extension requires this setting   |
| `group`       | string                | No         | Group name for collapsible section            |
| `options`     | `{label, value}[]`    | For select | Options for select-type fields                |
| `min`         | number                | No         | Minimum value (number fields only)            |
| `max`         | number                | No         | Maximum value (number fields only)            |

### Grouping

When secrets and settings share the same `group` value, they render together in a collapsible section. Ungrouped items appear at the top. Within each group, secrets render before settings.

### Complete Example Manifest

A manifest declaring both secrets (with placeholder and group) and settings:

```json
{
  "id": "github-sync",
  "name": "GitHub Sync",
  "version": "1.0.0",
  "serverCapabilities": {
    "serverEntry": "./server.ts",
    "secrets": [
      {
        "key": "github_token",
        "label": "GitHub Token",
        "description": "Personal access token with repo scope",
        "placeholder": "ghp_xxxxxxxxxxxx",
        "group": "GitHub",
        "required": true
      },
      {
        "key": "linear_api_key",
        "label": "Linear API Key",
        "placeholder": "lin_api_xxxx",
        "group": "Linear"
      }
    ],
    "settings": [
      {
        "type": "number",
        "key": "refresh_interval",
        "label": "Refresh Interval",
        "description": "How often to poll for updates (seconds)",
        "default": 60,
        "min": 10,
        "max": 3600
      },
      {
        "type": "boolean",
        "key": "show_archived",
        "label": "Show Archived Issues",
        "default": false,
        "group": "GitHub"
      },
      {
        "type": "select",
        "key": "sort_order",
        "label": "Sort Order",
        "options": [
          { "label": "Newest first", "value": "desc" },
          { "label": "Oldest first", "value": "asc" }
        ],
        "default": "desc"
      },
      {
        "type": "text",
        "key": "label_prefix",
        "label": "Label Prefix",
        "description": "Prefix added to synced issue labels",
        "placeholder": "sync:",
        "group": "GitHub"
      }
    ]
  },
  "contributions": {
    "dashboard.sections": true
  }
}
```

### Accessing Settings in `server.ts`

Read and write settings values via `ctx.settings`:

```typescript
const register: ServerExtensionRegister = (router, ctx) => {
  router.get('/config', async (_req, res) => {
    const interval = await ctx.settings.get<number>('refresh_interval');
    const all = await ctx.settings.getAll();
    res.json({ interval: interval ?? 60, all });
  });

  ctx.schedule(60, async () => {
    const showArchived = await ctx.settings.get<boolean>('show_archived');
    // Fetch data with the user's configured preferences...
  });
};

export default register;
```

---

## Declarative Proxy

For extensions that only need to forward requests to an external API with authentication, the **declarative proxy** avoids writing any server code. Add a `dataProxy` field to `extension.json`:

```json
{
  "id": "github-proxy",
  "name": "GitHub API Proxy",
  "version": "1.0.0",
  "serverCapabilities": {
    "secrets": [
      {
        "key": "github_token",
        "label": "GitHub Token",
        "required": true
      }
    ]
  },
  "dataProxy": {
    "baseUrl": "https://api.github.com",
    "authHeader": "Authorization",
    "authType": "Bearer",
    "authSecret": "github_token"
  }
}
```

### Configuration

| Field         | Required | Default         | Description                                                                        |
| ------------- | -------- | --------------- | ---------------------------------------------------------------------------------- |
| `baseUrl`     | Yes      | —               | Upstream API base URL. A query or fragment on it is ignored (warned once at load). |
| `authHeader`  | No       | `Authorization` | HTTP header name for the credential.                                               |
| `authType`    | No       | `Bearer`        | How the secret is formatted: `Bearer`, `Basic`, `Token`, or `Custom`.              |
| `authSecret`  | Yes      | —               | Key name in the extension's secret store.                                          |
| `pathRewrite` | No       | —               | Object mapping regex patterns to replacements.                                     |

**Auth type formatting:**

| `authType` | Header value           |
| ---------- | ---------------------- |
| `Bearer`   | `Bearer {secret}`      |
| `Basic`    | `Basic {secret}`       |
| `Token`    | `Token {secret}`       |
| `Custom`   | `{secret}` (raw value) |

### How It Works

Proxy routes are auto-mounted at `/api/ext/{id}/proxy/*`. The proxy:

1. Throttles the route to 120 requests per minute per IP — every call spends the operator's upstream credential
2. Confines the caller's sub-path to `baseUrl`: the joined URL is parsed, and anything that leaves the base origin or climbs above the base path (`..`, `..%2f`, `%2e%2e`) is refused with `400`
3. Strips hop-by-hop headers, every header that authenticates the CALLER to DorkOS (`cookie`, `authorization`, `x-dorkos-agent`) — the upstream is a third party and never sees them — and `content-length`, which describes the caller's bytes while the proxy re-serializes the body
4. Retrieves the auth secret from the encrypted store
5. Injects the formatted auth header
6. Forwards the request to `{baseUrl}/{remaining-path}`
7. Applies `pathRewrite` rules if configured (author-controlled, so they run after the caller's path is checked) and then re-runs the confinement check: the first check sees the normalized URL and the rewrite edits the raw string, so a caller path that cancels itself out (`legacy/../admin`) can be un-cancelled by an ordinary prefix-stripping rule. A rewrite whose result leaves `baseUrl` is refused with the same `400`
8. Returns the upstream response with its status code and content type

Redirects are **not followed**. A 3xx comes back to the caller with its `Location` header intact, so the injected credential can never be replayed to whatever an upstream (or an open redirect on it) points at.

From the client:

```typescript
// This becomes GET https://api.github.com/user/repos
const res = await fetch('/api/ext/github-proxy/proxy/user/repos');
```

### Error Responses

| Status | Condition                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------- |
| `400`  | The requested path leaves `baseUrl` (`code: PROXY_PATH_NOT_ALLOWED`).                          |
| `429`  | More than 120 requests per minute from one IP (`code: PROXY_RATE_LIMITED`).                    |
| `503`  | Required secret is not configured. Response includes a `hint` with the PUT endpoint to set it. |
| `502`  | Upstream network failure.                                                                      |

### When to Use Proxy vs Data Provider

Use **declarative proxy** when:

- You need simple API passthrough with auth injection
- No server-side data transformation is needed
- No caching, polling, or background tasks are needed

Use **data provider** (`server.ts`) when:

- You need to transform, aggregate, or cache API responses
- You need background polling with `ctx.schedule()`
- You need to emit SSE events to connected clients
- You need custom business logic beyond request forwarding

Both can coexist in the same extension — use the proxy for simple endpoints and `server.ts` routes for complex ones.

---

## Background Tasks

Background tasks use `ctx.schedule()` to poll external APIs, detect changes, and notify clients. The canonical pattern is **poll, compare, store, emit**:

```typescript
const register: ServerExtensionRegister = (router, ctx) => {
  ctx.schedule(60, async () => {
    // 1. Poll — fetch fresh data from the external API
    const apiKey = await ctx.secrets.get('api_key');
    if (!apiKey) return; // Skip if not configured
    const fresh = await fetchExternalData(apiKey);

    // 2. Compare — check if anything changed
    const prev = await ctx.storage.loadData<{ hash?: string }>();
    const hash = JSON.stringify(fresh);
    if (hash === prev?.hash) return; // No change

    // 3. Store — persist the new data
    await ctx.storage.saveData({ data: fresh, hash, updatedAt: Date.now() });

    // 4. Emit — notify connected clients
    ctx.emit('data-updated', fresh);
  });
};

export default register;
```

### Lifecycle

- **Startup**: Scheduled tasks begin running when the extension's server side is initialized (triggered by `POST /api/extensions/{id}/init-server` during client-side activation).
- **Error isolation**: If `fn` throws, the error is logged and the schedule continues. One bad tick does not stop future ticks.
- **Cleanup**: All scheduled intervals are cleared automatically when the extension is disabled, reloaded, or the server shuts down. You can also cancel manually via the returned function.
- **No overlap protection**: If a tick takes longer than the interval, the next tick fires independently. Use a flag or mutex if your task is expensive.

---

## Reference Extension: Linear Loop

The `apps/server/src/core-extensions/linear-issues/` directory contains a production-quality extension demonstrating the extension API surface: server-side data providers, manifest-driven settings, a dashboard section, and command palette integration. It shows Loop-categorized Linear issues on the DorkOS dashboard. Linear Loop is a default-off [core extension](#core-extensions) — it incubates here until `@dorkos/extension-api` is published and it migrates to the marketplace.

### Files

```
apps/server/src/core-extensions/linear-issues/
├── extension.json   # Manifest with secrets, settings (grouped), and slot contributions
├── server.ts        # Data provider: Loop-aware queries, categorization, dynamic polling
└── index.ts         # Client: dashboard section, command palette item
```

### What It Demonstrates

**Manifest** (`extension.json`):

- `serverCapabilities.secrets` with `group` and `placeholder` fields — the host auto-generates a grouped settings tab
- `serverCapabilities.settings` declaring typed settings (text, number, boolean, select) across two groups (Connection, Display)
- `contributions` for `dashboard.sections`
- A setting for toggling dashboard visibility (`show_dashboard`)

**Server** (`server.ts`):

- Loop-aware GraphQL query fetching active + recently completed issues with label data
- Server-side categorization by Loop stage (triage, ready, in-progress, monitoring, needs-input, completed)
- Loop health summary (counts per category) with change detection
- Dynamic poll interval from `ctx.settings.get('refresh_interval')`
- Team key from `ctx.settings.get('team_key')` for multi-team support
- Legacy endpoints (`/issues`, `/cached`) preserved alongside new `/loop` endpoint
- SSE emission via `ctx.emit('loop.updated', data)` on change detection

**Client** (`index.ts`):

- Dashboard section with Loop health badges and categorized issue sections
- Three view modes: Loop Status (default), By Project, All Active
- Command palette item ("Quick Idea to Linear")
- Settings-driven visibility: the `show_dashboard` toggle
- A `useLoopData` hook feeding the dashboard section

To use it: enable "Linear Loop" under **Core extensions** in Settings > Extensions, then configure your Linear API key and team key in the extension's settings tab.

---

## Agent-Built Extensions

DorkOS agents (Claude Code, Cursor, Windsurf) can create and manage extensions autonomously via MCP tools. The agent writes files to disk, compiles, tests, and reloads — the user sees the result in the DorkOS client immediately. No manual file creation or settings toggling required.

### MCP Tools Reference

Six MCP tools provide the complete extension lifecycle:

| Tool                   | Parameters                                    | Description                                                        |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `get_extension_api`    | None                                          | Full ExtensionAPI type definitions and usage examples as markdown  |
| `list_extensions`      | None                                          | List all extensions with status, scope, and errors                 |
| `create_extension`     | `name`, `description?`, `template?`, `scope?` | Scaffold, compile, and enable a new extension in one step          |
| `reload_extensions`    | `id?`                                         | Recompile all extensions, or a single extension by ID (hot reload) |
| `get_extension_errors` | None                                          | Get only extensions in an error state with diagnostic details      |
| `test_extension`       | `id`                                          | Headless smoke test: compile + activate against mock API           |

Compiling is always allowed. **Running** an extension's code in the server process is not, until a person has allowed that extension once — see [Step 4](#step-4-the-one-time-approval-dor-516).

### Agent Workflow

The recommended iteration loop:

```
1. get_extension_api         # Understand the API surface
2. create_extension          # Scaffold with a starter template
3. Edit index.ts             # Write the extension logic
4. Ask the person to allow it   # ONCE per extension, in Settings > Extensions
5. test_extension            # Verify compilation and activation (headless)
6. reload_extensions --id    # Hot-reload into the running client
7. Iterate from step 3       # Fix errors, add features
```

The `create_extension` tool handles scaffolding, compilation, and enabling in a single call. After that, the edit-test-reload cycle is the core loop. Use `test_extension` for fast headless validation before triggering a visual reload.

### Step 4: the one-time approval (DOR-516)

An extension runs in two places, and the approval covers both:

- **In the server process.** `test_extension` and the server half of `reload_extensions --id` execute the extension's code with the server's own privileges, outside the tier gate.
- **In the cockpit page.** `GET /api/extensions/:id/bundle` serves the client bundle the browser `import()`s and `activate()`s. That is same-origin JavaScript carrying the person's session, so it is not a lesser place to run — it can call the API as the operator, including the route that approves the server half.

So a person allows each extension once, before any of its code runs anywhere, and after that the loop above is unprompted.

What this looks like in practice:

- The **first** `test_extension` or server-entry load for a new extension is refused, with a message naming the extension and telling you to ask the person to allow it in **Settings > Extensions**. Retrying without that is refused identically.
- Its client bundle is not served either, so the extension contributes nothing to the cockpit until the person answers. `GET /api/extensions/:id/bundle` returns 404, the same as an extension that has not compiled.
- The person turns it on, once: **Turn it on** on the extension's card in Settings > Extensions, or 👍 on its row in the Activity inbox (below). Both halves start immediately; no restart, no page reload.
- **Every** later call goes through: editing, testing, reloading, a compile error, and the fix after it. Turning the extension off and on again does not re-ask. Approval is recorded per extension id **and copy** — the directory, plus the plugin that carries it when it came inside one (`extensions.approvedSources`, DOR-2383) — and is never spent by use. It is not tied to file contents, so edits never re-ask; another plugin or path carrying the same id does.
- A marketplace **uninstall clears it**, and any "Not now" for the removed copy, so a reinstall re-asks. An **update from the same plugin keeps it** for every extension the new version still carries (the same copy at the same path, like an edit); an extension the new version drops loses it and asks again if it returns (DOR-2383). What an approval must not survive is different code from somewhere else arriving under a familiar name. Removing a package leaves alone an approval recorded for a copy of the same id outside that package.

**The Activity inbox asks too (DOR-2517).** Every installed extension that is waiting — `origin: 'user'`, not approved for its current copy, not turned off, invalid or incompatible — raises one row in the inbox bell's "Needs You": "Turn on <Name>?", a second line built from the manifest, the source line, and ⓘ 👎 👍. `GET /api/extensions/pending-approvals` lists them; the kind is `extension.approval`, tier `notable`, so it badges the bell and **never pushes to a phone**. The second line has three parts. The first and last are DorkOS's own words: how the copy got here, read from the installer's own records ("You installed the flow plugin from dork-labs/marketplace." only when the installer recorded it; otherwise "<Name> was added to <project>." — neutral on purpose, since that covers both `create_extension` and a folder the person copied in by hand, and DorkOS cannot tell them apart), and "It runs as you." The middle comes from the manifest, which the extension's author writes, so it is the part that is cut: the whole line stays within 300 characters, names are capped at 60, and "It runs as you." always survives. Example: "You installed the flow plugin from dork-labs/marketplace. This adds a Flow tab that shows what your agents are working on. It runs as you." The middle names what the extension adds from `contributions` (`right-panel` is "a <Name> tab", `settings.tabs` is "a <Name> settings page") followed by the optional manifest field `purpose` (at most 120 characters, written to finish the sentence "This adds a Flow tab that …"), and falls back to `description` when `contributions` says nothing. Declare both if you want the row to say what your extension is for.

Both answers name the exact copy the row showed (path, plugin and version; the Settings card, which is never told a path, sends the version and plugin it shows): `POST /api/extensions/:id/approve` takes that as an optional body and refuses `409 stale_approval` when the copy on disk is no longer it, so a click on an old row can never turn on a copy that took its place. **Stop it** on the Settings card counts as the same answer given later: it records a "Not now" for that copy, so the ask does not come straight back to the bell.

👎 **Not now** (`POST /api/extensions/:id/dismiss-approval`, same person bar as approving) is never destructive: it uninstalls, disables and revokes nothing, and Settings > Extensions can still turn the extension on. It records the copy and version the person declined in `extensions.dismissedApprovals`, so the inbox stops asking until the extension's path, plugin or version changes — an update asks again. Approving clears it. There is no MCP tool for it either.

**Trusted sources (spec `flow-multiproject` §9.3).** When a person turns on a copy with a trusted origin whose source they do not trust yet, the approve response carries `trustOffer: { source }`, and the bell shows one green line under the answered row: "Next time, trust everything from dork-labs/marketplace? Yes". It shows once, on that device only: it goes when answered, dismissed, when the bell closes, or after 15 minutes, and is never stored or pushed. **Yes** calls `POST /api/extensions/trusted-sources` `{ source }`, which adds it to `extensions.trustedSources`; from then on any copy whose trusted origin names that source may run with no `extension.approval` row. Trusting a new code source is one of the asks only a person answers: both that route and `DELETE /api/extensions/trusted-sources` (Settings > Extensions > Trusted sources, "Stop trusting") run the same person bar as approving, `trustedSources` is `operator-only`, and no `ExtensionAPI` member or MCP tool reaches them. The residual is invariant 9's: with login off, a local caller that sends no agent header passes, and an approved extension's own browser code shares the page. A source is accepted only if some installed copy provably comes from it. Stopping keeps every extension from the source that is turned on running as it is: each one that ran only because of the source is given its own approval, pinned to that exact copy (its folder and plugin, never the origin) and, for a project copy, to its files' digest (`approvedSources[id].digest`), so it keeps running from its verified snapshot and any later change in the project asks again. A turned-off extension, a newer copy and a new extension from the source all wait for a person's yes again.

Everything that is not execution still works while you wait, which is what makes the wait cheap: you can create and edit files, and compiling reports real errors. Only running is held back.

There is deliberately **no MCP tool to approve an extension**. The record lives in `~/.dork/config.json` at `extensions.approvedToRun`, classified `operator-only`, so the agent surface is refused it everywhere — an agent that could write it would be approving its own code. Core extensions (`origin: 'core'`) ship inside DorkOS and are exempt by origin, so they never need this — and `origin` is derived from the record's path under `{dorkHome}/extensions`, so a `{cwd}/.dork/extensions/<core-id>` directory does not inherit the exemption; it is ignored outright, as is a project directory (or a plugin installed into the project) reusing the id of an extension the person approved for another copy. Full reasoning: `apps/server/src/services/extensions/extension-load-policy.ts`.

`reload_extensions --id` also refuses an extension the user has turned **off**, rather than quietly turning it back on. Turn it on in Settings first.

### Template Types

The `create_extension` tool accepts a `template` parameter:

**`dashboard-card`** (default) — Registers a React component in the `dashboard.sections` slot. Produces a styled card with heading and description. Good starting point for data display extensions.

**`right-panel-tab`** — Adds a tab to the shell's right panel (the contextual inspector) via the `right-panel` slot. The starter template ships a labelled tab with an inline-SVG tab icon and a placeholder body. Use for at-a-glance context beside the chat. See [Right-panel tabs](#right-panel-tabs).

**`command`** — Registers a command palette item (`Cmd+K`). The starter template fires a toast notification on execution. Use for action-oriented extensions that do not need a persistent UI.

**`settings-panel`** — Registers a tab in the settings dialog. The starter template includes a settings panel skeleton with `loadData`/`saveData` hooks for persistence. Use for extensions that need user configuration.

**`data-provider`** — Full-stack extension with both `index.ts` (dashboard card + settings tab) and `server.ts` (Express routes + background polling). The manifest includes `serverCapabilities` with a sample secret declaration. Use for extensions that fetch from external APIs. See [Server-Side Data Providers](#server-side-data-providers) for details.

All templates include an inline API Quick Reference comment at the top of their entry files listing the most common methods and all available slot names. Templates compile and activate out of the box — the agent can modify from a known-working baseline.

### Scope: Global vs Local

The `scope` parameter controls where the extension is installed:

- **`global`** (`~/.dork/extensions/{id}/`) — Available in all projects. Use for general-purpose utilities.
- **`local`** (`.dork/extensions/{id}/` in the active CWD) — Scoped to the current project. Use for project-specific dashboards or tools.

When the same extension ID exists in both scopes, local overrides global. When the user switches projects (CWD change), local extensions are re-scanned and the client reloads automatically.

Default scope for `create_extension` is `global`.

### Error Handling

Agents can diagnose and fix errors autonomously using structured error feedback:

**Compilation errors** — Returned by `test_extension` and `reload_extensions` with file, line, and column information:

```json
{
  "status": "error",
  "phase": "compilation",
  "errors": [
    { "text": "Expected ';'", "location": { "file": "index.ts", "line": 12, "column": 5 } }
  ]
}
```

**Activation errors** — Returned by `test_extension` when the extension compiles but throws during `activate()`:

```json
{
  "status": "error",
  "phase": "activation",
  "error": "Cannot read property 'registerComponent' of undefined",
  "stack": "TypeError: ..."
}
```

**Diagnostic workflow:**

1. Call `get_extension_errors` to see all extensions with problems
2. Read the structured error (phase, message, location)
3. Edit the source file to fix the issue
4. Call `test_extension` to verify the fix (headless, sub-300ms)
5. Call `reload_extensions --id` to push the fix to the client

### What Agents Should Not Do

- **Do not `import React from 'react'`.** React is on the global scope. Bare imports produce unresolvable module specifiers at runtime. Use `import type` for type-only imports (erased at compile time).
- **Do not create `node_modules` or install npm packages.** Extensions cannot have external dependencies beyond `react`, `react-dom`, and `@dorkos/extension-api` (provided by the host).
- **Do not modify `extension.json` after creation** unless changing metadata. The `id` field must remain stable.
- **Do not write to extension directories owned by other extensions.** Each extension has an isolated directory.
- **Do not create extensions that import from `@dorkos/shared` or server internals.** Only `@dorkos/extension-api` is available at runtime.

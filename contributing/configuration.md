# Configuration

DorkOS uses a persistent config file at `~/.dork/config.json` for user-configurable settings. The config system is built on the `conf` library with Zod schema validation, providing atomic writes, type safety, and automatic corruption recovery.

## Quick Start

Run the interactive setup wizard on first install:

```bash
dorkos init
```

Or accept all defaults non-interactively:

```bash
dorkos init --yes
```

Set individual values:

```bash
dorkos config set server.port 8080
dorkos config set ui.theme dark
```

View current settings:

```bash
dorkos config
```

## Config File Location

The config file lives at `~/.dork/config.json` by default. The `~/.dork/` directory is created automatically on first CLI startup.

Override the config directory by setting the `DORK_HOME` environment variable:

```bash
export DORK_HOME=/custom/path
dorkos config path
# /custom/path/config.json
```

## Runtime Data File Locations

DorkOS writes several runtime data files under `~/.dork/` in addition to `config.json`. The root directory is overridden by `DORK_HOME`.

| Path                          | Purpose                                                        |
| ----------------------------- | -------------------------------------------------------------- |
| `~/.dork/config.json`         | Persistent user config (this document)                         |
| `~/.dork/dork.db`             | SQLite database (Tasks, Mesh, Relay state; WAL mode)           |
| `~/.dork/schedules.json`      | JSON snapshot of Tasks schedules                               |
| `~/.dork/logs/dorkos.log`     | NDJSON server log with daily rotation                          |
| `~/.dork/relay/adapters.json` | Relay adapter config — hot-reloaded by AdapterManager          |
| `~/.dork/relay/index.db`      | SQLite index for Relay message delivery and trace data         |
| `~/.dork/relay/bindings.json` | Adapter-to-agent binding definitions — hot-reloaded at runtime |
| `~/.dork/relay/sessions.json` | Binding session map persisted across server restarts           |
| `~/.dork/relay/`              | Relay Maildir message store (subdirectories per subject)       |

### Relay config (`~/.dork/relay/adapters.json`)

The Relay subsystem reads adapter configuration from `~/.dork/relay/adapters.json`. This file is watched with chokidar and hot-reloaded whenever it changes — no server restart is required. Each entry follows the adapter manifest format: a `type` field matching a registered adapter, plus a `config` object whose shape is defined by the adapter's `ConfigField` schema. Sensitive config fields (marked `sensitive: true` in the manifest) are masked to `***` in API responses.

### Relay bindings (`~/.dork/relay/bindings.json`)

Adapter-to-agent bindings are persisted to `~/.dork/relay/bindings.json`. The file is also hot-reloaded via chokidar. Bindings map inbound adapter messages to specific agent CWDs using a most-specific-first resolution strategy. The companion file `~/.dork/relay/sessions.json` stores the active session map so that per-chat and per-user session strategies survive server restarts.

## Settings Reference

| Key                                              | Type                                                                     | Default            | Description                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.port`                                    | integer (1024--65535)                                                    | `4242`             | Port the Express server listens on                                                                                                                                                                                                                                                                                                                               |
| `server.cwd`                                     | string \| null                                                           | `null`             | Default working directory for sessions                                                                                                                                                                                                                                                                                                                           |
| `server.boundary`                                | string \| null                                                           | `null`             | Directory boundary root (`null` = home directory)                                                                                                                                                                                                                                                                                                                |
| `server.open`                                    | boolean                                                                  | `true`             | Open browser automatically on startup                                                                                                                                                                                                                                                                                                                            |
| `tunnel.enabled`                                 | boolean                                                                  | `false`            | Enable ngrok tunnel on startup                                                                                                                                                                                                                                                                                                                                   |
| `tunnel.domain`                                  | string \| null                                                           | `null`             | Custom ngrok domain                                                                                                                                                                                                                                                                                                                                              |
| `tunnel.authtoken`                               | string \| null                                                           | `null`             | ngrok auth token (sensitive)                                                                                                                                                                                                                                                                                                                                     |
| `tunnel.auth`                                    | string \| null                                                           | `null`             | HTTP basic auth for tunnel, `user:pass` format (sensitive)                                                                                                                                                                                                                                                                                                       |
| `logging.level`                                  | `"fatal"` \| `"error"` \| `"warn"` \| `"info"` \| `"debug"` \| `"trace"` | `"info"`           | Log verbosity level                                                                                                                                                                                                                                                                                                                                              |
| `logging.maxLogSizeKb`                           | integer (100--10240)                                                     | `500`              | Maximum log file size in KB before rotation                                                                                                                                                                                                                                                                                                                      |
| `logging.maxLogFiles`                            | integer (1--30)                                                          | `14`               | Number of rotated log files to retain                                                                                                                                                                                                                                                                                                                            |
| `ui.theme`                                       | `"light"` \| `"dark"` \| `"system"`                                      | `"system"`         | UI color theme                                                                                                                                                                                                                                                                                                                                                   |
| `ui.dismissedUpgradeVersions`                    | string[]                                                                 | `[]`               | Version strings the user has dismissed upgrade notifications for                                                                                                                                                                                                                                                                                                 |
| `ui.sidebar`                                     | object                                                                   | see below          | Sidebar organization (DOR-329, DOR-339, DOR-525, DOR-579, sidebar-now-today-library): pinned items, user-defined groups, muted items/groups, per-section collapse/sort/filter state under `sections`, the Getting-started suggestions this person has retired, and the date the welcome-back digest last appeared                                                |
| `ui.shapes`                                      | object                                                                   | see below          | Shape state (DOR-355): active Shape, reverse affinity hints (agent → Shape), and the follow toggle                                                                                                                                                                                                                                                               |
| `ui.statusBar`                                   | object                                                                   | `{ pins: [] }`     | Status-line pins (DOR-431, DOR-452): `pins` lists the items to show even when the line would stay quiet (`cwd`, `git`, `runtime`, `model`, `context`, `usage`, `permission`). Nothing pinned by default; syncs across clients and agents can set it via `config_patch`                                                                                           |
| `ui.promos.dismissedIds`                         | string[]                                                                 | `[]`               | Which feature-promo cards this person has waved away, by promo id (spec `sidebar-simplification` D4). Written by the `×` on the sidebar's bottom card. Server-held rather than per-browser, so a dismissal on a laptop settles it on a phone; unknown ids are kept, so a promo that returns under the same id stays dismissed                                    |
| `ui.composer.richText`                           | boolean                                                                  | `true`             | Whether the message box shows formatting as you type — bold, headings and lists take shape while you write (DOR-948). Ships **on** (owner decision, 2026-08-12), and only the chat composer reads it; rooms and onboarding stay plain. The Settings → Advanced switch is the way back to the plain box                                                           |
| `ui.autonomyAcknowledgedAt`                      | string (ISO 8601) \| null                                                | `null`             | When this person read what Full autonomy means and ticked "don't show this again" (spec `trust-dial`, decision 5). The cockpit sends this standing acknowledgement with every autonomy PATCH; `PATCH /api/sessions/:id` answers `428 AUTONOMY_ACK_REQUIRED` without one. `operator-only` to write — it records a person's consent, not a preference              |
| `ui.fullPowerDecidedAt`                          | string (ISO 8601) \| null                                                | `null`             | When this person answered the full-power door, either way (spec `full-power-defaults`, D1). The single "already asked" signal for both the onboarding power stage and the one-time modal: non-null means never ask again. Records an answer only — it grants nothing, which is why it is `no-risk` in the safe-defaults table and still `operator-only` to write |
| `ui.fullPowerChoice`                             | `'full'` \| `'supervised'` \| null                                       | `null`             | What they chose at that door. `'supervised'` is a first-class answer that changes nothing anywhere; choosing it and moving to full power later is a normal path (the Control Center that offers that in one click lands with task 2.2). Pre-selects `canInitiate` on a new adapter binding when it reads `'full'`. `operator-only` to write                      |
| `notifications.escalation.phoneAfterMinutes`     | `1` \| `2` \| `5` \| `15` \| `"never"`                                   | `2`                | How long something may sit waiting on you here before DorkOS tries to reach you somewhere else; `"never"` keeps everything on this computer. **Nothing reads it yet** (spec `notification-system`): the ladder that would act on it, a phone or a chat app, is later work. `operator-only` to write                                                              |
| `notifications.sounds.knock`                     | boolean                                                                  | `true`             | A soft double-knock when an agent stops and needs you. `operator-only` to write                                                                                                                                                                                                                                                                                  |
| `notifications.sounds.allClear`                  | boolean                                                                  | `true`             | A gentle chime when the last thing waiting on you is answered. `operator-only` to write                                                                                                                                                                                                                                                                          |
| `notifications.sounds.turnEnd`                   | boolean                                                                  | `false`            | A chime every time any turn finishes. Ships **off**, having been on for everyone and held per browser in `localStorage` under `dorkos-enable-notification-sound`; the cockpit reads that key once, keeps an explicit `true`, and deletes it either way. `operator-only` to write                                                                                 |
| `notifications.notifyOnTurnCompleteWhileAway`    | boolean                                                                  | `true`             | Whether news that blocks nothing (a turn that finished, a message addressed to you) may raise a browser notification while the window is hidden. One switch for the whole class rather than a per-kind matrix, and never consulted while the window is visible. `operator-only` to write                                                                         |
| `notifications.browserPermissionPrimerDismissed` | boolean                                                                  | `false`            | Whether this person has answered the one-time card that asks for browser-notification permission. Set by pressing either of its buttons, so "Not now" settles it as firmly as "Turn on notifications". `operator-only` to write                                                                                                                                  |
| `relay.enabled`                                  | boolean                                                                  | `true`             | Enable Relay subsystem (config-level toggle, distinct from `DORKOS_RELAY_ENABLED`)                                                                                                                                                                                                                                                                               |
| `relay.dataDir`                                  | string \| null                                                           | `null`             | Override Relay data directory (`null` = default under `DORK_HOME`)                                                                                                                                                                                                                                                                                               |
| `a2a.enabled`                                    | boolean                                                                  | `false`            | Mount the external A2A gateway — an agent card plus a JSON-RPC address outside agents can post work to. **Experimental**, listed in the [Experiments registry](#experimental-fields); needs `relay.enabled`. `DORKOS_A2A_ENABLED` overrules it in both directions when present, and the Settings switch then reports itself locked. `operator-only` to write     |
| `scheduler.enabled`                              | boolean                                                                  | `true`             | Enable Tasks scheduler subsystem (config-level toggle)                                                                                                                                                                                                                                                                                                           |
| `scheduler.maxConcurrentRuns`                    | integer (1--10)                                                          | `4`                | How many scheduled runs may be in flight at once. Raised from `1` in `0.67.0` (spec `full-power-defaults`, D1): one at a time meant a slow run held up every schedule behind it. A throttle, not a capability — the bounds are unchanged and every run still passes the same gates                                                                               |
| `scheduler.timezone`                             | string \| null                                                           | `null`             | Default timezone for cron expressions (`null` = system timezone)                                                                                                                                                                                                                                                                                                 |
| `scheduler.retentionCount`                       | integer                                                                  | `100`              | Number of completed run records to retain in the database                                                                                                                                                                                                                                                                                                        |
| `mesh.scanRoots`                                 | string[]                                                                 | `[]`               | Directories to scan for agent discovery                                                                                                                                                                                                                                                                                                                          |
| `connectors.rawMcpServers`                       | array of `{ slug, displayName, url, transport }`                         | `[]`               | Remote MCP servers the raw-MCP connector offers as connectable services (`transport`: `http` \| `sse`). Read at boot; edits take effect on the next server start                                                                                                                                                                                                 |
| `rooms.turnLimitsEnabled`                        | boolean                                                                  | `true`             | Whether automatic replies are limited at all. Off means no reply ceiling and no hourly cap — the Stop button is the only brake                                                                                                                                                                                                                                   |
| `rooms.maxAgentDepth`                            | integer (0--100)                                                         | `30`               | How many replies in a row agents may send each other in a room before it stops them. Your own messages reset the count; `0` turns automatic replies off                                                                                                                                                                                                          |
| `rooms.maxTurnsPerAgentPerCascade`               | integer (1--100)                                                         | `10`               | How many TURNS any ONE agent may take in a single back-and-forth (progress notes it posts mid-turn do not count extra)                                                                                                                                                                                                                                           |
| `rooms.maxAutomaticTurnsPerRoomPerHour`          | integer (0--10000)                                                       | `1000`             | The most automatic replies any ONE room may run per hour, counted whoever the caller claims to be                                                                                                                                                                                                                                                                |
| `rooms.maxAutomaticTurnsTotalPerHour`            | integer (0--100000)                                                      | `5000`             | The most automatic replies this DorkOS may run per hour across every room. The ceiling on what automatic replies can cost                                                                                                                                                                                                                                        |
| `rooms.replyWaitMinutes`                         | integer (1--120)                                                         | `10`               | How long a room waits for an agent's answer before carrying on. The agent is not stopped; a late answer is posted when it lands, saying which message it answers                                                                                                                                                                                                 |
| `rooms.lateReplyCeilingMinutes`                  | integer (1--1440)                                                        | `60`               | When a room gives up on a turn that never finishes and reports it as failed                                                                                                                                                                                                                                                                                      |
| `rooms.engagedWindowMinutes`                     | integer (0--1440)                                                        | `10`               | How long an agent keeps answering in a room after somebody talks to it, before it goes back to needing an @mention. Talking to it again starts the clock over; `0` means an @mention every time                                                                                                                                                                  |
| `rooms.engagedWindowPosts`                       | integer (0--100)                                                         | `5`                | How many messages from other members end that window, whichever runs out first                                                                                                                                                                                                                                                                                   |
| `rooms.collectDebounceMs`                        | integer (0--10000)                                                       | `500`              | How long a room gathers messages before an agent answers them together, so several people talking at once get one reply instead of one each                                                                                                                                                                                                                      |
| `rooms.collectMaxEntries`                        | integer (1--200)                                                         | `20`               | The most messages one gathered answer covers. Reaching it answers straight away; the messages past it start the next answer                                                                                                                                                                                                                                      |
| `welcomeBack.enabled`                            | boolean                                                                  | `true`             | Whether agents may post to your team channel when you come back after being away. Off means no post, and no work done to decide there was nothing to post                                                                                                                                                                                                        |
| `welcomeBack.absenceThresholdMinutes`            | integer (15--10080)                                                      | `240`              | How long you have to be away before coming back counts as a return                                                                                                                                                                                                                                                                                               |
| `welcomeBack.maxPosts`                           | integer (0--10)                                                          | `3`                | The most posts one return may produce, however many agents qualify. `0` silences them while leaving the feature on                                                                                                                                                                                                                                               |
| `welcomeBack.offersEnabled`                      | boolean                                                                  | `true`             | Whether a greeting may also carry a next-step offer. On by default (DOR-1121); it is the one part of a return that spends a model turn, because asking the agent is the only honest way to learn whether it has one, so the switch states that cost and an explicit off is never reversed by an upgrade or a wipe                                                |
| `uploads.maxFileSize`                            | integer                                                                  | `10485760` (10 MB) | Maximum file size in bytes per uploaded file                                                                                                                                                                                                                                                                                                                     |
| `uploads.maxFiles`                               | integer (1--50)                                                          | `10`               | Maximum number of files per upload request                                                                                                                                                                                                                                                                                                                       |
| `uploads.allowedTypes`                           | string[]                                                                 | `["*/*"]`          | Allowed MIME types (e.g., `["image/*", "text/plain"]`)                                                                                                                                                                                                                                                                                                           |
| `agentContext.relayTools`                        | boolean                                                                  | `true`             | Include Relay messaging tool documentation in agent context                                                                                                                                                                                                                                                                                                      |
| `agentContext.meshTools`                         | boolean                                                                  | `true`             | Include Mesh discovery tool documentation in agent context                                                                                                                                                                                                                                                                                                       |
| `agentContext.adapterTools`                      | boolean                                                                  | `true`             | Include adapter tool documentation in agent context                                                                                                                                                                                                                                                                                                              |
| `agentContext.tasksTools`                        | boolean                                                                  | `true`             | Include Tasks scheduler tool documentation in agent context                                                                                                                                                                                                                                                                                                      |
| `workbench.terminalGraceTtlMinutes`              | integer (1--120)                                                         | `10`               | Minutes a detached embedded-terminal PTY stays alive so a page refresh can re-attach to the live shell                                                                                                                                                                                                                                                           |
| `workbench.autoOpenDiff`                         | boolean                                                                  | `true`             | Auto-open a diff review in the workbench when the attached session's agent edits a file (DOR-212)                                                                                                                                                                                                                                                                |

The `agents` section configures agent storage defaults:

| Key                       | Type   | Default          | Description                                                                             |
| ------------------------- | ------ | ---------------- | --------------------------------------------------------------------------------------- |
| `agents.defaultDirectory` | string | `~/.dork/agents` | Default directory for agent storage. Resolve it with `resolveAgentsDirectory()` (below) |
| `agents.defaultAgent`     | string | `dorkbot`        | Default agent ID used when no agent is specified                                        |

The default is a **portable spelling of `{dorkHome}/agents`, not a literal path**.
`~/.dork` is the DorkOS data directory only in a normal production install — a dev
tree, a Docker deployment and a test all point `DORK_HOME` somewhere else, and the
agents DorkOS creates belong under that directory. So server code never passes this
value to `expandTilde()`; it goes through `resolveAgentsDirectory()`
(`apps/server/src/lib/agents-home.ts`), which maps the shipped default onto the data
directory in use and expands `~` against the person's real home only for a directory
they configured themselves. `GET /api/config` reports it already resolved, because the
cockpit shows a person where a new agent will live. Expanding the default against the
home directory is what wrote new agents into an operator's live `~/.dork/agents` from
a dev tree (DOR-662).

The `extensions` section controls the extension system:

| Key                        | Type       | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `extensions.enabled`       | `string[]` | `[]`    | Extension IDs the user turned ON that default OFF (opt-in overrides)                                                                                                                                                                                                                                                                                                                                                                 |
| `extensions.disabled`      | `string[]` | `[]`    | Extension IDs the user turned OFF that default ON (opt-out overrides)                                                                                                                                                                                                                                                                                                                                                                |
| `extensions.approvedToRun` | `string[]` | `[]`    | Extension IDs a person approved to run code — in the server process AND in the cockpit page, since the client bundle is same-origin JS carrying their session (DOR-516). Not a deviation list and independent of on/off; `operator-only`. Cleared on marketplace uninstall, so an update re-asks. Core extensions are exempt by origin (a path, not an id) and never appear here. See `services/extensions/extension-load-policy.ts` |

Both arrays record **deviations** from each extension's default state, not the full enabled set. This mirrors JetBrains' `disabled_plugins.txt`, generalized to two defaults:

- **`enabled`** is the opt-in path. User-installed and marketplace extensions default off, so turning one on adds its id here. Core extensions that ship off (`defaultEnabled: false`) also land here when the user opts in.
- **`disabled`** is the opt-out path. Core extensions that ship on (`defaultEnabled: true`) default to enabled, so turning one off adds its id here.

Resolution: a default-on extension is enabled unless its id is in `disabled`; a default-off extension is enabled only if its id is in `enabled`. An extension absent from both lists resolves to its declared default — so a newly-shipped core extension needs no migration in the common case.

> **Hand-edit caveat:** putting a default-on core extension id in `extensions.enabled` is a no-op — to turn a default-on extension off, add its id to `extensions.disabled` instead. The server logs a one-line warning if it detects a default-on id in `enabled`.

Extensions are discovered automatically from `<cwd>/.dork/extensions/` and the global `~/.dork/extensions/` directory. First-party **core extensions** are staged into the global directory at server startup and resolve the same way. See `contributing/extension-authoring.md` for the full extension system documentation.

The `harness` section controls agent-harness projection (Harness Sync):

| Key                     | Type     | Default | Description                                                                                  |
| ----------------------- | -------- | ------- | -------------------------------------------------------------------------------------------- |
| `harness.autoSync`      | boolean  | `true`  | Automatically run Harness Sync projection when a marketplace plugin is installed/uninstalled |
| `harness.approvedHooks` | string[] | `[]`    | Hook projections a person has allowed, as `<packageName>@<digest>` (operator-only)           |

When `harness.autoSync` is `true` (the default), installing or uninstalling a marketplace plugin re-projects `.agents/` and installed plugins to every harness. Set it to `false` to manage projection manually via `dorkos harness sync`.

`harness.approvedHooks` is the record of who may install hooks: shell commands a harness runs unattended, projected into `.claude/settings.local.json` and the generated `.codex/hooks.json` and friends. A package's hooks do not project until a person answers the approval card naming those exact commands (DOR-522); the entry's digest covers the resolved project path and every hook (command, event and matcher), so an update that changes what a package runs, or when it runs it, asks again. Classified `operator-only`, like `extensions.approvedToRun`: an agent cannot write itself an approval. `services/harness/hook-approval.ts` states the guarantee and its limits. Backfilled empty for existing configs by the `'0.57.0'` migration, so nothing already installed is pre-approved.

The `runtimes` section controls which agent runtimes register at server startup and how their binaries resolve (multi-runtime support, spec `additional-agent-runtimes`; backfilled for pre-existing configs, including the T1 credential fields below, by the `'0.45.0'` migration, and the `claudeCode` block by the `'0.57.0'` composite):

| Key                                     | Type                           | Default       | Description                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtimes.default`                      | string                         | `claude-code` | Registry default runtime — the fallback for new sessions (explicit hint > agent manifest > default)                                                                                                                                                                                                                                                                                                 |
| `runtimes.defaultTrustStop`             | `ask`/`act`/`autonomy` \| null | `null`        | Trust stop a NEW interactive session starts at, on every runtime with no answer of its own; `null` = the runtime chooses                                                                                                                                                                                                                                                                            |
| `runtimes.claudeCode.defaultAccount`    | string \| null                 | `null`        | Absolute Claude config directory new sessions run and bill on when neither the session nor its agent names one; `null` = inherit `$CLAUDE_CONFIG_DIR`, else `~/.claude`                                                                                                                                                                                                                             |
| `runtimes.claudeCode.accounts`          | array of `{ id, path, label }` | `[]`          | Claude accounts the operator registered. `id` is the kebab slug agents and launch hints reference; `label` may be `null`                                                                                                                                                                                                                                                                            |
| `runtimes.claudeCode.defaultModel`      | string \| null                 | `null`        | Model a NEW claude-code session starts on; `null` = the runtime chooses                                                                                                                                                                                                                                                                                                                             |
| `runtimes.claudeCode.defaultEffort`     | effort \| null                 | `null`        | Reasoning effort a NEW claude-code session starts at; `null` = the runtime chooses                                                                                                                                                                                                                                                                                                                  |
| `runtimes.claudeCode.defaultTrustStop`  | `ask`/`act`/`autonomy` \| null | `null`        | Trust stop a NEW claude-code session starts at, overriding `runtimes.defaultTrustStop`                                                                                                                                                                                                                                                                                                              |
| `runtimes.claudeCode.persistentSession` | boolean                        | `true`        | Keep a claude-code session's agent process running between messages instead of starting one per message. Flipped on in `0.67.0` when the flag graduated out of [Experiments](#experimental-fields) (spec `full-power-defaults`, D1). Safety-neutral — same executable, same permissions, same per-dispatch boundary check — and the cost is memory, bounded by the warm ceiling and the idle reaper |
| `runtimes.opencode.enabled`             | boolean                        | `true`        | Register the OpenCode runtime at startup                                                                                                                                                                                                                                                                                                                                                            |
| `runtimes.opencode.binaryPath`          | string \| null                 | `null`        | Absolute path to the `opencode` binary; authoritative when set. `null` = walk the ladder (provisioned → PATH)                                                                                                                                                                                                                                                                                       |
| `runtimes.opencode.port`                | integer (0--65535)             | `0`           | Port for the managed `opencode serve` sidecar (`0` = ephemeral port)                                                                                                                                                                                                                                                                                                                                |
| `runtimes.opencode.provider`            | string \| null                 | `null`        | Selected provider id keying into `providers` (`openrouter`, `openai`, …); `null` = OpenCode host auth                                                                                                                                                                                                                                                                                               |
| `runtimes.opencode.baseURL`             | string \| null                 | `null`        | Optional OpenAI-compatible base URL for a Direct provider (injected as `OPENAI_BASE_URL`)                                                                                                                                                                                                                                                                                                           |
| `runtimes.opencode.defaultModel`        | string \| null                 | `null`        | Model a NEW OpenCode session starts on, as `provider/model`; `null` = the runtime chooses. No effort sibling — see below                                                                                                                                                                                                                                                                            |
| `runtimes.opencode.defaultTrustStop`    | `ask`/`act`/`autonomy` \| null | `null`        | Trust stop a NEW OpenCode session starts at, overriding `runtimes.defaultTrustStop`                                                                                                                                                                                                                                                                                                                 |
| `runtimes.codex.enabled`                | boolean                        | `true`        | Register the Codex runtime at startup                                                                                                                                                                                                                                                                                                                                                               |
| `runtimes.codex.binaryPath`             | string \| null                 | `null`        | Absolute path to the `codex` binary; authoritative when set (set-but-absent reports missing, never falls through). `null` = walk the ladder (SDK-vendored → provisioned → PATH)                                                                                                                                                                                                                     |
| `runtimes.codex.credentialRef`          | reference \| null              | `null`        | Credential reference for Codex's API key (`null` = delegate to `codex login`); never a raw secret                                                                                                                                                                                                                                                                                                   |
| `runtimes.codex.defaultModel`           | string \| null                 | `null`        | Model a NEW codex session starts on; `null` = the runtime chooses                                                                                                                                                                                                                                                                                                                                   |
| `runtimes.codex.defaultEffort`          | effort \| null                 | `null`        | Reasoning effort a NEW codex session starts at; `null` = the runtime chooses                                                                                                                                                                                                                                                                                                                        |
| `runtimes.codex.defaultTrustStop`       | `ask`/`act`/`autonomy` \| null | `null`        | Trust stop a NEW codex session starts at, overriding `runtimes.defaultTrustStop`                                                                                                                                                                                                                                                                                                                    |

See the `### runtimes` section below for behavior details, `### providers` for the credential reference scheme, and `contributing/adding-a-runtime.md` for the runtime-author guide.

The `auth` section controls the local login gate (Better Auth):

| Key            | Type    | Default | Description                                                                        |
| -------------- | ------- | ------- | ---------------------------------------------------------------------------------- |
| `auth.enabled` | boolean | `false` | Whether local login is required to use this instance (progressive disclosure gate) |

When `auth.enabled` is `false` (the default), no auth gate runs and DorkOS shows no user concept anywhere. The Better Auth handler is always mounted at `/api/auth/*`, so the enable-login flow can create the owner account before flipping this flag to `true`. Registration is owner-only: the first registered user becomes the owner, and further sign-ups are rejected until a future invites spec reopens registration. Session cookies are signed by Better Auth; production deployments should set `BETTER_AUTH_SECRET` so sessions survive restarts. See the accounts-and-auth spec.

The `approvals` section holds the policy for standing permissions: an operator's "stop asking about this agent doing this thing" (DOR-501). It is the policy only: the permissions themselves are rows in the `approval_grants` SQLite table, so nothing about which agents are trusted can ever leave through `config_get`.

These settings are enforced. The tier gate reads both on every gated call (`readStandingGrantSettings`), so turning the master switch off stops the very next call rather than the next restart.

| Key                                  | Type                    | Default | Description                                                                                                                                |
| ------------------------------------ | ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `approvals.standingGrants`           | boolean                 | `false` | Whether standing permissions may exist at all                                                                                              |
| `approvals.trustWindowMinutes`       | integer (5--1440)       | `480`   | How long a new standing permission lasts, counted from the moment it is granted                                                            |
| `approvals.standingGrantsVoidBefore` | ISO 8601 string \| null | `null`  | **Machine-managed.** The moment the settings last stopped licensing standing permissions. Every permission granted at or before it is void |

Both leaves are `operator-only`, so under login-on they need a session cookie like every other operator-only setting (see [Who may write which setting](#who-may-write-which-setting)). On top of that, they **cannot be written at all while login is off** — that extra bar is `REQUIRES_LOGIN_CONFIG_PATHS` in `config-write-policy.ts`. The consequence is that **standing permissions require `auth.enabled`**.

That bar is not redundant with the general cookie rule, which allows any caller while login is off. It was written as a forward-looking guard, before anything enforced a permission, and it is now load-bearing: with the gate reading the switch, a caller that could write it while login is off would be pre-arming real behavior rather than an inert flag. Do not fold it into the general rule.

The window is bounded in the schema in both directions. The maximum of one day is what makes "forever" unrepresentable; the minimum of 5 minutes keeps the window from becoming a deny-all that looks like a broken feature. Expiry is absolute from the moment of the grant and never slides on use, so an agent cannot extend its own trust by acting. Turning either `auth.enabled` or `approvals.standingGrants` off ends every live permission immediately.

### The posture floor (DOR-520)

`approvals.standingGrantsVoidBefore` is written by DorkOS, never by hand. Whenever a write takes either `auth.enabled` or `approvals.standingGrants` away, `ConfigManager` stamps the current moment there, and `ApprovalGrantService` then refuses every permission granted at or before it — on `findLive` and on `list`, evaluated on read the same way expiry is.

It exists because `PATCH /api/config` is not the only write path. `dorkos config set approvals.standingGrants false` and `dorkos config reset` write the same file from another process, with no database and no routes, so they reach none of the revocation seams. Without the floor, switching the setting off and back on again inside one server lifetime left every permission alive and woke it up — nobody had decided that.

The marker lives in the config file rather than beside the permissions in SQLite for exactly that reason: the config file is the only thing every writer of these settings touches. It is also durable, so it still holds when the whole round trip happens while the server is down — the case a config-file watcher cannot see, and the case the boot sweep misses too, because by then the settings look fine again.

The floor is **monotonic**: after any write it equals what it was before, except on a narrowing where it becomes `max(previous, now)`. It is stated that way — as an invariant on the stored value rather than as a reaction to a transition — because the first version stamped only on the licensed → unlicensed transition, and any write performed while _already_ narrowed then put the leaf back to its default and erased the marker. `dorkos config reset` did exactly that, and a batched `PATCH /api/config` did it too (`applyConfigPatch` writes each top-level section from one pre-write snapshot, so a section written after `auth` narrowed carried a stale `null` back over the stamp). `max` rather than `now` also keeps a backwards clock from lowering a floor that has already voided permissions.

**What it does not cover.** The floor rests on every writer going through `ConfigManager`, so config content DorkOS did not write gets around it. Editing `~/.dork/config.json` in a text editor — including via `dorkos config edit`, which hands you the raw file — narrows the posture without stamping anything. Restoring the config file from a backup carries whatever floor that snapshot held, which may be older than the one it replaces or absent entirely; `config-write-policy.ts` already names the same class of problem for the settings themselves. In both cases an off-then-on round trip can still wake permissions inside one server lifetime, and a restart re-establishes the invariant only if the settings are still narrowed when it happens.

The `cloud` section holds the device-link binding between this instance and a DorkOS account (accounts-and-auth P2). It is managed by the `dorkos cloud` CLI commands and the `/api/cloud/*` routes — not edited by hand — and is independent of `auth.enabled`:

| Key                        | Type           | Default | Description                                                                                 |
| -------------------------- | -------------- | ------- | ------------------------------------------------------------------------------------------- |
| `cloud.instanceToken`      | string \| null | `null`  | Scoped instance API key issued by the cloud on link (**sensitive**); `null` when not linked |
| `cloud.instanceName`       | string \| null | `null`  | This instance's display name registered with the cloud (typically the hostname)             |
| `cloud.linkedAccountLabel` | string \| null | `null`  | Human-readable label of the linked DorkOS account, when the cloud reports one               |

`cloud.instanceToken` is registered in `SENSITIVE_CONFIG_KEYS`, so the CLI and REST API warn when it is written directly. The cloud base URL is set by the `DORKOS_CLOUD_URL` environment variable (default `https://dorkos.ai`; override for local dev against the site). While linked, the server heartbeats the cloud on startup and every 15 minutes; a `401` from the cloud (the account revoked the instance) clears the token and marks the instance unlinked. (This device-link check-in is unrelated to the opt-in telemetry heartbeat below.)

### telemetry

The shared opt-in consent namespace for everything DorkOS can send to dorkos.ai. Every channel is a peer boolean and defaults to `false` — nothing leaves the machine without an explicit opt-in (DOR-293, ADR 260711-141639). `userHasDecided` is the one shared gate: it records that the user answered a consent prompt either way, so no channel re-prompts. The namespace is deliberately per-channel so future work (error reporting, a remote OpenTelemetry exporter) hangs off the same object without a redesign.

| Key                                | Type           | Default | Description                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | -------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `telemetry.userHasDecided`         | boolean        | `false` | Shared gate: `true` once the user answered a consent prompt (either way), stopping the first-run consent dialog                                                                                                                                                                                                                                                                                                       |
| `telemetry.install`                | boolean        | `false` | Send anonymous marketplace install events to dorkos.ai (formerly `telemetry.enabled`). Opt-in (ADR 260727-182651); also gated behind the first-run notice                                                                                                                                                                                                                                                             |
| `telemetry.heartbeat`              | boolean        | `false` | Send the daily anonymous heartbeat to dorkos.ai (payload documented at https://dorkos.ai/telemetry). Opt-in (ADR 260727-182651); also gated behind the first-run notice                                                                                                                                                                                                                                               |
| `telemetry.errorReporting`         | boolean        | `false` | Send scrubbed crash reports to the owned dorkos.ai ingest (→ PostHog Error Tracking), never a third party. A **separate** explicit opt-in (never set by the first-run consent dialog); fires only when this is `true` and no env kill switch is set. DOR-293, ADR 260711-153307 + 260713-143958                                                                                                                       |
| `telemetry.lastPromptedVersion`    | string \| null | `null`  | The DorkOS version whose consent notice this install last saw, or `null` if never prompted. The re-prompt anchor for a future data-policy change (DOR-312, ADR 260713-143958 Phase 1); written by the consent surfaces, not yet read                                                                                                                                                                                  |
| `telemetry.linkAnalyticsToAccount` | boolean        | `false` | When linking this install to a DorkOS account, also include the anonymous per-install telemetry id in the device-link descriptor so the cloud merges this install's usage history onto the account person. A **separate** explicit opt-in captured in the account-link flow (never the first-run consent dialog); read at link time only, and suppressed by the env kill switches. DOR-320, ADR 260713-143958 Phase 4 |
| `telemetry.aiMetadata`             | boolean        | `false` | Bridge anonymous AI-run metadata (one `$ai_generation` event per completed turn: model, runtime, token counts, latency, cost — never content) to the owned ingest → PostHog LLM analytics. A **separate** explicit opt-in, independent of `usage`; the first-run notice gate does not apply. DOR-319, ADR 260713-143958 Phase 7                                                                                       |

The heartbeat payload is anonymous by construction — an instance UUID, version, OS/arch, configured runtimes, tunnel + cloud-link flags, and rough counts, never prompts, code, paths, or session content. It is sent at most once a day (enforced by a `heartbeat-last-sent` marker in `~/.dork/`), and the shared anonymous instance id lives in `~/.dork/telemetry-install-id`. Full contract: [dorkos.ai/telemetry](https://dorkos.ai/telemetry) and `docs/self-hosting/telemetry.mdx`.

The `0.46.0` config migration renames the legacy `telemetry.enabled` to `telemetry.install` (preserving the user's prior choice) and backfills `heartbeat` + `errorReporting` to `false`; it never enrolls an existing user in the new channels. The `0.48.0` migration backfills `telemetry.lastPromptedVersion` to `null` (DOR-312) and, per the Tier 1 opt-out flip (`applyTier1OptOutDefaults`, DOR-314, ADR 260713-143958 — since reversed by `applyTier1OptInDefaults` in `0.57.0`, ADR 260727-182651), enabled `install` + `heartbeat` for installs that never answered a consent prompt — an explicit prior choice (yes or no) survives byte-identical, and nothing sends before the first-run notice has been shown (`userHasDecided` or `lastPromptedVersion` gate). The same `0.48.0` block also backfills `telemetry.usage` (`backfillTelemetryUsageChannel`, DOR-315), `telemetry.linkAnalyticsToAccount` (`backfillTelemetryLinkAnalyticsToAccount`, DOR-320), and `telemetry.aiMetadata` (`backfillTelemetryAiMetadataChannel`, DOR-319) — the latter two are Tier 2 opt-ins, so every upgraded install starts `false` regardless of any prior telemetry choice (a new opt-in channel is never auto-enrolled).

`telemetry.aiMetadata` (DOR-319, ADR 260713-143958 Phase 7) is the Tier 2 half of Plane 2: when on, every completed runtime turn emits one PostHog-native `$ai_generation` event to the owned ingest (`https://dorkos.ai/api/telemetry/events` → PostHog LLM analytics) carrying only metadata — `$ai_model`, `$ai_provider` (the runtime id), `$ai_input_tokens`/`$ai_output_tokens`, `$ai_latency`, `$ai_total_cost_usd`, plus a random per-turn `$ai_trace_id` — with `$process_person_profile: false` so it never creates a PostHog person. The wire schema is a strict allowlist in `@dorkos/shared/telemetry-events` (`AiGenerationEventSchema`, a `$`-prefixed carve-out mirroring `$exception`); it is harvested at the single runtime-turn seam (`services/observability/ai-metadata.ts`, reading only non-content fields off the turn's `session_status` events) and sent by a batched sibling reporter (`services/core/ai-metadata-reporter.ts`) gated by this flag independently of `usage`. The SAME harvest also sets OpenTelemetry `gen_ai.*` attributes on the runtime span for the operator's own traces (Plane 2, no consent needed). Full contract: [dorkos.ai/telemetry](https://dorkos.ai/telemetry).

**Env kill switches (DOR-312).** Two environment variables force every outbound channel off, beating config (precedence: env > config): `DO_NOT_TRACK` (the universal cross-tool convention) and `DORKOS_TELEMETRY_DISABLED` (DorkOS-scoped). Either set to `1` or `true` (case-insensitive) silences all channels. `DORKOS_TELEMETRY_DEBUG=1` makes every sender (heartbeat, install, usage, and crash reports) print the exact JSON payload to stderr instead of sending it. The parsing + precedence live in `@dorkos/shared/telemetry-consent` so the server and CLI agree; `dorkos telemetry status|enable|disable [--channel install|heartbeat|errors]` reads and writes the same flags from the command line.

`telemetry.errorReporting` (DOR-293, ADR 260711-153307 + 260713-143958 Phase 6) is a **separate** opt-in from the first-party anonymous channels because crash data is inherently higher-risk. It fires only when the flag is `true` and no env kill switch is set; there is no `SENTRY_DSN` and no third party. Crash reports map to a PostHog-native `$exception` event and POST to the owned ingest (`https://dorkos.ai/api/telemetry/events`), which forwards to PostHog Error Tracking server-side — the same pipe the anonymous usage events ride. The report is built by an allowlist in `@dorkos/shared/error-report` (`buildExceptionEvent`): the error type plus a stack scrubbed to repo-relative filenames, with the raw message omitted and home dirs / absolute paths / secret-shaped tokens stripped. The same core is wired into the server (`services/core/error-reporter.ts`, hooked to the process crash handlers), the CLI (`packages/cli/src/lib/error-reporter.ts`, for standalone commands), and the cockpit (`POST /api/errors` rebuilds and re-scrubs the client's crash SERVER-side — the client payload is never trusted). Full contract: [dorkos.ai/telemetry](https://dorkos.ai/telemetry).

### providers

The top-level `providers` block is a registry of per-provider credential **references**, keyed by a stable provider id (`anthropic`, `openrouter`, `openai`, …). Values are **never raw secrets** — they are references using a three-scheme grammar, and the schema rejects anything that is not a well-formed reference (a pasted `sk-…` key fails validation). This is the substrate for the `CredentialProvider` port (ADR-0315): the connect flow writes a reference here, and the port resolves it to a real secret at each runtime's env-injection seam (never persisting plaintext, never logging the secret).

| Reference form  | Resolves from                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `keychain:<id>` | The OS keychain (macOS `security`; unavailable elsewhere resolves as an honest, typed failure)                                   |
| `env:<VAR>`     | The named process environment variable                                                                                           |
| `file:<name>`   | A DorkOS-owned encrypted secret store under `{DORK_HOME}/extension-secrets/runtime-credentials.json` (AES-256-GCM, never echoed) |

| Key         | Type                      | Default | Description                                                                        |
| ----------- | ------------------------- | ------- | ---------------------------------------------------------------------------------- |
| `providers` | record<string, reference> | `{}`    | Per-provider credential references (`keychain:`/`env:`/`file:`), never raw secrets |

A dangling reference (env var unset, file/keychain entry missing) resolves to a typed failure, not an empty string — the connect UX surfaces it honestly rather than silently sending an empty key. Claude reads `providers.anthropic` (injected as `ANTHROPIC_API_KEY`); OpenCode reads `providers[<runtimes.opencode.provider>]` (injected as the provider's key). Codex never receives its key via a subprocess env var — it never sets `CodexOptions.env` — so `runtimes.codex.credentialRef` feeds the delegated `codex login` path instead.

The `onboarding` section tracks first-time setup state (`completedSteps`, `skippedSteps`, `startedAt`, `dismissedAt`, `completedAt`, `runtimeDefaultSetAt`). `completedAt` is the authoritative "finished" signal — once set, the full-screen flow never reappears. `runtimeDefaultSetAt` records the moment first-run setup picked `runtimes.default` for the user (spec `execution-defaults` §7); non-null closes that question permanently, so the pick is never re-made behind somebody's back. It cannot be inferred from `runtimes.default`, which has a default value and so cannot tell a choice from a fallback. The whole section is managed automatically and should not be edited manually.

The `tours` section tracks the DorkBot living tour (`seen`, `declined`) so a subsystem tour never re-offers itself once the user has run or declined it. It is managed automatically by the client and should not be edited manually.

The `profile` section is what the user has told DorkOS about themselves (spec `user-profile-onboarding`). It is projected into every session's agent context as a `<user_profile>` block and feeds the role → recommendations mapping in `@dorkos/shared/profile-recommendations`. Every field is local-only; never included in any telemetry payload (pinned by sentinel-exclusion tests on the heartbeat and usage-event catalogs). All four leaves are `expose` + `agent-writable` on purpose — agents knowing and updating the profile is the feature.

| Key                             | Type                       | Default | Description                                                                                                                                                       |
| ------------------------------- | -------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile.roles`                 | string[] (≤10, ≤60 chars)  | `[]`    | What kind of work the user does. Free-form; onboarding offers the `ROLE_CANON` chips. Local-only; never included in any telemetry payload                         |
| `profile.tools`                 | string[] (≤50, ≤60 chars)  | `[]`    | Tools/services the user works with (e.g. `Gmail`, `Linear`). Not asked in onboarding v1; DorkBot fills it via `config_patch`. Local-only; never in telemetry      |
| `profile.displayName`           | string (≤80 chars) \| null | `null`  | What the user likes to be called. Optional; never required. Local-only; never included in any telemetry payload                                                   |
| `profile.rolePromptDismissedAt` | string \| null             | `null`  | ISO timestamp when the one-time existing-user role prompt was dismissed ("don't ask again"). Machine-managed. Local-only; never included in any telemetry payload |

The following settings are controlled exclusively by environment variables and have no corresponding config file key:

| Environment Variable      | Default                            | Description                                                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DORKOS_RELAY_ENABLED`    | `true`                             | Enable the Relay message bus subsystem at the process level                                                                                                                                                                                                         |
| `DORKOS_CORS_ORIGIN`      | localhost on DORKOS_PORT/VITE_PORT | CORS allowed origin(s). Set to `*` for wildcard or a comma-separated list to override.                                                                                                                                                                              |
| `DORKOS_CLOUD_URL`        | `https://dorkos.ai`                | Base URL of the DorkOS cloud (dorkos.ai) that this instance device-links and heartbeats to. Override for local dev against a self-hosted `apps/site`. Read via `apps/server/src/env.ts`.                                                                            |
| `DORKOS_VERSION_OVERRIDE` | (none)                             | Override the reported server version for testing upgrade UX. When set, dev mode detection is bypassed and this value is used as the current version. Example: `DORKOS_VERSION_OVERRIDE=0.1.0` simulates running an old version so the upgrade notification appears. |

The config file also contains a `version` field (currently `1`) that the schema carries for historical reasons. The authoritative migration tracker is a separate internal key that `conf` manages automatically — see **Schema Migrations** below.

### Cloud site (`apps/site`) environment variables

The **DorkOS account** cloud identity runs in `apps/site` (Next.js on Neon Postgres) and is configured by its own environment variables — these live on the dorkos.ai deployment, not in `~/.dork/config.json`. The authoritative list is `apps/site/.env.example`; they are also catalogued in `contributing/environment-variables.md`. They matter for self-hosting the site (or running it locally to develop the device-link flow):

| Environment Variable                        | Default                          | Description                                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                        | (none)                           | Signs DorkOS-account sessions. **Required in production** (32+ chars); `assertProductionAuthEnv()` fails closed if unset there.                                                                      |
| `BETTER_AUTH_URL`                           | `http://localhost:3000`          | Public origin of the cloud auth instance (production only; preview deploys auto-derive it from the Vercel branch URL). Must be non-localhost in production (verification/OAuth links point at it).   |
| `RESEND_API_KEY`                            | (none)                           | Resend API key for account verification + password-reset email. Sending throws a clear error when unset; local edition sends none.                                                                   |
| `RESEND_FROM`                               | `DorkOS <onboarding@resend.dev>` | Verified Resend sender address for those emails.                                                                                                                                                     |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | `''`                             | GitHub social sign-in credentials. Empty leaves the provider registered but non-functional.                                                                                                          |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | `''`                             | Google social sign-in credentials. Empty leaves the provider registered but non-functional.                                                                                                          |
| `ADMIN_USER_IDS`                            | `''`                             | Comma-separated DorkOS-account user ids granted full admin regardless of `role` (the `admin` plugin's break-glass bootstrap). Set the founder's `user.id` at launch. See _Cloud account management_. |

See `contributing/authentication.md` → _Cloud instance (P2)_ and _Cloud account management_ for how these wire into the second Better Auth instance.

## Schema Migrations

DorkOS's user config (`~/.dork/config.json`) is owned by the [`conf`](https://github.com/sindresorhus/conf) library (v15.1.0) via the `ConfigManager` wrapper at `apps/server/src/services/core/config-manager.ts`. Zod is the authoritative schema; `z.toJSONSchema(UserConfigSchema)` bridges to conf's Ajv validation so we never hand-maintain JSON Schema.

Any change to `UserConfigSchema` (add / rename / remove / retype a field) that affects an existing user's stored data **requires a migration**. This section documents when and how.

### Why migrations matter

When a user upgrades DorkOS, their `config.json` was written by the previous version. The schema Zod now validates may differ from the shape on disk:

- **Added field with a default** — conf's defaults-merge handles this automatically on next instantiation. No migration needed.
- **Renamed field** — the old key lingers under its old name and the new key is absent. Without a migration the user loses their setting.
- **Removed field** — the old key sticks around as dead data and can trip up future type checks.
- **Type change** — a stored `number` being re-parsed as `string` will fail Zod validation and trigger the corrupt-config recovery path, losing the user's data.
- **Default value change** — sometimes OK, sometimes not. If the user never set the value explicitly, do they want the new default or their old inferred one? Usually they want the new default — but be deliberate.

Migrations run once per user, per version boundary, the first time a new DorkOS version instantiates `ConfigManager`. They are the only safe way to evolve stored data across releases.

### `config.json` holds the effective config

Every write through `ConfigManager` writes the whole file back, with every unset field filled in at its default. This is not a DorkOS decision. `conf` compiles Ajv with `useDefaults: true`, and Ajv inserts a missing property's `default` into the object it is validating. `Conf.set` reads the store through that validating getter and assigns the result straight back, so writing one leaf persists the defaults of every other one. `Conf.reset` and `Conf.clear` fill the same way (`reset` calls `set`).

**The fill is in those library calls, not in any one DorkOS method.** Several places reach them, so patching one would change nothing: `ConfigManager.write()` (what `set` and `setDot` use, and therefore where `PATCH /api/config` and `dorkos config set` land), `ConfigManager.reset()`, which calls `Conf.reset`/`Conf.clear` directly, the posture-floor stamp, and corrupt-recovery through `restoreProtectedState` (`safe-defaults/protected-state.ts`). Two paths do NOT fill. Opening the store merges only the top-level `defaults`, so a section already on disk keeps the shape it had. Migration bodies write with conf's validation switched off, so what they set is what lands.

**So absence is not a state this design keeps.** Deleting a key from `config.json` by hand appears to work, and holds only until the next config write puts it back at its default. The one durable restore is to restore the file: copy a snapshot back over it. A key that reappears at its schema default after a write is this behaviour, not a bug (DOR-1267).

Two costs follow, and both are named elsewhere on this page. A change to a shipped default never reaches anyone whose file already has the old value written in, which is the "Default value change" case above. And a later migration cannot tell a value DorkOS seeded from one a person chose, which is what makes a change of mind expensive under the append-only rule below. Turning the fill off is not a knob: `z.toJSONSchema(UserConfigSchema)` marks every defaulted leaf `required`, and the fill is what satisfies that, so with `ajvOptions: { useDefaults: false }` a file missing one leaf fails validation, which the recovery path reads as corruption and replaces with defaults. That case is pinned by a test in `apps/server/src/services/core/__tests__/config-manager.test.ts`. Making absence durable means moving default-filling out of Ajv and into a DorkOS read boundary, which is an ADR, not an edit.

### How `conf` handles migrations

`conf` tracks migration state **inside the config file itself**, in an internal key at `__internal__.migrations.version`. The flow is:

1. `ConfigManager` constructs `new Conf<UserConfig>({ projectVersion, migrations, ... })`.
2. `conf` reads the stored `__internal__.migrations.version` and compares it against `projectVersion`.
3. Every migration whose key satisfies `> storedVersion && <= projectVersion` (semver-ordered) runs in sequence. Each migration receives the `conf` store and may call `store.has()`, `store.get()`, `store.set()`, `store.delete()`.
4. After all applicable migrations run, `conf` updates `__internal__.migrations.version` to `projectVersion`.
5. Each migration runs at most once per user — subsequent launches see the updated internal version and skip.

`projectVersion` is the **app version**, not a schema version. Migration keys are the app versions at or after which each migration should run. A migration keyed `'0.35.0'` runs on the first launch of DorkOS 0.35.0 (or any later version, if the user skipped 0.35.0 entirely).

> `projectVersion` is not hardcoded — `ConfigManager` imports `SERVER_VERSION` from `apps/server/src/lib/version.ts` and hands it to Conf. That resolver honors `DORKOS_VERSION_OVERRIDE`, the esbuild-injected `__CLI_VERSION__`, and the `package.json` dev fallback, in that order. Migration keys line up with real release boundaries automatically — do not reintroduce a hardcoded `projectVersion` string.

### Append-only rule

**Pick the key first: strictly greater than the newest `v*` tag** (`git tag -l 'v*' | sort -V | tail -1`). Not "the version in `package.json`" — a branch can sit open past a real release without ever touching its own copy of that file, which is how a `'0.54.0'` migration once shipped dead (DOR-339). `conf` runs a key only when `storedVersion < key <= projectVersion`, so a key at or below a released version is skipped for everyone already on it, silently.

**Never append to a key that has shipped, either.** The key being present in a release is not the point — the BODY is what runs, and a body added to an already-tagged composite key is dead code that looks alive (DOR-988).

**Never edit a shipped migration.** Once a migration has run on real users, its body is frozen — editing it would leave users in divergent states (those who ran the old body vs. those who ran the new one). Note who counts as a real user, below: it is not only the people on a release.

**Never edit a MERGED migration either, tagged or not.** This is the rule that used to say the opposite, and the correction is DOR-1222. The old text said an unshipped key had run for nobody, so its body could be amended in place; two amendments to `'0.59.0'` were made on that licence. It was false. What runs a migration is `projectVersion`, and `projectVersion` is `SERVER_VERSION` — the version compiled into a built CLI bundle (`__CLI_VERSION__`) or the desktop app, `DORKOS_VERSION_OVERRIDE` when set, and `0.0.0` only in a raw dev tree. Every one of those versions is bumped in the repository **before** the tag exists, so anyone who builds and runs during the merge-to-release window is stamped with the new version, has run whatever the body said that day, and never runs the key again.

That is not a theoretical population. The operator's own `~/.dork/config.json` was stamped `0.59.0` on 2026-08-12, while `0.59.0` was still "unreleased", so both later amendments to that key — `welcomeBack.offersEnabled` OFF to ON (DOR-1121), then the composer prefs seed — skipped him in silence. There is older evidence in the file too: `backfillApprovalsDefaults` carries two separate `if`s rather than one, precisely because an earlier build of that same then-unreleased key had already created an `approvals` block on somebody's disk. **The dogfood machine is always somebody.**

So the licence does not come from the tag, and it does not come from anywhere. Once a migration merges, its body is frozen. A change of mind opens a NEW key strictly above the newest tag.

Reach for that follow-up key knowing what it costs: check that it can tell a value the earlier migration seeded from one a person chose. Where it cannot, it overwrites the choice — which is why a change of mind is harder to write than an edit, and should be. If the two states genuinely cannot be told apart, that is an argument for living with the seed you shipped, not for editing it away.

To fix a migration that has already merged (whether or not it is tagged):

1. Leave it in place, exactly as it is.
2. Append a **new** migration at a key above the newest `v*` tag that reads the current state, tells the two populations apart, and corrects only the one that needs it.

**All of this is enforced, by two guards that cover different things.** Neither is optional reading before you edit that file:

| Guard                                                                          | Compares                                                                                                                                     | Catches                                                                                                                     | Blind to                                                                                                                                                            |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__tests__/migration-safety.ts` (DOR-339, DOR-988)                             | each key's table slice, byte for byte, against the newest release tag                                                                        | a key authored at or below a released version; any edit — code or comment — to a slice that has shipped                     | anything between merge and tag; helper functions the table only calls                                                                                               |
| `__tests__/migration-append-only.ts` + `merged-migration-hashes.ts` (DOR-1222) | a hash per key of its whole reachable closure — table slice plus every function and constant in the file it reaches — against a pinned value | any change to a merged body, to a helper it calls, or to a constant it reads, from the moment it merges, with no tag needed | anything outside `config-manager.ts` — narrowing `ONBOARDING_STEPS` (`packages/shared/src/config-schema.ts`) changes what `0.55.0`'s scrub deletes and moves no pin |

`config-manager.test.ts` runs both over the real repository on every CI run, and the tag-based one fails loudly (rather than skipping) in a checkout that cannot see tags.

The pins live in `apps/server/src/services/core/__tests__/merged-migration-hashes.ts`, one line per key. **Add a key's pin in the same pull request that adds the key** — the guard fails until you do, because a pin added later leaves a window where the body could be rewritten with nothing to show for it. Changing an existing pin is the only escape hatch, and it is a single changed line in a file that exists for nothing else, so it cannot pass review unseen: bump one only with a justification in the pull request that names the population which could have run the old body and says why it is empty. On this repository it never has been.

**The import boundary is already crossed**, so treat it as a live gap rather than a theoretical one. Three of the eleven keys reach into `@dorkos/shared/config-schema`: `0.55.0` reads `ONBOARDING_STEPS`, `0.59.0` reads `ComposerPrefsSchema`, and `0.57.0` calls `toSidebarItemRef` outright. `scrubRetiredOnboardingSteps` deletes exactly the step ids missing from that enum, so narrowing it again makes a shipped migration delete more with every pin unmoved; editing `toSidebarItemRef` rewrites what `0.57.0`'s rename produces, in a file no guard here reads. Following imports was left out because it would reach the whole config schema and turn every ordinary field addition into a repin — a trade, not an oversight. **When you change anything in `config-schema.ts` that a migration reads or calls, check the migrations yourself; nothing will stop you.**

**One legitimate repin recurs**, and it is worth recognising so it is not mistaken for the alarm. Several helpers are shared: extending one (adding a leaf to the `seeded` object in `backfillRoomsDefaults`, say) changes the closure of every key that calls it, so several pins move at once and the guard says so explicitly. That is sound only when a NEW key re-runs the helper, which is what covers the people who already passed the older keys — the pattern `0.60.0` follows. Repin the older keys, and name the new key in the pull request. If there is no new key, the pins are telling you the truth: you have changed what those migrations did, for nobody who has run them.

The hash normalizes comments and formatting away, so correcting a stale sentence inside a merged body does not trip it — the byte-identity guard still will, if the key has shipped, which is why the docblock above `CONFIG_MIGRATIONS` says to correct that kind of thing above the key rather than inside it.

### Step-by-step: adding a new config field

For the guided flow, use the `.claude/skills/adding-config-fields/` skill — Claude will walk through these steps interactively. For reference, they are:

1. **Add the field to the Zod schema** in `packages/shared/src/config-schema.ts` with a `.default(...)` (make it optional only if the absence of the field is semantically meaningful).
2. **Verify `USER_CONFIG_DEFAULTS` still parses** — that constant is computed from `UserConfigSchema.parse({ version: 1 })` at import time; a required field without a default crashes on first import.
3. **Bump `projectVersion`** in `ConfigManager` constructor to the target release version.
4. **Append a migration** to the `migrations` block, under a NEW key strictly greater than the newest `v*` tag, and **pin it in `merged-migration-hashes.ts` in the same pull request** (see [Append-only rule](#append-only-rule) — never extend a key that has already merged, tagged or not). Guard every `store.set/delete` with `store.has()` so the migration is idempotent.
5. **Classify the field for agent disclosure** in `CONFIG_DISCLOSURE` (`apps/server/src/services/core/operator/config-disclosure.ts`): `expose` or `withhold`. The `config_get` MCP tool answers with no credential in the default login-off posture, so its snapshot is an allowlist. The drift guard in `config-disclosure.test.ts` fails until every schema leaf has a verdict, which is deliberate: it is what stops a new secret-bearing field from shipping onto that surface. Withhold anything that is a credential or names where one lives, and add it to `PRESENCE_FLAG_PATHS` if callers need a yes/no "is it configured". Two rules about the key: a field inside an array of objects is keyed with a `[]` array hop, repeated per nesting level (`ui.sidebar.groups[].myField`, `ui.sidebar.groups[].items[].kind`), and an `expose` verdict must resolve to a scalar, an array of scalars, or an open record listed in `EXPOSED_RECORD_PATHS` — a whole subtree cannot be exposed on one verdict.
6. **Classify the field for agent writes** in `CONFIG_WRITE_POLICY` (`apps/server/src/services/core/operator/config-write-policy.ts`): `agent-writable` or `operator-only`. A separate decision from step 5, because a field can be safe to show an agent and unsafe to let one change. `config_patch` is tier `act`, so it runs with no approval; that is how an agent could once turn off `auth.enabled` and remove the posture that makes destructive approvals enforceable (DOR-488). Its drift guard in `config-write-policy.test.ts` fails until every schema leaf has a verdict. Mark it `operator-only` when changing it, on its own, removes or widens a security control (the login gate, public exposure, the MCP endpoint's gate, credentials and the hosts they reach, code the server loads or spawns, how far DorkOS reaches on disk, or consent about what leaves the machine); everything else is a preference. The human path, `PATCH /api/config`, enforces the same verdict but with an escape for the person in the cockpit, so a Settings toggle keeps working — see [Who may write which setting](#who-may-write-which-setting) for the two bars and the residual that escape leaves open under login-off.
7. **State what the default does for the person who never touches it** in one of the three lists in `apps/server/src/services/core/safe-defaults/default-verdicts.ts` (`NO_RISK_DEFAULTS`, `SAFE_DEFAULTS`, `PERMISSIVE_DEFAULTS`): `no-risk`, `safe`, or `permissive`. A third drift guard, in `safe-defaults/__tests__/default-verdicts.test.ts`, fails until every leaf has a verdict. `no-risk` means the default cannot send data off the machine, grant an agent a capability, or relax a bound — most fields. `safe` means the default _is_ the protective option (a gate that starts closed, a list that starts empty). `permissive` means it is not, which is allowed but must be argued: the entry carries a written reason and the guard rejects an empty one. See ADR 260727-181825.
8. **Decide whether it must survive a config wipe.** `~/.dork/config.json` is replaced wholesale by corrupt-recovery and by `reset()`, and without a rule in `PROTECTIVE_CARRYOVERS` (`safe-defaults/protected-state.ts`) the wipe silently reverses whatever the person had set — which is exactly how an explicit telemetry opt-out came back as the opt-out-tier defaults (DOR-584). **Two kinds of field need a rule, not one.** The obvious kind is a permissive default a person could move to a protective value. The easy one to miss is a field whose default is already a real bound but can be tightened _past_: `rooms.maxTurnsPerAgentPerCascade` ships at `10` and is classified `safe`, yet someone who set it to `1` still loses that without a rule. `safe` means the shipped value protects, not that it is the tightest a person might want. Only a field where no tighter value exists needs nothing — and for numeric bounds the guard makes you say which case you are in, so a new one cannot be added silently.
9. **Document the field** in the Settings Reference table above. The `check-docs-changed.sh` hook will remind you at session-stop if you forget, but doing it inline is cleaner.
10. **Mirror the doc to `docs/getting-started/configuration.mdx`** if the field is user-visible.
11. **Add a test** in `apps/server/src/services/core/__tests__/config-manager.test.ts` that exercises the migration against a realistic stale-config blob. Mock-store tests are fine for a migration body in isolation, but **any change to the schema itself needs at least one test that boots a real `ConfigManager` over a real file** — see [A rename is not a backfill](#a-rename-is-not-a-backfill) for why `createMockStore` and `UserConfigSchema.parse` both miss the failures that matter. **Booting a real manager is necessary and not sufficient: that test must read `config.json` itself, not call `get`/`getDot`.** Every suite DOR-1496 found vacuous already met the real-file bar and still certified migrations it never ran, because the getter's Ajv fill answers the question before the file is consulted. The rule and the one top-level-section exception are in `.claude/rules/safe-defaults.md` under Testing; prove the assertion by suppressing the body and watching it go red.
12. **Wire a CLI flag** in `packages/cli/src/cli.ts` if the field needs one, following the precedence rule (CLI flag > env var > config > default).
13. **If the field is a feature flag that ships OFF, register it as an experiment** — see [Experimental fields](#experimental-fields). Skipping this is how a flag becomes unreachable, which is the whole of DOR-1304.

### Experimental fields

A field whose default is `false` because the feature is not finished being proved is a **staged opt-in**, and it gets one extra step: an entry in `EXPERIMENTS` at `apps/server/src/services/core/config/experiments-registry.ts`.

**Why it is not optional.** `GET /api/config` is a hand-curated DTO, not a dump of `UserConfigSchema`. A flag nobody adds to that curation is reachable only by hand-editing `~/.dork/config.json`, so nobody turns it on, so nothing is learned about it, so it can never graduate. That is exactly what happened to `runtimes.claudeCode.persistentSession`: it shipped, it worked, and it sat invisible. It has since GRADUATED — registered, proved, on by default in `0.67.0`, entry deleted — which is the whole arc this mechanism exists to make possible.

**What an entry is.** `{ path, title, description, costNote?, envOverride?, graduationIssue }`. The three prose fields are read by a person who does not code — follow the `writing-for-humans` skill: benefit first, cost second, no mechanism. `envOverride` names the environment variable that overrules the setting, if one does; its presence is what makes the row report `lockedByEnv` and render as a disabled switch showing reality (the same treatment `scheduler.enabled` and `relay.enabled` get). `graduationIssue` is the tracker issue that will decide the flag's fate.

**The doctrine, and why the registry is meant to shrink.** DorkOS ships features on by default (ADR-0054). A flag exists only for the window in which a feature is unproven; then it graduates to on-by-default and the flag is **deleted** — ADR-0062 (Mesh), ADR-0171 (Relay and Pulse) and ADR-0266 (hydration) are three that went through exactly that and no longer exist. So **graduating a flag means deleting its registry entry in the same change that flips the default**, and removing the flag itself once nothing reads it. An empty registry is not a broken feature; it is the success state, and the Experiments section in Settings says so in plain words.

**What the guard enforces.** `apps/server/src/services/core/config/__tests__/experiments-registry.test.ts` fails unless every entry's `path` resolves to a real boolean leaf of `UserConfigSchema` that defaults to `false`, and carries a non-empty `graduationIssue`. The default check is the sharp one: an entry whose default has already flipped to `true` would offer somebody a switch to turn OFF something the product now assumes.

**What the person sees.** Settings → Experiments, one switch per entry, rendered generically from `config.experiments` — the client holds no list of its own, so adding or graduating an experiment needs no client change at all.

### Reference example

The migration chain lives in the module-level `CONFIG_MIGRATIONS` constant at `apps/server/src/services/core/config-manager.ts` (extracted from the constructor for testability and to enforce the append-only rule by construction):

```typescript
const CONFIG_MIGRATIONS = {
  '1.0.0': (store: {
    has: (key: string) => boolean;
    set: (key: string, value: unknown) => void;
  }) => {
    if (!store.has('version')) {
      store.set('version', 1);
    }
  },
} as const;
```

Both the primary and corrupt-recovery `Conf` constructors share a single `confOptions` object that references `CONFIG_MIGRATIONS` and `SERVER_VERSION` as `projectVersion`. This ensures migrations run even after a corrupt-recovery path — previously the catch branch silently dropped `projectVersion` and `migrations`.

A hypothetical migration for a future `0.35.0` release that renames `server.cwd` to `server.workingDirectory` would append to `CONFIG_MIGRATIONS`:

```typescript
const CONFIG_MIGRATIONS = {
  '1.0.0': (store) => {
    /* ... existing ... */
  },
  '0.35.0': (store) => {
    // Rename server.cwd → server.workingDirectory.
    // Idempotent: guarded by store.has() so re-running is safe.
    if (store.has('server.cwd') && !store.has('server.workingDirectory')) {
      store.set('server.workingDirectory', store.get('server.cwd'));
      store.delete('server.cwd');
    }
  },
} as const;
```

No manual `projectVersion` bump is needed — it resolves from `SERVER_VERSION` via `lib/version.ts`, which reflects the real app version at runtime. The new field would be updated in `UserConfigSchema` and this doc's Settings Reference table in the same PR.

### Shipped migrations: accounts-and-auth

Three bodies landed with the local-login work (see `contributing/authentication.md`), all composed into the same `'0.45.0'` key. All are append-only and idempotent:

| Version  | Body                                 | Effect                                                                                                         |
| -------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `0.45.0` | `backfillAuthDefaults`               | Writes `auth: { enabled: false }` when absent.                                                                 |
| `0.45.0` | `dropTunnelPasscodeAndSessionSecret` | **Removes** `tunnel.passcodeEnabled` / `tunnel.passcodeHash` / `tunnel.passcodeSalt` and root `sessionSecret`. |
| `0.45.0` | `backfillCloudDefaults`              | Writes the all-`null` `cloud` section when absent (device-link, P2).                                           |

The `dropTunnelPasscodeAndSessionSecret` body exists because the tunnel passcode auth path and the `cookie-session` signing secret were removed — Better Auth is now the one auth path and manages its own session signing. The `sessionSecret` root field and the three `tunnel.passcode*` fields no longer exist in `UserConfigSchema`; stale copies are deleted on upgrade (old passcode hashes are discarded, not migrated). `mcp.apiKey` is retained in the schema for the seeding compat window (folded into a per-user Better Auth key by `seedLegacyMcpApiKey`); its removal is a later cleanup.

### Shipped migrations: agent sidebar organization

Nine `ui.*` migrations have landed. All are append-only and idempotent; seven are pure backfills, and two (`migrateSidebarMembersToItemRefs` and `migrateSidebarSectionPrefs`) reshape fields rather than add them:

| Version  | Body                              | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.50.0` | `backfillSidebarDefaults`         | Writes `ui.sidebar` (empty pins/groups, `name` ungrouped sort, all sections expanded) onto an existing `ui` block when absent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `0.52.0` | `backfillShapesDefaults`          | Writes `ui.shapes` (no active Shape, no affinity hints, follow off) onto an existing `ui` block when absent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `0.55.0` | `backfillSidebarSettingsDefaults` | Writes `ui.sidebar.muted: []`, `ui.sidebar.ungroupedDisplayFilter: 'all'`, and `displayFilter: 'all'` / `muted: false` on every stored group (DOR-339).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `0.57.0` | `migrateStatusBarToPins`          | Puts `ui.statusBar` into its pins shape (`{ pins: [] }`) on an existing `ui` block — status-bar preferences moved from client `localStorage` to server config (DOR-431) and became an additive pin list instead of ten visibility booleans (DOR-452). Drops the retired booleans, which only a pre-release build could have written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `0.57.0` | `backfillSidebarRoomSections`     | Writes `ui.sidebar.channelsCollapsed: false`, `ui.sidebar.dmsCollapsed: false` and `ui.sidebar.threadsCollapsed: false` onto an existing `ui.sidebar` (rooms sidebar, DOR-525; Threads section, room-messaging-design §3). All seed expanded, so an upgrade shows the new sections instead of hiding them behind collapsed headers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `0.57.0` | `backfillAutonomyAcknowledgement` | Writes `ui.autonomyAcknowledgedAt: null` onto an existing `ui` block when the key is absent (spec `trust-dial`, decision 5). Seeds `null` on purpose — an upgrade must never hand out a consent nobody gave, so every existing install meets the confirmation once before its first Full-autonomy session. Skips a key already present, including one a person has reset back to `null`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `0.57.0` | `migrateSidebarMembersToItemRefs` | Converts `ui.sidebar.pinned`, `ui.sidebar.muted` and every group's member list from agent-path strings to `SidebarItemRef` objects, renaming `groups[].agentPaths` -> `groups[].items` (sidebar-groups, DOR-579). Every stored string predates rooms in the sidebar, so all of them map to `{ kind: 'agent', path }`. **The only rename in this table** — see the note below on why correctness does not depend on it running.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `0.59.0` | `backfillComposerPrefs`           | Writes `ui.composer: { richText: true }` onto an existing `ui` block when the section is absent (composer rich text, DOR-948). Seeds **on**, matching the schema default after the owner's 2026-08-12 call. The body originally seeded `false` and was EDITED rather than superseded by a second key, on the since-corrected belief that an untagged key has run for nobody — anyone whose install ran the `false` version still has it (DOR-1222). Skips an existing `ui.composer`, so it never overwrites a choice somebody made.                                                                                                                                                                                                                                                                                                                            |
| `0.59.0` | `migrateSidebarSectionPrefs`      | Moves the seven per-section flags (`ungroupedCollapsed`, `channelsCollapsed`, `dmsCollapsed`, `threadsCollapsed`, `recentsCollapsed`, `ungroupedSortMode`, `ungroupedDisplayFilter`) into the `ui.sidebar.sections` record, records a dismissed groups hint as a retired `suggestion:groups-hint`, and deletes all eight retired keys (spec `sidebar-now-today-library` §D). `pinned`, `groups` and `muted` are not touched. A value already equal to its old default is not carried across, because absent and default mean the same thing on both sides.                                                                                                                                                                                                                                                                                                     |
| `0.63.0` | `backfillPromoDismissals`         | Writes `ui.promos: { dismissedIds: [] }` onto an existing `ui` block when the section is absent (spec `sidebar-simplification` D4). This row used to call the body a no-op ANCHOR — something Ajv's `useDefaults` would supply during validation whether or not it ran, "measured, not assumed". Re-measured in DOR-1496, that is false, and it contradicted [`config.json` holds the effective config](#configjson-holds-the-effective-config) two sections up: opening the store merges only TOP-LEVEL defaults, so a `ui` object already on disk never gains a nested section, and the read-time fill lands in the throwaway copy conf's `store` getter is about to return. This body is the only thing that writes `ui.promos` to an upgrading file. Seeds EMPTY, and skips an existing `ui.promos`, so it can never bring back a card somebody dismissed. |

That table covers the `ui.*` bodies only. The `0.57.0` key is a composite and also carries `migrateStatusBarToPins`, `backfillApprovalsDefaults`, `backfillExtensionsApprovedToRun`, `backfillRoomsDefaults`, `backfillClaudeCodeRuntimeDefaults` (seeds `runtimes.claudeCode` on an existing `runtimes` block — no account chosen, none registered, i.e. today's inherit-the-environment behavior), `backfillRuntimeExecutionDefaults` (seeds `defaultModel` on all three runtime sections and `defaultEffort` on claude-code and codex, every leaf `null` — "let the runtime choose"; runs after the body above so the section it writes into exists), `backfillAutonomyAcknowledgement` (seeds `ui.autonomyAcknowledgedAt: null`), `backfillDefaultTrustStops` (seeds `runtimes.defaultTrustStop` and the per-runtime override on each section, every leaf `null` — each runtime keeps its own starting mode; runs after the two runtime bodies above), and **`applyTier1OptInDefaults`** — which turns `telemetry.install`, `heartbeat` and `usage` off for every install that never answered a consent prompt, reversing the `0.48.0` enrolment for that population (ADR 260727-182651). An explicit choice, in either direction, is left byte-identical, and nobody is re-prompted. That composite is CLOSED: `v0.57.0` is tagged, so a body added to it now runs for nobody who already upgraded past it. New work opens a new key — see [Append-only rule](#append-only-rule).

`0.59.0` is a composite as well, and it is CLOSED — `v0.59.0` shipped on 2026-08-12. It carries `backfillWelcomeBackDefaults` and `backfillClaudeCodePersistentSession` (seeds `runtimes.claudeCode.persistentSession: false` on an existing `runtimes.claudeCode` block — one process per message, i.e. today's behavior) alongside `migrateSidebarSectionPrefs`, which sits there rather than under a key of its own because the schema that removes the eight sidebar keys shipped in that same release. Read that composite as a record: the bodies in it were amended after merging, which is the practice DOR-1222 ended.

`0.60.0` carries a re-run of `backfillRoomsDefaults` for the two collect bounds. It was untagged when it merged and closed from that moment all the same, because merged is what closes a key. Six keys have landed above it since: `0.62.0` seeds `a2a: { enabled: false }` when that section is absent (`seedA2aDisabled`), `0.63.0` carries `backfillPromoDismissals` from the table above, `0.64.0` seeds the `notifications` section ([below](#shipped-migrations-notifications)), `0.65.0` renames `runtimes.claudeCode.activeAccount` to `defaultAccount` and gives every registered account a stable id (`migrateClaudeAccountRegistry`), `0.66.0` raises the room turn limits and adds the two leaves the new room model needs (`raiseRoomTurnLimits`, DOR-1428), and `0.67.0` carries the three safety-neutral bodies of spec `full-power-defaults`: `seedFullPowerDecision` reserves `ui.fullPowerDecidedAt` / `ui.fullPowerChoice` at `null`, `raiseSchedulerConcurrencyFloor` moves a stored `scheduler.maxConcurrentRuns` of exactly `1` to `4`, and `warmClaudeCodeSessionsByDefault` moves a stored `runtimes.claudeCode.persistentSession` of exactly `false` to `true`. `0.67.0` is INDEPENDENT of `0.66.0` and order-immaterial with it — that key touches `rooms.*`, this one `ui.*` / `scheduler.*` / `runtimes.claudeCode.*`, disjoint sections — and it is the newest key.

Read the last two bodies with their caveat, which their own comments state: a stored `1` and a stored `false` are indistinguishable from an explicit choice of the old default, because both are what shipped. Nothing on disk separates "never touched it" from "set it back deliberately", so both are raised. The trade is made with open eyes — neither is a capability, both stay inside bounds the schema already enforced, and the changelog names the change in plain words. `maxConcurrentRuns` is already revertible in Settings -> Tools; `persistentSession` is NOT revertible from any screen until the Control Center lands (task 2.2), because the Experiments row was its only control and graduation removed it — so `PATCH /api/config` is the way back in the meantime, and the changelog says that out loud. **No consent-gated value is touched by that key** (the program's A1 invariant): `runtimes.defaultTrustStop`, `ui.autonomyAcknowledgedAt`, `approvals.standingGrants`, the mesh access rules and `canInitiate` are written by the power door's accept, with a person looking at it, and never by a migration.

Believing it was open is what let DOR-1121 flip `backfillWelcomeBackDefaults` to seed `offersEnabled: true`, a few hours after DOR-1046 wrote it seeding `false`, by amending the body rather than appending a key. The reasoning recorded at the time — nobody had run it, so nobody carries the old seed — was wrong: any install that booted a build carrying `0.59.0` in those hours ran the `false` version and still has it. The fill-if-absent rule does leave an explicit `false` on disk exactly where it is, which is the half of that argument that holds, and the reason a later key re-seeding `true` would have been worse rather than better.

`ui.sidebar` holds the server-persisted sidebar organization — pinned items, user-defined groups (each with its own member order, sort mode, collapse state, display filter, and mute flag), and per-section sort/collapse/filter/mute preferences. `pinned`, `muted` and `groups[].items` all hold `SidebarItemRef` values (`{ kind: 'agent', path }` or `{ kind: 'room', roomId }`), compared with `sameSidebarItem` — a union has no structural identity, so `includes`/`indexOf`/`===` would silently miss. conf merges top-level defaults shallowly and never reaches inside array elements at all, so a `ui.sidebar` already on disk — including every group inside it — never inherits a newly-added field on its own; each backfill above supplies exactly the fields it introduced. None of them overwrite an existing value, so a user's organization, filters, and mute choices all survive untouched across upgrades.

#### A reshape is not a backfill

Every additive migration here degrades safely: skip the key, the field is absent, a Zod default fills in, nothing breaks. The two reshapes do not. `migrateSidebarMembersToItemRefs` renames a field and `migrateSidebarSectionPrefs` REMOVES eight, and skipping either is destructive — the old encoding becomes schema-invalid, conf's Ajv throws in the `ConfigManager` constructor, and the recovery path backs the file up and replaces it with defaults. Not "the sidebar forgets its groups": the whole file resets, `mesh.scanRoots`, `approvals`, `runtimes`, `cloud` and `onboarding` with it.

Since DOR-584 the reset is no longer total. `safe-defaults/protected-state.ts` reads the doomed file before it is replaced and re-applies the person's consent decision and any value they had moved to the protective side (ADR 260727-181825). That narrows the blast radius; it does not remove it. Preferences still go, and salvage depends on the file being readable as JSON — so not condemning the file in the first place, which is what the rename handling below is for, is still the primary defence rather than a belt-and-braces extra.

**Downgrading is still not a supported way back**, though since DOR-1221 a NEW KEY no longer costs the file, and since DOR-1227 a WIDENED VALUE on a named setting does not either. A config that `migrateSidebarSectionPrefs` has rewritten carries `sections`, `gettingStarted` and `digest`, and an older build's schema does not describe them; that build now ignores those keys and leaves them on disk ([Keys from another build](#keys-from-another-build)) instead of condemning the whole config. A newer build's `ui.theme: 'midnight'` is read as `system` and left on disk for the build that understands it ([Values from another build](#values-from-another-build)). What the older build cannot do is honour a preference it has no field for, and a RENAME still loses the value in both directions unless the old name is tolerated too. The migration is written to be idempotent so a re-upgrade is a clean no-op.

**The residual, stated plainly: a widened value inside a LIST or a RECORD still costs the file.** The two tolerances cover named keys and named scalar leaves. A new member of `ui.statusBar.pins`, a new `workbench.defaultViewers` viewer, a new `onboarding.completedSteps` step, a new `providers` credential form — anything whose position inside a list or a record is its only identity — is still condemned by an older build, and so is a change to `version` itself. The reason is in [Values from another build](#values-from-another-build): tolerance stops where preservation stops, and nothing can carry a list element back across a write without guessing which element it was.

Migrations are skipped more often than the table suggests. conf runs a key only when `key > storedVersion && key <= projectVersion`, so a dev tree — where `SERVER_VERSION` resolves to `0.0.0` — runs **none** of them, and shipping a schema in a patch release below its migration key skips that key for every user.

So a rename needs two things the additive backfills never did:

1. **`tolerateRetiredSidebarKeys`** (`config-manager.ts`) widens the JSON Schema handed to conf. It has two jobs, and conflating them is easy: for `SidebarItemRefSchema` and `SidebarGroupSchema` it makes Ajv ACCEPT the pre-DOR-579 encoding — and, more subtly, makes it KEEP `groups[].agentPaths`, because conf builds Ajv with `removeAdditional` and an undeclared key is deleted from the object on the way in rather than preserved. For `SidebarPrefsSchema` it names the eight keys the P2 redesign retired, which is the opposite errand: they already load (unknown keys always do), and declaring them is what makes Zod's strip on the write path clear them out. It lives at that seam rather than in the Zod schema because Ajv is the only validator on the config read path.
2. **`ConfigManager.canonicalSidebar`** converts, once per process, the first time anything reads `ui`, and writes the result back.

DOR-579 originally shipped that conversion differently: `normalizeSidebarPrefs` ran on **every** read, in the server and again in the cockpit, scanning three lists for ever to answer "no". DOR-588 replaced it with the latched version above and deleted the client's copy. What did not change is the guarantee: nothing a person organised is lost, on any install, whether or not the migration ran.

The half-legacy file is the one to hold in mind. A config whose `pinned` and `muted` are already references and whose only old part is a section's `agentPaths` looks perfectly healthy — and without the widening above, Ajv drops that key, the section loads with no members, and the next config change of any kind saves it empty. It has a fixture of its own, named for its subject, in `'a pre-DOR-579 sidebar is converted the first time anything reads it (DOR-588)'` in `config-manager.test.ts`. That block boots a real `ConfigManager` over real files; the mock-store tests cannot see this failure, and neither can `UserConfigSchema.parse`, because Zod strips unknown keys where Ajv rejects them.

The conversion runs on the first READ rather than at boot on purpose. At boot it would cost a read of a file the operating system may be refusing, on a machine already in trouble, and this class promises that a boot it cannot complete leaves the settings exactly where they are — a promise `config-load-failure.test.ts` measures down to the number of read attempts.

`ui.shapes` holds person-scoped Shape state (DOR-355): the currently-applied Shape (`active`), the reverse affinity hints that map an agent's `projectPath` to a preferred Shape (`agentDefaults`), and whether applying a Shape auto-follows to its default agent (`autoFollowAgent`, off by default). It lives in user config — never on `.dork/agent.json` — per ADR 260717-001409. Each section is written as a whole object (deepMerge replaces arrays). The same shallow-merge caveat applies, so `backfillShapesDefaults` supplies the nested default onto an existing `ui` block and never overwrites an existing `ui.shapes`.

`ui.statusBar` holds the status-line pins (DOR-431, DOR-452). It was promoted from client `localStorage` into server config so the choice syncs across every client and an agent can set it via `config_patch` (spec agents-as-operators). The status line is quiet by default — an item appears when its promotion rule fires — so `pins` is additive: it lists the items to show anyway. The schema enumerates the legal pin keys, so a `config_patch` naming an unknown item fails validation instead of persisting a typo; the client's `isPinnable` set and that enum are kept in step by a drift test. A PATCH replaces arrays wholesale, so patching `pins` sets the whole list. The same shallow-merge caveat applies, so `migrateStatusBarToPins` supplies the nested default onto an existing `ui` block.

`ui.composer.richText` decides whether the message box shows formatting as you type instead of leaving markdown as characters (DOR-948). It lives in server config for the same reason pins do — the choice follows the person to every client on this machine — its three classifications are `no-risk` (it sends nothing off the machine, grants no capability and enforces no bound — the same class as `ui.theme`), `expose`, and `agent-writable`, because nothing is at stake in it. **It ships `true`** — the repo owner made that call on 2026-08-12, ahead of the graduation criteria in `specs/composer-rich-text/02-specification.md`, on the reasoning that the two rungs still open (IME and screen readers) need people using the thing to get exercised. Only the chat composer reads it; rooms and onboarding stay plain, which is composition rather than configuration. The Settings → Advanced switch stays as the escape hatch and comes out with the plain textarea path, which is blocked on the nested-list serialize fix. The same shallow-merge caveat applies, so `backfillComposerPrefs` supplies the nested section onto an existing `ui` block and never overwrites an existing `ui.composer`.

`ui.autonomyAcknowledgedAt` records that this person read what a mode that never asks means and asked not to be shown the dialog again (spec `trust-dial`, decision 5). A timestamp rather than a boolean, because the record is only worth keeping if it says WHEN: Settings shows the date back with a Reset that clears it. `PATCH /api/sessions/:id` refuses such a mode unless the request carries `acknowledgedAutonomy: true` **or** this field is set — the checkbox trades a repeated ritual for a recorded one, and the server's requirement never relaxes.

**Which modes need it is a semantic rule, not the autonomy stop alone** (DOR-816): `needsConsentRitual` in `@dorkos/shared/permission-semantics` answers yes for a mode at the `autonomy` stop, and for any mode declaring `asks: 'never'` with a `reach` other than `'read'` — Codex files exactly such a mode at the middle stop. One record covers the whole door whichever mode opened it. The `defaultTrustStop` leaves are unaffected: they store one of the dial's three stops, where only `autonomy` can mean "does not ask".

**It is a consent ritual, not a security boundary.** Any caller that can reach the route can send `acknowledgedAutonomy: true` itself; what the door buys is that a person cannot arrive in a mode that never asks without having been told what that means. The boundary against agent callers is separate work (`agent-approval-settings`, DOR-501). **Two surfaces are outside the door entirely, on purpose:** a session BORN at a runtime's declared default never PATCHes and so is never gated (what keeps that honest is the separate invariant that no production runtime defaults to a stop that stops asking), and Obsidian's `DirectTransport` calls `runtime.updateSession` in-process without crossing the route at all. Obsidian also cannot store the standing record — its `updateConfig` is a no-op and its `getConfig` returns no `ui` block — so the cockpit withholds the "don't show this again" checkbox there rather than offering a tick that saves nothing (`useAutonomyAcknowledgement().canRemember`). It lives under `ui` rather than `approvals` because every `approvals.*` leaf requires login to write, and requiring login to dismiss a dialog would make the feature unreachable on the default login-off install; it is still `operator-only`, so an agent cannot forge the record. Unattended surfaces — bindings, tasks, rooms — never pass through this route and keep their own, stricter gates.

This field briefly held ten visibility booleans instead (`cwd`, `git`, … each `true` = shown), between DOR-431 and DOR-452 and never in a tagged release. Pins replaced them because the semantics inverted — subtractive "hide this" became additive "always show this" — and there is no faithful mapping between the two: translating visible→pinned would hand anyone still on the defaults ten pins and erase the quiet line. `migrateStatusBarToPins` therefore drops the old booleans rather than converting them, a deliberate one-time reset.

### Shipped migrations: notifications

One body landed with the notification system (spec `notification-system`, DOR-1385), under a key of its own:

| Version  | Body                           | Effect                                                                                                                                                                                                                            |
| -------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.64.0` | `backfillNotificationDefaults` | Writes the whole `notifications` section from `NOTIFICATION_PREFS_DEFAULTS` when it is absent: knock and all-clear sounds on, the every-turn chime off, away notices on, escalation at 2 minutes, the permission card unanswered. |

It seeds a **top-level** section, unlike every `ui.*` body in the table above, so there is nothing on disk to merge into. An install that predates it has no `notifications` key at any depth, and conf merges top-level defaults shallowly. It reads the shared defaults constant rather than a literal, so the seed cannot drift from the schema it is seeding, and it skips a section already present, so re-running can never overwrite a choice somebody made.

**The per-browser chime it replaces is not migrated here.** `dorkos-enable-notification-sound` lives in a browser's `localStorage`, which the server cannot read, so the cockpit imports it on first read instead. See [notifications](#notifications) above.

### Interaction with `/system:release`

The `/system:release` command includes a **config schema migration drift** check in Phase 2. When it detects that `packages/shared/src/config-schema.ts` or `apps/server/src/services/core/config-manager.ts` changed since the last tag without a matching migration entry at the target version, it offers three paths:

- **Scaffold the migration inline** — the command drafts a migration, presents it for your review, then edits `config-manager.ts` to append the entry and bump `projectVersion`. The modified file is staged into the release commit automatically.
- **Pause so you can write it manually** — exits the release cleanly; you edit `config-manager.ts`, commit, then re-run `/system:release`.
- **Mark as "no migration needed"** — for type-only changes, TSDoc updates, or added-field-with-default cases where conf's defaults-merge handles it automatically. You take responsibility; the release continues.

See `.claude/commands/system/release.md` Phase 2 for the full flow.

### Anti-patterns

- **Editing a migration body that has already merged.** Creates inconsistent state across users — including when no tag carries it yet, because a built CLI or the desktop app runs the version before it is tagged (DOR-1222). Append a new migration instead.
- **Hardcoding `projectVersion` in the Conf constructor.** It's sourced from `SERVER_VERSION` — never pass a string literal. If the version resolver itself breaks, fix `lib/version.ts`, not `config-manager.ts`.
- **Non-idempotent migrations.** Always guard with `store.has()` / `store.get() === oldValue` so re-running the same migration (e.g., after a corrupt-recovery that reset the internal version tracker) is safe.
- **Adding a required field without a default.** `USER_CONFIG_DEFAULTS = UserConfigSchema.parse({ version: 1 })` runs at import time — a missing required field crashes the server on startup for every new install.
- **Changing `UserConfigSchema` without updating this doc or `docs/getting-started/configuration.mdx`.** Users read docs to discover what they can configure; leaving them stale is worse than not having them.

### Live-apply: `configManager.onChange`

Most settings are read at use, so a change simply governs the next thing that reads them. A few are **applied once** — `runtimes.default` is pushed onto the runtime registry at boot and never re-read — and a Settings screen over a field like that is a quiet lie: the person changes it, the screen agrees, and nothing happens until they restart.

`ConfigManager.onChange(listener)` is the seam that fixes it. It fires after any write **this process** makes — `PATCH /api/config` and the `config_patch` operator tool both go through `applyConfigPatch`, which calls `configManager.set` — and reports only the top-level sections that were touched, never values (a listener reads back what it cares about, which cannot go stale between the write and the read). It returns an unsubscribe function, and a listener that throws is logged and stepped over: the write has already landed, and a subscriber must not turn somebody's settings change into a 500.

**What it does not see:** `dorkos config set` run in a terminal, or a hand edit of `config.json` while the server runs. Those still take effect at the next restart, exactly as before. conf's own file watcher (`watch: true`) would cover them, and was not used: its `onDidChange` is unreachable from outside the class (the store is private, and exposing it hands every caller an unvalidated store), a live `fs.watch` is a handle held by every manager a test constructs, and the case this was asked for — a person changing a setting in the cockpit and expecting it to hold — is in-process by construction. If out-of-process live-apply ever becomes the complaint, the upgrade is `watch: true` bridged into this same emitter.

The one subscriber today is `applyAndWatchConfiguredDefaultRuntime` (`services/core/runtime-registry.ts`), which re-applies `runtimes.default`. The execution defaults (`runtimes.*.defaultModel` / `defaultEffort`) need nothing: they are read when a session is created, so a change governs the next session on its own. `runtimes.claudeCode.persistentSession` needs nothing for the same reason — it is read when a session launches its process, so a change governs the next process rather than the one already running.

### Future work

`~/.dork/marketplaces.json` is currently owned by a hand-rolled `MarketplaceSourceManager` (in `apps/server/src/services/marketplace/marketplace-source-manager.ts`) rather than `conf`. A pending refactor will unify it onto the same pattern. When it lands, the `adding-config-fields` skill and the `/system:release` drift check both extend to cover it — no parallel system.

### server.port

The TCP port for the Express server. Must be an integer between 1024 and 65535.

```bash
dorkos config set server.port 8080
```

Equivalent CLI flag: `--port` / `-p`
Equivalent env var: `DORKOS_PORT`

### server.cwd

The default working directory for Claude Code sessions. When `null`, the server uses the current working directory at startup.

```bash
dorkos config set server.cwd /home/user/projects/myapp
```

To clear back to "use current directory":

```bash
dorkos config set server.cwd null
```

Equivalent CLI flag: `--dir` / `-d`
Equivalent env var: `DORKOS_DEFAULT_CWD`

### server.boundary

The directory boundary restricts all filesystem operations to a specific root directory. When `null` (default), the boundary is the user's home directory (`~/`). All API endpoints that accept `cwd`, `path`, or `dir` parameters validate against this boundary and return 403 if the path is outside it.

At startup, the server logs a warning if:

- The boundary is set above the home directory
- `server.cwd` is outside the configured boundary (falls back to boundary root)

```bash
dorkos config set server.boundary /home/user/projects
```

Equivalent CLI flag: `--boundary` / `-b`
Equivalent env var: `DORKOS_BOUNDARY`

### server.open

Whether to automatically open DorkOS in the default browser on startup. Defaults to `true`. Only applies in interactive terminals (non-TTY environments always skip opening).

```bash
dorkos config set server.open false
```

Equivalent CLI flag: `--no-open` (to suppress) — there is no `--open` flag since the default is already `true`
Equivalent env var: `DORKOS_OPEN`

**Open browser resolution:**

```
--no-open                # CLI flag (wins if provided, sets open=false)
DORKOS_OPEN=false        # Env var (wins if no CLI flag)
server.open: false       # config.json (wins if no env var)
true                     # Built-in default (fallback)
```

### tunnel.enabled

Whether to start an ngrok tunnel automatically when the server starts. Requires `NGROK_AUTHTOKEN` to be set (via env var or `tunnel.authtoken`).

```bash
dorkos config set tunnel.enabled true
```

Equivalent CLI flag: `--tunnel` / `-t`
Equivalent env var: `TUNNEL_ENABLED`

### tunnel.domain

A custom ngrok domain (e.g., `myapp.ngrok.io`). When `null`, ngrok assigns a random subdomain.

```bash
dorkos config set tunnel.domain myapp.ngrok.io
```

Equivalent env var: `TUNNEL_DOMAIN`

### tunnel.authtoken

The ngrok authentication token. This is a **sensitive field** -- setting it via config will produce a warning. Prefer using the `NGROK_AUTHTOKEN` environment variable instead.

```bash
# Preferred: use environment variable
export NGROK_AUTHTOKEN=your-token-here

# Alternative: store in config (triggers warning)
dorkos config set tunnel.authtoken your-token-here
```

Equivalent env var: `NGROK_AUTHTOKEN`

### tunnel.auth

HTTP basic authentication credentials for the tunnel in `user:pass` format. This is a **sensitive field** -- prefer the `TUNNEL_AUTH` environment variable.

```bash
# Preferred: use environment variable
export TUNNEL_AUTH=admin:secretpassword

# Alternative: store in config (triggers warning)
dorkos config set tunnel.auth admin:secretpassword
```

Equivalent env var: `TUNNEL_AUTH`

### logging.level

The log verbosity level for the server. Controls both console output and NDJSON file logging to `{DORK_HOME}/logs/dorkos.log`.

```bash
dorkos config set logging.level debug
```

Equivalent CLI flag: `--log-level` / `-l`
Equivalent env var: `DORKOS_LOG_LEVEL`

Log files are written as NDJSON (newline-delimited JSON) with daily rotation. When a log file is from a previous day, it's renamed to `dorkos.YYYY-MM-DD.log`. Within the same day, files exceeding the size threshold are rotated to `dorkos.YYYY-MM-DD.N.log`. Default: 500KB max size, 14 rotated files retained.

### logging.maxLogSizeKb

Maximum log file size in kilobytes before size-based rotation triggers. Range: 100–10240. Default: `500`.

```bash
dorkos config set logging.maxLogSizeKb 1024
```

### logging.maxLogFiles

Maximum number of rotated log files to retain. Range: 1–30. Default: `14`.

```bash
dorkos config set logging.maxLogFiles 7
```

### ui.theme

The UI color theme. Options: `light`, `dark`, or `system` (follows OS preference).

```bash
dorkos config set ui.theme dark
```

### notifications

How DorkOS gets your attention, and how hard it tries (spec `notification-system`, DOR-1385). One top-level block rather than three scattered leaves, because a person deciding "how loud should this be?" should not have to find the answers in three places. It is config rather than browser storage for the reason `ui.promos.dismissedIds` is: how loud your agents may be is a fact about the person, so answering it on a laptop should answer it on a phone.

Settings → Notifications is the surface. Every leaf also moves from the command line:

```bash
dorkos config set notifications.sounds.turnEnd true
dorkos config set notifications.notifyOnTurnCompleteWhileAway false
```

**`notifications.escalation.phoneAfterMinutes` has nothing reading it yet.** It stores the answer to "how long may something sit waiting on me here before you try somewhere else", and the ladder that would act on it (a phone, a chat app) is later work. The default of 2 minutes is long enough that stepping away from the keyboard does not buzz a phone, and short enough that a ten-minute prompt window is not mostly gone before anybody is told. It is documented because the setting is real, persisted, and settable today, not because anything escalates.

`notifications.sounds.turnEnd` is the one leaf with a history. That chime used to fire on every turn of every session, held per browser in `localStorage` under `dorkos-enable-notification-sound`, and on for everybody. It now ships **off**: across a fleet of agents a sound every turn carries no information, and `sounds.knock` is the cue that means something. Nobody loses a choice they made. `useNotificationPrefs` (`apps/client/src/layers/entities/config/model/use-notification-prefs.ts`) reads the retired browser key once after config has answered, promotes an explicit `true` to `turnEnd: true`, and clears the key either way. The server never sees that key, which is why this import lives in the cockpit rather than in the migration.

**All six leaves are classified together:** `expose` in `CONFIG_DISCLOSURE`, `operator-only` in `CONFIG_WRITE_POLICY`, and `no-risk` in `default-verdicts.ts`. An agent may read how loud it is allowed to be and may not change it, because an agent that could write these could silence the very channel that says it is waiting on you. `no-risk` follows from the same reading of the defaults that `ui.theme` gets: nothing here sends data off the machine, grants a capability, or relaxes a bound.

Existing installs are seeded by the `'0.64.0'` migration, below.

### mesh.scanRoots

Directories to scan for agent discovery. The Mesh subsystem is always enabled and initializes automatically on server startup. If initialization fails (e.g., SQLite errors), the server continues with graceful degradation.

When `scanRoots` is empty (default), the reconciler scans from the server's default working directory. Add explicit paths to control which directories are scanned for `.dork/agent.json` manifests.

```bash
dorkos config set mesh.scanRoots '["/home/user/projects", "/home/user/agents"]'
```

### rooms.turnLimitsEnabled

The master switch over everything in this section. On — how it ships — the cascade guard and both hourly caps apply. Off, none of them do: agents answer each other with no reply ceiling and no hourly ceiling, and the halt button and per-agent Stop are the only things that end an exchange (ADR 260823-000218 accepts that state explicitly).

Off is a posture for watching two agents work something out, not one to leave on: every turn costs a model call. The numbers below are kept while it is off, so turning it back on restores exactly what was set. Operator-only, and the sharpest one in the block — a single write takes every bound off at once.

```bash
dorkos config set rooms.turnLimitsEnabled false
```

### rooms.maxAgentDepth / rooms.maxTurnsPerAgentPerCascade

The cascade guard from ADR 260726-170127, as amended by ADR 260823-000217. A room post triggers every agent member the message addresses; a triggered agent's reply is itself a post, so it can trigger the next agent.

`maxAgentDepth` is how deep that whole chain may run. `maxTurnsPerAgentPerCascade` counts each agent separately, and it is the rule that actually bounds ping-pong: two agents trading answers stop after ten each rather than running the chain out between them, and it fires well below the depth ceiling. It used to be an ancestry rule — one turn per agent per conversation, ever — which was too tight to hold a real exchange and is now a counter with a number a person can move.

`maxTurnsPerAgentPerCascade` counts **turns, not messages** (DOR-1434). Every entry one turn writes carries that turn's `dispatch_id`, so an agent that posts three progress notes through the rooms tool and then answers has spent one, not four. Entries with no turn behind them — a person's post, an agent post with nothing in flight, and every row written before the column existed — count one each, which is what they cost under the message counting this replaced.

A post by a **human** always starts a fresh cascade at depth 0, so a room the guard has quietened is always one message from running again. `maxAgentDepth: 0` refuses every automatic reply, which is the way to turn room triggering off without leaving a room.

Refusals are visible: the room writes a `notice` entry naming the agent that stopped. Both are operator-only — an agent that could raise its own reply ceiling could spend your model budget.

```bash
dorkos config set rooms.maxAgentDepth 5
dorkos config set rooms.maxTurnsPerAgentPerCascade 3
```

### rooms.maxAutomaticTurnsPerRoomPerHour / rooms.maxAutomaticTurnsTotalPerHour

Two rolling caps on automatic turns, and the **only** spend bounds that do not depend on the auth posture.

The cascade guard above decides who may reset a cascade by reading the author's kind, and `resolveCaller` answers that by looking for an `X-DorkOS-Agent` header. With `auth.enabled` off — the default — `sessionGate` is a pass-through, so a local program that simply omits the header resolves as the local human and clears both the cascade reset and every `OPERATOR_ONLY` roster gate. That is the DOR-505 residual (`lib/caller-authority.ts` documents the same move) and it cannot be closed from the rooms domain.

These caps do not ask. They count every automatic turn a room starts, refuse past the number, and write a `budget_reached` notice once per exhaustion.

**Both exist because only one of them bounds spend.** The per-room cap bounds a _room_, and rooms are free — a caller multiplies its allowance by creating them (measured: 2/room bought 16 turns across 8 channels). The total cap is the ceiling. The per-room cap stays because it stops a single busy room eating the whole allowance and starving the others.

Threads used to be the cheaper version of that lever and are not any more. While a thread was a child room it carried a window of its own and five threads off one parent bought 12 turns against a cap of 2; under ADR `260728-022013` a thread reply is an entry in its channel, so one window covers a channel and everything threaded inside it.

Set either to `0` to stop automatic replies entirely.

**Both windows survive a restart** (DOR-1205). Each turn that actually runs is written to `room_turn_spend` and the current hour is read back when the server starts, so an hour means an hour of wall clock rather than an hour of uptime — restarting no longer clears either ceiling. Rows age out of the table as new ones land, so it holds at most the last hour and is a counter, never a spend history.

They ship loose on purpose (ADR 260823-000218): at the old 60/240 they fired during ordinary work, and a cap that fires during ordinary work gets turned off rather than respected. The trade is stated there — a fresh install can spend about 5,000 automatic turns in an hour at the worst case.

```bash
dorkos config set rooms.maxAutomaticTurnsPerRoomPerHour 120
dorkos config set rooms.maxAutomaticTurnsTotalPerHour 480
```

### rooms.engagedWindowMinutes / rooms.engagedWindowPosts

The two ceilings behind the `engaged` response mode, which is what a channel seeds a new agent member to (room-participation spec §9).

`engaged` answers when the agent is addressed **and** for a bounded window afterwards. That window is not stored anywhere: it is a predicate over the room log, read fresh on every message, so there is no state to reset on restart and nothing that can disagree with what was actually said. It ends when either ceiling runs out — ten minutes, or five messages from other members — and being addressed again starts both over, because the new mention simply becomes the anchor.

The window is **thread-scoped**. Being addressed inside a thread engages an agent in that thread and nowhere else, and being addressed at the channel's top level does not engage it inside every open thread.

Neither number is measured. No vendor publishes a figure for how long a person expects to keep talking to something without naming it again, and no study establishes one (`meta/agent-etiquette.md` §10). These are ours, to be tuned by using the product.

Both are **ceilings, not settings**: a room can hold an agent to a shorter window, never a longer one. Set either to `0` and `engaged` behaves exactly like `mention-only`. Operator-only — an agent that could lengthen its own window would be voting itself back into every conversation it was ever addressed in.

```bash
dorkos config set rooms.engagedWindowMinutes 3
dorkos config set rooms.engagedWindowPosts 2
```

### rooms.collectDebounceMs / rooms.collectMaxEntries

How a room decides that people have stopped talking (room-participation spec §10.4).

Messages that reach the same agent inside `collectDebounceMs` are answered by ONE turn: the newest is what the agent replies to, and the ones behind it are in front of it as context. Half a second of gathering turns "three people talking at once, three rushed replies" into one considered one, and it costs one automatic reply instead of three.

The window opens once and does not slide. A message arriving inside it joins the batch without pushing the deadline back, so a room where somebody types every four hundred milliseconds still gets an answer — starving the reply for as long as the chatter lasts would be the opposite of gathering it. `collectMaxEntries` is the other bound in the same direction: reaching it answers straight away rather than waiting the window out, and the messages past it start the next answer.

Nothing is ever dropped. A message the window did not fit is still in the room, and the agent reads it on its next turn — including a message that lands while the agent is already working, which is folded into that agent's next answer and marked as having arrived while it was busy.

Neither number is measured; both are ours, to be tuned by using the product (`meta/agent-etiquette.md` §9). Operator-only, for the reason the engaged window is: an agent that set the pause to zero and the cap to one would be voting itself a turn per message.

```bash
dorkos config set rooms.collectDebounceMs 1500
dorkos config set rooms.collectMaxEntries 10
```

### welcomeBack

What your agents may say when you come back after being away (spec `team-room-home`, D5.2).

The iron rule these numbers enforce is **news, not noise**. Coming back to three useful lines is a welcome; coming back to twelve is a reason to turn the feature off. Every leaf is a ceiling on the noise, never a target to fill — an install where nothing happened while you were gone stays silent whatever these say.

`absenceThresholdMinutes` is four hours by default: long enough that something real has happened since, short enough to catch a morning. Its floor is a quarter of an hour because anything shorter is a coffee, not an absence; its ceiling is a week, past which "what changed" is a question the feed answers better than a greeting does. `maxPosts` is three, because a welcome is read at a glance; `0` silences the posts while leaving the feature on, and `enabled: false` is the cheaper way to the same silence because it also skips the work of deciding who had news.

`offersEnabled` is the one leaf here that costs money, which is why it is its own switch — and since DOR-1121 it ships **on**, because the offer is the part of a return worth reading and a spend switch nobody finds is a feature nobody has. The status lines above are derived from session state and spend nothing; an OFFER — "want me to open the PR?" — cannot be known about without asking the agent, and asking runs it for a turn. Three things bound that spend rather than a sentence in a prompt. The switch names the cost where a person meets it (Settings → Preferences), turning it off is one click that nothing takes back — no migration re-seeds it and `PROTECTIVE_CARRYOVERS` carries the off through a config wipe — and the ceiling is the cap you already set: the only agents ever asked are the ones `maxPosts` let speak, each asked at most once per return. Every way an offer can fail (a busy agent, an exhausted turn budget, a failed turn, an agent with nothing to say) is silence — the status lines still post, and the room writes no notice about the offer that did not happen. An offer that simply takes a long time is late rather than lost: it is waited out to `rooms.lateReplyCeilingMinutes` and posted when it lands, like every other slow turn in a room.

All four are operator-only, on the same side of the line as `rooms.engagedWindow*`: they decide whether a turn **runs**, not how long a room waits for one that was already going to. Posts ride the ordinary room path, so the cascade guard and both automatic-turn spend caps hold them like any other turn — an offer turn is charged against `rooms.maxAutomaticTurnsPerRoomPerHour` exactly as a reply is.

**`enabled` and `offersEnabled` have switches in the cockpit** (Settings → Preferences); the offers switch is hidden while the notes are off, because there is nothing for an offer to ride on. The two numbers stay file-only and go out over `GET /api/config` read-only, so the switch can name the threshold actually in force instead of the shipped default. They are judgement calls somebody tunes once; further controls earn their place after the first ones have been lived with, not before.

```bash
dorkos config set welcomeBack.enabled false
dorkos config set welcomeBack.absenceThresholdMinutes 720
dorkos config set welcomeBack.maxPosts 1
dorkos config set welcomeBack.offersEnabled false
```

### uploads

Controls file upload limits for the `POST /api/uploads` endpoint. The upload handler reads these values dynamically on each request from the config manager.

| Key                    | Type       | Default            | Description                       |
| ---------------------- | ---------- | ------------------ | --------------------------------- |
| `uploads.maxFileSize`  | `number`   | `10485760` (10 MB) | Maximum file size in bytes        |
| `uploads.maxFiles`     | `number`   | `10`               | Maximum files per request (1--50) |
| `uploads.allowedTypes` | `string[]` | `["*/*"]`          | Allowed MIME types                |

```bash
dorkos config set uploads.maxFileSize 52428800    # 50 MB
dorkos config set uploads.maxFiles 20
```

### agentContext

Controls which tool domain blocks are injected into agent system prompts. Each toggle determines whether the corresponding tool documentation is included in the context, helping agents understand available tools.

| Key                         | Type      | Default | Description                                |
| --------------------------- | --------- | ------- | ------------------------------------------ |
| `agentContext.relayTools`   | `boolean` | `true`  | Include Relay messaging tool documentation |
| `agentContext.meshTools`    | `boolean` | `true`  | Include Mesh discovery tool documentation  |
| `agentContext.adapterTools` | `boolean` | `true`  | Include adapter tool documentation         |
| `agentContext.tasksTools`   | `boolean` | `true`  | Include Tasks scheduler tool documentation |

These can be configured globally in Settings > Tools tab, or per-agent via the agent manifest's `enabledToolGroups` field (which overrides global defaults).

```bash
dorkos config set agentContext.relayTools false
dorkos config set agentContext.tasksTools false
```

### runtimes

Controls the agent runtimes beyond Claude Code (Codex and OpenCode, spec `additional-agent-runtimes`). Both are enabled by default and register at server startup; a disabled runtime is simply never registered — it disappears from pickers, capabilities, and session-list aggregation. The `claudeCode` block is the exception in kind: it does not gate registration (Claude Code is always available) but chooses **which Claude account** the runtime runs on.

```bash
dorkos config set runtimes.default opencode
dorkos config set runtimes.codex.enabled false
dorkos config set runtimes.opencode.binaryPath /opt/opencode/bin/opencode
dorkos config set runtimes.claudeCode.defaultAccount ~/.claude2
```

#### runtimes.claudeCode — which Claude account runs the work

A "Claude Code account" **is** a Claude config directory: it holds that account's `projects/` transcripts and its own sign-in, which is why pointing the SDK at a different one changes both the history DorkOS can see and the subscription the work bills to. An operator running one account per paying client runs several of these directories.

Before this block existed, which one DorkOS used was decided entirely by whatever `CLAUDE_CONFIG_DIR` the launching terminal happened to export, and could not be changed from inside DorkOS at all. Spec `claude-code-accounts` (DOR-729) adds two decisions:

- **`defaultAccount` sits IN FRONT of the env var, not behind it.** `resolveActiveClaudeRoot()` (`services/runtimes/claude-code/claude-config-dir.ts`) resolves `defaultAccount ?? $CLAUDE_CONFIG_DIR ?? ~/.claude`, so a configured account is deterministic instead of depending on the launching shell. At the `null` default the chain is byte-for-byte the SDK's own, so nothing changes for anyone who does not set it. It is stored as a **path, not an index into `accounts`** and not an id, so removing an account can never silently repoint the selection at a different client — and a default may legitimately name a root that is not a registry entry. (Renamed from `activeAccount` in 0.65.0, spec `billing-account-ladder`; the migration carries the value.)
- **A launch resolves a LADDER, and `defaultAccount` is only its third rung.** `resolveLaunchAccountRoot()` in the same module walks session launch hint → agent manifest `account` → `defaultAccount` → the environment (ADR 260821-205323). The first two reference accounts by `accounts[].id`, never by path (ADR 260821-205324); an id that names no registered account logs a warning and falls through, so a launch never fails over a billing setting. The ladder runs ONLY when a session has no account of its own — after launch, disk owns the answer (ADR 260801-204127). An agent's `account` is operator-only: the agent-reachable self-edit path (`services/core/operator/agent-updater.ts`) refuses the key, while the cockpit's `PATCH /api/mesh/agents/:id` accepts it.
- **`resolveClaudeRootSet()` is the union listing and search enumerate**: the active root, `$CLAUDE_CONFIG_DIR` when set, `~/.claude` unconditionally, and every `accounts[].path` — deduplicated, active root first. `~/.claude` stays in even when another account is active, because the SDK may already have written there and dropping it would hide history. Choosing an account therefore ADDS it to the set, so selecting `~/.claude2` cannot move new work somewhere listing does not cover.

**Validation is structural, never credential-based.** A directory qualifies as an account when it exists and contains a `projects/` subdirectory. That single test separates the real accounts from neighbours like `~/.claude-worktrees` and `~/.claudekit`, which have none. Claude Code names its macOS Keychain entry after a hash of the config directory, which explains _why_ changing the directory changes the billing identity — but that is observed behavior of one release and macOS-only, so nothing here depends on it. Authentication failures surface as runtime errors, which is honest, rather than as a pre-flight guess. **Never auto-glob `~/.claude*`**: it is a guess and it sweeps up exactly those two non-accounts. The operator registers accounts.

All of these leaves are `operator-only`. A Claude config directory carries its own sign-in, so moving the default account moves the operator's spend onto a different subscription — for the operator this was written for, a different paying client. Under login-on that means the account switcher writes through `PATCH /api/config` with a session cookie and must handle a 403 rather than assume success.

`GET /api/config` reports this block **resolved**, as `claudeCode: { resolvedAccount, inherited, accounts[] }` (each row carrying its `id`), for the same reason it resolves `claudeCliPath` and `agents.defaultDirectory`: the cockpit cannot see the server process's `CLAUDE_CONFIG_DIR`, so it would otherwise show an empty field where the effective default belongs. Each account also carries **`isAccountRoot`** — the same structural check, deliberately not named `exists`, because a directory that is really there but holds no `projects/` reports `false` — so the UI can say honestly which registered directories DorkOS can no longer find.

**A change applies live.** `applyConfigPatch` (the seam both `PATCH /api/config` and the `config_patch` operator tool go through) compares the accounts before and after the write and calls `applyClaudeAccountChange()` (`services/runtimes/claude-code/account-switch.ts`) when they moved: drop the transcript reader's caches, restart the session-list broadcaster so its watchers re-resolve their roots, and broadcast `session_list_invalidated` on `/api/events`. The broadcast is not optional — a restarted watcher upserts sessions from the roots it now watches but never removes the ones it stopped watching, so without it a cockpit shows the union of the old and new account sets until someone reloads.

**Two rules about `CLAUDE_CONFIG_DIR` that only work together.** Read both before touching either.

1. **Every SDK subprocess gets the account spelled out.** `claudeConfigDirEnv()` builds the `CLAUDE_CONFIG_DIR` entry for `sdkOptions.env` at both spawn sites (a turn in `messaging/message-sender.ts`, the command-warm probe in `claude-code-runtime.ts`) so the account is never inherited from `process.env`. A turn uses the session's own `accountRoot` when disk resolved one, else the active account — which is how a resume stays on the client that paid for it, including across the resume-failure retry that restarts the turn as a brand-new SDK session. **The entry can be `undefined`, and that is deliberate:** when nothing set `CLAUDE_CONFIG_DIR` and the account is the default `~/.claude`, absence is the faithful spelling. Claude Code takes the UNSUFFIXED macOS Keychain name (`Claude Code-credentials`) exactly when the variable is unset, so writing the default path where nothing was set would point the CLI at an entry that does not exist and break sign-in for every default install. Node's `child_process` drops `undefined` env values, so the entry both overrides an inherited value and removes it.
2. **Rename and fork run under an env lock.** `renameSession`, `forkSession`, and `getSessionInfo` run **in-process**, and their SDK option types carry only `dir?`/`sessionStore?` — no config dir, no env — so the only lever is `process.env.CLAUDE_CONFIG_DIR`, which the SDK memoizes _keyed on_ that variable. `withClaudeConfigDir()` (`services/runtimes/claude-code/claude-config-env-lock.ts`) is the single writer: it serializes every caller, restores the previous value including its absence, and hides the mutation from `resolveActiveClaudeRoot()` so a concurrent brand-new session cannot resolve to the account being renamed. This is survivable **only** because of rule 1 — do not make either one conditional without the other.

`getSessionInfo` (the SDK-persisted custom title) is deliberately **not** wrapped: it sits on the session-listing path, and serializing every listing behind a process-global mutation trades a systemic risk for a cosmetic gain. It is called only when the session's account is the active one, so a title set on a non-active account shows that session's first message instead until you switch back. That is a chosen, bounded degradation (spec D8), not an oversight.

#### runtimes.claudeCode.persistentSession — one process per message, or one per chat

The persistent-session setting (spec `persistent-session-runtime`, P3). Off, every message launches its own SDK `query()`, resumes the transcript, answers and exits, which is what claude-code did for its first year. On — how it ships since `0.67.0` — the session's pump holds that process open between messages, so the next message reaches an agent that is already running.

**It is no longer an experiment.** It graduated in spec `full-power-defaults` (D1): the registry entry was deleted in the same change that flipped the default, per the doctrine [above](#experimental-fields), and with it went the only switch the setting had. **It has no control on any screen until the Control Center lands (task 2.2)** — a graduation that removes the UI is the one failure mode of this doctrine, so it is written down rather than glossed: until then, `PATCH /api/config`, `dorkos config set`, or the file. The `0.67.0` migration moves a stored `false` — which the `0.59.0` backfill wrote into every upgraded config — up to `true`, and cannot tell that seed from a person who tried it and turned it off. That caveat is recorded in the migration comment and named in the changelog.

- **Read at LAUNCH, by one function.** `isPersistentSessionEnabled()` (`services/runtimes/claude-code/persistent-session-optin.ts`) is called when a session acquires its pump — the same moment the warm-session ceiling is read, and for the same reason. So the opt-in is per SESSION even though the setting is per machine: a chat already under way keeps the path it started on until its process is replaced, and two sessions on one host can be on different paths at once. That is what makes the two comparable on the same workload, and the resume path stays live underneath because it is also the recovery route a crashed pump falls back to.
- **Nothing reads it as a boot value**, so it needs no `onChange` subscriber; a change governs the next process, not the running one.
- **It never guesses.** An unreadable config (the singleton before `initConfigManager()`) answers `false`. Reading a launch decision must not be able to fail a launch. Note what that is and is not now the default flipped: it is a fallback for a config that cannot be read at all, not the shipped value — a readable config answers `true` unless somebody said otherwise.
- **`agent-writable` and `expose`**, unlike the trust-stop leaf above. It says how work runs, not whether anybody is asked before it happens: the same executable is spawned under the same trust stop, the boundary check runs per dispatch either way, and no credential is reachable through it. What it can cost is memory, which the warm-session ceiling bounds in code rather than here.
- **The capability flag is a separate decision.** `supportsPersistentSession` on the claude-code runtime (`runtime-constants.ts`) declares what the runtime CAN do; this setting says what this machine WANTS. Until the pump joins the dispatch path, the setting changes nothing.

**Its row in `docs/getting-started/configuration.mdx` was deliberately withheld until the wiring landed, and landed with it** (task 3.10, DOR-1175). Every other field in that table does something the moment a person writes it; this one did nothing at all until the pump reached the dispatch path, so a user-facing row before then would have described behavior that was not there — the demo-claim gate, applied to a settings table. The row and its prose went in with `supportsPersistentSession: true`, and they say what actually ships: on by default since `0.67.0`, applies to the next message in each chat, and a chat already holding an agent keeps it until that agent is reaped, evicted or the server restarts.

#### runtimes.\*.defaultModel / defaultEffort — what a new session starts with

The execution defaults (spec `execution-defaults`, E1). They answer one question: when nothing else has decided, which model and how much reasoning does a NEW session get?

- **Per runtime, and it has to be.** A model id only means something inside the runtime that offers it — `opus` is meaningless to Codex, `gpt-5.3-codex` to Claude Code, and OpenCode addresses models as `provider/model`. A single shared default would be wrong for at least two of the three the moment anyone set it, and wrong silently.
- **`null` is the shipped value and means "let the runtime choose"** — byte-for-byte the behavior before the fields existed. An upgrade starts nobody's sessions somewhere new.
- **OpenCode has `defaultModel` and no `defaultEffort`.** Its prompt API accepts no effort at all, in both the pinned and current SDK; effort exists there only as config-file variants with no API selection. A field would be a setting that does nothing, so the schema does not have one and the UI says "Not supported by OpenCode" rather than hiding the row.
- **An unrecognized key is ignored, not obeyed — and since DOR-1221 it no longer costs the file.** Writing something the schema does not have (`runtimes.opencode.defaultEffort` is the typo this section invites) does nothing at all: it is kept on disk and skipped on read ([Keys from another build](#keys-from-another-build)). It used to condemn the whole config, because Ajv validated with `additionalProperties: false`. Nothing tells you the setting is inert, so the typo is still worth avoiding — this is the first block whose shape differs per runtime.
- **`effort` is the shared ladder** (`EFFORT_LEVELS`: `none`, `minimal`, `low`, `medium`, `high`, `max`, `xhigh`), and the two runtimes that honor it read the bottom two rungs differently on purpose: claude-code's `none` turns thinking off, while codex's clamps up to `minimal`; `max` is real on claude-code and clamps down to `xhigh` on codex. Both clamp sites carry the note (`claude-code/messaging/thinking-config.ts`, `codex/turn-input.ts`); change neither without the other.

**Where the value lands.** `resolveSessionDefaults` (`services/session/resolve-session-defaults.ts`) answers the question, and `RuntimeRegistry` applies it to whatever CREATES a session's `session_metadata` row — the same row every adapter already resolves a turn from (`per-send override → persisted → the runtime's own default`). So no adapter knows about config.

"Whatever creates the row" is deliberate: it is not one caller. The first message writes the runtime binding (`persistSessionRuntime`), and changing a setting before the first message writes the row first (`saveSessionSettings`) — the pre-launch path, which E3's picker makes the normal one. Both put the seed on the INSERT branch and UNDER the caller's own values, so an explicit choice always wins and only the keys a write does not carry are filled (`seedForNewRow`). Seeding one creator only meant the other silently dropped the defaults. An existing row is never touched — the INSERT-OR-IGNORE and the patch-only UPDATE branch are what enforce "applies to new conversations, running ones keep their settings", not a convention. The ladder is agent-explicit (the manifest fields arrive with E2) → this server default → nothing.

#### runtimes.defaultTrustStop — how much a new session may do without asking

The default trust level (spec `trust-dial`, decision 6). One question — _when should a new agent stop and check with me?_ — answered once, globally, with a per-runtime override for anybody who wants something narrower somewhere.

- **The stored value is a STOP, never a mode id.** `ask` / `act` / `autonomy` are the three positions of the Trust Dial and mean the same thing on every runtime; the mode sitting at a position does not (`bypassPermissions` on Claude Code, `danger-full-access` on Codex). `resolveSessionDefaults` translates the stop through the bound runtime's own capability profile using `resolveTrustStops` — the same function the dial renders from — so a default lands on exactly the mode the dial would show as selected, including Claude Code's first-declared rule (`acceptEdits` before `auto`). A runtime that declares no mode at the configured stop contributes nothing and starts where it always started.
- **`null` is the shipped value**, and every shipped runtime's own default resolves to that same stop: session surfaces (the Trust Dial) still call it "Ask first," and Settings' Runtimes tab calls the identical stop "Asks before acting" (`SETTINGS_STOP_LABELS` in `stop-labels.ts`): one behavior, two surface-appropriate labels. No upgrade moves anybody.
- **Per runtime beats global.** `runtimes.<runtime>.defaultTrustStop` wins where it is set; `null` there means "follow the global one", which is a real state with its own row in Settings rather than a silent copy.
- **Interactive sessions only.** The permission tier answers only when the caller hands the resolver the runtime's declared modes, and only the attended paths do — `persistSessionRuntime(..., { interactive: true })` from `POST /api/sessions/:id/messages`, and every settings write (`saveSessionSettings`). A room turn, a scheduled task and a relay binding each carry their own permission mode and their own stricter gates, including the bypass clamp on file-sourced schedules, and must never inherit the cockpit's. Withholding the descriptors is how that is enforced, so forgetting to pass them makes a preference not apply — the safe direction.
- **Clearing the acknowledgement demotes the default.** Reset is the only way the record goes away, and `PATCH /api/config` turns every `defaultTrustStop` still holding `'autonomy'` back to `null` in the SAME write (`demoteAutonomyDefaultsOnAckClear`). The record is that default's licence; keeping the default after erasing the licence leaves new sessions born bypassed with no consent on file, and the cockpit's first mode change for one of them refused 428 by the session door. Gentler stops are untouched — they never needed the record.
- **Autonomy is a permitted default, gated at set-time.** Writing `'autonomy'` into any of the four leaves needs the durable acknowledgement: `PATCH /api/config` answers `428 AUTONOMY_ACK_REQUIRED` unless `ui.autonomyAcknowledgedAt` is already set or the same patch sets it (`services/core/approvals/autonomy-consent.ts`). The cockpit's confirmation dialog sends both in ONE request, so there is no window where the stop landed without the consent. That standing record is then what satisfies the session door (`PATCH /api/sessions/:id`) for every session the default births — the composition is pinned end to end in `routes/__tests__/default-trust-stop.integration.test.ts`.
- **All four leaves are `operator-only` to write**, unlike the model and effort leaves beside them. Those say how work runs; this one says whether anybody is asked before it happens, and one write removes the approval gate from every interactive session started from then on — durably, and silently, since a new session simply opens already bypassed. They stay `expose` to READ: an agent that can see the posture can explain why its session started where it did.

Room turns take one detour. A room session's `session_metadata` row is written AFTER its turn is known to have started, so a runtime that throws leaves no orphan row — which is too late to seed the turn that is starting. `room-turn-runner.ts` therefore resolves the same defaults itself for a session with no row yet and passes them to `triggerTurn`; the registry writes the same values onto the row it then creates, so the second turn inherits the ordinary way. That leaves one window, documented at the seam: a settings change landing between the row check and the turn is outranked for that single turn, and self-heals from the next one.

Behavior details:

- **Registration is config-gated, readiness is check-gated.** `runtimes.<type>.enabled` decides whether the adapter registers at boot (`apps/server/src/index.ts`). Whether it is _usable_ is decided by its `checkDependencies()` probes (binary on PATH + auth state), surfaced via `GET /api/system/requirements` and the client's needs-setup flow.
- **`binaryPath` is authoritative when set.** If the configured path does not exist, the dependency check reports the runtime missing rather than silently falling back to a different binary on PATH (see `services/runtimes/{codex,opencode}/check-dependencies.ts`).
- **`opencode.port`** feeds the managed `opencode serve` sidecar (`services/runtimes/opencode/server-manager.ts`). `0` (default) picks an ephemeral port; the sidecar binds `127.0.0.1` only, with per-boot basic-auth credentials.
- **No credentials in DorkOS config.** Codex auth is `codex login` (or `CODEX_API_KEY` in the server's environment); OpenCode provider credentials live in OpenCode's own `auth.json` (`opencode auth login`). DorkOS stores no runtime API keys.
- **Migration:** the block is backfilled for pre-existing configs by the `backfillRuntimesDefaults` migration keyed `'0.45.0'` in `CONFIG_MIGRATIONS` (`apps/server/src/services/core/config-manager.ts`), following the append-only rules above.

User-facing docs: `docs/guides/runtimes.mdx` and the runtimes section of `docs/getting-started/configuration.mdx`.

### DORKOS_RELAY_ENABLED

Process-level feature flag that enables the Relay message bus subsystem. When `true`, the server mounts the `/api/relay` routes, starts the `RelayCore`, and routes Tasks (scheduled) message flows through the Relay bus. Session messaging is unaffected: `POST /api/sessions/:id/messages` always triggers the runtime directly, with delivery on the durable `GET /api/sessions/:id/events` stream.

```bash
export DORKOS_RELAY_ENABLED=true
dorkos
```

This env var controls process-level Relay initialization and must be set before the server starts. The config file has a separate `relay.enabled` field (default `true`) that controls the config-layer toggle independently.

### DORKOS_CORS_ORIGIN

Configures the `Access-Control-Allow-Origin` header on the Express server. When unset, defaults to localhost on `DORKOS_PORT` and `VITE_PORT` (code default 4241, dev convention 6241). Set to `*` for wildcard, or a comma-separated list of origins to allow multiple production origins.

```bash
export DORKOS_CORS_ORIGIN=https://myapp.example.com
dorkos
```

There is no config file key for this setting. It must be set as an environment variable.

## Precedence

Settings are resolved in this order (highest priority first):

```
CLI flags  >  Environment variables  >  config.json  >  Built-in defaults
```

### How Precedence Works

Each setting follows the same resolution chain. The first non-empty value wins.

**Port resolution:**

```
--port 9000              # CLI flag (wins if provided)
DORKOS_PORT=8080         # Env var (wins if no CLI flag)
server.port: 5000        # config.json (wins if no env var)
4242                     # Built-in default (fallback)
```

**Working directory resolution:**

```
--dir ~/myproject        # CLI flag (wins if provided)
DORKOS_DEFAULT_CWD=...   # Env var (wins if no CLI flag)
server.cwd: /path        # config.json (wins if no env var)
process.cwd()            # Current directory (fallback)
```

**Tunnel enabled resolution:**

```
--tunnel                 # CLI flag (wins if provided)
TUNNEL_ENABLED=true      # Env var (wins if no CLI flag)
tunnel.enabled: true     # config.json (wins if no env var)
false                    # Built-in default (fallback)
```

**Log level resolution:**

```
--log-level debug           # CLI flag (wins if provided)
DORKOS_LOG_LEVEL=4          # Env var (wins if no CLI flag; numeric 0-5)
logging.level: debug        # config.json (wins if no env var)
info                        # Built-in default (fallback)
```

**Boundary resolution:**

```
--boundary /path        # CLI flag (wins if provided)
DORKOS_BOUNDARY=...     # Env var (wins if no CLI flag)
server.boundary: /path  # config.json (wins if no env var)
os.homedir()            # Home directory (fallback)
```

**Tunnel credentials** (authtoken, auth, domain) use a simpler chain: the environment variable takes priority over config.json. There are no CLI flags for these.

### Examples

Start on port 9000 regardless of config:

```bash
dorkos --port 9000
```

Set a default port in config, then override for one session:

```bash
dorkos config set server.port 5000   # Persisted default
dorkos --port 9000                   # One-time override
```

Environment variable overrides config but not CLI flag:

```bash
dorkos config set server.port 5000   # config.json
DORKOS_PORT=8080 dorkos              # Uses 8080 (env > config)
DORKOS_PORT=8080 dorkos --port 9000  # Uses 9000 (flag > env)
```

## CLI Commands

### `dorkos config`

Show all effective settings in a formatted table. Each value shows whether it comes from the config file or is a built-in default.

```bash
$ dorkos config
DorkOS Configuration (~/.dork/config.json)

  server.port          4242           (default)
  server.cwd           —              (default)
  server.boundary      —              (default)
  server.open          true           (default)
  tunnel.enabled       false          (default)
  tunnel.domain        —              (default)
  tunnel.authtoken     —              (default)
  tunnel.auth          —              (default)
  ui.theme             system         (default)
  agentContext.relayTools   true       (default)
  agentContext.meshTools    true       (default)
  agentContext.adapterTools true       (default)
  agentContext.tasksTools   true       (default)

Config file: /Users/you/.dork/config.json
```

### `dorkos config get <key>`

Get a single config value by dot-path.

```bash
$ dorkos config get server.port
4242

$ dorkos config get ui.theme
system
```

Exits with code 1 if the key does not exist.

### `dorkos config set <key> <value>`

Set a single config value. Values are automatically parsed: `true`/`false` become booleans, numeric strings become numbers, `null` becomes null.

```bash
dorkos config set server.port 8080
dorkos config set tunnel.enabled true
dorkos config set server.cwd null
```

Setting a sensitive key (`tunnel.authtoken`, `tunnel.auth`) prints a warning recommending environment variables instead.

### `dorkos config list`

Output the full config as formatted JSON. Useful for scripting and debugging.

```bash
$ dorkos config list
{
  "version": 1,
  "server": { "port": 4242, "cwd": null, "boundary": null },
  "tunnel": { "enabled": false, "domain": null, "authtoken": null, "auth": null },
  "ui": { "theme": "system" },
  "logging": { "level": "info", "maxLogSizeKb": 500, "maxLogFiles": 14 },
  "relay": { "enabled": true, "dataDir": null },
  "scheduler": { "enabled": true, "maxConcurrentRuns": 4, "timezone": null, "retentionCount": 100 },
  "mesh": { "scanRoots": [] },
  "uploads": { "maxFileSize": 10485760, "maxFiles": 10, "allowedTypes": ["*/*"] },
  "agentContext": { "relayTools": true, "meshTools": true, "adapterTools": true, "tasksTools": true }
}
```

### `dorkos config reset [key]`

Reset a specific key to its default value, or reset all settings when no key is provided.

```bash
# Reset a single key
dorkos config reset server.port
# Reset server.port to default (4242)

# Reset everything
dorkos config reset
# Reset all settings to defaults
```

### `dorkos config edit`

Open the config file in your `$EDITOR`. Falls back to `notepad` on Windows or `nano` on other platforms.

```bash
dorkos config edit
```

### `dorkos config path`

Print the absolute path to the config file. Useful in scripts.

```bash
$ dorkos config path
/Users/you/.dork/config.json
```

### `dorkos config validate`

Validate the config file against the Zod schema. Exits with code 0 if valid, code 1 if invalid.

```bash
$ dorkos config validate
Config is valid

$ dorkos config validate
Config validation failed:
  - server.port: Number must be greater than or equal to 1024
```

### `dorkos install`

Install a marketplace package into the current project.

```bash
dorkos install <package-name>
dorkos install <package-name> --marketplace <source>    # Pin to a specific source
dorkos install <package-name> --yes                     # Skip confirmation prompt
dorkos install <package-name> --force                   # Overwrite conflicting files
```

Install dispatches the appropriate per-kind flow (plugin, agent, skill-pack, adapter, or shape) based on the package manifest's `type` field. On failure, the atomic transaction engine restores the previous state. See `contributing/marketplace-installs.md` for the full pipeline.

### `dorkos uninstall`

Remove an installed marketplace package.

```bash
dorkos uninstall <package-name>
dorkos uninstall <package-name> --purge    # Also remove package data directories
```

### `dorkos update`

Check for and optionally apply updates to installed packages. Advisory by default — reports available updates without applying them.

```bash
dorkos update                     # Check all installed packages for updates
dorkos update <package-name>      # Check a specific package
dorkos update <package-name> --apply   # Fetch and apply the update
```

### `dorkos marketplace`

Manage marketplace sources (the `marketplace.json` registries that list available packages).

```bash
dorkos marketplace list [<source>]        # List packages from all or a specific source
dorkos marketplace add <url-or-path>      # Register a new marketplace source
dorkos marketplace remove <source-name>   # Remove a registered source
dorkos marketplace refresh [<source>]     # Force-refetch marketplace.json for all or one source
```

### `dorkos cache`

Manage the marketplace package cache (content-addressable clone cache at `~/.dork/cache/`).

```bash
dorkos cache prune [--keep <N>]   # Remove old cached packages, keeping the N most recent per package
dorkos cache clear                # Wipe the entire cache
```

### `dorkos package`

Scaffold and validate DorkOS marketplace packages.

```bash
dorkos package init <name> --type <plugin|agent|skill-pack|adapter|shape>
                                  # Scaffold a new package in ./<name>/
dorkos package validate <path>    # Validate a package directory against the manifest schema
```

See `contributing/marketplace-packages.md` for the package format and manifest reference.

### `dorkos cleanup`

Interactively remove all DorkOS data. Prompts for confirmation at each phase.

**Safety checks:**

- Verifies the DorkOS server is not running (checks `/api/health` on configured port)
- Prompts before each deletion phase

**What it removes:**

1. **Global data** (`~/.dork/`): `config.json`, `dork.db` (+ WAL/SHM), `logs/`, `relay/`
2. **Per-project data**: Each project's `.dork/` directory (discovered from the database before deletion)

Does **not** touch `~/.claude/` (Claude Code's own data).

```bash
$ dorkos cleanup
Checking if DorkOS server is running...
Server is not running.

This will remove all DorkOS data:
  - ~/.dork/ (config, database, logs, relay state)
  - .dork/ directories in discovered projects

? Remove global DorkOS data (~/.dork/)? Yes
Removed ~/.dork/

? Remove per-project .dork/ directories? Yes
Removed /home/user/myapp/.dork/
Removed /home/user/api/.dork/

Cleanup complete.
```

### `dorkos init`

Run the interactive setup wizard. Prompts for port, theme, tunnel, and working directory. If a config file already exists, asks for confirmation before overwriting.

```bash
$ dorkos init
DorkOS Setup

? Default port: 4242
? UI theme: System (follow OS)
? Enable tunnel by default? No
? Default working directory (leave empty for current directory):

Config saved to /Users/you/.dork/config.json
```

Skip all prompts and initialize with defaults:

```bash
dorkos init --yes
```

## REST API

### PATCH /api/config

Update config settings via the REST API. Accepts partial updates -- only the keys you include are changed.

**A write that changes something writes one `info` line naming the leaves that changed and the door it came through** — capped at eight with a count of the rest (`[Config] Patched by PATCH /api/config: runtimes.claudeCode.defaultTrustStop`). Four properties are load-bearing, and `describeConfigWrite` in `services/core/operator/config-patch.ts` owns all four:

- **Derived from the write, not the request.** It diffs stored-before against stored-after, so a key Zod stripped is named by nobody, a patch that re-sends the stored value produces no line, and a leaf the server folded in itself — the Reset demotion below — is named alongside the rest.
- **Paths only, never values.** Config holds `tunnel.authtoken`, `mcp.apiKey` and `cloud.instanceToken`, and logs get pasted into issues. Arrays are leaves, so their contents never reach the line either.
- **Every segment escaped.** Three sections are `z.record`s (`ui.shapes.agentDefaults`, `workbench.defaultViewers`, `providers`), so their leaf segments are caller-chosen — and the first is `agent-writable`. A key holding a newline and a counterfeit `[Config] Patched by …` forged this very line during review, so segments outside `[A-Za-z0-9_-]` are clipped, JSON-quoted, and swept for what JSON leaves alone.
- **Operator-only paths named first.** The cap is a readability bound, not a number sized to hold a section (`runtimes` is 22 leaves, `ui` is 32), so ordering is what stops it from truncating away the setting an investigation came for.

`config-patch-paths.test.ts` pins all four, deriving its secret list from `SENSITIVE_CONFIG_KEYS` and its record sections from the schema, so a new one is covered the day it lands. This exists because an operator-only setting drifted twice with nothing on disk that could name the writer: the line used to be `debug` (never written by a production install, which logs at info) and named only the top-level section (DOR-1237). The `by <door>` half arrived with DOR-1247, when the same line started being written by three doors and "which one?" became the next question. It still does **not** cover every write — see [Who writes your config](#who-writes-your-config).

**Request:**

```http
PATCH /api/config
Content-Type: application/json

{
  "server": { "port": 8080 },
  "ui": { "theme": "dark" }
}
```

**Success response (200):**

```json
{
  "success": true,
  "config": {
    "version": 1,
    "server": { "port": 8080, "cwd": null, "boundary": null },
    "tunnel": { "enabled": false, "domain": null, "authtoken": null, "auth": null },
    "ui": { "theme": "dark" },
    "logging": { "level": "info", "maxLogSizeKb": 500, "maxLogFiles": 14 },
    "relay": { "enabled": true, "dataDir": null },
    "scheduler": {
      "enabled": true,
      "maxConcurrentRuns": 4,
      "timezone": null,
      "retentionCount": 100
    },
    "mesh": { "scanRoots": [] },
    "uploads": { "maxFileSize": 10485760, "maxFiles": 10, "allowedTypes": ["*/*"] },
    "agentContext": {
      "relayTools": true,
      "meshTools": true,
      "adapterTools": true,
      "tasksTools": true
    }
  }
}
```

**Validation error (400):**

```json
{
  "error": "Validation failed",
  "details": ["server.port: Number must be greater than or equal to 1024"]
}
```

The endpoint deep-merges the patch into the current config, validates the merged result against the full schema, and only writes if validation passes. If any sensitive keys are included in the patch, the response includes a `warnings` array:

```json
{
  "success": true,
  "config": { ... },
  "warnings": ["'tunnel.authtoken' contains sensitive data. Consider using environment variables instead."]
}
```

### Who may write which setting

Every general-purpose door — `PATCH /api/config`, `dorkos config set`, and the `config_patch` operator tool — runs the same step, `applyGuardedConfigWrite` in `services/core/operator/config-write.ts`. It is one sequence: the login bar, the operator bar, the Full-autonomy consent door, the write, the audit line. What differs per door is only WHO is asking, handed in as a `ConfigWriteAuthority` — a pair of callbacks that answer "may this caller write these login-gated paths" and "…these operator-only paths".

Before DOR-1247 the sequence was copied into the route and half-copied into the tool, and the CLI ran none of it. That is exactly how `dorkos config set runtimes.claudeCode.defaultTrustStop autonomy` came to be a legal, silent, unacknowledged write.

Settings classified `operator-only` in `CONFIG_WRITE_POLICY` have to clear two bars on the HTTP route before anything is written. Everything else is a preference and goes through for any caller.

| Bar            | Implemented by                    | Refuses                                                                   | Posture      | Refusal code               |
| -------------- | --------------------------------- | ------------------------------------------------------------------------- | ------------ | -------------------------- |
| the cookie bar | `requireOperatorCookieUnderLogin` | a caller with no session cookie, including one holding a per-user API key | login **on** | `operator_cookie_required` |
| the agent bar  | `trustedCaller`                   | a caller presenting `X-DorkOS-Agent`, or holding an approval token        | both         | `operator_only_config`     |

The bars are named for what they check, not for the order they run in, because the order carries no meaning: it decides only which refusal a caller failing both hears, never what is allowed. (Ordinal names were tried and rotted the first time the order changed.) The cookie bar runs first.

The cookie bar is the one DOR-505 added, and it exists because `trustedCaller` is cleared by omitting two headers, which anything with a shell can do. Under login-on that used to include a program holding one of the person's API keys: `sessionGate` accepts a key as the same identity a browser session proves (DOR-474), so it could write `auth.enabled` here while the capability surface refused it the same write.

**The residual, stated so nobody reads the table as more than it is.** With login **off** there is no cookie for anyone, so the **cookie bar allows and the agent bar is the only one left**. That gap was re-examined and accepted rather than closed — see [The `curl` residual under login-off](#the-curl-residual-under-login-off-accepted-and-why) below for what was tried and why nothing weaker than Require login works.

### Who writes your config

Two kinds of writer, and the difference decides what each one owes you.

**General-purpose doors** are handed a path and write whatever it names. All three run `applyGuardedConfigWrite`, so all three enforce the same policy, ask the same consent question, and write the same line.

| Door                           | Authority                  | Refuses operator-only settings                                     | Audit line                                     |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| `PATCH /api/config`            | built from the request     | the cookie bar under login-on, then the agent bar in both postures | `[Config] Patched by PATCH /api/config: …`     |
| `dorkos config set`            | `LOCAL_OPERATOR_AUTHORITY` | no — the caller is the person at their own terminal                | `[Config] Patched by dorkos config set: …`     |
| `config_patch` (operator tool) | `OPERATOR_TOOL_AUTHORITY`  | always, with no approval that could unlock it                      | `[Config] Patched by the config_patch tool: …` |

**Why the CLI clears both bars.** It runs under the person's own shell, on the data directory they own — the same trust the cockpit has in the default login-off posture, where the server admits it cannot tell the cockpit from any other local process. Refusing the terminal what the browser is allowed would add no guarantee; it would move the person to `dorkos config edit`, which hands them the raw file with no policy, no consent door and no log. The login bar is allowed for a sharper reason: applying it would refuse `dorkos config set approvals.standingGrants false`, the PROTECTIVE direction, on the surface `standing-grant-posture.ts` names as the one that has to work with no server running.

**What the CLI does NOT clear** is the Full-autonomy consent door, because that is not an authority question — it asks whether the person has been told what Full autonomy means, and the answer is the same whoever is typing. `dorkos config set runtimes.claudeCode.defaultTrustStop autonomy` prints the cockpit's own sentence and writes nothing until `ui.autonomyAcknowledgedAt` exists. The terminal's way to satisfy it is `dorkos config acknowledge-autonomy`, which prints what is being agreed to and asks once (no by default, and it refuses outright with no TTY rather than offering a `--yes` that would sign the form for you). The refusal names that command, because a sentence with no next step is a dead end in a shell.

**The consent residual, stated beside the `curl` one because it is the same shape.** `ui.autonomyAcknowledgedAt` is `operator-only`, and `LOCAL_OPERATOR_AUTHORITY` clears the operator bar — so `dorkos config set ui.autonomyAcknowledgedAt <date>` followed by `dorkos config set … defaultTrustStop autonomy` goes through with the consent text never on screen. Reproduced end to end. **That is the trust model, not a hole in it:** a person with a shell can sign their own form, exactly as they can through `dorkos config edit`, and the cockpit's own "Don't show this again" checkbox is the same act on another surface. A ritual can make the DEFAULT path show a person what they are agreeing to; it cannot stop somebody who already knows the field name. An **agent** is a different matter and is stopped by a different mechanism — `operator-only` refuses it on the capability surface and over HTTP, neither of which is this authority. The mitigation is the audit line: both writes are logged with the door that made them, so the sequence is visible afterwards even though nothing refuses it at the time.

**Purpose-built writers** write one known setting as part of doing something else. They keep their own gate — often a stricter one; starting a tunnel needs login AND an owner account — and take `logConfigWrite(subsystem, section, before, after)`, which writes `[Config] Set by <subsystem>: <paths>` with the same paths-only, escaped, no-line-when-nothing-changed rules. Re-running the path policy there would either do nothing or refuse the writer its own job.

| Writer                                        | Section      | Named in the log as                                                                            |
| --------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `index.ts` first-run telemetry notice         | `telemetry`  | the first-run telemetry notice                                                                 |
| `index.ts` profile router setter              | `profile`    | the profile route                                                                              |
| `routes/config.ts` `PUT /agents/defaultAgent` | `agents`     | the default-agent route                                                                        |
| `routes/tunnel.ts` start / stop               | `tunnel`     | the tunnel route                                                                               |
| `services/core/agent-creator.ts`              | `agents`     | the agent creator                                                                              |
| `services/core/auth/cloud-link.ts`            | `cloud`      | the account link / unlinking this instance                                                     |
| `services/core/auth/seed-legacy-mcp-key.ts`   | `mcp`        | the MCP key migration                                                                          |
| `services/shapes/shape-services.ts`           | `ui`         | applying a Shape / clearing the active Shape                                                   |
| `services/extensions/extension-manager.ts`    | `extensions` | the extensions manager / approving an extension to run / withdrawing an extension run approval |
| `services/harness/hook-approval.ts`           | `harness`    | approving a package hook                                                                       |

The section is passed explicitly because a purpose-built writer only ever moves its own, and the diff is scoped to it. One bound follows: `ConfigManager.set` stamps `approvals.standingGrantsVoidBefore` when a write narrows the standing-permission posture, and a section-scoped diff cannot see that. Nothing on this list writes `auth` or `approvals`, so it does not bite today; a writer that needs to should use the guarded step, which diffs the whole config.

#### What still writes without a line, and why that is a decision

- **`dorkos config reset`, `dorkos config edit`, `dorkos init`, `dorkos auth`, `dorkos telemetry`, `dorkos cloud`.** Every one is a verb a person typed, naming the thing it changes; none can be pointed at an arbitrary path. `config reset` additionally cannot produce a permissive value — it moves settings TO the shipped defaults, which are the protective side by rule (ADR 260727-181825), and a whole-config reset keeps the protections a person moved (`safe-defaults/protected-state.ts`). `config edit` hands over the raw file, so nothing here can see it at all; `standing-grant-posture.ts` names it as the hand-edit case.

  **These are not small settings, so do not round the list up in user-facing copy.** `dorkos telemetry enable` moves six `operator-only` leaves; `dorkos auth enable` moves `auth.enabled`; `dorkos cloud link` moves the account token and name. All silent. Any sentence promising that "your log names what changed a setting" has to say `dorkos config set`, not "the command line" — reproduced during review, and the changelog and `docs/guides/action-approvals.mdx` were both narrowed for it.

- **A hand edit or a restored backup.** Config content DorkOS did not write. Same class as `config edit`.

#### The `curl` residual under login-off: ACCEPTED, and why

With login **off** there is no cookie for anyone, so the cookie bar allows and the agent bar is the only one left: a program on this machine that omits `X-DorkOS-Agent` can write every `operator-only` setting through `PATCH /api/config`.

DOR-1247 looked at closing this and did not, deliberately. **The cockpit is itself a login-off PATCH caller**, and in that posture it presents nothing a local program cannot also present — no cookie, no distinguishing header, and `Origin`/CORS is a browser courtesy, not evidence about who is on the other end. Any bar strong enough to refuse the program would refuse the cockpit, which locks a person out of their own settings; any bar weak enough to admit the cockpit is one `curl -H` away. Inventing a marker would assert a distinction the server cannot make, which is worse than the honest gap because it reads like protection.

So the answer stays the one DOR-505 gave: **turning on Require login is what closes it**, and it is documented for users under "Settings your agents cannot change" in `docs/guides/action-approvals.mdx`. Do not describe this route as "operator-only enforced" without that qualifier. This one _is_ logged, being the same route.

Two consequences worth knowing when you touch this code:

- **The enable-login flow is unaffected on purpose.** `OwnerSetupHost.tsx` writes `auth.enabled: true` while login is still off, so the cookie bar does not apply to it. A guard that read the POST-patch state instead of the current state would make login impossible to turn on.
- **`approvals.*` has a login bar in front of both bars** on the HTTP route, `REQUIRES_LOGIN_CONFIG_PATHS`, which refuses those writes outright while login is off. See [the `approvals` section](#settings-reference).

**So still never read a silent log as proof a setting did not change** — but the silence is now much narrower: the three doors and the ten writers above all speak.

## Error Recovery

Recovery **replaces the config file**, so what counts as "corrupt" is a data-loss decision. `classifyConfigLoadFailure` (`config-manager.ts`) owns it, and sorts a `conf` constructor throw into four kinds:

| Failure                                        | Raised by             | Kind        | Effect                                     |
| ---------------------------------------------- | --------------------- | ----------- | ------------------------------------------ |
| `SyntaxError` (JSON does not parse)            | conf's `_deserialize` | `corrupt`   | replaced immediately                       |
| message starts `Config schema violation:`      | conf's Ajv wrapper    | `corrupt`   | replaced immediately                       |
| message is `Failed to decrypt config data.`    | conf's decrypt        | `corrupt`   | replaced immediately                       |
| any errno error (`EMFILE`, `EACCES`, `EIO`)    | the OS                | `io`        | **never replaced**, retried, then reported |
| message starts `Something went wrong during …` | a migration body      | `migration` | **never replaced**, reported immediately   |
| anything else                                  | code `conf` ran       | `unknown`   | retried, replaced only if it never clears  |

`conf` rethrows all of these identically — DorkOS sets `clearInvalidConfig: false`, so conf clears nothing itself — which is why the decision lives here.

**A schema violation now always names a SHAPE the schema does not describe.** Two whole classes have been taken out of the validator's hands, because neither is damage: an unrecognized key (`config/version-skew.ts`, [Keys from another build](#keys-from-another-build)) and a value on a named scalar leaf (`config/widened-leaves.ts`, [Values from another build](#values-from-another-build)). What still reaches `corrupt` is a section that is a list, a list that is a string, a required field with nothing to fill it — shapes a build widening a setting never produces.

**Why `io` is its own kind, rather than "has not cleared yet".** An errno failure is never evidence about what a file contains, and that stays true however many times it repeats. The fd-exhaustion storm that destroyed a real config ran far longer than any sensible boot-time backoff, so a rule of "it failed four times, therefore the file is bad" would hand the same defect back on a timer.

**The errno is not always still attached.** `conf`'s `_migrate` catches everything thrown inside its per-migration `try` and rethrows it as a plain `Error` (`Something went wrong during the migration! …`) with no `code` and no `cause`. That block is full of reads — every migration body calls `store.get`, and each one reads the file — so an `EMFILE` during an **upgrade boot**, the one launch where a migration body runs, used to arrive stripped of everything identifying it and destroy the config. `isIoFailure` therefore also reads the errno back out of the head of `conf`'s appended message, gated on that wrapper sentence so the match cannot fire on an unrelated error.

**And behind all of it, one absolute rule: nothing is replaced that was not read first.** `readStoredConfigForSalvage` runs before the backup, on the same retry staircase, and a read that never succeeded aborts the replacement with `ConfigUnreadableError` instead. A successful read is both the evidence that the file is the problem and the only way `restoreProtectedState` can carry a protection across, so a verdict that cannot be checked is never acted on. This is what makes the guarantee hold even where the classification above is wrong: a message format is a weaker thing to trust than a read that worked.

**Why `unknown` is eventually replaced.** `conf` runs the migration chain inside its constructor, and `_migrate` feeds the file's own `__internal__.migrations.version` into `semver` (`_shouldPerformMigration`). That value sits outside the Ajv schema and conf skips validation while migrating, so one flipped byte in it throws a bare `TypeError: Invalid Version` from a place the allowlist never sees. That is as file-caused as a syntax error. Leaving it in `io` would block every future boot while telling the person their file was fine. The retry staircase does the classifying, so this needs no knowledge of which conf internals can throw.

**Why a throwing migration body is not in that class (DOR-1221).** It used to be, and it was the `io` mistake in a different costume: a bug in DorkOS's own upgrade code fails identically on all four attempts, looks deterministic, and used to condemn a file that was never the problem — so whoever shipped the fix had no settings left to boot into. `conf` marks the case for us. `_migrate` wraps everything thrown inside its per-migration `try`, and the semver check above runs **outside** that `try`, so a corrupt migration version still arrives bare and still lands in `unknown`. The errno check runs first, so a laundered `EMFILE` is still `io`. What is left under the wrapper is DorkOS's own code throwing: the boot stops with `ConfigMigrationFailedError` and the file is not touched.

**A `corrupt` verdict** (or an `unknown` one that outlived the staircase) runs the recovery path on startup:

1. The file is read for salvage (`readStoredConfigForSalvage`), then backed up to a timestamped `~/.dork/config-<date>-<time>.json.bak`
2. The original is deleted and a fresh config created with defaults
3. `restoreProtectedState` re-applies the protections in `PROTECTIVE_CARRYOVERS` (DOR-584)
4. The underlying error and the backup path are logged

```
[Config] /Users/you/.dork/config.json could not be used: Config schema violation: `mesh/scanRoots` must be array
Corrupt config backed up to /Users/you/.dork/config-20260815-093012-441.json.bak
Creating fresh config with defaults.
```

**Backups rotate; they never overwrite (`config/backups.ts`).** One fixed `config.json.bak` meant the second recovery destroyed what the first one saved — five recoveries on one machine left a single backup holding a config that had already been replaced with defaults. Each recovery now writes its own timestamped file and the newest ten are kept (`CONFIG_BACKUPS_KEPT`). The pre-rotation `config.json.bak` does not match the pattern, so pruning never removes it.

**An `io` verdict never replaces or deletes the file.** The load is retried on a short backoff (`CONFIG_LOAD_RETRY_DELAYS_MS`, four attempts over ~750ms), and if it still fails the constructor throws `ConfigUnreadableError`. The server prints that message and exits 1 rather than booting on defaults, because defaults are a different security posture (`auth.enabled` off, `mcp.enabled` on) than the file it could not read.

Say "did not replace or delete", never "nothing was changed". `conf`'s `#runMigrations` calls `_write(storeWithDefaults)` **before** `_migrate` runs, so on any upgrade boot the file has already been rewritten with the defaults merged in before DorkOS reaches a verdict. Nothing is lost (the merge is shallow and the stored value wins per top-level key), but a 131-byte pre-upgrade config can be 2429 bytes by the time the error is printed. Note that the byte-for-byte test in `config-load-failure.test.ts` cannot catch this: its fixture was written by `ConfigManager`, so it is already default-shaped and conf's `assert.deepEqual` short-circuits the write.

`ConfigUnreadableError` picks its wording from the situation rather than assuming one. The reassuring branch is only used when it is still true, since the same error can be raised on the second leg of recovery after the original has moved to `.bak`, where the message has to send the person to the backup instead. Its `advice` branches on the errno: "start DorkOS again" is right for a descriptor shortage and wrong for `EACCES`, where waiting is an instruction to loop forever, so a permission failure gets a permission fix and the option of renaming the file. `dorkos doctor` reads that same `advice` rather than keeping a second copy.

Guessing wrong toward `io` costs a restart. Guessing wrong toward `corrupt` costs a person their settings. So `io` membership is decided by a bare errno code (`/^E[A-Z0-9]+$/`, excluding Node's underscore-bearing `ERR_*` codes, which report a bad call rather than a refused syscall), and widening it needs the same scrutiny as a destructive migration.

### Keys from another build

A key in `config.json` that this build's schema does not declare is **version skew, not corruption**. A newer build writes a setting and an older one starts; a migration retires a key and the file has not met that migration yet; a dogfooding machine runs several builds a day and does both before lunch. Zod closes every object it generates (`additionalProperties: false`) and `conf` validates on **every read of the file**, so one such key used to make the whole config unloadable — and the recovery path above read that as damage and replaced it. Five wipes on one machine; the last was `ui`, `ui/sidebar` (three times) and `runtimes/claudeCode` complaining together.

`config/version-skew.ts` fixes it structurally rather than by reading Ajv's error text:

- **`tolerateUnknownKeys`** rewrites every `additionalProperties: false` in the generated schema to `true`, once, before conf ever sees it. A node whose `additionalProperties` is a _schema_ (a record type) is left alone. Everything else this pass leaves alone — a wrong-shaped section, a list where an object belongs, a missing required field all still fail, which is what keeps the tolerance from becoming "validate nothing". `config/__tests__/version-skew.test.ts` fails if any object in the generated schema closes again. The one further relaxation is `relaxWidenedLeaves` in the next section, applied afterwards and deliberately a narrower cut.
- **`preserveUnknownKeys`**, called from `ConfigManager`'s write path, carries the unrecognized keys from disk onto every section it writes — with two carve-outs. Tolerating a key on the way in is only half of it: every write goes through Zod, which strips what it does not declare, so an older build saving a theme would otherwise delete the newer build's settings one section at a time. Records and arrays are left to the writer, and a key this build _does_ declare can still be deleted.

Two things that follow from the array carve-out, because they are easy to read past. An unknown key nested inside an ARRAY ITEM — `ui.sidebar.groups[]`, `runtimes.claudeCode.accounts[]` — is **dropped** when this build writes that whole section, since position is not identity and re-attaching by index would be a guess. It survives every boot and every write that does not touch its section, which is the common case, but a Zod-parsed write of the section it lives in loses it. And a record's keys (`ui.sidebar.sections`) are the writer's to remove, which is what keeps `dropUnknownSectionIds` working.

Nothing reads these keys, and they are absent from the `UserConfig` type. They are tolerated, preserved, and otherwise ignored. What this does NOT cover is a key both builds declare whose VALUE a newer build widened — that is the next section.

### Values from another build

A key both builds declare can still hold a value only one of them understands. A newer build adds a `ui.theme` member, raises a bound, allows a type that was not allowed before; the person picks the new value; the older build starts and Ajv refuses a key it DOES declare. Before DOR-1227 that condemned the file, and the whole of `mesh.scanRoots`, `approvals`, `runtimes` and every preference went with one word.

The argument is the one DOR-1221 made, one level down. That value belongs to another build, so it is skew, not damage.

**The policy, in one line: a violation on a named scalar leaf that has a schema default is skew; everything else is damage.**

| Stored                                             | Verdict | What happens                                               |
| -------------------------------------------------- | ------- | ---------------------------------------------------------- |
| `ui.theme: "midnight"` (enum widened)              | skew    | boots on `system`, `midnight` stays on disk                |
| `server.port: 80` (bound raised)                   | skew    | boots on `4242`, `80` stays on disk                        |
| `server.port: "auto"` (leaf retyped)               | skew    | boots on `4242`, `"auto"` stays on disk                    |
| `mesh.scanRoots: "…"` (list is a string)           | damage  | condemned, backed up, recovered                            |
| `ui.statusBar: [...]` (object is a list)           | damage  | condemned, backed up, recovered                            |
| `ui.statusBar.pins: ["cwd","weather"]` (in a list) | damage  | condemned — the residual, below                            |
| `version: 2`                                       | damage  | condemned — no default to fall back to, and a format break |

`config/widened-leaves.ts` does it in three moves, and they are the same three shapes as the unknown-key half:

- **`relaxWidenedLeaves`** replaces every named scalar leaf in the generated schema with a stub carrying only its `default`, so Ajv stops checking those positions and still fills a missing one in. It follows `properties` and nothing else — never `items`, never a record's `additionalProperties`.
- **`repairWidenedLeaves`**, called from `ConfigManager`'s read boundary (`get`, `getAll`, `getDot`), checks each relaxed leaf against its OWN Zod field and falls back to that field's default when Zod refuses it. Zod rather than a second JSON-Schema validator, because Zod is the authoritative schema here; hand-rolling `enum`/`minimum`/`pattern` to re-check what we had just stopped Ajv from checking would be a second, quietly divergent opinion about what the config means.
- **`preserveWidenedLeaves`**, called from the write path, carries the stored value back onto any write that **carries back the value this build handed out**. Without it the loss just arrives quietly: this build read `theme` as `system`, so the section it saves says `system`. The test is EQUALITY, not absence — a partial write that omits the leaf entirely is treated as a deletion and the stored value goes, exactly as `preserveUnknownKeys` treats an omitted key. Every caller in DorkOS writes a Zod-parsed section, where every leaf is present.

**The two halves cannot drift, by construction.** A leaf is relaxed only if `repairWidenedLeaves` can resolve its Zod field and get a default out of it, decided at the same place and the same moment. So "what Ajv stopped checking" and "what DorkOS checks instead" are one set, not two lists somebody has to keep in agreement.

**Why the line is at a NAMED leaf, and what that leaves open.** Tolerance has to be paid for on the write path, and only a named leaf can pay: one key, one value, carried back exactly. Inside a list or a record an element has a position rather than a name, and matching a stored element to a written one by index is a guess whose wrong answers write one person's setting onto another's row — the same reason `preserveUnknownKeys` refuses arrays and records. **So the residual is real: a new `ui.statusBar.pins` id, a new `workbench.defaultViewers` viewer, a new `onboarding.completedSteps` step, or a new `providers` credential form written by a newer build still condemns the file.** So does a change to `version`. If that becomes the next thing to hurt, closing it means solving list identity first, not loosening the rule here.

**Tolerated is not silent.** Falling back to a default is the right behaviour and the wrong secret — the relaxed set includes `auth.enabled`, `mcp.enabled`, `approvals.standingGrants`, `approvals.trustWindowMinutes` and `telemetry.usage`, and before this the same file was condemned LOUDLY, with a backup and a line the operator saw. Turning that into a login gate quietly off would break rule 2 of `.claude/rules/safe-defaults.md`. So `ConfigManager.unreadableSettings()` names them, and three surfaces use it: one `logger.warn` per boot (not per read — `get` runs the repair on every call), a `dorkos doctor` row that appears only when there is something to report, and `dorkos config validate`, which keeps `valid: true` but lists them under `warnings`. A stored value on one of the four `SENSITIVE_CONFIG_KEYS` prints as `<hidden>`: they are nullable strings with defaults, so they are all relaxed, and a re-encoded token must not reach a log file.

**Two smaller things worth knowing.** A person on the older build can always overwrite the value — a write carrying anything other than the default this build handed out wins — and setting a leaf to exactly the value already on screen is the one case that reads as "not touched", so the stored value survives. And `getDot` reports the value DorkOS is running on rather than the bytes on disk, because the CLI decides real things through it (`server.port`, `logging.level`, `tunnel.enabled`) and the two must not disagree; `conf` still performs the lookup, so `dot-prop` escaping for a record key with a literal dot in it is unchanged.

Coverage sits in five files, and the split is load-bearing. `config/__tests__/version-skew.test.ts`, `config/__tests__/widened-leaves.test.ts` and `config/__tests__/backups.test.ts` cover the two sections above and the rotation. `__tests__/config-load-failure.test.ts` holds the steady-state cases: the `__internal__.migrations.version` repros, a persistent `EMFILE` that must leave the file byte-for-byte intact, the salvage gate, and the message wording. `__tests__/config-load-failure-migration.test.ts` holds the upgrade boot, and needs its own module registry because `conf` runs a migration only when its key is `<= projectVersion`: `SERVER_VERSION` is `0.0.0` in a dev tree, so **no migration body runs in the default test environment** and every laundered-errno case is unreachable. That file sets `DORKOS_VERSION_OVERRIDE` in a `vi.hoisted` block before its imports, and asserts the override took effect, because a suite that silently stopped exercising migrations is how the defect survived a review.

You can manually validate your config at any time:

```bash
dorkos config validate
```

Or reset to a known-good state:

```bash
dorkos config reset
```

## Security

Two config keys are marked as sensitive: `tunnel.authtoken` and `tunnel.auth`. These contain credentials that should not be stored in plain-text config files on shared machines.

**Recommendations:**

- Use environment variables (`NGROK_AUTHTOKEN`, `TUNNEL_AUTH`) instead of storing credentials in `config.json`
- The CLI and REST API both warn when sensitive keys are written
- The config file has standard user file permissions but is not encrypted
- Never commit `~/.dork/config.json` to version control

If you must store tunnel credentials in the config (e.g., single-user machine), be aware that they are saved as plain text in `~/.dork/config.json`.

## Docker

DorkOS provides Docker images for testing and deployment. All Docker images set `DORKOS_HOST=0.0.0.0` so that the Express server binds to all interfaces (required for Docker port forwarding).

### Running in Docker

Build and run a DorkOS container from local code:

```bash
pnpm docker:build    # Build the image
pnpm docker:run      # Run the container (maps DORKOS_PORT)
```

The `runtime` target of the root `Dockerfile` bundles the CLI, server, and client. Pass environment variables at runtime:

```bash
docker run --rm -p 4242:4242 \
  -e ANTHROPIC_API_KEY=your-key \
  -e DORKOS_PORT=4242 \
  dorkos:local
```

### Integration Testing

```bash
pnpm smoke:integration   # Full integration test (local tarball)
pnpm smoke:npm           # Test published npm package
pnpm smoke:docker        # CLI install smoke test only
```

### Publishing

Publish the CLI to npm:

```bash
pnpm publish:cli
```

This runs `pnpm publish --filter=dorkos`, which triggers the `prepublishOnly` script to build the CLI bundle automatically.

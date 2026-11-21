<!-- Generated from packages/test-utils/src/runtime-capability-matrix.ts by `pnpm docs:runtime-capabilities`. Do not edit by hand. -->

# Runtime capabilities

What every agent runtime DorkOS runs should do, and how far each one gets. This is the list of what runtimes **should** do, not only what is built: a capability nobody has built yet enters as a row marked `planned`, with the ticket that will build it.

To add a capability, add a row to `packages/test-utils/src/runtime-capability-matrix.ts` and run `pnpm docs:runtime-capabilities`. The census (`apps/server/src/services/runtimes/__tests__/runtime-capability-census.test.ts`) then checks it.

**Statuses:** `yes` does what the row says. `partial` does some of it. `unverified` says it does and no test proves it yet. `planned` will, under the named ticket. `no` does not, and nothing is planned. `n/a` does not apply.

**Proof tiers** are `U` for a deterministic CI test, `E` for a browser test on test-mode, and `L` for a live run against the real backend. Only `L` cells may be claimed in public copy.

The census checks legacy `U` claims against runtime and conformance test titles. An explicit `U` or `E` reference names a test file and its exact test title. The census also checks the declared runtime flags, row IDs, and generated guide.

An `L` reference names a passing case in a JSON receipt under `contributing/capabilities/runtime-evidence/`. Give the receipt a `runtime`, `runtimeVersion`, 40-character Git `revision`, `source` (`live-conformance`, `eval`, or `harness-smoke`), and `mode` set to `live`. Record each case’s `id` and `status` in `cases`. Review the scope of the run before citing it for a cell.

`test-mode` is the scripted fixture runtime the browser tests use, not a product runtime.

## Parity

| Runtime | yes | partial | unverified | planned | no | n/a |
| --- | --- | --- | --- | --- | --- | --- |
| claude-code | 46 | 2 | 4 | 0 | 0 | 2 |
| codex | 37 | 2 | 5 | 2 | 7 | 1 |
| opencode | 31 | 2 | 6 | 3 | 9 | 3 |
| doe | 35 | 1 | 4 | 2 | 11 | 1 |
| test-mode | 28 | 0 | 10 | 0 | 0 | 16 |

## Sessions

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-SES-01 | Track and look up sessions | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-SES-02 | List a project’s sessions | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-SES-03 | Resume a conversation | yes (U) | unverified | unverified | yes (U) | unverified |
| RT-SES-04 | One id for the whole conversation | yes (U) | unverified | partial (U) | yes (U) | unverified |
| RT-SES-05 | Settings follow the session | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-SES-06 | Find a session’s folder without a disk scan | yes (U) | n/a | n/a | yes (U) | n/a |
| RT-SES-07 | Fork a session | yes (U) | no | yes (U) | no | unverified |

- **RT-SES-01** A session the runtime started can be looked up by its id, and an unknown id answers null, never a guess.
- **RT-SES-02** Listing a project returns the sessions started inside it, including its subfolders, and never a lookalike sibling folder’s.
- **RT-SES-03** A later message continues the same conversation with its history, including after the server restarts. _(flag `supportsResume`)_
- **RT-SES-04** The id DorkOS hands out for a new session is the id it is stored, listed and messaged under for its whole life (DOR-2712).
  - opencode. U [re-lists the same OpenCode session under its ORIGINAL DorkOS id after a restart](../../apps/server/src/services/runtimes/opencode/__tests__/session-map.test.ts)
- **RT-SES-05** A session whose backend renames it keeps the mode, model and effort the person chose.
- **RT-SES-06** The runtime answers which folder a live session works in from memory, and never throws. _(conformance C10)_
- **RT-SES-07** A conversation can be copied into a new session that continues on its own.

## Streaming and history

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-STR-01 | A well-formed turn stream | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-STR-02 | A failed turn says so | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-STR-03 | Never repeat the person’s message back | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-STR-04 | Read a conversation’s history | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-STR-05 | History DorkOS keeps | n/a | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-STR-06 | Honest live status | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-STR-07 | A gap-free event stream | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-STR-08 | Hidden context stays hidden | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |

- **RT-STR-01** A turn yields only well-formed stream events and always ends with exactly one `done`.
- **RT-STR-02** A turn that fails yields a typed `error` event before its `done`, never silence.
- **RT-STR-03** The agent’s output never echoes the trigger or any context DorkOS wrapped around it.
- **RT-STR-04** After a turn completes, the session’s history reads back as messages, never a throw.
- **RT-STR-05** A runtime whose backend keeps no readable transcript has DorkOS record the turn, so it survives a server restart. _(flag `logBackedHistory`)_
- **RT-STR-06** A session reports a running turn while it runs and idle the moment it ends, and a session that never ran reports idle.
- **RT-STR-07** The durable event stream names the counter it numbers events with, so a reconnect replays from the right place.
- **RT-STR-08** Documents and context attached to a turn reach the agent and never show as the person’s visible message or the agent’s output.

## Tools and approvals

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-TOOL-01 | Ask before a tool runs | yes (U) | yes (U) | yes (U) | yes (U) | unverified |

- **RT-TOOL-01** When the permission mode says so, a tool call stops on an approval card and runs only on yes. _(flag `supportsToolApproval`)_

## Questions

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-ASK-01 | Ask the person a question | yes (U) | yes (U) | no | no | yes (U) |

- **RT-ASK-01** The agent can stop and ask the person a question, and an unanswered question says so in history. _(flag `supportsQuestionPrompt`)_

## Permission modes

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-PERM-01 | Declare permission modes honestly | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-PERM-02 | A mode set before the first message holds | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-PERM-03 | Changing a setting says what happened | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-PERM-04 | Plan mode | unverified | no | no | no | n/a |

- **RT-PERM-01** Every mode the runtime offers says, in plain words, what it will do without asking, and the default is one of them.
- **RT-PERM-02** A permission mode sent with a session’s first message is the mode its first turn runs in.
- **RT-PERM-03** Changing a session’s settings answers whether it applied now or on the next turn, and never claims a session it does not have.
- **RT-PERM-04** A read-only planning mode in which nothing changes until the person approves a plan. _(flag `permissionModes has 'plan'`)_

## Models and effort

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-MOD-01 | Reasoning effort | yes (U) | yes (U) | no | no | n/a |

- **RT-MOD-01** The person’s effort setting reaches the model the turn runs on. _(flag `settings.supportsEffort`)_

## Accounts and credits

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-ACCT-01 | More than one sign-in | yes (U) | no | no | no | n/a |
| RT-ACCT-02 | Run on DorkOS credits | yes (U) | yes (U) | yes (U) | yes (U) | n/a |
| RT-ACCT-03 | A sign-in failure is explained | yes (U) | yes (U) | yes (U) | yes (U) | n/a |

- **RT-ACCT-01** A session runs and bills on the account it was started on, and the runtime can say which. _(flag `supportsAccounts`; conformance C12)_
- **RT-ACCT-02** A session set to credits runs on the credits token, and is refused with nothing started when there is no live token. _(flag `credits`)_
- **RT-ACCT-03** When the runtime’s sign-in fails, the person reads it in DorkOS’s words naming the runtime, and it stays an error after a reload.

## MCP

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-MCP-01 | DorkOS’s own tools | yes (U) | no | no | yes (U) | n/a |
| RT-MCP-02 | The person’s MCP servers | partial (U) | partial (U) | partial (U) | yes (U) | n/a |

- **RT-MCP-01** The agent can use DorkOS’s tools (rooms, relay, tasks, connections) from inside its turn. _(flag `supportsMcp`)_
- **RT-MCP-02** MCP servers the person added in DorkOS are available to the agent. _(flag `supportsManagedMcpServers`)_
  - claude-code. U [injects only the ENABLED server, and dorkos is present and unshadowed](../../apps/server/src/services/runtimes/claude-code/__tests__/mcp-server-config.test.ts)
  - codex. U [carries tools, identity and trust over the wire, authenticated by a thread key](../../apps/server/src/services/runtimes/codex/app-server/__tests__/thread-loader.test.ts), U [drops an sse managed server (Codex has no SSE transport) and injects the rest](../../apps/server/src/services/runtimes/codex/__tests__/codex-runtime.test.ts)
  - opencode. U [registers enabled managed servers into the sidecar before the prompt, dropping sse](../../apps/server/src/services/runtimes/opencode/__tests__/opencode-runtime.test.ts)

## Plugins, prompts and folders

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-PLG-01 | Plugins | yes (U) | no | no | yes (U) | n/a |
| RT-PLG-02 | DorkOS’s instructions stay current | yes (U) | yes (U) | yes (U) | yes (U) | unverified |
| RT-PLG-03 | Folder grants | yes (U) | yes (U) | yes (U) | yes (U) | unverified |

- **RT-PLG-01** Plugins the person turned on load into the agent’s session. _(flag `supportsPlugins`)_
- **RT-PLG-02** When the instructions DorkOS adds to the system prompt change, the next turn of a running session gets the new ones.
- **RT-PLG-03** Each turn reaches exactly the extra folders it was granted, and no others.

## Steer, stage and queue

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-DISP-01 | Steer a running turn | yes (U) | yes (U) | no | yes (U) | yes (U) |
| RT-DISP-02 | Add context without a reply | yes (U) | no | no | no | yes (U) |
| RT-DISP-03 | The queue keeps order | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-DISP-04 | An unsupported way of sending is refused cleanly | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |

- **RT-DISP-01** A message sent while the agent works reaches it inside the same turn, without starting a new one. _(flag `supportsSteer`; conformance C7)_
- **RT-DISP-02** Context the person adds reaches the agent without starting a turn or a reply. _(flag `supportsContextStaging`; conformance C9)_
- **RT-DISP-03** Each turn window ends with exactly one `done`, and a queued message runs after a failed turn but never into an open question or approval. _(conformance C2, C3)_
- **RT-DISP-04** A steer or stage the runtime does not declare is refused as unsupported, never thrown. _(conformance C1)_

## Stopping a turn

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-STOP-01 | Stop is safe with nothing running | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-STOP-02 | Stopping a live turn answers honestly | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |

- **RT-STOP-01** Stopping a session with no turn open, or one the runtime never saw, answers “not running” and never fails. _(conformance I1, I5)_
- **RT-STOP-02** Stopping a running turn returns a receipt naming the runtime and the outcome, within a bound even when the backend never answers. _(conformance I2, C11)_

## Background work and turn lifecycle

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-LIFE-01 | Keep the agent warm between turns | yes (U) | yes (U) | no | no | yes (U) |
| RT-LIFE-02 | Settle an open turn | yes (U) | yes (U) | n/a | no | yes (U) |
| RT-LIFE-03 | Work that outlives the turn wakes the chat | partial DOR-2717 | partial (U) DOR-2717 | planned DOR-2717 | no | n/a |

- **RT-LIFE-01** The agent’s process stays open between turns, reports idle while it waits, and a reaped process is invisible to the next turn. _(flag `supportsPersistentSession`; conformance C4, C5)_
- **RT-LIFE-02** Asking a warm session to settle answers honestly when nothing is open, and never throws. _(flag `supportsPersistentSession`; conformance C8)_
- **RT-LIFE-03** A background shell or helper that finishes after the turn ended delivers its result into the chat as a new turn, as it does in the runtime’s own CLI.

## Attachments and media

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-MEDIA-01 | Attach images to a message | unverified | unverified | unverified | no | n/a |
| RT-MEDIA-02 | Show pictures returned by tools | yes (U) | yes (U) | yes (U) | no | n/a |

- **RT-MEDIA-01** Images the person attaches reach the agent with the message.
- **RT-MEDIA-02** A picture returned by an agent’s tool reaches the chat as a stored attachment announced by URL. _(flag `mediaOutput !== 'none'`)_
  - claude-code. U [announces the image by URL, with the bytes already on disk](../../apps/server/src/services/runtimes/claude-code/sessions/__tests__/pump-turn-stream-media.test.ts)
  - codex. U [records an MCP image for the runtime to store](../../apps/server/src/services/runtimes/codex/app-server/__tests__/notification-mapper.test.ts), U [announces the image by URL, with the bytes already on disk](../../apps/server/src/services/runtimes/codex/__tests__/media-capture.test.ts)
  - opencode. U [stores the bytes and announces them by URL](../../apps/server/src/services/runtimes/opencode/__tests__/media-capture.test.ts), U [writes bytes that are actually the image, not a placeholder](../../apps/server/src/services/runtimes/opencode/__tests__/media-capture.test.ts)

## Cost and usage

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-COST-01 | Cost and usage per turn | yes (U) | no | yes (U) | yes (U) | n/a |

- **RT-COST-01** Each turn reports the tokens it used, and its cost where the account pays per token. _(flag `supportsCostTracking`)_

## Compaction

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-CMP-01 | Compact the conversation | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-CMP-02 | The agent can ask for its own conversation to be compacted | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-CMP-03 | Report how full the conversation is | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |

- **RT-CMP-01** The person can ask for the conversation to be compacted, and progress is reported while it runs. _(flag `commandIntents.compact`)_
- **RT-CMP-02** An agent asks for its own conversation to be summarized; it runs after the turn ends, and the chat says the agent asked. Its focus note is used where the runtime takes one (Claude Code). _(flag `commandIntents.compact`)_
- **RT-CMP-03** After each reply the runtime reports the tokens in the context and the size of the window, so DorkOS can tell the agent when it passes 80%. A model whose window the runtime cannot learn reports no window rather than a guess.

## Rooms

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-ROOM-01 | Carry room messages as context | yes (U) | yes (U) | yes (U) | partial (U) | unverified |
| RT-ROOM-02 | Post one reply to the room | unverified | unverified | unverified | unverified | yes (E) |

- **RT-ROOM-01** A room turn receives member messages inside a labeled room context block.
  - claude-code. U [carries room context for Claude Code](../../apps/server/src/services/runtimes/shared/__tests__/room-context-runtime-neutrality.test.ts)
  - codex. U [carries room context for Codex](../../apps/server/src/services/runtimes/shared/__tests__/room-context-runtime-neutrality.test.ts)
  - opencode. U [carries room context for OpenCode](../../apps/server/src/services/runtimes/shared/__tests__/room-context-runtime-neutrality.test.ts)
  - doe. U [carries neutral $kind context through its shared formatter](../../apps/server/src/services/runtimes/doe/__tests__/context.test.ts)
- **RT-ROOM-02** A reply posted through the room capability appears once, and a quiet turn nobody asked for leaves the room unchanged.
  - test-mode. E [a tool-only reply lands once, and its own narration never reaches the room](../../apps/e2e/tests/rooms/room-tool-only-replies.spec.ts), E [nobody asked, so a quiet turn leaves the room unchanged and the pill clears](../../apps/e2e/tests/rooms/room-tool-only-replies.spec.ts)

## Scheduled tasks

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-TASK-01 | Run a task on its chosen runtime | unverified | yes (U) | unverified | unverified | unverified |

- **RT-TASK-01** A scheduled run uses its named runtime and records a failure without starting a turn elsewhere when that runtime is disabled.
  - codex. U [runs the task on the runtime IT names, not the registry default](../../apps/server/src/services/tasks/__tests__/task-scheduler-service.test.ts), U [fails the run loudly when the named runtime is not turned on, and starts no turn](../../apps/server/src/services/tasks/__tests__/task-scheduler-service.test.ts)

## Relay

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-RELAY-01 | Deliver to the target agent’s runtime | yes (U) | yes (U) | unverified | unverified | unverified |

- **RT-RELAY-01** An agent message reaches the registered runtime named by the target’s manifest and starts one turn there.
  - claude-code. U [answers a claude-code agent on claude-code](../../apps/server/src/services/relay/__tests__/agent-subject-target-runtime.integration.test.ts)
  - codex. U [answers a codex agent on codex, not on the default runtime](../../apps/server/src/services/relay/__tests__/agent-subject-target-runtime.integration.test.ts)

## Extension tools

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-EXT-01 | List accepted extension tools | yes (U) | unverified | unverified | unverified | unverified |

- **RT-EXT-01** The session tool list includes accepted extension tools alongside built-in tools and drops extension tools when unregistered.
  - claude-code. U [lists every core tool and the accepted extension tools, and never the refused one](../../apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/extension-tool-listing.test.ts)

## Sleep and keep-awake

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-AWAKE-01 | Hold keep-awake during an active chat turn | yes (U) | yes (U) | yes (U) | yes (U) | yes (U) |
| RT-AWAKE-02 | Apply keep-awake in the runtime’s own process | n/a | yes (U) | n/a | n/a | n/a |

- **RT-AWAKE-01** A streamed chat turn through the runtime registry adds one hold to the shared keep-awake counter and releases it when the turn ends.
  - claude-code. U [holds a turn on any runtime resolved from runtimeRegistry, exactly once](../../apps/server/src/services/core/keep-awake/__tests__/hold-during-turn.test.ts)
  - codex. U [holds a turn on any runtime resolved from runtimeRegistry, exactly once](../../apps/server/src/services/core/keep-awake/__tests__/hold-during-turn.test.ts)
  - opencode. U [holds a turn on any runtime resolved from runtimeRegistry, exactly once](../../apps/server/src/services/core/keep-awake/__tests__/hold-during-turn.test.ts)
  - doe. U [holds a turn on any runtime resolved from runtimeRegistry, exactly once](../../apps/server/src/services/core/keep-awake/__tests__/hold-during-turn.test.ts)
  - test-mode. U [holds a turn on any runtime resolved from runtimeRegistry, exactly once](../../apps/server/src/services/core/keep-awake/__tests__/hold-during-turn.test.ts)
- **RT-AWAKE-02** The runtime receives the idle sleep setting when keep-awake applies and reloads the session before its next turn after the setting changes.
  - codex. U [loads the thread with features.prevent_idle_sleep while keep-awake applies](../../apps/server/src/services/runtimes/codex/__tests__/codex-keep-awake.test.ts), U [leaves it out while keep-awake does not apply](../../apps/server/src/services/runtimes/codex/__tests__/codex-keep-awake.test.ts), U [reloads the thread before its next turn when the keep-awake setting changes](../../apps/server/src/services/runtimes/codex/__tests__/codex-keep-awake.test.ts)

## Safety guards

| ID | Capability | claude-code | codex | opencode | doe | test-mode |
| --- | --- | --- | --- | --- | --- | --- |
| RT-GRD-01 | Keep the agent off protected files | yes (U) | planned DOR-3597 | planned DOR-4445 | planned DOR-4445 | n/a |
| RT-GRD-02 | Keep the agent’s own setup closed below Full | yes (U) | planned DOR-3598 | planned DOR-3598 | planned DOR-3598 | n/a |

- **RT-GRD-01** File tools refuse the shared protected list: its secrets at every level, the files that grant power below Full. Below Full, a shell command that reads a protected file, such as a browser profile’s sign-ins, goes to a person first. _(flag `guards.protectedPaths`)_
- **RT-GRD-02** Below Full, file tools cannot change the agent’s own hooks, skills, settings or MCP servers, and at any level they cannot change its `.dork/agent.json`. A shell command that plainly writes them is refused too. _(flag `guards.ownFolder`)_

## Gaps

Every cell that is not `yes`, `no` or `n/a`, planned work first.

| ID | Runtime | Status | Ticket | Why |
| --- | --- | --- | --- | --- |
| RT-LIFE-03 | opencode | planned | DOR-2717 | Nothing delivers work that finishes after an OpenCode turn. |
| RT-GRD-01 | codex | planned | DOR-3597 | The sandbox denies protected paths only under the folders DorkOS names (DOR-3790), and file-change approvals are not checked against the list. |
| RT-GRD-01 | opencode | planned | DOR-4445 | Its file tools refuse the protected list; its shell is not checked against it. |
| RT-GRD-01 | doe | planned | DOR-4445 | Its file tools refuse the protected list; its shell is not checked against it. |
| RT-GRD-02 | codex | planned | DOR-3598 | Its own `.codex/` and `.agents/` setup is not held below Full. |
| RT-GRD-02 | opencode | planned | DOR-3598 | Its own `opencode.json` and `.agents/` setup is not held below Full. |
| RT-GRD-02 | doe | planned | DOR-3598 | An agent home in the data folder is closed to its file tools; an agent in a project folder, and its shell, are not held. |
| RT-SES-04 | opencode | partial |  | A fresh mapper re-lists the original DorkOS id from the same database. Sending after a restart remains unverified. |
| RT-MCP-02 | claude-code | partial |  | The SDK factory builds options for enabled stdio servers from the agent’s manifest. A tool call remains unverified. |
| RT-MCP-02 | codex | partial |  | Managed HTTP server settings reach app-server. SSE servers are excluded. |
| RT-MCP-02 | opencode | partial |  | Enabled stdio and HTTP servers register before the prompt. SSE is excluded. |
| RT-LIFE-03 | claude-code | partial | DOR-2717 | Helpers, shells and session timers report back on a warm session; async hooks and durable timers do not. |
| RT-LIFE-03 | codex | partial | DOR-2717 | Background commands wake the chat; a helper agent that outlives its turn is tracked but not yet proven against Codex. |
| RT-ROOM-01 | doe | partial |  | The formatter case checks the room block and its label, leaving message text unchecked. |
| RT-SES-03 | codex | unverified |  | Resumes its thread by id; no test pins a resumed turn seeing earlier history. |
| RT-SES-03 | opencode | unverified |  | Resumes its session by id; no test pins a resumed turn seeing earlier history. |
| RT-SES-03 | test-mode | unverified |  | test-mode is a scripted fixture with no backend behind it. |
| RT-SES-04 | codex | unverified |  | DorkOS keeps its own id and maps the thread to it; no test pins the round trip. |
| RT-SES-04 | test-mode | unverified |  | test-mode is a scripted fixture with no backend behind it. |
| RT-SES-07 | test-mode | unverified |  | test-mode is a scripted fixture with no backend behind it. |
| RT-TOOL-01 | test-mode | unverified |  | test-mode is a scripted fixture with no backend behind it. |
| RT-PERM-04 | claude-code | unverified |  | Declared and offered; no test pins that a plan-mode turn changes nothing. |
| RT-PLG-02 | test-mode | unverified |  | test-mode is a scripted fixture with no backend behind it. |
| RT-PLG-03 | test-mode | unverified |  | test-mode is a scripted fixture with no backend behind it. |
| RT-MEDIA-01 | claude-code | unverified |  | The composer sends the saved file path. How the agent receives the image needs a test. |
| RT-MEDIA-01 | codex | unverified |  | The composer sends the saved file path. How the agent receives the image needs a test. |
| RT-MEDIA-01 | opencode | unverified |  | The composer sends the saved file path. How the agent receives the image needs a test. |
| RT-ROOM-01 | test-mode | unverified |  | The browser room cases check delivery after the scripted turn. |
| RT-ROOM-02 | claude-code | unverified |  | The browser cases drive scripted test-mode replies. |
| RT-ROOM-02 | codex | unverified |  | The browser cases drive scripted test-mode replies. |
| RT-ROOM-02 | opencode | unverified |  | The browser cases drive scripted test-mode replies. |
| RT-ROOM-02 | doe | unverified |  | The browser cases drive scripted test-mode replies. |
| RT-TASK-01 | claude-code | unverified |  | The scheduler cases use Codex as the named runtime. |
| RT-TASK-01 | opencode | unverified |  | The scheduler cases use Codex as the named runtime. |
| RT-TASK-01 | doe | unverified |  | The scheduler cases use Codex as the named runtime. |
| RT-TASK-01 | test-mode | unverified |  | The scheduler cases use Codex as the named runtime. |
| RT-RELAY-01 | opencode | unverified |  | The target-manifest delivery cases register Claude Code and Codex. |
| RT-RELAY-01 | doe | unverified |  | The target-manifest delivery cases register Claude Code and Codex. |
| RT-RELAY-01 | test-mode | unverified |  | The target-manifest delivery cases register Claude Code and Codex. |
| RT-EXT-01 | codex | unverified |  | The extension tool-listing case exercises the Claude Code transport. |
| RT-EXT-01 | opencode | unverified |  | The extension tool-listing case exercises the Claude Code transport. |
| RT-EXT-01 | doe | unverified |  | The extension tool-listing case exercises the Claude Code transport. |
| RT-EXT-01 | test-mode | unverified |  | The extension tool-listing case exercises the Claude Code transport. |

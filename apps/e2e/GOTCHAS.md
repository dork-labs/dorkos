# Browser Test Gotchas

Anti-patterns and hard-won lessons discovered during test creation. Read this before writing any new test.

## Selectors

- Avoid `getByText()` on dynamic content that changes between runs (timestamps, session IDs, message previews)
- Sidebar session items re-render on SSE updates; grab locators fresh after any navigation that triggers a sync
- **An agent's streamed words are in the DOM TWICE while the turn is live**: once in the message, and once in the transcript's screen-reader announcer (`[data-testid="transcript-announcer"]`, a `role="log"` region that mirrors each new sentence and empties itself a few seconds later). A bare `page.getByText(/…/)` on assistant text therefore resolves to two elements and fails the strict-mode check. Scope it to where you mean — `page.getByTestId('transcript-feed').getByText(…)` for what the reader sees, the announcer for what a screen reader hears.
  - **And it fails on the first poll, not after the timeout.** Playwright treats a strict-mode violation as non-retriable, so the assertion never waits the announcer out — a `timeout: 10_000` buys you nothing here.
  - **Your machine will not show you this.** The announcer only picks up a message it sees _arriving_, and locally a mock turn lands in one batch with the streaming flag already down, so the region stays empty and a bare `getByText` passes. CI is slow enough to render the turn across several frames, the announcer adopts, and the same line fails there and only there. Scope the locator on the way in; do not wait for a green local run to tell you it was needed.

## Multi-window / connection-budget tests

Two ways to write a multi-window test so it can **never fail**. Both were live
traps while `tests/streams/multi-window.spec.ts` was being written, and both
produce a permanently green test rather than an error:

- **`browser.newContext()` per window.** Separate contexts have separate socket
  pools, so the per-origin budget is never shared and the test passes against
  the very bug it exists to catch. Real windows of one browser share a profile.
  Use **one** `browser.newContext()` and `context.newPage()` per window.
- **`page.request.get()` or the `request` fixture for the probe.** Both run in
  **Node**, not in the page, so they bypass the browser's socket pool entirely.
  The probe has to run inside the browser: `page.evaluate(() => fetch('/api/health'))`.

Two more things that make such a test vacuous without erroring: opening every
window on the **same** session id (the stream manager attaches one stream for
all of them, so the budget is never approached), and not asserting that any
stream actually connected — "everything was fast" proves nothing if the sockets
never opened. Count them.

## `--repeat-each` needs `--workers=1` on the shared test-mode legs

**`--repeat-each=N` alone does not prove stability on `chromium-mock`. It
manufactures failures.** Playwright creates N copies of each test and schedules
them like any other tests, and locally `workers` is unset — so repeats of ONE
file land on SEVERAL workers at once. `test.describe.configure({ mode: 'default' })`
serializes tests _within_ a worker and does nothing across them, so the copies
race each other's `POST /api/test/reset`, which wipes scenarios, tracked sessions
and projectors for everybody.

Measured twice, independently, on the same day, which is how confident to be
about it. On three untouched, long-standing `chat-mock.spec.ts` tests:
`--repeat-each=6` → **10 of 18 failed**; the same command with `--workers=1` →
**18 of 18 passed**. And on the compaction suite (DOR-1215): **2 of 6 red** at
`--repeat-each=3`, **0 of 6** with `--workers=1`. The failures look like product
bugs — an empty transcript reading "Start a conversation", a card that never
rendered — and none of them is one.

So: **`--repeat-each=N --workers=1`**, which is also what CI runs
(`workers: CI ? 1 : undefined`). A flake hunt without `--workers=1` on these
projects will send you after a race that only your own command created. The same
applies to any other project on a shared leg (`chromium-connections`,
`chromium-streams`, `chromium-team-room`, `chromium-bridge`).

**And reap the ports between back-to-back local runs** — see the stale-Vite note
at the end of this file. Two of the "failures" above were that instead.

## Timing & Waits

- SSE streaming indicators have three states (`streaming`, `waiting`, `complete`) — always wait for the full lifecycle, not just `visible`
- `toHaveURL()` assertions can race with client-side router updates; pair with a visible-element wait on the target page

## Navigation & State

- Creating a new session via the UI changes the `?session=` URL param; tests that check session count must re-query after URL stabilizes
- Settings dialog is a modal overlay — it does not change the URL, so `toHaveURL` won't help; use `waitFor({ state: 'visible' })` on the dialog locator

## Sending a message

- **`ChatPage.sendMessage` can silently send nothing.** It fills the composer and
  clicks send; the composer is a CONTROLLED field, so a fill that lands before
  the session and its agent have hydrated is reverted by the next render, and the
  click then sends an empty box. Nothing errors. The spec times out later on
  whatever the turn was meant to produce and reports a missing CARD rather than a
  missing SEND. Use **`ChatPage.sendAndLand`**, which waits for the composer, for
  the send button to appear after the fill, for the person's message, and for the
  agent to have BEGUN answering.
- **Waiting for the user's own message is not enough**, which is why
  `sendAndLand` also waits for an assistant message: an optimistic user bubble
  can be wiped when the session snapshot arrives, leaving the transcript back at
  "Start a conversation" with no turn ever started — and a barrier that stopped
  at the user bubble passes in exactly that case.
- **A consequence for fixtures: every scripted scenario must SAY something before
  it blocks.** `todo-progress` originally emitted its three task creations and
  parked in silence, which is indistinguishable from a dropped send; it cost
  three failures until it was given an opening line.
- **The send button does not exist on an empty composer** — the action slot only
  becomes "send" once there is text — so a readiness wait on it _before_ filling
  can never pass.

## Dynamic Content

- Assistant messages stream in token-by-token; never assert exact text content mid-stream — wait for the inference indicator to reach `hidden` first
- Optimistic UI updates (e.g., message appears before server confirms) can cause stale element handles; re-locate after any mutation
- A tool call that is already `complete` on the frame its part first mounts is never put in the DOM at all — auto-hide drops it, rather than hiding it with CSS. The mock scenarios are zero-latency and `turn_end` remounts the part as complete, so a tool-call assertion is racing a 0ms turn and will eventually lose. Turn the preference off for that test: `page.addInitScript(() => localStorage.setItem('dorkos-auto-hide-tool-calls', 'false'))`, before `goto`.

## Interactive prompts (approvals, questions, elicitation)

Learned while writing the DOR-1214 suites (`tests/chat/interactive-prompts.ts`,
`tests/chat/live-turn-visibility.ts`). All of these produced a green-looking
locator that was pointing at the wrong thing.

- **Button accessible names carry their keyboard hint.** Approve's name is
  `"Approve Enter"`, Always Allow's is `"Always Allow Shift+Enter"`, Deny's is
  `"Deny Esc"` — a `<Kbd>` child folds into the name, and it only renders while
  the card is ACTIVE, so the name is not stable either. `{ name: 'Approve',
exact: true }` never matches.
- **`/^Approve\b/` does NOT exclude "Approve All".** The word boundary sits
  between `Approve` and the space, so it is satisfied by the exact string it
  looks like it rules out — same for `/^Deny\b/` and "Deny All". Use a negative
  lookahead: `/^Approve(?!\s+All)/`. Scoping the locator to the card hides this
  today (the batch bar lives in the composer, not the transcript), which is
  exactly why the comment claiming the guard outlived the guard.
- **`tool-approval-decided` and `question-prompt-submitted` are TRANSIENT.** Both
  are live in-place rows that exist only until the turn ends and the message is
  rebuilt from history. Asserting them is a race against the turn closing (it
  lost, twice, in three repeats). Assert the durable `approval-receipt` and its
  `data-outcome` (`allowed` / `denied` / `expired`) instead, or assert the card
  is simply gone.
- **A completed tool call's RESULT needs two things**: auto-hide off
  (`localStorage['dorkos-auto-hide-tool-calls'] = 'false'`, see Dynamic Content
  below) _and_ an expand click — the card renders collapsed to a one-line header.
  Wait for `inference-indicator-streaming` to be hidden before that click, or
  Playwright refuses to click a still-reflowing element and reports it as a click
  timeout rather than as an animation.
- **`permission_denied` never reaches a client.** The session-event normalizer
  maps it to `null` (it is an SDK pre-`canUseTool` denial, not an operator's), so
  a fixture emitting it, and any assertion resting on it, is dead weight. An
  operator's refusal reaches the transcript via `interaction_resolved`.
- **Elicitation form fields are labelled by the schema's `description`, not its
  `title`** — `ElicitationPrompt.tsx` uses `prop.description ?? key` and ignores
  `title` entirely. A fixture that sets only `title` renders the raw property key.
- **A subagent's description is on screen twice while it runs** — in its
  transcript block and in the background task bar — so a bare `getByText` is a
  strict-mode violation. Scope it to `[data-testid="subagent-block"]`.
- **Subagent blocks are DROPPED, not collapsed, when the turn ends.** The rebuild
  from history removes settled sub-agent parts the way it removes finished tool
  calls. Assert `toHaveCount(0)`; `data-status="complete"` exists only in the
  window before the rebuild.
- **The todos reducer discards the id you send on a `create`** and assigns its own
  `String(nextId++)` counter (`use-task-state.ts`), then looks an `update` up by
  the id the event carries. A fixture whose tasks are not numbered `'1'`, `'2'`,
  `'3'` renders fine and never advances — the updates find nothing and are
  dropped in silence.
- **`not.toContainText` fails when the element is absent.** An interrupted turn
  can leave a session with no history, and the transcript then unmounts for the
  empty state — so a negative assertion on `transcript-feed` errors with "element
  not found" instead of passing. Use `expect(page.getByText(...)).toHaveCount(0)`.

## The live compaction row is transient — you cannot assert on it twice

A successful compaction draws **two different rows, from two different sources**,
one after the other:

- **live** — `[data-testid="compact-boundary-row"]`, projected from the turn's
  `compact_boundary` event (`CompactBoundaryRow`);
- **durable** — `[data-testid="compaction-row"]`, the `messageType: 'compaction'`
  history message (`UserMessageContent`).

At `turn_end` the client reconciles against canonical history and the durable row
**replaces** the live one. So a test that asserts `toBeVisible()` on the live row
and then asserts anything else about it is racing that handover — and on a loaded
machine it loses. That failure is badly disguised: the second assertion reports
`compact-boundary-trigger` "element(s) not found", which reads exactly like the
boundary having arrived without its metadata.

Two ways to write it safely, both in `tests/chat/compaction.ts`:

- Assert everything about the live row **in one locator**
  (`.filter({ hasText: … })`), or
- drive the `compacting-hold` scenario, which holds the turn open after the
  boundary until `POST /api/test/finish-turn` — then the live row stands still,
  and the handover itself becomes assertable instead of being the thing that
  beats you.

`/compact` (the command intent) **cannot** be held open, so a live-row assertion
on that path is racy by construction. Pin the live row on the held scenario, and
pin the durable row everywhere else.

## Known coverage gaps

Worth knowing before you assume a behaviour is tested.

- **A turn blocked on an approval offers no Stop, so C-10 cannot be driven for
  that case.** The approval card REPLACES the composer, and the composer is where
  the Stop button lives — there is no affordance to click. The runtime itself
  handles it correctly (`interruptQuery` aborts a parked scenario and closes the
  turn, pinned in `test-mode/__tests__/interactive-scenarios.test.ts`), so this is
  a UI gap rather than a broken stop. `live-turn-visibility.ts` pins the current
  behaviour instead, and will go red the day a Stop is offered there.
- **Steering a message into a live turn (capability C-09) has no coverage,
  because there is nothing to drive.** P4.1 landed the runtime and dispatcher
  halves — `AgentRuntime.deliverIntoTurn` and `deliverSteer` in
  `message-dispatcher.ts` — but `deliverSteer` has **no caller**: no HTTP route
  reaches it, and no client control asks for it. `POST /messages` accepts
  `disposition: 'steer'` and `resolveDisposition` degrades every one of them to
  `queue`; every runtime including claude-code still declares
  `supportsSteer: false`. There is no composer Steer affordance to click. This
  needs the product half before a browser test can exist.
- **Auto-hide of completed tool calls has no browser coverage.** `chat-mock.spec.ts` switches the preference OFF to assert the card renders, and nothing asserts what it does when it is ON — which is the shipped default, so the default path is the untested one.
- **Relay's Mode A empty state has no coverage.** DorkOS registers a built-in `claude-code` adapter, so a running server always has one connection and always renders the tabs. Reaching the "Connect your agents to the world" state needs a server with that adapter removed.
- **Creating a session from the roster has no coverage.** The old spec drove a "New session" control that no longer exists; session creation is exercised only against `TestModeRuntime` in `chat-mock.spec.ts`.
- **Discovery scanning has no coverage.** `tests/mesh/mesh-panel.spec.ts` had two tests for it — a scan-roots input and a Scan button that enabled once roots were typed — against a Mesh dialog that no longer exists. Its replacement, `tests/agents/agents-page.spec.ts`, covers the fleet page's four views and dropped those two (8 tests became 5). Scanning did not go away with the dialog: it is the **"Bring in existing projects"** quick action in the command palette, which nothing tests.

## Known flakes

These are known, not mysteries. If you hit one, you have found the known thing —
go to the ticket where there is one rather than re-diagnosing it. None of them
is a test bug, so none is fixed here. The last one has no ticket on purpose: it
is a property of running this suite on a machine that is already busy, and it
cannot reach CI.

- **DOR-697 — `relay/adapter-wizard-fields.spec.ts`, ~1 run in 7.** A save
  answers **500** with `ENOENT: no such file or directory, rename …` under
  `DORK_HOME`. Not always the same test in the file. Two writers save adapter
  config to a **fixed** temp path (`dataPath + '.tmp'`) and then rename it, so
  two concurrent saves race: A writes tmp, B overwrites it, A renames, B renames
  onto nothing. It is a product race in server code, and the serious half is not
  the 500 — A can rename B's half-written file into a store that also holds
  `runtime-credentials.json`. Do not "fix" this by retrying the request.
- **DOR-698 — `rooms/mention-picker.spec.ts`, ~1 run in 16 even in isolation.**
  `getByRole('combobox', { name: 'Message #…' })` is not visible. Isolation rules
  out cross-test interference; it is the composer's own readiness.
- **The cockpit crashes into its error boundary with `useEventStream must be
used within an EventStreamProvider`, any spec, roughly 1 run in 10.** The
  failing assertion is whatever the test was doing — usually "expected 2,
  received 0", because the whole app has been replaced by the boundary — so it
  reads like a product bug in the surface under test. **It is not.** Check
  `error-context.md` before diagnosing anything: if the page snapshot is
  `DorkOS encountered an unexpected error` over that sentence, you have found
  this and not your feature.

  The suite runs the client through `turbo dev`, so Vite HMR is live. A hot
  update creates a **new** React Context object while already-mounted consumers
  still hold the old one, `useContext` answers `undefined`, and the provider's
  own guard throws. Dev-only by construction — a production build has no HMR —
  and unrelated to whatever spec happened to be running. Background on this
  provider's mount behaviour: `research/20260327_sse_singleton_strictmode_hmr.md`.

  Re-run the spec in isolation (`--repeat-each=5`) before you touch anything. If
  it passes, that is the answer.

- **`home-surface/home-shell.spec.ts` › "the dashboard is gone, not hidden —
  Home is the #team room", locally only, on a busy machine.** It waits 5s for
  `home-composer`, which is the #team room's box, and loses that race when the
  file is running wide enough in parallel — this repo is routinely several agents
  deep, and the cockpit leg is one Express process serving all of them.

  **Not caused by whatever you just changed, and the check is cheap.** Run the
  file with your own block grepped out (`-g "the shell|375px"`): if the other
  tests pass at that width, you have this. Adding tests to the file is enough to
  trigger it — four new ones at 390px did (DOR-1180), and the same six
  pre-existing tests were green with them filtered out. `--workers=1` is also
  always green, and that is what CI runs (`workers: CI ? 1 : undefined`), so this
  cannot reach a PR check. Do not add a retry or stretch the timeout for it.

**A stale Vite can outlive its run.** `turbo dev` spawns vite as a grandchild,
so when Playwright kills the leg the vite process survives holding the port.
Start a second run straight after a first and it inherits that vite — now
proxying to an API leg that is gone — and `globalSetup` dies with
`Could not dismiss onboarding … 500`, which names onboarding and not the cause.
Reap the ports between back-to-back local runs. CI gets fresh runners, so this
is local-only.

## Assertions this suite cannot make

The whole suite shares one server, and specs run in parallel against it. So an assertion is only sound if it is about rooms, agents or schedules **this test seeded**. Anything phrased as a claim about everything on the server is a claim only one test can be right about at a time — and it will fail when a neighbour is doing its job.

Concretely, do not assert:

- that a list is empty ("No schedules yet.") — a sibling is seeding into it;
- **which three emoji a message capsule's quick row holds.** They are the
  READER's most-used, counted across every room on the server, so any sibling
  spec that reacts to anything changes them for everyone. Naming 👍 there passes
  on a clean database and fails the moment another reactions test runs first —
  which is what it did. Read the row (`RoomsPage.quickReactionsIn`, then the
  button's `data-emoji`) and assert against what you read;
- that a palette's **first** row is anything in particular — another spec's unread room may be above yours;
- that pressing Enter on an unfiltered list opens _your_ thing — filter to your own run id first.

That last one is not hypothetical: `rooms-in-palette` pressed Enter on the untyped palette's first unread row, which on a busy suite was a _neighbour's_ room — and arriving at a room marks it read, so it silently cleared another spec's unread badge and made that spec fail about half the time. It looked like a product bug for a while (DOR-692, since closed as an artefact).

## Counting answers in a room an agent replies in

`#team`, or a channel on the test-mode leg. Four traps, every one of them found
the hard way in DOR-1213, and three of the four produce a test that passes when
it should fail rather than one that errors.

- **"Entries I have not seen before" is not "answers to my message."** `POST
/entries` is trigger-only, so a test that asserts its timeline and moves on
  leaves its agent's reply still coming; it lands during the NEXT test, after
  that test's `before` snapshot, and is counted as an answer to a message it has
  nothing to do with. Scope by `cascadeRoot` — the server's own answer to which
  conversation a line belongs to — not by id-not-seen-before.
- **A notice is not a participant.** The room speaks in the same feed and in the
  same cascade. An agent unregistered by an earlier run leaves an `engaged` seat
  behind in `#team`, and the room says so ("… isn't set up on this machine any
  more, so it can't answer here") _inside your cascade_. Counting it made
  "nobody else piles on" fail against a working product. Filter
  `body.notice === undefined` whenever the claim is about who ANSWERED.
- **Counting on the first answer cannot see the second.** "Only one agent
  answered" read off the snapshot taken when the first reply lands does not fail
  when another agent piles on — it passes, because it looked too early. Settle
  first: post a marker, wait for ITS answer, then wait for the room's `working`
  count to reach zero (`TeamRoomApi.settle`). The marker proves the room
  processed something later; the working count proves no other agent is still
  holding a claim. `tests/rooms/room-autonomy.spec.ts` does the seeded-room
  version of the same thing with a fourth message.
- **`#team` marks at most one moment an hour, so a moment test cannot repeat.**
  A second attempt — `--repeat-each`, a Playwright retry — creates its agent, is
  correctly suppressed, and fails on a precondition as if the ordering rule had
  broken. Tell "I already ran" from "somebody else ran first" by whose agent the
  existing moment names, and skip only for the first.

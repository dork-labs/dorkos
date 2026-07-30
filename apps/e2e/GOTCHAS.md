# Browser Test Gotchas

Anti-patterns and hard-won lessons discovered during test creation. Read this before writing any new test.

## Selectors

- Avoid `getByText()` on dynamic content that changes between runs (timestamps, session IDs, message previews)
- Sidebar session items re-render on SSE updates; grab locators fresh after any navigation that triggers a sync

## Timing & Waits

- SSE streaming indicators have three states (`streaming`, `waiting`, `complete`) — always wait for the full lifecycle, not just `visible`
- `toHaveURL()` assertions can race with client-side router updates; pair with a visible-element wait on the target page

## Navigation & State

- Creating a new session via the UI changes the `?session=` URL param; tests that check session count must re-query after URL stabilizes
- Settings dialog is a modal overlay — it does not change the URL, so `toHaveURL` won't help; use `waitFor({ state: 'visible' })` on the dialog locator

## Dynamic Content

- Assistant messages stream in token-by-token; never assert exact text content mid-stream — wait for the inference indicator to reach `hidden` first
- Optimistic UI updates (e.g., message appears before server confirms) can cause stale element handles; re-locate after any mutation
- A tool call that is already `complete` on the frame its part first mounts is never put in the DOM at all — auto-hide drops it, rather than hiding it with CSS. The mock scenarios are zero-latency and `turn_end` remounts the part as complete, so a tool-call assertion is racing a 0ms turn and will eventually lose. Turn the preference off for that test: `page.addInitScript(() => localStorage.setItem('dorkos-auto-hide-tool-calls', 'false'))`, before `goto`.

## Known coverage gaps

Worth knowing before you assume a behaviour is tested.

- **Auto-hide of completed tool calls has no browser coverage.** `chat-mock.spec.ts` switches the preference OFF to assert the card renders, and nothing asserts what it does when it is ON — which is the shipped default, so the default path is the untested one.
- **Relay's Mode A empty state has no coverage.** DorkOS registers a built-in `claude-code` adapter, so a running server always has one connection and always renders the tabs. Reaching the "Connect your agents to the world" state needs a server with that adapter removed.
- **Creating a session from the roster has no coverage.** The old spec drove a "New session" control that no longer exists; session creation is exercised only against `TestModeRuntime` in `chat-mock.spec.ts`.
- **Discovery scanning has no coverage.** `tests/mesh/mesh-panel.spec.ts` had two tests for it — a scan-roots input and a Scan button that enabled once roots were typed — against a Mesh dialog that no longer exists. Its replacement, `tests/agents/agents-page.spec.ts`, covers the fleet page's four views and dropped those two (8 tests became 5). Scanning did not go away with the dialog: it is the **"Bring in existing projects"** quick action in the command palette, which nothing tests.

## Known flakes

These are tracked, not mysteries. If you hit one, you have found the known
thing — go to the ticket rather than re-diagnosing it. Neither is a test bug, so
neither is fixed here.

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
- that a palette's **first** row is anything in particular — another spec's unread room may be above yours;
- that pressing Enter on an unfiltered list opens _your_ thing — filter to your own run id first.

That last one is not hypothetical: `rooms-in-palette` pressed Enter on the untyped palette's first unread row, which on a busy suite was a _neighbour's_ room — and arriving at a room marks it read, so it silently cleared another spec's unread badge and made that spec fail about half the time. It looked like a product bug for a while (DOR-692, since closed as an artefact).

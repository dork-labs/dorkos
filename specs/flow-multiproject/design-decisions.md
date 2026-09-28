# Design decisions

Every decision this spec builds on. The operator made the visual ones in a visual-companion session on 2026-09-28; the mockups are in [`design/`](design/) (visual-companion fragments, open them in a browser as they are). The orchestrator made the non-visual ones (the operator's standing rule: visuals go to the operator, everything else is decided). The agreed experience these refine is [`converged-design.md`](converged-design.md), the result of a four-round adversarial design debate. The operator removed its "Private" feature, Presenting mode and the "yours or a client's?" setup question on 2026-09-28.

The operator's steer for this work: **"Feel free to improve and/or extend the extensions API if you need to in order to achieve the absolute best results. We want to offer an absolutely world class experience."** So every capability flow needs becomes a general, documented extension-API seam, never a flow-specific hook in core.

This file is named `design-decisions.md`, not `04-*`, on purpose: a `04-*` file auto-promotes a spec's status to "implemented".

## Visual decisions (operator, 2026-09-28)

### V1. An extension waiting for run approval asks in the Activity inbox (DOR-2517)

Screens: `design/ext-approval-card.html` (A: full card, B: short row plus dialog), then `design/ext-approval-card-v2.html`. **Chosen: v2 option A.** The operator asked for something between the two: a short row with thumbs up, thumbs down and a way to get more info, because icon buttons take less space.

- One short row in the bell list: an icon tile, the title "Flow wants to run", and a mono source line "flow plugin · dork-labs/marketplace".
- Three icon buttons on the right, 26px square, outlined: **ⓘ** (accessible name "More about this"), **👎** ("Not now"), **👍** ("Allow it to run"). Each has a tooltip with its name. They are real icons from the house icon set (lucide `Info`, `ThumbsDown`, `ThumbsUp`), not emoji.
- **ⓘ expands the row in place.** It grows downward into a muted box with ExtensionCard's existing consent copy (the server-half or page-only variant, whichever applies), one line on what it adds when the manifest says so ("It adds a Flow tab and a Flow settings page"), and the link "See it in Settings → Extensions". ⓘ shows as pressed while open. It works the same on a phone. Option B (a popover beside the row) was rejected.
- **After an answer** the row moves to "Earlier" as history: "You allowed Flow to run · 2:14pm · Flow tab added", or "Flow isn't allowed yet · 2:14pm · Allow it" (the link allows it from there).
- **👎 is never destructive.** The extension stays installed; Settings → Extensions and the history row can still allow it.

### V2. Flow's items in the inbox, across projects

Screen: `design/inbox-flow-decisions.html`. **Chosen: A**, a small project heading over each project's items.

- Every flow decision uses the V1 row. **Yes/no decisions** get ⓘ 👎 👍 (a review gate: 👍 "Looks good", 👎 "Needs changes", which asks for a short note and sends the work back; it never closes anything). **Other decisions** get one short word button ("Answer", "Reconnect").
- Under "Needs you", items group under a small project heading: the project name on the left, its tracker ("Linear DOR") muted on the right. **With only one project present, the heading hides.**
- An escalated condition says how long it waited: "Can't reach it since 09:14 · asked after 1h".
- History shows "resolved on its own": "Linear came back for dorkos · Resolved on its own at 11:02".
- One live row per project and condition. A flapping condition never makes duplicates.
- Non-flow items (tool approvals, messages, schedule cards) keep today's look.

### V3. The Flow tab in the right panel

Screen: `design/flow-tab-lenses.html`. **Chosen: A**, one scroll.

- **Project lens** (the chat is in a flow project). Header: project name (bold), "· Linear DOR" muted, then **Pause** and **⚙** buttons. Then, in one scrolling column: condition lines ("Can't reach Linear since 09:14 · Reconnect"), "Running · 2 of 3" with one row per run (account dot, item id and title, neutral state pill "Building" / "Needs you" / "In review" / "Handing off" / "Parked"), "Up next" with the first few queued items numbered and "+ 5 more". Footer: "2 need you elsewhere →" on the left (only when it applies), "Open in Linear ↗" on the right. Option B (inner Running | Up next tabs) was rejected.
- **All-projects lens** (the chat is in no project, or a folder without flow). Header "All projects". Only projects with a decision or a condition, one line each ("**dorkos** · 2 need you", "**blintz** · Can't reach Linear"), then "2 other projects are fine", then "Open Flow home →". It is not a copy of the home.
- **"Set up flow here"**: one quiet muted line in the all-projects lens when the chat's folder is a repo with no flow install. Never a banner.
- **Tab label marker:** a small amber dot after the "Flow" label, only when a decision is waiting or every project is paused. No count.
- **Accounts leave the Flow tab.** They live on the account chip and in Settings, where they already are (the operator saw this called out and did not object).
- No engine words anywhere ("Building", never "EXECUTE"; "Nothing ready to work on", never "starved").

### V4. Flow home (`/flow`)

Screen: `design/flow-home.html`. **Chosen: A**, a calm list in three bands, **plus a project filter** (operator addition).

- Page title "Flow"; top right **"Pause all projects ▾"**; tabs **Projects** (default) | **Capacity this week**.
- Three bands: **"Needs you · 3"** (one row per decision: project name in a fixed-width column, the decision, and its V1/V2 buttons, acting in place), **"Something's off · 1"** (one line per project with a live condition, with its one action, e.g. Resume), **"All fine · 2"** (one muted line per quiet project: "2 running · 4 up next", "Nothing ready to work on").
- **Project filter** (operator addition): an "All projects ▾" control at the top of the page. Picking one project filters all three bands to it. The choice lives in the page URL (`?project=<name>`) so it can be bookmarked and shared between tabs. Option B (cards) was rejected.
- Clicking a project opens its project lens as a full page.
- **Pause menu** (every pause, here and in the lens): "Until tomorrow 9am" (first, the default for Pause all), "For 1 hour", "Until I resume". While paused the button reads "Paused until 9:00" with **Resume** beside it.
- Exists only at 2+ projects; at 1 project the page shows that project's lens, so links never 404.

### V5. The run chip

Screens: `design/run-chip.html`, then `design/run-chip-v2.html`. **Chosen: B, in the status bar at the bottom**, beside the runtime and account chips (not the chat header).

- **One item:** "DOR-2387 · Building". Click: the item in the tracker and the project lens.
- **Several items** (a chat handing items to helpers, e.g. a drain orchestrator): "3 items · 1 needs you ▴", showing the count and the most urgent state. Click opens a list upward: one row per item with its state pill, then "Open dorkos in Flow →".
- States: Building, Needs you, In review, Parked, "Last update 2h ago" (quiet, or its data is stale; the time is muted), "Merged · closed" (one item) / "Done" (all of several).
- Phone: the id (or "3 items") and the state only; the title is dropped.
- Present facts only; it never forecasts.
- This came from an operator question: can one chat work on several items at once? Yes, and today's core link (`flow-run-link.ts`) keeps only the newest record per session and hides the rest. That is a bug this work fixes (N9).

### V6. Flow settings, the three tiers

Screen: `design/settings-tiers.html`. **Chosen: both A and B** (operator: "could we have both? They could use the exact same components, the only difference is that in the Settings section there's a project switcher"). The orchestrator agreed.

- **One component, two entry points.** The per-project settings page (opened from ⚙ in the lens and from Flow home) shows it for one project. **Settings → Flow** shows the same component with a project switcher on top, which **defaults to the current chat's project**, and the heading always names the project being edited ("Editing dorkos").
- Two labelled boxes, each with a small "who it affects" pill:
  - **"Shared with the repo"** ("everyone on this repo"): tracker and team, the review policy, schedules, labels. A mono note: "Saving changes .agents/flow/config.json in this repo." (the real path as flow resolves it, from `scripts/config-names.ts`; the mockup showed `.dork/flow/`). Schedules show read-only here with a link to Tasks, since they are DorkOS tasks.
  - **"Just me"** ("only this computer"): how much it does on its own, at most at once, the pause default, and **"Accounts this project may use"**: one checkbox per account (dot and name). An account restricted to other projects shows why ("· only for client-app") and checking it asks first.
- **This computer** (the account pool, the reserve, handoff mode) stays where it is today: Settings → Runtimes and the existing account roles in Settings → Flow.
- Settings → Runtimes shows a restriction on the account's own row: "Only for client-app".

## Non-visual decisions (orchestrator, 2026-09-28)

### N1. Everything flow needs becomes a general extension-API seam

Flow is the first user of each seam, never a special case. Each seam gets TSDoc, a docs page section (`docs/` extension authoring), an entry in the hello-world or a test fixture extension, and a conformance-style test in core. The seams:

| Seam            | Side   | Shape (final names are the spec's call)                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tab marker      | client | `api.setTabMarker(tabId, 'attention' \| null)`. Core draws the dot; an extension cannot style it. Its accessible name joins the tab's ("Flow, something needs you"). Generalises the two-entry `TabUnreadDot` table.                                                                                                                                                                                                                 |
| Project context | client | `ExtensionReadableState.currentProject: { root: string; name: string } \| null`, resolved by core (N4), subscribable like `currentCwd`.                                                                                                                                                                                                                                                                                              |
| Pages           | client | `api.registerPage(path, component, { title, icon })` mounts a full page at **`/x/<extensionId>/<path>`** (the flow home is `/x/flow`). The `x/` prefix means no core route can ever collide. Pages are listed in the command palette and in the phone menu under "Add-ons". `api.navigate` accepts them. No sidebar entry (no new app chrome for a plugin).                                                                          |
| Status bar      | client | A new `status-bar` slot, session-aware (the component receives the session id and cwd). Follows the status bar's existing item pattern. Flow's run chip is its first user.                                                                                                                                                                                                                                                           |
| Decisions       | server | `ctx.inbox.raise({ key, title, detail?, project?, actions })`, `ctx.inbox.resolve(key, { outcome })`, and an action handler. `key` is namespaced by core to the extension. Actions are `approve`/`reject` (drawn as 👍/👎) or one `word` action. Core owns persistence, keyed dedupe, "resolved on its own" history, grouping, the bell count, push and the phone. The extension owns _when_ to raise (its conditions' time limits). |
| Projects        | server | `ctx.projects.resolve(cwd)` and `ctx.projects.list()` from core's project registry (N4).                                                                                                                                                                                                                                                                                                                                             |

### N2. Inbox storage and kinds

- Two new **standing** notification kinds: `extension.approval` (DOR-2517) and `extension.decision` (N1). Standing, like `ask.pending`: the live source of truth is a store, and the `notifications` table gets exactly one history row at resolution, with its outcome.
- `extension.decision` is backed by a new table `extension_decisions` (extension id, namespaced key, project root, title, detail, actions JSON, raisedAt, resolvedAt, outcome). Its unique key is (extension id, key) among open rows, which is the dedupe.
- Outcomes: `approved`, `rejected`, `answered`, `cleared` (resolved on its own), `dismissed` (DOR-2517's "Not now"). History copy for `cleared` is "Resolved on its own at 11:02".
- Tier: `extension.decision` is **blocking** (it pushes to the phone through the existing escalation ladder). `extension.approval` is **notable**: it counts in "Needs you" and badges the bell, but it never pushes to a phone, since nobody should approve code from a lock screen.
- **Grouping** (V2) is presentation in `features/inbox`: rows that carry a project group under its heading when two or more projects are present. It applies to every kind that knows its project, including tool approvals (their `requestingCwd` resolves to a project), so the inbox reads the same for everything.

### N3. DOR-2517 lifecycle

- The live source is the extension manager: every discovered, non-core extension that is not approved to run and not dismissed for its current source.
- **Raised** when a plugin install or update brings a new extension, when an extension's source changes (dropping source-bound approval), and for extensions that are enabled but were never approved (today's `flow` state on the operator's machine before they clicked Allow).
- **Not raised** for an update from the same approved source.
- **👍** calls the existing `POST /api/extensions/:id/approve` (same person-only bar). The extension activates live through the existing `extension_reloaded` broadcast; its tab appears with no reload.
- **👎 ("Not now")** records a dismissal bound to the current source and version. It does not re-ask until the source or version changes. Nothing is uninstalled or disabled (DOR-1398's lesson: a decline must never be destructive).
- DOR-2517 ships first, on its own, once V1 is built: it is small, High, and needs only the `extension.approval` kind and the V1 row.

### N4. A core project registry

- **A project is the git main checkout that contains a flow install.** More generally for core: the main checkout of a cwd, which is the parent of `git rev-parse --path-format=absolute --git-common-dir`. Worktrees (including `~/.dork/workspaces/*`) and subfolders map to it. A folder that is not inside one repo is "no project".
- Core gets one shared, cached helper `resolveProjectRoot(cwd)` in the server (today the pattern is duplicated in `flow-run-link.ts` and a test-only `worktree-scan.ts` helper). Every caller moves to it.
- The registry of known projects is the set of project roots core has seen as session, agent or workspace cwds, plus any root an extension reports through `ctx.projects`. Flow's own install discovery (`discoverCheckouts`) keeps working and feeds it.

### N5. Extensions across many projects

- Today `ExtensionDiscovery.discover()` scans one cwd, so only one project's plugin-carried extensions are visible. With flow installed in four repos, the copy that loads depends on the server's cwd.
- **Change:** discovery also scans the plugin-carried extensions of every known project (N4). Copies of one extension id from the **same approved source** collapse to one: the highest version wins ("newest install wins"). Copies from different sources keep today's precedence rules and warning, and approval stays source-bound.
- The loaded extension serves every project; a per-project difference in behaviour is the extension's to report (flow shows "runs an older flow, update" only when the difference changes behaviour).

### N6. Account eligibility is core-enforced

- Stored in `~/.dork/config.json` (machine-local, never committed), with a semver-keyed migration per `contributing/configuration.md`:
  - `runtimes.claudeCode.accounts[].onlyProjects: string[] | null` (null = any project). Set from Settings → Runtimes ("Only for client-app").
  - `runtimes.claudeCode.projectAccounts: Record<projectRoot, { allow: string[] }>`: the V6 per-project checkboxes. No entry = every account the account-side rule allows.
  - Main (this computer's sign-in, id `default`) takes part like any account.
- **An account may serve a project only if both rules allow it.**
- **Enforced at every automatic pick site:** the launch ladder `resolveLaunchAccountRoot` (gains a cwd), `checkAccountLaunch` and `rankAccounts` (the advisor may only rank eligible accounts; core filters its answer), carry-over and "continue on another account", the automatic handoff timer, schedules and tasks (direct and over relay), relay dispatch and the `session_start` MCP tool.
- When no account is eligible, the launch is refused with a plain message naming the project and pointing to its settings. It never falls back to an ineligible account.
- Flow's existing "Kept out · Only for these repos" chips in Settings → Flow move to core (`onlyProjects`) with a one-time migration of `fleet.json`; flow's tab then shows core's rule and links to it. "Kept out" itself stays flow's role (flow never uses the account anywhere).

### N7. Conditions and escalation live in the extension

- Flow owns its conditions (paused, tracker unreachable, nothing ready) and each one's time limit, and raises one decision per project and condition only after that limit. It resolves the decision with `cleared` when the condition clears.
- Starting limits (tuned later by use): tracker unreachable escalates after **1 hour**; "nothing ready" escalates only when a project with free capacity has been idle for **24 hours and** has untriaged items ("12 ideas are waiting in dorkos. Triage now?"); paused never escalates (it has an end time).
- Every pause has a duration (V4's menu); the pause stores its end time.

### N8. Flow home route and nav

- The home is extension page `/x/flow` (N1). At one project it renders that project's lens. `/x/flow/p/<name>` is a project lens as a page (the phone's lens, and the target of "clicking a project").
- The phone has no right panel. There, the home is the project list and a project opens its lens page; at one project the lens is the page.

### N9. One chat, many items

- Core's `flow-run-link.ts` keeps every run record for a session (a list), not only the newest. `Session` gains a list of tracker items. The run chip (V5) and any other reader take the list.

### N10. Decisions settled by the design, restated for implementers

- No new app-chrome indicator for a plugin; the marker sits on the tab's own label.
- The Flow tab is absent at 0 installs and always present, in the same position, from the first install on.
- Usage emergencies need no human pause: the account pool hands off and keeps the reserve by itself.

## Out of scope

- **The account pool is already core** (`runtimes.claudeCode.accounts[]`, the usage store, the advisor). Nothing moves; N6 only adds eligibility.
- The "Capacity this week" tab's detailed design (it is secondary and never the default); the spec gives it a minimal first version.
- Exact condition time limits beyond the starting values in N7.

## Round 2: every ask from the person's side, and a path to full autonomy (operator, 2026-09-28)

The operator reviewed the screens and asked for a rework "centered around what's going to be easiest for the user" ("channel Steve Jobs and Jony Ive"), with a firm rule: **"all of this should be optional and there should be some path to make everything fully autonomous."** Screens: `design/start-chat-and-helpers.html` (superseded in part, see V7) and `design/rework-asks.html`.

### V7. "Start a chat here" is an outcome button, not a drafted command

- Screen 7's question 1 (open a chat with the command typed in vs a confirm box) is **superseded**. The operator's objection: a person who just installed a plugin doesn't know what `/flow:triage` means, and neither option said why.
- A button names the outcome ("Sort them", "Set up flow here"). One click starts the work in a **new chat** (never the current one, whose unsent text stays with it). The inbox row becomes "Sorting 12 ideas… · Watch". There is no command on screen and no second confirmation: the click is the yes.
- The new chat's title is plain words ("Sorting 12 new ideas in dorkos"), and its first line says who started it and why ("Started by Flow: 12 new ideas were waiting to be sorted").
- Screen 7's question 2 (an item worked on in its own chat): one list, with "Open its chat" on items that run in their own chat. Subagents inside a chat need nothing new. The word "helper" is dropped from every surface and the spec ("its own chat").

### V8. The words on every ask

Three rules for every ask, on every surface (inbox, Flow tab, Flow home):

1. **Say what will happen and why, in plain words. Never a command, a stage name or an item id as the headline.** Titles are questions or outcomes: "Turn on Flow?", "Ship the new out-of-usage banner?", "Should the old API keep working?", "12 new ideas haven't been sorted", "Sign in to Linear again".
2. **Anything that asks must say why.** A second line under every title: what happens, why now, what a "no" means. "It's built, tests pass, and the reviewer agent found nothing. Shipping merges it into the app."
3. **Every ask offers a way to never ask again.**

- **Buttons read as outcomes:** 👍 "Ship it" / 👎 "Send it back"; 👍 "Turn it on" / 👎 "Not now"; word buttons "Sort them", "Sign in".
- **A question carries the agent's own pick and a deadline:** "If you don't answer by 5pm, it keeps it (the safer choice)." The choices are chips, with the agent's pick marked "agent's pick", plus "Reply…". Silence means the agent goes ahead with its pick at the deadline. A person is never the bottleneck.
- **A condition reaches a person only when only a person can fix it.** "Sign in to Linear again" appears only when the sign-in is really gone. A blip retries quietly and never reaches the inbox.

### V9. "Do this on its own next time" (Pick 1: A)

- After a person answers, **once**, a green line under the row offers it: "Shipped. Next time, ship on its own when the reviewer agent approves? [Yes]". It shows at the moment it makes sense, then goes away. Option B (an "Always" button on every row) was rejected: one more button everywhere, and easy to click by accident.
- Saying yes moves that project's autonomy setting (V10) for that kind of ask. For an extension approval it offers "Next time, trust everything from dork-labs?" (a trusted source, N11).

### V10. One autonomy dial per project (Pick 2: A)

- In the project's "Just me" settings box: one dial with three stops, **Ask me first | Tell me after | Just do it**, a table under it saying what each stop means, and **"Customize…"**, which opens per-kind switches (option B's layout) for people who want them.

| Kind of ask            | Ask me first  | Tell me after                            | Just do it                          |
| ---------------------- | ------------- | ---------------------------------------- | ----------------------------------- |
| Ship finished work     | asks you      | the reviewer agent approves, you're told | the reviewer agent approves         |
| Agent questions        | waits for you | the agent picks at the deadline          | the agent picks and writes down why |
| Sort new ideas         | asks you      | daily, you're told                       | daily                               |
| Retry and fix problems | asks you      | on its own, you're told                  | on its own                          |

- "Tell me after" and "Just do it" produce a quiet **"While you were away"** summary in Activity (history rows, not asks).
- Default stop: **Tell me after** (the operator's goal is autonomy; DorkOS's "full power" default is consent-led and on).

## N11. The autonomy model (orchestrator, 2026-09-28)

- **Every ask has a "who answers" setting: you, an agent or rule you trust, or nobody with a safe default at a deadline.** The check never disappears; it is delegated. That is the path to full autonomy that keeps safety.
- **Only three asks can never be fully automated, because only a person can do them:** signing in to an outside service (made rare: tokens refresh on their own and a person is asked only when the sign-in is gone), spending past a limit the person set, and trusting code from a source not yet trusted (once per source: `extensions.trustedSources` in core config; an extension from a trusted source runs without an `extension.approval` row).
- **Flow's "always ask" floor** (`calibration.alwaysAsk`, "inviolable", charter G12) changes meaning from "a human must answer" to **"someone must check"**: at "Just do it" its triggers go to the reviewer agent, never to nobody. The floor keeps `.min(1)`. This is a flow charter change the flow spec records.
- **Every agent- or extension-initiated ask must justify itself.** `DecisionInput.why` is **required** (plain text, at most 300 characters). A decision without it is refused. Questions carry `defaultChoice` and `decideBy`.
- **Starting work is a seam, not a drafted command** (N12).
- This sits one level above DorkOS's existing "full power" permission mode (spec `full-power-defaults`): that covers the tool-approval gate inside a chat; this covers flow's decisions across projects. The two stay separate, and copy keeps the attended/unattended split from that work ("still asks when it matters").

## N12. Starting work from an extension

- Server `ctx.sessions.start({ project, prompt, title, reason })` starts a new chat in a project, runs the prompt at once, and records its origin (`startedBy: { extensionId, reason }`), which the chat shows as its first line. Client `api.startWork(...)` does the same from a button, and returns the new session id so the row can say "Watch".
- The prompt is never shown as the headline. The chat's title is `title`.
- It uses the project's account eligibility (N6) like any launch.
- Records `startedBy` for session-started chats too (`session_start`), which is the "who started this chat" link the "Open its chat" rows use.

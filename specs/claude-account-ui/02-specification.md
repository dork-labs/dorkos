---
slug: claude-account-ui
id: 260926-152113
created: 2026-09-26
status: specified
tracker: DOR-2387, DOR-2388, plus the UI parts of DOR-2379 (color, settings) and DOR-2382 (the limited state)
project: Flow CLI & Account Fleet
ideation: specs/claude-account-ui/01-ideation.md; dork-labs/marketplace specs/flow-fleet/01-ideation.md §6.8-6.9 and 04-design-decisions.md
design: specs/claude-account-ui/04-design-decisions.md (binding) and design/*.html
server: specs/claude-account-fleet/02-specification.md (S4, merged in #2146)
contracts: dork-labs/marketplace specs/flow-cli-core/02-specification.md §1 (CONTRACT_VERSION 1.0.0, main at c9bfe19)
---

# Claude account UI: see which account a session spends, and move work off a spent one

**Status:** Specified. The visual design is the operator's (visual companion, 2026-09-26; `04-design-decisions.md`), with the banner placement and its states decided by the orchestrator on the operator's behalf. Technical choices below are made under the autonomy grant and logged in §15. Visual questions the decided designs do not answer are in §14 and are **not** decided here.

**Scope:** the DorkOS client (core UI), two small server additions the UI needs (§7), and the Flow extension that ships inside the flow plugin in `dork-labs/marketplace` (§8).

## 1. Overview

S4 (`specs/claude-account-fleet/`) teaches the server about accounts: a color per account, usage per account, a `limit` on a session that hit a hard limit, and the tracker item a flow run serves. This spec shows all of it:

- **Where you work** (decision 1, option C): a status-bar account chip with a color dot, the name and two tiny usage bars; a popover with each window, reset times, the tracker item and "Continue on another account →"; a color dot on each sidebar session row; a name badge in the session header.
- **Settings** (decision 2, option A): Settings → Runtimes → Claude accounts gains each account's color and live 5-hour and weekly bars, plus a one-line pointer to a new **Flow** tab. The Flow tab (added by the Flow extension) sets each account's role, the main account's reserve, repo scopes and the handoff mode.
- **When an account runs out** (decision 3): a banner above the message box that walks through limited, waiting, reset and moved, and collapses into a one-line transcript marker when resolved; and the "Continue on another account" picker.

All of it appears **only when 2 or more Claude Code accounts are registered**. With one account the UI is exactly what it is today.

## 2. What this builds on, and who owns what

| Need                                                                                              | Comes from                      | Status     |
| ------------------------------------------------------------------------------------------------- | ------------------------------- | ---------- |
| `color` + `colorIsDefault` on `GET /api/config` `claudeCode.accounts[]`; `DEFAULT_ACCOUNT_COLORS` | S4 task 1.3 (D1), 1.1           | specified  |
| `AccountUsage`, `GET /api/runtimes/claude-code/accounts/usage`, the `account_usage` event         | S4 task 2.1 (D2)                | specified  |
| `SessionStatus.limit`, `sessionDisplayState`, the uncategorised `rate_limit` error frame          | S4 tasks 1.2, 2.3 (D4)          | specified  |
| `Session.accountId`, `Session.status`, `Session.trackerItem`, envelope `accountUsage`             | S4 tasks 1.2, 2.4, 3.5 (D7, D8) | specified  |
| `dispatchSessionMessage` (the extracted launch path)                                              | S4 task 2.5                     | specified  |
| Extension context `dorkHome`, `claudeAccounts.{list, usage, onUsage, registerLaunchGuard}`        | S4 task 3.1 (X1-X3)             | specified  |
| `FLOW_FLEET_SETTINGS_TAB_ID = 'flow:fleet'`                                                       | S4 task 1.1                     | specified  |
| fleet.json reader/writer (`scripts/fleet/accounts.ts`, `scripts/atomic-json.ts`)                  | marketplace S1, on main         | **landed** |
| `rankAccounts` (eligibility and order for an item)                                                | marketplace S3 task 1.2         | specified  |
| `flow handoff <id> --to <acct>`                                                                   | marketplace S3 task 4.3         | specified  |

This spec adds, and owns:

- the account **palette values** (S4 left them provisional, §5);
- **X4, an account advisor** on the extension server API, and the continue routes that use it (§7.1);
- **limit episodes** (§7.2): the durable record behind the banner's states and the transcript marker, with wait, resume and model fallback; S4 said the client half needed nothing new; that held for the settings note, but the picker needs flow's policy and a flow-run handoff, and core must never read `fleet.json` (S4 §2), so the extension has to supply both;
- **discovery of extensions that ship inside an installed plugin** (§7.3). Without it the Flow extension installs but never runs (checked: `extension-discovery.ts` scans only `<dorkHome>/extensions/` and `<cwd>/.dork/extensions/`, and `install-plugin.ts` then calls `enable()` on an id discovery never saw, which returns `null`).

**Linear.** DOR-2387 = §6.1-6.4. DOR-2388 = §6.6, §7.1, §8.4. DOR-2379's UI part = §6.5 color and bars. DOR-2382's UI part = §6.7 and §7.2. DOR-2379 is already Done (its core part moved into S4); its UI part rides DOR-2387's tasks.

## 3. Goals and non-goals

**Goals**

- A person with 2+ accounts can tell, without opening anything, which account every Claude Code session spends and how close each is to a limit.
- Near a limit and out of usage are said in words, never by color alone.
- One click from a session moves its work to another account in the same folder; for a flow run, flow does the move so its records stay right.
- The operator sets how flow spends each account in Settings → Flow, and the flow CLI reads the same file.
- One account: nothing new renders, no new request is made on the hot path.

**Non-goals**

- Any server change S4 already specifies.
- Automatic handoff, ranking or checkpoints (flow S3). This UI shows them and triggers `flow handoff`; it does not reimplement them.
- A probe button, an Accounts/Fleet page (ideation §6.8's "Fleet view"), or a usage history. Not in the decided designs.
- Codex or OpenCode accounts.
- Moving a live chat between accounts (impossible by design; "continue" starts a new session).

## 4. Invariants (each needs its evidence in tests)

1. **One account renders exactly today's UI.** No chip, dot, badge, bar, note, banner, marker or picker; no `account_usage` subscription effect on render. _Evidence:_ each surface's test renders it with 0, 1 and 2 accounts and asserts absence at 0 and 1 (RTL `queryBy*` is null) and presence at 2.
2. **Color is never the only signal.** Every dot has the account name as its accessible name and tooltip; the chip and header badge always print the name; amber and red states print what happened. _Evidence:_ RTL queries by role and name, never by class; an axe pass on each showcase.
3. **Unknown is never zero** (S4 invariant 4). A window with no reading renders as unknown (§6.0 "Unknown"), is announced as "unknown", and is never drawn as an empty 0% bar. _Evidence:_ bar tests with `usedPct: null` and with the window absent.
4. **Core never reads `fleet.json`.** Policy reaches core only through the X4 advisor. _Evidence:_ a guard test (`apps/server/src/services/runtimes/claude-code/accounts/__tests__/no-fleet-policy-read.test.ts`) fails if a non-test `.ts`/`.tsx` file under `apps/server/src`, `apps/client/src` or `packages/shared/src` contains the string literal `'fleet.json'` or `"fleet.json"` (comments and the vendored conformance fixtures are not code and are skipped).
5. **A flow run is only moved by flow.** When the advisor says it manages a session, "Continue" goes through `flow handoff`, and a failure there is shown, never retried as a core launch (two writers in one worktree). _Evidence:_ route test with a managed session whose `continueSession` throws: no core dispatch happens.
6. **A person's pick is not policed by flow's launch guards** (S4 X3). The core continue path passes no guard. Policy only shapes what the picker offers (§6.6). _Evidence:_ continue-route test with a registered guard that denies everything still launches a non-managed session.

## 5. Account identity: palette and helpers

**The palette** (replaces S4's provisional `DEFAULT_ACCOUNT_COLORS` values; 8 entries, order is the default-by-position order):

| #   | Name   | Hex       | Min contrast on any app surface |
| --- | ------ | --------- | ------------------------------- |
| 1   | blue   | `#2f7be0` | 3.41                            |
| 2   | green  | `#1d8a4a` | 3.45                            |
| 3   | amber  | `#c2680a` | 3.25                            |
| 4   | purple | `#9b51e0` | 3.35                            |
| 5   | pink   | `#d6336c` | 3.28                            |
| 6   | teal   | `#0d9488` | 3.06                            |
| 7   | indigo | `#6366f1` | 3.39                            |
| 8   | stone  | `#78716c` | 3.15                            |

"Min contrast" is the WCAG ratio against the worst of the six surfaces a dot sits on: light `#ffffff`, `#fafafa` (background), `#e8e8e8` (sidebar); dark `#0a0a0a`, `#1a1a1a` (sidebar), `#262626` (hover/muted). All pass the 3:1 non-text rule in both themes, so one hex per account works in both (the contract stores one value). The first four follow the order of the decided mockups (blue, green, amber, purple). No red: red means "out" in this UI.

- Dots and badges only, never a large fill (design decision 1). The one literal-color use is the dot's `background-color` from the account's hex, set through a CSS variable (`--account-color`) the way `identity-avatar.tsx` does, with a comment naming this exception.
- A color stored by hand that is not in the palette still renders (the contract accepts any `#rrggbb`).
- A test in `packages/shared` recomputes the table's ratios from the hex values and fails if any drops below 3.0.

**Client helpers** (`apps/client/src/layers/shared/lib/claude-accounts.ts`, pure, tested):

- `accountWindow(usage, key)`: the `AccountUsage.windows` entry for `five_hour` or `seven_day`, or `null`.
- `barTone(window)`: `'unknown'` when `window` is null or `usedPct` is null and `status` is not `rejected`; `'error'` when `status === 'rejected'` or `usedPct >= 100`; `'warning'` when `usedPct >= 70`; else `'success'`. (70 is where both decided mockups turn a bar amber: 72% amber, 40% green. The chip's own amber rule is separate, below.)
- `chipState(usage, limit)`: `'out'` when the session's `limit` is active (see `isLimitActive`) or `usage.state === 'limited'`; `'near'` when `usage.state === 'warning'` (S4: any window `usedPct >= 90` or `allowed_warning`); `'unknown'` when `usage` is absent or `state === 'unknown'`; else `'ok'`.
- `isLimitActive(limit, now)`: `limit !== null && (limit.resetsAt === null || now < Date.parse(limit.resetsAt))`.
- `nearestWindow(usage)`: for the `near` text, the readable window with the highest `usedPct` (ties: `five_hour` first).
- `formatResetTime(iso, now, locale?)`: local time. Same day → `2:10pm`; within the next 6 days → `Sun 9am`; later → `Oct 3`. Minutes are dropped when `:00`. `null` → `null`.
- `formatResetDay(iso, now)`: the weekday (`Sun`), or the time (`3pm`) when it is today; `null` → `null`.
- `formatBackIn(ms)`: under 60 min → `47 min`; under 24 h → `1h 12m` (`2h` when minutes are 0). Never used for 24 h or more.
- `limitText(windowKind, resetsAt, now)`: the §6.7 wording rule in one place: `five_hour` with a reset under 24 h away → `back in <formatBackIn>`; otherwise `out until <formatResetTime>`; no reset → `out`.
- `windowShortName(key)`: `five_hour` → `5h`, `seven_day` → `week`, `seven_day_opus` → `week (Opus)`, `seven_day_sonnet` → `week (Sonnet)`, `model:<slug>` → `week (<Slug>)`, anything else → the server's `label`.
- `planName(subscriptionType)`: `'max'` → `Max plan`, `'pro'` → `Pro plan`, other non-null → capitalised + ` plan`, `null` → `null` (omitted).

## 6. The client (`apps/client/src`)

FSD placement follows today's split: session rows (`entities/session`) already read accounts through `shared/model/server-config/use-claude-accounts.ts`, because an entity may not import `entities/config`. Account data therefore lives in `shared/`.

### 6.0 Shared building blocks

**Data** (`layers/shared/model/server-config/`):

- `useClaudeAccounts()` gains `color` and `colorIsDefault` on each `accounts[]` entry (from S4 D1) and `colorFor(pathOrId): string | null`. `isMultiAccount` (`accounts.length > 1`, registered rows only; checked in `describeClaudeCodeAccounts`) stays **the one gate** every surface in this spec uses.
- New `useAccountUsage(): { byId: Map<string, AccountUsage>, byPath: Map<string, AccountUsage>, isLoading }`. Query key `accountKeys.usage()`, `queryFn: transport.getAccountUsage()`, `enabled: isMultiAccount`, `staleTime` 60 s. It is seeded from the session list envelope's `accountUsage` (S4 D7) by the session-list query's `onSuccess`-equivalent (`queryClient.setQueryData` merge, never replacing a newer record: compare `updatedAt`).
- New `useAccountUsageSync()`, mounted once in `AppShell.tsx` beside `use-config-sync`: `useEventSubscription('account_usage', (u) => upsert by accountId ?? path)`. Guarded by `isMultiAccount` so a one-account app does no work.
- `Transport` (`packages/shared/src/transport.ts`) gains `getAccountUsage(): Promise<{ accounts: AccountUsage[] }>` plus one method per route in §7.1 and §7.2 (`getAccountAdvisor`, `getContinueOptions`, `continueOnAccount`, `getAccountLimit`, `waitForAccountReset`, `resumeAfterAccountReset`, `continueOnFallbackModel`). `HttpTransport` (the one `Transport` implementation today, through a new `account-methods.ts` beside `session-methods.ts`) implements them; `createMockTransport` and `createPlaygroundTransport` get defaults.

**UI atoms** (`layers/shared/ui/`, each with `data-slot`, TSDoc, sizes per `components.md`):

- `AccountDot({ color, name, size = 'sm', className })`: an 8px (`sm`) or 10px (`md`) circle, `role="img"`, `aria-label={name}`, wrapped in the house `Tooltip` showing `name`. Background from `--account-color`.
- `UsageMiniBars({ fiveHour, week, className })`: two vertical 4×10px bars, 2px apart, bottom-filled to `usedPct`, fill by `barTone` through `bg-status-<tone>` tokens (`success`, `warning-dot`, `error`); track `bg-muted`. `role="img"` with `aria-label` "5-hour window 40% used, weekly 72% used" (unknown → "5-hour window usage unknown").
- `UsageBar({ window, label, showReset })`: the horizontal 6px bar of the popover and settings rows, with the label on the left and "40% · resets 2:10pm" on the right (`text-2xs`, `text-muted-foreground`). Same tones and the same accessible text.
- **Unknown** (a window with no reading): the track renders with no fill and a dashed outline instead of a solid track, and the text says "unknown". Whether the dashed outline is the right treatment is open design question Q6 (§14); until answered, implement it behind the one `barTone === 'unknown'` branch so a change is one place.

### 6.1 Status-bar account chip (decision 1, DOR-2387)

- **Where:** a new status-bar item `account`, directly after `runtime` in `STATUS_BAR_REGISTRY` (`features/status/model/status-bar-registry.ts`), cluster and group the same as `runtime`. `promote`: `runtime === 'claude-code' && isMultiAccount`. `severity`: above `usage` when `chipState` is `near` or `out`, else equal to `runtime`. Label "Account", description "Which Claude account this session spends, and how much is left."
- **Component:** `features/status/ui/AccountItem.tsx`, rendered by `buildStatusItemNodes` (`features/chat/ui/status/status-item-nodes.tsx`). Input: the session's account (`useResolvedSessionRuntime(sessionId).account`, with `Session.accountId` from S4 D7), its `AccountUsage` from `useAccountUsage`, and the session's `status.limit`.
- **States and text** (all from decision 1):

| `chipState` | Look                                           | Text                                                                                                                                                        |
| ----------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`        | neutral chip                                   | `● Acct 2` + `UsageMiniBars`                                                                                                                                |
| `unknown`   | neutral chip                                   | `● Acct 2` + unknown bars                                                                                                                                   |
| `near`      | `STATUS_TONE_SURFACE.warning` + warning border | `● Acct 3 · 91% of week` (`nearestWindow`, `windowShortName`)                                                                                               |
| `out`       | `STATUS_TONE_SURFACE.error` + error border     | 7-day or model window: `● Acct 4 · out until Tue 3pm`; 5-hour window: `● Acct 4 · back in 47 min` (the §6.7 wording rule); reset unknown → `● Acct 4 · out` |

The account name is the label (`nameFor`). `near` and `out` drop the bars and print words instead, as the mockup does.

- **Click → popover** (`features/status/ui/AccountPopover.tsx`, house `ResponsivePopover`):
  1. Header: dot + name (semibold), `planName` right-aligned in muted text (omitted when `null`).
  2. One `UsageBar` per readable window in S4's order (`five_hour`, `seven_day`, then the rest), labelled with the server's `label` ("5-hour window", "Weekly", …). The mockup's "5-hour" / "This week" wording is used for the two main windows: `five_hour` → "5-hour", `seven_day` → "This week"; others keep the server label.
  3. When `Session.trackerItem` is set: "Working on DOR-2353" (muted, `text-2xs`). The mockup's "· started on this account" clause is **not** rendered: see Q5.
  4. The action **"Continue on another account →"** (a `Button` `size="sm"`, primary as in the mockup). Opens the picker (§6.6). Hidden while the session has a live turn (`status.lifecycle` running): you cannot continue a session that is still working. Hidden before launch.
- **Before launch** (the account is still a hint, `pendingAccount`): the chip **is** the existing pre-launch account picker (`useAccountSwitch`), moved here from `RuntimeItem`'s dropdown and restyled to match. The account group is removed from `RuntimeItem`'s menu in the same change so the choice lives in one place; `RuntimeItem` keeps its runtime and model choices. How the restyled picker looks (trigger and menu rows) is open design question Q7.
- **Live updates:** the chip re-renders from the `account_usage` event and the session stream's `status_change` (`limit`), with no polling.

### 6.2 Sidebar session rows (decision 1)

- `entities/session/ui/AccountMark.tsx` becomes the account **dot**: `AccountDot` with the account's color and name (tooltip and `aria-label`), still `null` unless `isMultiAccount` and the session is Claude Code. Rendered by `SessionRowFull` and `SessionRowCompact`. Its position relative to the existing origin/runtime marks, and whether the row keeps printing the account name next to the dot, are open design question Q4; the default until answered is the design's reading: the dot leads the title and the name moves into the tooltip.
- **Out of usage:** when `sessionDisplayState(session.status) === 'limited'` and `isLimitActive`, the row gets `STATUS_TONE_SURFACE.error` as a soft tint and shows state text in its trailing position (where the relative time sits; the time is hidden while the text shows):
  - `out · handing off` when the advisor manages the session (`trackerItem` set and `GET …/accounts/advisor` reports `handoff: 'auto'`);
  - `out · waiting for reset` otherwise (handoff `ask`, or a session no flow run owns, since nothing will move it).
    The text is also added to the row's accessible name. `useSessionBorderState` gains a `limited` state whose label is "Out of usage" for the tooltip.

### 6.3 Session header badge (decision 1)

`widgets/one-bar/ui/SessionHeader.tsx` passes an account chip into `OneBar`'s `chips`, after the origin chip: a small outlined pill (`rounded-full`, `border`, `text-2xs`) with the dot and the account name. When the session is out (`chipState === 'out'`) the pill uses the error surface and reads `● Acct 4 · out` (the account-limit mockup's header). Same gate. `features/status` owns the pill component (`AccountBadge`); the widget composes it.

### 6.4 One source for "which account and how is it"

`features/status/model/use-session-account.ts#useSessionAccount(sessionId)` returns `{ visible, accountId, path, name, color, usage, limit, chipState, trackerItem }` and is the only place the chip, popover, header badge and notice compute it. The sidebar (an entity) computes the same from the row's own `Session` fields with the pure helpers of §5, so both agree by construction.

### 6.5 Settings → Runtimes → Claude accounts (decision 2, option A; DOR-2379 UI)

`features/settings/ui/runtimes/sections/ClaudeAccountsSection.tsx`, each `AccountRow`:

- A leading `AccountDot` (`md`) in the account's color. How the operator changes the color is open design question Q8 (the decided design says the color is chosen here but has no mockup of the control). Until decided, the dot is display-only and the row's color stays the default by position.
- Trailing `5h` and `wk` `UsageBar`s in the compact 110px form of the mockup (label left, bar right, no reset text; the reset time is in the bar's tooltip). Unknown per §6.0.
- The name, "in use" and the shortened path as today.
- **With 2+ accounts only** (with one account, the bars are not shown either: invariant 1 and the design's one-account rule).
- **The Flow note**, under the list, only when `isMultiAccount` **and** `useSlotContributions('settings.tabs')` contains `FLOW_FLEET_SETTINGS_TAB_ID`: "Flow uses these accounts for your work. Choose how in **Settings → Flow**." The bold part is a link-styled button calling `useSettingsDeepLink().setTab(FLOW_FLEET_SETTINGS_TAB_ID)` (the dialog is already open). Muted surface, `rounded-md`, as in the mockup.
- `toWritableAccounts` already sends `color` (S4 task 1.3). No other write change.

### 6.6 "Continue on another account" picker (decision 3, DOR-2388)

**Core UI; works without flow** (orchestrator decision, 2026-09-26). There is no flow-contributed UI slot: everything flow changes arrives as data from the server's account advisor (§7.1).

`features/continue-on-account/` (new feature slice): `ui/ContinueOnAccountDialog.tsx`, `model/use-continue-options.ts`, `model/use-continue-on-account.ts`.

- **Opened from:** the popover action (§6.1) and the banner's "Continue on another account…" and "Choose account…" (§6.7).
- **Data:** `GET /api/sessions/:id/continue-options` (§7.1): `{ advised, accounts[], recommendedAccountId, carryOver, … }`, the session's own account excluded.
- **Common content** (house `ResponsiveDialog`, max width 380px as the mockup):
  - Title "Continue on another account".
  - One option row per account: dot, name, and on the right "28% left · resets Sun" (100 − the weekly `usedPct`; the weekly reset as a day: `formatResetDay`, §5, which gives the weekday, or the time when it is today). Weekly unknown → "usage unknown". An account that is out (`state === 'limited'`) → "out until 3pm" or "back in 47 min" (the §6.7 wording rule), and its row is disabled.
  - Rows are a `radiogroup`; footer `Cancel` and a primary "Continue on <name>" naming the selected account.
  - "No other account can take this work right now." replaces the list when no row is selectable; the primary button is disabled.
- **Without flow** (`advised: false`: no advisor registered, or it gave no answer in time):
  - Subtitle (mockup v2): "Starts a new chat in the same folder, with a summary of this one. Sorted by most usage left."
  - Rows sorted by most weekly headroom (100 − `seven_day.usedPct`); unknown weekly usage after every known one; ties keep registry order. **No `recommended` badge, nothing hidden, nothing dimmed.** The first selectable row is selected on open.
  - Carry-over list (mockup v2): "Carries over: the folder and a summary of this chat" / "Doesn't: the chat itself".
- **With flow** (`advised: true`):
  - Rows in the advisor's order. `excluded` accounts are **not listed** (DOR-2388: a kept-out account is never offered outside its repos); one muted line under the list names them: "Client is kept out, so it isn't listed." (two or more: "Client and Acct 5 are kept out, so they aren't listed."). A `reserved` account is shown dimmed with its reason on the right, e.g. "kept in reserve (50%)" (whether it can still be chosen is Q2; default: not for a flow run, because `flow handoff` refuses it; yes otherwise).
  - A `recommended` badge (success tone, pill) on `recommendedAccountId`, which is selected on open.
  - Subtitle and carry-over list from `carryOver`: when it includes `checkpoint` and `task` (a flow run), mockup v2's "Picks up in the same folder and branch from flow's checkpoint." and "Carries over: files, branch, checkpoint, task" / "Doesn't: the chat itself"; otherwise the without-flow wording.
- **Continue:** `POST /api/sessions/:id/continue-on-account { account }` (§7.1). On `202 { sessionId }` the dialog closes and the app navigates to the new session. On an error the dialog stays open and shows the server's message inline (`role="alert"`); nothing is retried.

### 6.7 The out-of-usage banner and its transcript marker (decision 3: option A, decided)

**Decided** (the operator delegated the pick; orchestrator, 2026-09-26; mockup `design/account-limit-v2.html` option A): a banner above the message box. **When it resolves, the banner collapses into a one-line marker in the transcript at the point the turn stopped.** Core UI; works without flow. Option B (a card in the transcript) is not built.

**Components** (`features/continue-on-account/`): `ui/AccountLimitBanner.tsx`, `ui/AccountLimitMarker.tsx`, `model/use-account-limit.ts`. One banner component serves every state below: the same layout (bold first sentence, optional second sentence, a button row, an optional checkbox), different text and actions. That is the rule for every state the mockup does not draw.

**Where:**

- The banner mounts in `widgets/session/ui/ChatPanel.tsx` directly above `SessionComposer`, after `TurnFailedNotice`, and replaces `TurnFailedNotice` for a limited turn (one notice, not two). It is the house `Banner`, `variant="critical"` (the mockup's red) in every state, per the rule that the states the mockup does not draw keep the same banner; whether `waiting`, `reset-ready` and `moved` should drop to the neutral tone is Q13. `role="status"` (the turn's own error frame already announced the stop).
- The marker renders in place of the turn's `rate_limit` error part (`features/chat/ui/message/ErrorMessageBlock.tsx` gains a branch for `code === 'rate_limit'`, only when `isMultiAccount`): **nothing** while the banner for that episode is showing (mockup A draws nothing at the stop point), then one muted `text-2xs` line once the episode is resolved. With one account the part renders as S4's plain error card, as today (invariant 1).

**Data:** `useAccountLimit(sessionId)` reads `GET /api/sessions/:id/account-limit` (§7.2) and refetches on the `account_limit_changed` event for this session and on the session stream's `status_change`. The server computes the phase, so every open window agrees.

**States** (the server's `phase`, plus `allOut` and `kind`):

| State                 | When                                                                                                                                       | Banner (first sentence **bold**; then text; buttons in order)                                                                                                                                                                                                                                                                                                                                                                               | Composer                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| near-limit            | the account is `warning`                                                                                                                   | **No banner.** The amber chip only (§6.1).                                                                                                                                                                                                                                                                                                                                                                                                  | normal                                                                                                                     |
| `limited`             | the session's limit is active, no wait chosen, nothing moved                                                                               | **"Acct 4 is out of usage until Tue 3pm."** (7-day) or **"Acct 4 is out of usage · back in 47 min."** (5-hour). Without flow, or flow `ask`, or a session flow does not run: **Continue on another account…** (primary, opens §6.6), **Wait for reset**. Flow `auto` (`onLimited.mode === 'auto'`): + "Moving this task to ● Acct 2 in 10s…", counting down to `deadline`; **Move now** (primary), **Choose account…**, **Wait for reset**. | paused: "Paused until you continue or the account resets" (flow auto: "Paused until the task moves or the account resets") |
| `limited`, all out    | no other account is selectable (every other account out, or hidden by flow)                                                                | **"All accounts are out."** + "Soonest back: ● Acct 2, Sun 9am" (the earliest `resetsAt` among all accounts, this one included). Only **Wait for reset**.                                                                                                                                                                                                                                                                                   | paused                                                                                                                     |
| `limited`, model only | the limit's window is a model window (`seven_day_opus`, `seven_day_sonnet`, `model:*`) and neither `five_hour` nor `seven_day` is rejected | **"Opus is out on Acct 3 for this week."** + primary **Keep going on Sonnet, same account**, then **Continue on another account…**, **Wait for reset**. The model named is `modelFallback` (§7.2).                                                                                                                                                                                                                                          | paused                                                                                                                     |
| `waiting`             | the person chose Wait, or flow will wait itself (`onLimited` is `ask` and every other account is out)                                      | **"Waiting for Acct 4 · back in 1h 12m"** (under 24 h) or **"Waiting for Acct 4 · back Tue 3pm"**; a checkbox **"Continue automatically when it resets"** (default on with flow, off without; §7.2); **Continue on another account…** stays available as a secondary button.                                                                                                                                                                | paused                                                                                                                     |
| `reset-ready`         | `resetsAt` passed, auto-continue off                                                                                                       | **"Acct 4 has reset."** + primary **Continue** (sends the resume message in this chat, §7.2).                                                                                                                                                                                                                                                                                                                                               | normal                                                                                                                     |
| `moved`               | the work continued in another session (by the picker, Move now, the countdown, or flow's supervisor)                                       | **"This task continued on ● Acct 2."** + **Open it →** (primary link to the new session) and a quiet text button **Continue here anyway**.                                                                                                                                                                                                                                                                                                  | disabled by default; "Continue here anyway" re-enables it for this session in this window                                  |
| resolved              | a new turn started in this chat (after a reset, after a model switch, or after "Continue here anyway")                                     | **No banner.** The marker takes over.                                                                                                                                                                                                                                                                                                                                                                                                       | normal                                                                                                                     |

**Wording rule** (orchestrator): a 5-hour window says "back in 47 min" (a duration; "1h 12m" past an hour); a 7-day or model window says "out until Tue 3pm" (`formatResetTime`). The same rule drives the chip's out text (§6.1): `Acct 4 · back in 47 min` / `Acct 4 · out until Tue 3pm`. Helper `formatBackIn(ms)`: under 60 min → "47 min"; under 24 h → "1h 12m" ("2h" when minutes are 0); 24 h or more is never shown as a duration (the rule falls back to "until Tue 3pm"). Durations tick once a minute.

**Actions:**

- **Continue on another account…** / **Choose account…**: open §6.6.
- **Move now**: `POST …/continue-on-account { account: onLimited.toAccountId }`.
- **Countdown at zero**: the same call with `trigger: 'auto'` (idempotent per limit episode, §7.1). A page opened after the deadline shows "Moving this task to ● Acct 2…" and makes the same call.
- **Wait for reset**: `POST /api/sessions/:id/account-limit/wait { resumeOnReset }` with the checkbox's default; the checkbox then toggles the same field. In flow `auto` mode it also stops DorkOS's countdown (flow's own supervisor may still move the work: Q1).
- **Keep going on Sonnet, same account**: `POST /api/sessions/:id/account-limit/model-fallback` (§7.2): the server switches the session's model and sends the resume message; the banner resolves.
- **Continue** (reset-ready): `POST /api/sessions/:id/account-limit/resume`.
- **Open it →**: navigate to the new session. **Continue here anyway**: client-only; re-enables the composer; sending a message there resolves the episode as resumed.

**The transcript marker** (one line, muted, `text-2xs`, a small icon, at the stop point), by resolution:

| Resolution                                                                        | Marker                                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| moved                                                                             | "Acct 4 ran out · moved to ● Acct 2 at 2:14pm" (links to the new session) |
| resumed after the reset                                                           | "Resumed after reset at 4:02pm"                                           |
| resumed on another model                                                          | "Opus ran out · continued on Sonnet at 4:02pm"                            |
| resumed before the reset ("Continue here anyway", or another cause)               | "Acct 4 ran out · continued here at 4:02pm"                               |
| unresolved (older episode whose banner is gone, e.g. a later episode replaced it) | "Acct 4 ran out of usage"                                                 |

Markers read their episode from `episodes[]` in the same response (§7.2), matched to the `rate_limit` part by time: the episode whose `since` is the first at or after the part's message timestamp (within 5 minutes). No match (for example, a transcript older than this feature) → S4's plain error card.

## 7. Server additions (`apps/server`)

### 7.1 X4: the account advisor, and the continue routes (DOR-2388)

The orchestrator's decision (2026-09-26): the server exposes an **account advisor** the Flow extension registers; the picker and notice are core UI that read it as data, and there is no flow-contributed UI slot. This extends S4's extension API (X1-X3) with X4.

**Extension server API** (`packages/extension-api/src/server-extension-api.ts`, on S4's `claudeAccounts`):

```ts
/** What may carry over when work moves to another account. */
export type CarryOverItem = 'files' | 'branch' | 'summary' | 'checkpoint' | 'task';

/** Lets an extension rank and filter the accounts a person is offered, and move work it runs. */
export interface ClaudeAccountAdvisor {
  /** Fleet-wide handoff mode for the work this advisor runs (used for sidebar text). */
  describe(): Promise<{ handoff: 'auto' | 'ask' }>;
  /** Rank and filter every registered account for continuing `sessionId`. */
  advise(req: { sessionId: string; cwd: string; fromAccountId: string | null }): Promise<{
    /** True when this advisor runs the session's work (a flow run). */
    managed: boolean;
    /** Accounts in the order to offer them; an account left out is offered last as 'eligible'. */
    accounts: Array<{
      accountId: string;
      availability: 'eligible' | 'reserved' | 'excluded';
      /** Plain words for a person, e.g. "kept in reserve (50%)". */
      reason?: string;
    }>;
    recommendedAccountId: string | null;
    /** What the move keeps, e.g. ['files','branch','checkpoint','task'] for a flow run. */
    carryOver: CarryOverItem[];
    /** Set when the advisor already moved this session's work (e.g. flow's own supervisor did). */
    movedToSessionId?: string | null;
  }>;
  /** What the advisor will do about a limited session; null = nothing (not its work). */
  onLimited(req: {
    sessionId: string;
    cwd: string;
    accountId: string | null;
    window: string;
    resetsAt: string | null;
  }): Promise<{ mode: 'auto'; toAccountId: string; countdownSeconds: number } | { mode: 'ask' } | null>;
  /** Move a session the advisor manages. `handled: false` = not mine; core continues it. */
  continueSession?(req: {
    sessionId: string;
    cwd: string;
    toAccountId: string;
  }): Promise<{ handled: false } | { handled: true; sessionId: string }>;
}
// claudeAccounts gains:
registerAdvisor(advisor: ClaudeAccountAdvisor): () => void;
```

- Held in `services/runtimes/claude-code/accounts/account-advisor.ts`. One advisor at a time: a second registration replaces the first and logs a warning; the disposer removes only its own. Removed on extension shutdown and reload (same mechanism as S4's guards). `contributing/extension-authoring.md` documents it.
- `describe`, `advise` and `onLimited` are raced against 2 s; a throw or timeout means "no advice" (logged at most once a minute), never an error to the person.
- `continueSession` is raced against 90 s (flow's launch start timeout plus margin). A throw, a timeout, or `handled: false` when `advise` said `managed: true` is an error to the person (invariant 5), never a core launch.

**Routes** (`routes/runtimes.ts` and `routes/sessions.ts`; logic in `services/session/fleet/continue-on-account.ts`):

- `GET /api/runtimes/claude-code/accounts/advisor` → `200 { present: boolean, handoff: 'auto' | 'ask' | null }` (from `describe`). Client: `accountKeys.advisor()`, stale 30 s, `enabled: isMultiAccount`.
- `GET /api/sessions/:id/continue-options` → `200`:

  ```ts
  {
    fromAccountId: string | null;
    advised: boolean;                  // an advisor answered in time
    managed: boolean;                  // false when !advised
    accounts: Array<{ usage: AccountUsage; availability: 'eligible' | 'reserved' | 'excluded'; reason: string | null }>;
    recommendedAccountId: string | null; // always null when !advised
    carryOver: CarryOverItem[];         // ['files','branch','summary'] when !advised
    onLimited: { mode: 'auto'; toAccountId: string; deadline: string } | { mode: 'ask' } | null;
    movedToSessionId: string | null;
  }
  ```

  - `404` unknown session; `409 NOT_CLAUDE_CODE` for another runtime.
  - Every registered account but the session's own, with its `AccountUsage` from the D2 store (`list()`).
  - **Without advice:** all `eligible`, sorted by weekly headroom (100 − `seven_day.usedPct`; unknown after every known; ties by registry order); `recommendedAccountId: null`; `onLimited: null`.
  - **With advice:** the advisor's order and annotations (excluded rows are still returned, so a client or log can say why; the UI hides them). A `recommendedAccountId` that is excluded, out, or unknown is dropped to `null`. `onLimited` is asked only while the session's `limit` is active; `deadline = limit.since + countdownSeconds` (so every open window counts to the same instant, and a reload does not restart it); a `toAccountId` that is not selectable turns the answer into `{ mode: 'ask' }`.
  - `movedToSessionId`: the advisor's value, else the successor recorded on the session's latest limit episode (§7.2).

- `POST /api/sessions/:id/continue-on-account { account: string, trigger?: 'person' | 'auto' }` → `202 { sessionId: string, via: 'flow' | 'dorkos' }`.
  - `400` unknown account or the session's own; `409 LIVE_TURN` while the session has a live turn ("Wait for this session to finish its turn, then continue it on another account."); `409 WAITING` for `trigger: 'auto'` when the person chose to wait on this episode (§7.2), so a countdown in a second window cannot override the wait.
  - **Once per limit episode:** a second call for the same session and the same `limit.since` (either trigger) returns the first call's result instead of moving the work again, and a call while one is in flight waits for it. This is what makes the countdown safe with two windows open; flow's own `handing-off` compare-and-set (S3 §4.3) covers a race with flow's supervisor.
  - **Managed** (`advise` says so): `continueSession`; `handled: true` → `via: 'flow'`. A throw, a timeout or `handled: false` → `502 { error: <the advisor's message> }` and nothing else happens (invariant 5).
  - Either way the move is recorded on the session's latest unresolved limit episode as `moved` (§7.2), when there is one.
  - **Not managed, or no advisor:** a core launch through S4's `dispatchSessionMessage` with `origin: { kind: 'interactive' }` (a person's action; the `auto` trigger only fires from a countdown the person could stop), `account` as the hint, the old session's `cwd`, `runtime: 'claude-code'`, its `agentPath` when it has one, its settings row's `model`, `effort` and `permissionMode` copied to the new session's row first, a new server-minted id, the first message "Continue where the previous session stopped. The context above says what it was doing.", and a `seedContext` (≤ `SEED_CONTEXT_MAX_LENGTH`) from `buildContinueSeed(session)`: the previous session's id, title, account name and why it stopped (window and reset, if any), the cwd and git branch, then the last user message (≤ 1,500 chars) and the last assistant text (≤ 3,000 chars) read through the same history read `GET /api/sessions/:id/messages` uses, and a line pointing at `.dork/flow/HANDOFF.md` when that file exists in the cwd. No model writes this; it is quoted text, so it invents nothing and spends nothing.
  - No launch guard applies (invariant 6). An Activity entry records the move ("Continued <title> on <account>").
- OpenAPI regenerated (`pnpm docs:export-api`).

### 7.2 Limit episodes: waiting, resuming, and the marker's memory

The banner's states (§6.7) need facts S4 does not keep: that the person chose to wait, whether to continue automatically, and how an episode ended (moved where, resumed when). This section adds them. S4's `SessionStatus.limit` stays the live signal; an episode is its durable record.

**Table** (`packages/db/src/schema/account-limit-episodes.ts` + a Drizzle migration): `account_limit_episodes` with `id` (text, uuid), `session_id`, `account_id` (nullable), `account_path`, `window`, `resets_at` (nullable ISO), `since` (ISO), `wait_chosen_at` (nullable), `resume_on_reset` (integer 0/1), `resolution` (`moved` | `resumed-reset` | `resumed-model` | `resumed-early` | null), `resolved_at`, `to_session_id`, `to_account_id`, `model` (nullable). Unique on (`session_id`, `since`). Rows are deleted 30 days after `resolved_at` (swept on boot).

**Service** (`services/session/fleet/limit-episodes.ts`, one instance built in `index.ts`):

- **Open:** when a session's projected status gains a `limit` (S4 D4), insert an episode (idempotent on `since`).
- **Moved:** the continue route (§7.1) resolves the latest unresolved episode as `moved` with the new session and account. For a managed session whose advisor reports `movedToSessionId` (flow's own supervisor moved it), the next `account-limit` read records it the same way.
- **Resumed:** the session's next `turn_start` resolves its unresolved episode: `resumed-model` when the model changed since `since`, `resumed-reset` when now ≥ `resets_at`, else `resumed-early`.
- **Wait:** `POST /api/sessions/:id/account-limit/wait { resumeOnReset: boolean }` sets `wait_chosen_at` (first call only) and `resume_on_reset`. The checkbox's default is `true` when the advisor manages the session, else `false`.
- **Timer:** for an unresolved episode with a `resets_at`, one timer fires at `resets_at` (re-armed on boot; an overdue one fires once at boot). It emits `account_limit_changed` (so `waiting` becomes `reset-ready`, or the banner clears) and, when `resume_on_reset` is set and the session is **not** managed, resumes the session (below). A managed session is resumed by flow's supervisor (S3 "resume here"), never by DorkOS: two resumers would send two messages. Before resuming it reads the account's `AccountUsage`: a window still `rejected` (the reset moved) re-arms the timer to the new `resetsAt`, or to 5 minutes when there is none.
- **Resume** (`POST …/account-limit/resume`, and the timer): sends "Continue where you stopped." into the same session through `dispatchSessionMessage` with a new `TurnOrigin` member `{ kind: 'limit-resume' }`, which `permissionSeedForOrigin` maps to `'none'` (the session's row already exists and keeps its mode; the exhaustive switch and `__tests__/turn-origin-call-sites.test.ts` are updated). `409 LIVE_TURN` while a turn runs; `409 STILL_LIMITED` while the account is still out ("Acct 4 is still out of usage. Try again after it resets.").
- **Model fallback** (`POST …/account-limit/model-fallback`): only for an episode whose window is a model window. The fallback is the first model in the claude-code runtime's model list (newest first) whose family has no rejected model window on this account and differs from the current model's family. A model's family is the lowercased first word of its display name (`Opus 5.5` → `opus`); a window's family is `seven_day_opus` → `opus`, `seven_day_sonnet` → `sonnet`, `model:<slug>` → `<slug>`. The server writes the model with the same session-settings write the status-bar model picker uses, then resumes as above. `409 NO_FALLBACK_MODEL` when there is none (the banner never offers it then).
- **Event:** global `account_limit_changed { sessionId }` on every insert, update and timer transition; added to the client `stream-manager.ts` allowlist.

**Read:** `GET /api/sessions/:id/account-limit` → `200`:

```ts
{
  phase: 'none' | 'limited' | 'waiting' | 'reset-ready' | 'moved';
  managed: boolean;
  episode: {
    id: string; accountId: string | null; accountLabel: string; window: string;
    windowKind: 'five_hour' | 'weekly' | 'model'; modelFamily: string | null;
    resetsAt: string | null; since: string; resumeOnReset: boolean;
    moved: { toSessionId: string; toAccountId: string; at: string } | null;
  } | null;
  allOut: { soonest: { accountId: string; resetsAt: string } | null } | null;
  modelFallback: { model: string; label: string } | null;
  onLimited: { mode: 'auto'; toAccountId: string; deadline: string } | { mode: 'ask' } | null;
  episodes: Array<{
    id: string; since: string; accountId: string | null; window: string;
    resolution: 'moved' | 'resumed-reset' | 'resumed-model' | 'resumed-early' | null;
    resolvedAt: string | null; toSessionId: string | null; toAccountId: string | null; model: string | null;
  }>;
}
```

- `phase`: `moved` when the latest episode is resolved `moved` and no turn has run since; else, for an unresolved latest episode: `reset-ready` when `resetsAt` has passed and `resumeOnReset` is off; `waiting` when a wait was chosen, or when the advisor's `onLimited` is `ask` **and** `allOut` is set (flow will wait for the reset itself); `limited` otherwise; else `none`.
- `windowKind`: `five_hour` for `five_hour`; `model` for `seven_day_opus`, `seven_day_sonnet` and `model:*`; `weekly` for every other key.
- `allOut`: set when no other account is selectable by §7.1's rules (with advice: hidden and out accounts count as unavailable); `soonest` is the earliest known `resetsAt` among every registered account, this one included.
- `modelFallback`: computed as for the route above, only when `windowKind === 'model'` and neither `five_hour` nor `seven_day` is rejected on this account.
- `onLimited` as in §7.1 (asked only while `phase` is `limited`).
- `episodes`: this session's last 20, oldest first, for the transcript markers.
- `404` unknown session. OpenAPI regenerated with §7.1's routes.

### 7.3 Run extensions that ship inside an installed plugin

- `ExtensionDiscovery.discover` scans two more roots: `<dorkHome>/plugins/*/.dork/extensions/*` with origin `global`, and `<cwd>/.dork/plugins/*/.dork/extensions/*` with origin `local`. Precedence and approval are exactly those of the existing roots: a local record never takes over an id that is core or already approved (the DOR-511 rule in the same file), and a plugin-carried extension needs the person's one-time "Allow it to run" (DOR-516) like any other non-core extension. Two plugins carrying the same id: the first by sorted plugin directory name wins, with a warning.
- The record remembers its plugin directory, so uninstalling the plugin (`flows/uninstall.ts`, which already walks the package's `.dork/extensions`) disables it and clears its approval, and the compile cache is keyed by the real path.
- Tests: an installed fixture plugin with an extension is discovered, enabled by `install-plugin.ts`, refused until approved, and gone after uninstall; a project plugin cannot inherit an approved global id.

## 8. The Flow extension (`dork-labs/marketplace`, `plugins/flow/`)

### 8.1 Where it lives and how it ships

- Folder `plugins/flow/.dork/extensions/flow/`: `extension.json`, `index.ts` (client), `server.ts`, and `ui/*.ts` / `lib/*.ts` modules. Extension id **`flow`** (it must equal the folder name), so the tab id `fleet` becomes `flow:fleet` (S4 §10).
- `plugins/flow/.dork/manifest.json`: `"layers"` gains `"extensions"`, `"extensions": ["flow"]`. The marketplace's `.claude-plugin/dorkos.json` entry for `flow` lists `extensions` in its layers. `.claude-plugin/plugin.json` is unchanged.
- `extension.json`: `{ "id": "flow", "name": "Flow", "version": <plugin version>, "description": "Choose how flow spends your Claude accounts.", "minHostVersion": <the DorkOS release carrying S4 X1-X3 and §7> }`. **No** `serverCapabilities.secrets` or `settings`: those would make the host add a second, generic "Flow" tab.
- Client code may import only `react` (as the global, via `const h = React.createElement`, the `linear-issues` pattern), `react-dom` and `@dorkos/extension-api`. No `@dork-labs/ui`, shadcn or lucide. Controls are built with the host's CSS variables (`--border`, `--muted`, `--muted-foreground`, `--foreground`, `--ring`, `--radius`) and native elements, matching the host's control heights (28-32px) and 13px labels.
- The server half imports flow's own modules directly (esbuild bundles relative imports): `../../../scripts/fleet/accounts.ts` (`resolveFleetPolicy`, `loadFleetPolicy`, `updateFleetPolicy`, `setAccountPolicy`, `setHandoff`, `mayServe`, `effectiveReservePct`), and S3's `rankAccounts` once it lands. Those modules are zod-free, which keeps the server bundle small.
- `dorkHome` comes from S4's `ctx.dorkHome`, never `resolveDorkHome()`: flow's own resolver ignores DorkOS's dev home, and the extension must write where this DorkOS reads.
- **Older DorkOS:** when `ctx.claudeAccounts` or `ctx.dorkHome` is missing, the server registers no routes that need them and `GET …/fleet` answers `501 { reason: 'host-too-old' }`; the tab shows one line, "Update DorkOS to choose how flow uses your accounts."

### 8.2 Server routes (mounted by the host at `/api/ext/flow/`)

- `GET /fleet` → `{ handoff, accounts: Array<{ id, label, color, role, reservePct, spendDownWindowHours, repos, effectiveReservePct }>, warnings: string[] }`. Identities from `ctx.claudeAccounts.list()` (registry order, resolved colors), mapped to flow's `{ id, routable }` shape with `routable = ACCOUNT_ID_PATTERN.test(id)`; policy from `loadFleetPolicy(ctx.dorkHome, identities)`; `effectiveReservePct` fed the account's ledger windows read with flow's own `scripts/fleet/usage-ledger.ts` reader from `ctx.dorkHome` (the flow functions take the raw ledger shape, not DorkOS's `AccountUsage`).
- `PUT /fleet/accounts/:id` body `{ role?, reservePct?, spendDownWindowHours?, repos? }` (the `AccountPolicyPatch` shape; `null` resets a field to its default). One `updateFleetPolicy` call under the contract's lock. **Choosing `main` for an account while another is `main`** demotes the old one to `rotation` in the same locked update (the contract allows only one `main`). `repos` entries must match `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`; else `400` naming the entry. Unknown id → `404`. Returns the new `GET /fleet` body.
- `PUT /fleet/handoff` body `{ handoff: 'auto' | 'ask' }` via `setHandoff`. Returns the new body.
- Any write error from the lock (gave up after 2 s, a newer file version) → `409` with flow's own message.

### 8.3 The Settings tab (decision 2, option A)

`api.registerSettingsTab('fleet', 'Flow', FleetTab, { group: 'Add-ons' })` in `activate`. `FleetTab` (`ui/fleet-tab.ts`), from the mockup, top to bottom:

1. Heading "Which accounts flow may use"; muted line "Flow spends the account whose unused time expires soonest, and saves Main for last."
2. One row per account: dot (color, `role="img"`, `aria-label` = name), name, and a three-way segmented control **Main | Rotation | Kept out**, built as a `role="radiogroup"` of `role="radio"` buttons with roving tabindex and arrow keys; the selected segment uses `--foreground` fill and `--background` text, as the mockup's dark segment.
3. Under the Main row, an inset panel: "Keep **50%** for me" + a native `<input type="range" min=0 max=100 step=5>` (`aria-label` "Share of the weekly limit kept for you", `aria-valuetext` "50%") + "· Use it all in the last" + a native `<select>` of 6, 12, 24, 48 and 72 hours (a stored value outside the list is added as its own option) + "before it resets". The reserve writes on release (`change`), not on every drag step.
4. Under each Kept out row, an inset panel: "Only for these repos:" + one chip per `owner/name` with a remove button (`aria-label` "Remove <repo>") + an "+ add" chip. How "+ add" takes the new repo is Q9.
5. A final row: "When an account runs out" + a segmented control **Hand off automatically | Ask me**.

- Every change writes at once (no Save button, as the mockup), optimistic, and rolls back with an inline `role="alert"` message on an error.
- Zero accounts registered: one muted line "Add Claude accounts in Settings → Runtimes first." (plain text: the extension API has no way to switch Settings tabs).
- The extension calls its routes with the `resolveApiBaseUrl()` helper `linear-issues` uses, so it works in the desktop app.

### 8.4 The advisor (DOR-2388)

`server.ts` registers `ctx.claudeAccounts.registerAdvisor(...)`. It answers for every session (so a kept-out account is hidden in any session outside its repos), but only moves and counts down for a flow run.

- `describe()`: `{ handoff }` from `loadFleetPolicy(ctx.dorkHome, identities)`.
- `advise({ sessionId, cwd, fromAccountId })`:
  - `managed`: the main checkout's `.dork/flow/flow-state.json` (contract §1.3, found from `cwd` exactly as S4 D8 does) has a run whose `sessionId` equals `sessionId`.
  - Per account, **for a flow run**: `excluded` when flow could not move the run there (`!mayServe(policy, repo)`, repo from the checkout's `origin` via `parseOriginRepo`, or `rankAccounts` calls it ineligible once S3 1.2 lands). **For any other session** (a person's own work): `excluded` only for an account the operator explicitly set to Kept out in `fleet.json` whose repos do not include this one. An account with no `fleet.json` entry reads as kept-out to flow (the contract's opt-in default), but hiding it from a person's own picks would hide every account on a fresh install, so it stays `eligible` there. Then `reserved` when its role is `main`, it is outside its spend-down window, and another non-excluded account has weekly room (the main-account rule, contract §1.1b); else `eligible`. `reason` for `reserved`: "kept in reserve (<effectiveReservePct>%)"; for `excluded`: "kept out of this repo" (the UI hides these rows; the reason is for logs).
  - Order and `recommendedAccountId`: S3's `rankAccounts` (with `fromAccountId` excluded) once S3 task 1.2 has landed; until then, eligible accounts by weekly headroom, then reserved, then excluded, and the first eligible one with weekly room is recommended.
  - `carryOver`: `['files', 'branch', 'checkpoint', 'task']` when managed, else `['files', 'branch', 'summary']`.
  - `movedToSessionId`: for a managed session, when flow's run record shows it was handed off from `sessionId` (S3's `drain.handoffs`), the run's current `sessionId`; else `null`.
- `onLimited({ sessionId, cwd })`: `null` unless managed; `{ mode: 'ask' }` when `handoff` is `ask`; `{ mode: 'auto', toAccountId: <recommended>, countdownSeconds: 10 }` when `auto` and there is a recommended account; `{ mode: 'ask' }` when `auto` but nothing is eligible (flow will wait for the reset).
- `continueSession({ sessionId, cwd, toAccountId })`: not a flow run → `{ handled: false }`. A flow run → `execFile('node', ['--experimental-strip-types', <flowRoot>/scripts/flow.ts, 'handoff', <identifier>, '--to', toAccountId, '--project', <main checkout>, '--json'])` with no shell and a 90 s timeout, where `flowRoot` is three levels above `ctx.extensionDir`. `node` comes from `PATH`, never `process.execPath` (inside the desktop app that is Electron); a missing or too-old `node` throws "Flow needs Node 22.6 or newer on your PATH to move this work." On exit 0, re-read the run and return its new `sessionId`. A non-zero exit throws with flow's own message (the person sees it). Until S3 task 4.3 ships `flow handoff`, a managed session throws "Flow cannot move this run yet. Update flow."

## 9. One account vs two or more

| Surface                                                 | 0 or 1 account                                                                                         | 2+ accounts |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------- |
| Status-bar chip, popover                                | not rendered; the runtime chip keeps today's account menu for pre-launch (it only shows with 2+ today) | §6.1        |
| Sidebar dot, limited row tint and text                  | not rendered                                                                                           | §6.2        |
| Header badge                                            | not rendered                                                                                           | §6.3        |
| Settings rows: dot, bars; the Flow note                 | not rendered                                                                                           | §6.5        |
| Picker, banner, marker                                  | not rendered; a `rate_limit` error shows as S4's plain error card; no episode endpoint is called       | §6.6, §6.7  |
| `useAccountUsage`, `useAccountUsageSync`, advisor query | disabled (no request, no subscription work)                                                            | on          |
| Flow tab                                                | rendered when the extension runs (it lists the one account)                                            | rendered    |

## 10. Accessibility

- Color is never the only signal (invariant 2). The chip, badge, banner and picker rows print the name; state is in words ("91% of week", "out until Tue 3pm", "out · handing off").
- `AccountDot`, `UsageMiniBars` and `UsageBar` are `role="img"` with full sentences as names; the popover and dialog use the house primitives (focus trap, `Escape`, return focus to the chip).
- The chip is a button with `aria-haspopup="dialog"` and `aria-expanded`; its accessible name includes the state text.
- The banner is `role="status"`, not `alert` (the house `Banner` sets `alert` for `critical`; this use overrides it): it appears after the turn's own error frame, which already announced the stop. The countdown is not announced each second: the live text is "in 10s" once, and the button labels carry the rest. The picker's inline error is `role="alert"`. The checkbox is a labelled native checkbox. The marker is plain text in the transcript's reading order.
- The Flow tab's segmented controls are real radio groups (arrow keys, `aria-checked`), the slider is a native range with `aria-valuetext`, and every chip remove button is labelled.
- Everything works at 360px wide: the chip's text truncates the name first (the state words never truncate); the dialog is a bottom sheet on mobile (`ResponsiveDialog`).

## 11. Copy

All from the decided mockups unless marked **(new)**; all follow `writing-for-humans`.

| Where                                          | Text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chip near                                      | `<name> · 91% of week`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Chip out                                       | `<name> · out until Tue 3pm` (7-day or model window), `<name> · back in 47 min` (5-hour window), `<name> · out` (reset unknown)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Popover                                        | `Max plan`; `5-hour`, `This week`; `40% · resets 2:10pm`; `Working on DOR-2353`; `Continue on another account →`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Sidebar                                        | `out · handing off`, `out · waiting for reset`; tooltip `Out of usage` **(new)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Header                                         | `● <name>`, `● <name> · out`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Settings note                                  | `Flow uses these accounts for your work. Choose how in Settings → Flow.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Picker                                         | `Continue on another account`; with a flow run (mockup v2): `Picks up in the same folder and branch from flow's checkpoint.`, `Carries over: files, branch, checkpoint, task`, `Doesn't: the chat itself`, `Client is kept out, so it isn't listed.` (plural: `Client and Acct 5 are kept out, so they aren't listed.` **(new)**); otherwise (mockup v2): `Starts a new chat in the same folder, with a summary of this one. Sorted by most usage left.`, `Carries over: the folder and a summary of this chat`, `Doesn't: the chat itself`; `recommended`; `28% left · resets Sun`; `kept in reserve (50%)`; `usage unknown` **(new)**; `out until 3pm` / `back in 47 min` **(new)**; `Cancel`; `Continue on <name>`; `No other account can take this work right now.` **(new)** |
| Banner                                         | `Acct 4 is out of usage until Tue 3pm.` / `Acct 4 is out of usage · back in 47 min.`; `Continue on another account…`, `Wait for reset`; flow auto: `Moving this task to ● Acct 2 in 10s…`, `Move now`, `Choose account…`; composer `Paused until you continue or the account resets` / `Paused until the task moves or the account resets` (mockup v2); **(orchestrator)** `All accounts are out.` `Soonest back: ● Acct 2, Sun 9am`; `Opus is out on Acct 3 for this week.` `Keep going on Sonnet, same account`; `Waiting for Acct 4 · back in 1h 12m` / `· back Tue 3pm`; `Continue automatically when it resets`; `This task continued on ● Acct 2.` `Open it →` `Continue here anyway`; **(new)** `Acct 4 has reset.` `Continue`                                             |
| Transcript marker                              | **(orchestrator)** `Acct 4 ran out · moved to ● Acct 2 at 2:14pm`, `Resumed after reset at 4:02pm`; **(new, same pattern)** `Opus ran out · continued on Sonnet at 4:02pm`, `Acct 4 ran out · continued here at 4:02pm`, `Acct 4 ran out of usage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Server errors **(new)**                        | `Wait for this session to finish its turn, then continue it on another account.`; `Flow cannot move this run yet. Update flow.`; `Flow needs Node 22.6 or newer on your PATH to move this work.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Flow tab                                       | as the mockup; `Update DorkOS to choose how flow uses your accounts.` **(new)**; `Add Claude accounts in Settings → Runtimes first.` **(new)**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| First message of a continued session **(new)** | `Continue where the previous session stopped. The context above says what it was doing.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Resume message in the same chat **(new)**      | `Continue where you stopped.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Resume errors **(new)**                        | `Acct 4 is still out of usage. Try again after it resets.`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 12. Testing

Client tests use RTL with `createMockTransport` inside `TransportProvider` and a fresh `createTestQueryClient()` (pattern: `features/settings/ui/runtimes/__tests__/ClaudeAccountsSection.test.tsx`). Every test must fail with its implementation reverted. Fixtures come from one new `packages/test-utils` factory, `createMockAccountUsage(overrides)`, plus `createMockSession({ accountId, status: { lifecycle, limit }, trackerItem })`.

| Area                                       | Tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Palette                                    | contrast table recomputed from hex, every ratio ≥ 3.0; 8 distinct values; no red hue (hue 345-15°).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Helpers                                    | `barTone` (null, 0, 69, 70, 99, 100, rejected), `chipState` table incl. an expired limit, `isLimitActive` (null reset, past, future), `nearestWindow` ties, `formatResetTime` (same day, :00 drop, weekday, far date, `null`, a DST boundary with a fixed `now` and `TZ`), `windowShortName`, `planName`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Gating                                     | For the chip, sidebar dot, header badge, settings bars and note, banner and marker: render with 0, 1 and 2 accounts; absent at 0 and 1, present at 2 (invariant 1). `getAccountUsage` is not called with 1 account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Chip                                       | ok/unknown/near/out text and accessible name; bars' `aria-label`; opens the popover; popover rows per window with local reset times; tracker line only with `trackerItem`; the action hidden during a live turn; an `account_usage` event through the mock event stream updates the chip without a refetch. Pre-launch: the picker moved from `RuntimeItem` (update `RuntimeItem.test.tsx`: no account group), and choosing sets `pendingAccount`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Sidebar                                    | dot has name as `aria-label` and tooltip; limited row shows the right text for managed+auto, ask, and unmanaged; the time returns after `resetsAt` (fake timers).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Header                                     | badge name; out variant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Settings                                   | bars per window incl. unknown; the Flow note only with 2+ accounts **and** a `flow:fleet` contribution registered in the extension registry; clicking it calls `setTab('flow:fleet')`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Picker, **flow absent** (`advised: false`) | rows in the server's headroom order, **no `recommended` badge, nothing hidden or dimmed**, first selectable row preselected, the without-flow subtitle and carry-over list, limited rows disabled.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Picker, **flow present** (`advised: true`) | recommended badge on and preselecting `recommendedAccountId`, reserved dimmed with its reason (selectable per Q2 default: not when `managed`), excluded absent, the flow-run subtitle and list only when `carryOver` has `checkpoint` and `task`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Picker, both                               | `Continue on <name>` follows selection; submit posts `{ account }` and navigates on 202; server error shown with `role="alert"` and the dialog stays; nothing selectable → the one-line message and a disabled button; keyboard: arrows move between radios, `Escape` closes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Banner                                     | One test per state row of §6.7 against a mocked `getAccountLimit`: near-limit renders no banner; `limited` without flow (primary "Continue on another account…" opens the picker; "Wait for reset" posts `{ resumeOnReset: false }`); `limited` with flow `ask` (same as without); `limited` with flow `auto` ("in 10s…" counts down to `deadline` with fake timers, a remount mid-count resumes from `deadline`, Move now posts `{ account: toAccountId }`, zero posts `{ account, trigger: 'auto' }` exactly once, Wait stops the count and posts no continue); all-out (only Wait, the soonest account and day); model-only (primary posts model-fallback; absent without `modelFallback`); `waiting` (checkbox default from `resumeOnReset`, toggling posts the new value, `back in` under 24 h and `back Tue 3pm` beyond); `reset-ready` (Continue posts resume); `moved` (Open it navigates, the composer is disabled until "Continue here anyway"); 5-hour vs 7-day wording. Composer paused in `limited` and `waiting`, not when `resetsAt` is null. `account_limit_changed` for this session refetches.                                                                                                                                                                                                |
| Marker                                     | each resolution row of §6.7 renders its line, matched by time to the right `rate_limit` part; nothing while the banner for that episode shows; no match → the plain error card; one account → the plain error card.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Episodes (server)                          | open on a limit (idempotent on `since`); resolved `moved` by the continue route and by an advisor `movedToSessionId`; `resumed-reset` / `resumed-model` / `resumed-early` on the next `turn_start`; wait sets the fields and the default checkbox by managed; the timer fires at `resets_at` (fake clock), re-arms on boot, fires once when overdue, re-arms when the account is still rejected, and resumes only unmanaged sessions with `resume_on_reset`; resume refuses a live turn and a still-limited account; model fallback picks the right model (Opus out → Sonnet; none → 409) and writes the session model before sending; `limit-resume` origin seeds nothing; `phase` table incl. `moved` then a new turn → `none`; `allOut` and `soonest`; continue with `trigger: 'auto'` after a wait was chosen is refused (`409 WAITING`); the migration applies on an existing DB; 30-day sweep.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Server X4                                  | registration, replacement warning, removal on reload; `advise`/`describe`/`onLimited` timeout and throw → no advice.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Server routes                              | continue-options **without an advisor** (headroom order, unknown last, `recommendedAccountId: null`, `carryOver` files/branch/summary, `onLimited: null`) and **with one** (its order, an excluded or out recommendation dropped to null, excluded rows kept in the response, `deadline = limit.since + countdownSeconds`, a non-selectable `toAccountId` → `ask`, `onLimited` not asked without an active limit); `movedToSessionId` from the advisor, else from this server's own continue; continue called twice for one limit episode (and concurrently) moves once and returns the same result; continue: managed → `continueSession` only (spy: no dispatch), managed failure → 502 with the message and no dispatch (invariant 5), unmanaged → `dispatchSessionMessage` with interactive origin, copied settings, the seed within the cap, and **no guard consulted even when a denying guard is registered** (invariant 6); live turn → 409; OpenAPI has the new schemas.                                                                                                                                                                                                                                                                                                                               |
| Invariant 4                                | the guard test named in §4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Discovery                                  | §7.3 tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Flow extension (marketplace)               | Server handlers with a fake `ctx` over a temp `dorkHome`: GET resolves defaults (every account `kept-out` with no file); PUT role main demotes the old main in one write; repos validation; `null` resets; a write the flow CLI makes between two PUTs survives; host-too-old → 501. Advisor: managed detection from a `flow-state.json` fixture, excluded/reserved/eligible per the contract's conformance cases (`fleet-policy.cases.json`, `room.cases.json`), `continueSession` builds the exact argv (fake `execFile`), non-zero exit throws flow's message. Tab: RTL tests with `react`, `react-dom`, `@testing-library/react` and `jsdom` added as **dev** dependencies of the plugin (vitest `environment: 'jsdom'` for `.dork/extensions/**` tests only): radiogroup keyboard, range `aria-valuetext`, chip remove label, optimistic write and rollback, zero-account line. The DorkOS `extension-test-harness` loads the built extension and counts exactly one `settings.tabs` registration (it counts per slot, not ids); the extension's own RTL test asserts `registerSettingsTab` is called with `'fleet'`, `'Flow'` and `{ group: 'Add-ons' }`. Advisor for a person's own session: with no `fleet.json`, nothing is excluded; an explicit Kept out account scoped to another repo is excluded. |
| Accessibility                              | a `@smoke` Playwright spec over the Dev Playground sections of §13 using the repo's `apps/e2e/axe.ts` `runAxe` helper (the `sidebar-model-showcase.spec.ts` pattern: no server, no seeding): zero violations on the chip + popover, picker, settings section, header badge, sidebar rows the banner in each state and the transcript marker, in light and dark.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 13. Dev Playground

Per the `maintaining-dev-playground` skill: render the real components with injected data, never rebuilt layouts.

| Page                              | Section (id = slug of title)                         | Shows                                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation (`ConversationPage`) | `AccountItem`                                        | ok, unknown, near (week and 5h), out with and without reset, pre-launch picker                                                                                                           |
| Conversation                      | `AccountPopover`                                     | with and without plan, with a tracker item, extra windows (Opus)                                                                                                                         |
| Conversation                      | `ContinueOnAccountDialog`                            | without flow (headroom order, no badge), with flow for a flow run (recommended, reserved, checkpoint wording), with flow for another session, nothing to offer, server error             |
| Conversation                      | `AccountLimitBanner`                                 | every §6.7 state: limited without flow, limited with flow auto counting down, all out, model only, waiting (with and without flow default), reset-ready, moved; 5-hour and 7-day wording |
| Conversation                      | `AccountLimitMarker`                                 | each resolution line                                                                                                                                                                     |
| Sidebar Model                     | `AccountMark`                                        | dots per palette color; limited rows (handing off, waiting) in full and compact                                                                                                          |
| One Bar                           | `AccountBadge`                                       | normal and out                                                                                                                                                                           |
| Settings                          | `ClaudeAccountsShowcaseSection` (existing, extended) | multi-account with bars incl. unknown, with and without the Flow note                                                                                                                    |
| Design Tokens                     | `Account palette`                                    | the 8 colors on light and dark surfaces with their contrast ratios                                                                                                                       |

Data: `settings-mock-data.ts` gains `color`/`colorIsDefault` on `MOCK_SERVER_CONFIG_MULTI_ACCOUNT` and a `MOCK_ACCOUNT_USAGE` set (one per state); `createPlaygroundTransport()` answers `getAccountUsage`, `getAccountAdvisor`, `getContinueOptions` and `getAccountLimit` from it (one fixture per banner state), and resolves the write methods without effect. The Flow tab lives in the marketplace and is not in the core playground.

## 14. Open design questions (the operator decides these in the visual companion)

- ~~**Q0. Notice placement.**~~ (RESOLVED, orchestrator for the operator, 2026-09-26) A: a banner above the message box that collapses into a one-line transcript marker when resolved, with the states in §6.7.
- **Q1. Holding flow when the person says wait.** In flow `auto` mode, "Wait for reset" stops DorkOS's countdown, and "Continue automatically when it resets" unchecked should stop flow resuming. Flow S3 has neither a hold nor a "don't resume" flag: its supervisor moves or resumes the run on its own next pass. Choices: (a) ship as is and let flow act anyway (the banner then goes to `moved` or clears when flow acts); (b) for a flow run, hide "Wait for reset" in `auto` mode and show the checkbox checked and disabled; (c) add a hold to flow S3 (a contract change) and an advisor `hold(sessionId, { resumeOnReset })`. Default until answered: (a).
- **Q2. Can a person pick an account shown as "kept in reserve"?** The mockup dims Main. Default here: not for a flow run (flow refuses it), yes for any other session.
- ~~**Q3. Wording for a session flow does not run.**~~ (RESOLVED by the orchestrator and mockup v2) "Starts a new chat in the same folder, with a summary of this one. Sorted by most usage left." and "Carries over: the folder and a summary of this chat" / "Doesn't: the chat itself".
- **Q4. The sidebar dot's exact place.** Rows already carry origin and runtime marks (line 2 in the full row, a trailing cluster in the compact row, which also has a leading status dot). Does the account dot lead the title (design reading, default) or sit with the other marks, and does the row keep printing the account name next to it (today's `AccountMark`) or move it into the tooltip (default)?
- **Q5. "started on this account"** in the popover. Every DorkOS session lives on one account, so the clause would always be true; the useful form is "continued from Acct 4", which needs the run's previous account (flow's `drain.handoffs`), not in S4's `trackerItem`. Default: omit the clause.
- **Q6. How a window with no reading looks.** S4 forbids drawing unknown as 0%. Proposed: a dashed empty track and the word "unknown" in the popover and settings.
- **Q7. The pre-launch chip, "restyled to match".** Proposed: the same chip (dot, name, bars) with a small chevron; the menu rows are dot + name + bars, the default account first, with today's "not ready" note.
- **Q8. Choosing an account's color in Settings → Runtimes.** The decision says it is chosen there, with no mockup of the control. Proposed: clicking the row's dot opens a popover of the 8 swatches (a radio group) plus "Default".
- **Q9. "+ add" in "Only for these repos".** Proposed: the chip turns into a small text field (placeholder "owner/name"); Enter adds, Escape cancels, a bad value shows "Use owner/name, like acme/app."
- **Q10. The marker's look.** The decision says "a one-line marker in the transcript"; the spec draws it as one muted `text-2xs` line with a small icon (a clock for resumed, an arrow for moved), and keeps the moved line's account dot. Proposed as that.
- **Q11. "Continue here anyway"** re-enables the composer for this window only (not saved, not shared with other windows). Proposed as that; the alternative is to remember it on the episode.
- **Q13. The banner's tone in calm states.** `waiting`, `reset-ready` and `moved` are not failures, but the rule keeps them in the same red banner. Proposed: keep red (as decided) unless the operator wants the house neutral banner for those three.
- **Q12. `reset-ready` copy and action** ("Acct 4 has reset." + Continue) are not in the orchestrator's list beyond "offers Continue". Proposed as written.

## 15. Decisions and assumptions (autonomy grant; reversible)

- **Palette** chosen by contrast (§5) and owned here; S4's values were provisional by design. One hex per account in both themes, because the contract stores one value.
- **Bar amber at 70%**, read off both decided mockups (72% amber); the chip's own amber rule stays S4's 90%.
- **X4 advisor added to the extension server API** rather than core reading flow's policy (forbidden by S4 §2) or the client calling `/api/ext/flow/*` by name (couples core to one extension). Mirrors S4's guard seam. ADR seeded.
- **The continue action is a server route,** not the client's existing send: the server must decide flow-vs-core atomically, mint the id, build the seed from the transcript, and copy settings.
- **A flow run is moved only by `flow handoff`;** a failure is shown, never retried as a core launch (two writers).
- **Plugin-carried extensions are discovered** (§7.3) with today's approval rules. Without this the Flow extension never runs. ADR seeded.
- **The seed is quoted text, not a model summary:** nothing invented, nothing spent.
- **`limit` without a reset time never pauses the composer.**
- **Main moves demote the previous Main to Rotation** in one locked write.
- **Spend-down choices 6/12/24/48/72 h;** a stored custom value is kept as its own option.
- **The Flow tab UI is hand-built on host CSS variables** because extensions cannot import the host's components today. A follow-up could expose host primitives to extensions; not needed for this spec.
- **The status-bar pre-launch picker moves out of `RuntimeItem`** (one place for one choice).
- **Short window names in the near chip** ("of 5h", "of week") follow the mockup's "of week".
- **Existing TurnFailedNotice is replaced by the banner** for a limited turn (one notice, not two).
- **Limit episodes are a table, not memory** (§7.2): the banner's `waiting` and `moved` states and the transcript marker must survive a restart and agree across windows.
- **DorkOS resumes only sessions flow does not run;** flow's supervisor resumes its own (two resumers would send two messages).
- **A new `limit-resume` turn origin** seeds nothing: the session's row exists and keeps its mode.
- **Model fallback picks by family** from the runtime's model list; no hard-coded model names.
- **Kept-out hiding for a person's own session** applies only to accounts the operator explicitly set to Kept out; unconfigured accounts stay offered, or a fresh flow install would hide every account.
- **Orchestrator decision (2026-09-26), adopted:** the picker and notice are core UI and work without flow; flow changes them only through the server's account advisor (rank, filter, recommended, reasons, `onLimited` countdown or ask, `carryOver`); no flow-contributed UI slot.
- **The countdown runs to a server-computed `deadline`** (`limit.since + countdownSeconds`), and the continue route is idempotent per limit episode, so reloads and several open windows agree and move the work once.
- **The advisor also answers for sessions flow does not run,** so a kept-out account is hidden outside its repos in any session (DOR-2388); only flow runs get a countdown and flow's carry-over list.
- **`node` from PATH** runs `flow handoff`; `process.execPath` is Electron inside the desktop app.

## 16. Draft ADRs seeded

- `260926-153106` An extension advises which Claude accounts a person is offered and moves the work it runs; core never reads its policy.
- `260926-153107` Extensions that ship inside an installed plugin are discovered and gated like any other extension.

## 17. References

- Design: `04-design-decisions.md`, `design/account-display.html`, `design/accounts-split.html`, `design/account-limit.html`.
- Server: `specs/claude-account-fleet/02-specification.md` (S4). Contracts: marketplace `specs/flow-cli-core/02-specification.md` §1. Handoff: marketplace `specs/flow-handoff-dispatch/02-specification.md` §2.5, §5.
- Code: `features/status/` (status bar, `RuntimeItem`, `use-account-switch`), `features/settings/ui/runtimes/sections/ClaudeAccountsSection.tsx`, `entities/session/ui/{SessionRowFull,SessionRowCompact,AccountMark}.tsx`, `widgets/one-bar/ui/SessionHeader.tsx`, `widgets/session/ui/ChatPanel.tsx`, `features/chat/ui/message/ErrorMessageBlock.tsx`, `shared/model/server-config/use-claude-accounts.ts`, `shared/lib/transport/stream-manager.ts`, `packages/extension-api/src/server-extension-api.ts`, `apps/server/src/services/extensions/extension-discovery.ts`, `apps/server/src/core-extensions/linear-issues/` (extension template).
- Linear: DOR-2387, DOR-2388, DOR-2379, DOR-2382 (project "Flow CLI & Account Fleet").

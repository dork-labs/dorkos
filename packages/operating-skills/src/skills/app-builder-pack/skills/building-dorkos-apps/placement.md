# Placement: where the app shows, and the interview that decides it

Once approved, an app shows only in the places its manifest declares and the person
allowed. So where it shows is your choice, made with the person, before you build. Placement is a product
decision, not a template.

## The interview

One round, all questions at once, each with your best guess so the person can answer
"yes" to most. Skip any the request already answers. Never more than one round: build
on the answers you have and say which guesses you kept.

1. **What's the one job, and who uses it?** Just the person, or others too (other
   people, other agents)? *Guess: just you; "see today's to-dos and tick them off".*
2. **How often will you look at it?** A glance many times a day, daily work, or rarely.
   *Guess: daily.*
3. **What does it touch?** Read only; writes inside DorkOS (its own files, other apps'
   data); or acts in public (posts, sends, deletes, spends). *Guess: read only.* Public
   actions are built last, read-only part first, and only after the person says yes.
4. **Where does its data come from?** Its own files, another app, or an outside
   service. *Guess: its own files.*
5. **Who hears your comments?** When you comment in the app, which agent gets it.
   *Guess: the agent that built it.*

Then **state the place, with its reason. Don't ask it.** Pick from the answers to 1–3
and the table below: a glance suits a small note or an Activity section; daily work
suits a page or a tab beside the chats; rarely suits a command or no screen at all.

Talk to the person in the "Say it as" words from the table, never the product names.

Example wording: "Before I build: (1) I'll make it a page you open from Apps, since
you'll work in it daily. (2) It only reads, and nothing leaves DorkOS. (3) It keeps its
own files. (4) Just for you, and your comments go to me. Change any of these, or say go."

## The surfaces

| Surface | Say it as | How it's added | Use it for | The person's control |
|---|---|---|---|---|
| **Full page** at `/x/<id>/<path>` | "a page you open from Apps" | `registerPage(path, Component, { title, icon, menu })` | Real work: lists, editors, dashboards | Opens as a tab; listed in Apps and ⌘K; can be pinned to the sidebar |
| **Right-panel tab** | "a tab beside your chats" | `registerComponent('right-panel', id, C, { label, icon, showIn })` | A companion beside the chat | Hide here / Show here, and Settings → Extensions → "Panel tab shows" |
| **Activity section** (slot id `dashboard.sections`) | "a section on your Activity page" | `registerComponent('dashboard.sections', …)` | A short glanceable block | None |
| **Status bar** | "a small note under the chat box" | `registerStatusBarItem(id, C, { label, when, urgent })` | One number or alert per chat | None; all apps share one slot |
| **Settings tab** | "its own tab in Settings" | `registerSettingsTab(id, label, C, { group })` | The app's own settings | None |
| **⌘K command** | "a command you run from the search bar" | `registerCommand(id, label, fn)` | A one-step action | None |
| **Dialog** | "a small pop-up" | `registerDialog(id, C)` | A short confirm or form the app opens | Closes it |
| **Canvas** | "opens beside the chat" | `api.openCanvas(content)` (opens only, no slot; declare `canvas`) | Showing a result beside the chat | Closes it |
| **Tools only** | "no screen, just something your agents can use" | `tools` in the manifest, no UI | Something only agents use | Turns the app off |

`get_extension_api` doesn't list `registerPage` or `registerStatusBarItem`; they're in
`@dorkos/extension-api`. Check `api.isSlotAvailable(slot)` when a slot may be missing.

## Declare every place in `contributions`

`extension.json` lists every place the app shows in, under `contributions`, each set to
exactly `true`. DorkOS shows the app only in the places it lists, and the person's
approval card names each one. Declare only the places you register.

| Key | Allows | The card says |
|---|---|---|
| `pages` | `registerPage` | a page |
| `right-panel` | `registerComponent('right-panel', …)` | a panel tab |
| `dashboard.sections` | `registerComponent('dashboard.sections', …)` | an Activity section |
| `settings.tabs` | `registerSettingsTab` | a Settings page |
| `status-bar` | `registerStatusBarItem` | a status bar item |
| `command-palette.items` | `registerCommand` | ⌘K commands |
| `dialog` | `registerDialog` | dialogs |
| `sidebar.footer` | `registerComponent('sidebar.footer', …)` | a sidebar item |
| `canvas` | `api.openCanvas` | canvas documents |
| `inbox` | `ctx.inbox` (server code) | Inbox cards |

```json
"contributions": { "pages": true, "command-palette.items": true }
```

- **A place you didn't declare is refused.** A screen registration draws nothing and
  does nothing, logs a console warning, and the app's Settings row lists the place. In
  a framed app, `openCanvas` throws instead. On the server, `ctx.inbox` calls reject and
  `onAction` does nothing. `test_extension` counts an undeclared place as 0 and adds a
  warning, so read `warnings`. It can't see `ctx.inbox`, a registration made after
  `activate` returns, or one behind `api.context === 'registration'`, so check those
  yourself. Other keys are ignored, but adding one
  still counts as a change.
- **An update that only adds places can keep running.** This works for an app in your
  own folder that the person approved on a DorkOS release that records places. The app
  keeps its old places, and only the new ones wait for the person's OK ("Not now" leaves
  it running without them). It counts only when `contributions` gains known places, each
  set to `true`, and nothing else changes: the same files, every other file byte for
  byte, and the same `version`. If you also changed code, bump `version`, and the whole
  app asks again, as every update does. An app from the personal marketplace always
  bumps its version, so every change there is a new card.
- **Names that pass for DorkOS are refused.** An app named "DorkOS…", or exactly a
  DorkOS page name (Settings, Inbox, Activity, Connections, Marketplace, Security,
  Tasks, Team, Apps, Workspaces, Channels, DorkBot), won't install or start. Spacing,
  case, accents and look-alike letters don't get around it. A name that mixes Latin
  letters with letters from another alphabet is refused too. DorkOS's own scan and the
  marketplace install check `name` in `extension.json`; `create_extension` checks the
  name you give it. If the app gives agents tools, its name must use plain letters A to
  Z, at most 40 characters, with no quotes.

Rules of thumb:

- **One main surface.** Many apps want two: a page plus a narrow panel tab, or a page
  plus its settings tab. Each extra surface needs a reason the person agreed to.
- **Panel tabs set `showIn`** to the pages, agents or rooms where they matter. Never `'*'`
  unless the person asked for everywhere.
- **The status bar is shared and scarce.** Use `when` so the item only shows when it has
  something to say. Keep `when` and `urgent` pure: read only `ctx`.
- **Nothing may pass for DorkOS.** DorkOS draws the app's name itself on its ⌘K rows,
  dialogs and Inbox cards, so leave the name out of ⌘K labels and dialog titles
  ("Refresh the forecast", not "Weather: refresh"). ⌘K search reads only the label, so
  make it say what the command does. Also:
  - Pick a name that isn't reserved ([above](#declare-every-place-in-contributions)),
    and no names of agents.
  - Keep titles and labels plain text, and never style anything like an approval card or
    use DorkOS's mark.
  - **Never ask for a password, code, key or sign-in inside the app.** A dialog that asks
    for credentials is phishing, whatever it looks like. Sign-ins go through DorkOS
    Connections.
  - **The app never stands in for DorkOS's approval.** Anything that needs the person's
    OK (permissions, spending, sending outside DorkOS) goes through DorkOS's own approval
    card. An in-app "Approve" button can only record the person's own decision in the
    app's own data.
- **Every surface you add goes in the reach list** you give the person (SKILL.md), so the
  slots are part of what they approve.

## Open platform gaps (check whether each is still open)

- **DOR-4257:** the `sidebar.footer` slot draws an item that does nothing when clicked.
  Don't use it.
- **DOR-4258:** in the sandboxed frame (API v2), a status-bar item's `when` is dropped, so
  it always takes the shared slot. Until fixed, register it only if it always has
  something to show. Panel-tab icons also fall back to a puzzle piece (DOR-4130).
- **DOR-4259:** `create_extension` has no page template. For a page, scaffold the closest
  client-only template, then replace its registration with `registerPage` and update
  `contributions`.
- **DOR-4260:** the authoring guide still describes a retired sidebar "Add-ons" section.
  Pages are reached from Apps, ⌘K and sidebar pins.

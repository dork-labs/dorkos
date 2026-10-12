# Mini-app placement and navigation

**Status:** specified · **Date:** 2026-10-12 · **Spec id:** 261012-191847

## The ask

Dorian, 2026-10-12 in #dorkos:

> Let's move forward with allowing Mini Apps to show for specific agents. It shouldn't be limited to a single agent... we should be able to create rules for what agents, channels and/or pages it shows in the right panel for. … For our marketing queue mini app, it should be a visible tab for the dorkos agent, the dorkos-marketing agent, #dorkos room and #dorkos-marketing room.
>
> If a mini-app exists on its own page, it's nice that we can get to it from the command palette, but there should also be other ways to navigate to it.

## Today

- A mini app adds a right-panel tab with `api.registerComponent('right-panel', id, Component, { label, icon })`. The factory drops any `visibleWhen`, so **every mini-app tab shows on every page** (`extension-api-factory.ts` `adaptToContribution`).
- A mini app's page (`api.registerPage`) is reachable from the command palette (searched only), the phone's You → Add-ons list, an app tab once opened, and a typed URL. On a desktop there is no standing link to it.

## Part 1: where a tab shows

### The rule model

A placement is two target lists, **show** and **hide**. Each list names agents, rooms and pages:

```ts
interface PlacementTargets {
  agents: string[]; // agent ids
  rooms: string[]; // room ids (channels and direct messages on this computer)
  pages: string[]; // page keys ('activity', 'session', 'channels', 'x/<extId>', …); '*' = everywhere
}
interface MiniAppPlacement {
  show: PlacementTargets;
  hide: PlacementTargets;
}
```

Only `pages` takes a wildcard. "Every chat" is page `session` and "every channel" is page `channels`, so agents and rooms only ever hold real ids.

**Where am I** (`usePlacementHere`):

| Route                            | Here                                   |
| -------------------------------- | -------------------------------------- |
| `/session`                       | `{ page: 'session', agentId }`         |
| `/channels?id=R` (this computer) | `{ page: 'channels', roomId: R }`      |
| `/channels?community=…`          | `{ page: 'channels' }` (no local id)   |
| `/` (Home is #team)              | `{ page: 'home', roomId: <#team id> }` |
| `/activity`, `/tasks`, …         | `{ page: 'activity' }` …               |
| `/x/<extId>/…`                   | `{ page: 'x/<extId>' }`                |

The agent comes from the agent query for the chat's folder, not the store's `currentAgentId`, which an effect sets a moment later. While Home's #team lookup or the chat's agent is still loading, "here" is **pending**: the panel keeps the last answer, skips its auto-select (which would otherwise overwrite the tab the person was on), and hides the ⋯ menu (a pick made then would be written for the place just left).

**Matching** (`placementShows`, pure, shared by the panel and Settings): hidden if `hide` matches; otherwise shown if `show` matches. "Matches" is a union: `pages` holds `'*'` or `here.page`, or `rooms` holds `here.roomId`, or `agents` holds `here.agentId`. An AND rule (agent X only inside room Y) has no customer.

**Hide here / Show here** act on the most specific target for here: the room in a room, the agent in a chat, the page elsewhere. Where nothing narrower than "every chat" or "every channel" exists (a chat with no agent, a community room), neither is offered.

- Hide here removes that target from `show`, and adds it to `hide` only if a wider entry still covers here. Nothing wider is removed, so hiding a tab in one channel never hides it in the others.
- Show here removes **every** `hide` entry that matches here (so a broad hide can never silently win), then adds the target to `show` unless `show` already matches.

### Who sets it

Three layers, last one wins:

1. **Everywhere** (`show.pages = ['*']`). Today's behavior, so no existing mini app changes.
2. **The mini app's declared default**: `registerComponent('right-panel', id, C, { showIn: { agents?, rooms?, pages? } })`. Agent and room ids belong to one computer, so the docs steer shared mini apps to pages and leave specific agents and rooms to the saved choice.
3. **The saved choice**, `ui.panelTabs`: one entry per tab, replacing the declared default whole. "Use its default" removes the entry.

**Agents may write the saved choice.** `ui.panelTabs[]` leaves are `agent-writable`. Principle 1 (trusted by default) settles it: where a tab shows grants the mini app nothing; its code already runs or not by the `extensions.*` approvals. Every agent write goes through `config_patch`, which is in the record. The saved choice is shared by everyone using this DorkOS, like sidebar pins.

### Storage

```ts
ui.panelTabs: Array<{ tab: string /* '<extId>:<tabId>' */; show: PlacementTargets; hide: PlacementTargets }>
```

- Under `ui` beside `ui.statusBar.pins`, not under `extensions.*`, whose write-policy line ("decides which code runs") stays true.
- A list, because `PATCH /api/config` replaces lists and deep-merges objects: with a record, "reset this tab" could not be written. The client writes the whole list built from its cached config, as sidebar and status-bar pins do. A concurrent agent write can be overwritten; the refetch after every write shows the result. Acceptable for a preference changed by hand a few times; a server-side read-modify-write tool is the upgrade if it ever bites.
- Every element field is a plain string, never an enum, so a newer build's page key cannot condemn an older build's file (`widened-leaves.ts`).
- Seeded `[]` on disk by migration `0.112.0` (`seedUiPanelTabs`): a nested leaf in a section stored configs already have, so nothing else writes it.
- Returned by `GET /api/config` under `ui.panelTabs`. Disclosure `expose` (it names room ids, as `ui.sidebar.pinned` already does).

### The UI

**Settings → Extensions**, on each running mini app's card with a right-panel tab, **Panel tab shows**: Everywhere / Only in…, chips for each chosen agent, channel and page (removable), an **Add** picker (search across agents, channels and DMs, and pages), **Hidden in** chips when `hide` is not empty, and **Use its default** (or **Reset**) when a saved choice exists.

**In the right panel**, one **⋯** button in the header (a 375px panel has no room for three): **Open full page** (the mini app's home page, when it has one), **Hide here**, **Where it shows…** (opens Settings → Extensions scrolled to the card), and a **Show here** list of mini-app tabs hidden here.

## Part 2: getting to a mini app's page

Dorian's 2026-10-12 ask supersedes `flow-multiproject` N10 ("no sidebar entry for extension pages"). Picked, with why:

1. **An "Add-ons" section in the sidebar Library.** Lists every mini app with a menu page, by its own title and icon, active when you are on it, foldable (persisted section id `addons`), absent when there are none. "Add-ons" is the word the app already uses for these pages (palette group, phone menu, tab fallback label); "Apps" already means Connections. It replaces the phone's You → Add-ons list, since the phone's Library shows the same section.
2. **Open full page from the right-panel tab** (above).
3. **Deep links already work** (`/x/<id>`), and app tabs already remember an open page. Nothing to build.

Not built, and why:

- **Agent profile list.** Placement already puts the tab beside the agent; a second list on the profile repeats it.
- **Room header button.** Same reason, and the header is crowded with run state.
- **Activity.** Activity is for things that need you; a mini app's page badge already reaches its app tab.

## Build plan (PRs)

1. **Placement** (DOR-2867): shared schema + matcher, `ui.panelTabs` (schema, migration, write policy, disclosure, `GET /api/config`, docs), extension API `showIn`, right-panel filtering, the ⋯ menu, Settings "Panel tab shows". Unit tests for the matcher and the UI; a browser test for hide here / show here.
2. **Add-ons section** in the sidebar (DOR-2868), with tests.
3. **Social Queue's four places** (DOR-2869): written as the saved choice in `ui.panelTabs` once the feature runs in Dorian's app, not hard-coded into the mini app.

Docs: `contributing/extension-authoring.md`, `docs/integrations/extensions.mdx`, `contributing/configuration.md`, `docs/getting-started/configuration.mdx`, the agent-facing API reference (`extension-tools.ts`) and the `right-panel-tab` template. A changelog fragment per PR.

## Review

An adversarial review (Opus, 2026-10-12) found one blocker (a broad hide could beat a narrow Show here) and twelve smaller issues. All are folded in above: the storage move to `ui.panelTabs`, the seed migration, the pending state, no Hide here where here is too broad, pages-only wildcard, `extensionId` on the contribution, one ⋯ button, the Add-ons name, and the N10 supersession. Not done: a marker dot on hidden tabs in the Show here list, and a UI command that opens a hidden tab still does nothing.

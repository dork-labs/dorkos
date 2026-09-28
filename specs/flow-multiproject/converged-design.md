# Flow across many projects: the agreed design

Built from rounds 01–05. **Operator decision 2026-09-28: no Private feature and no Presenting mode.** Every project shows the same way everywhere. The goal was the best experience, so feasibility is judged later (see the last section).

## Definitions

- **Project**: the git main checkout that contains a flow install.
  - Worktrees (including `~/.dork/workspaces/*`) and subfolders count as part of their main checkout.
  - A folder that holds several repos, or none, is **no project**.
- **Decision**: something that needs a human, with an owner, an action and an end. Decisions go to the inbox.
- **Condition**: a state that persists, such as paused, nothing ready, or tracker unreachable. A condition lives with its subject and becomes a decision only by escalation.
- **No engine words on any surface.** "Nothing ready to work on", never "starved"; "Building", never "EXECUTE". The stage spine never leads a surface.

## Layers and surfaces

| Layer     | Owner                    | Surface                                                | Shows                                                                                                                                     |
| --------- | ------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Machine   | **DorkOS core**          | Account chip, out-of-usage banner, Settings → Accounts | The account pool: rotation, usage, the reserve on Main, handoff mode. Flow reads the pool and advises it; it never writes to core chrome. |
| Attention | DorkOS core, fed by flow | The one Activity inbox                                 | Decisions only: review gates, questions an agent asked, "blocked, needs you", escalated conditions. Tagged and grouped by project.        |
| Project   | flow                     | Flow tab, project lens; project settings → Flow        | One project: its runs, queue, conditions, pause, tracker link, and settings link.                                                         |
| Run       | flow                     | A chip in the chat header                              | The one run this chat _is_.                                                                                                               |
| Portfolio | flow                     | Flow home (`/flow`)                                    | All projects, sorted by attention. A second tab, "Capacity this week", shows spend per project and per account.                           |

## Flow home (`/flow`)

- **Order:**
  1. "Needs you": decisions, linking to their inbox items.
  2. Projects with a live condition, one plain line each.
  3. Quiet projects, one line each with counts.
- **Header:** "Pause all projects". While paused, it reads "Paused until 9:00", with a Resume button.
- **Capacity this week** is a secondary tab and never the default.
- **Exists only at 2 or more projects.** At 1 project, `/flow` redirects to that project's lens, so links never 404.

## Flow tab (right panel)

- **Absent at 0 installs.** Present from the first install on, always in the same position.
- **Two lenses, named in the header:**
  - **Project lens** (the chat is in a flow project). The header reads "client-api · Linear API" with Pause and Settings. The body shows runs, the queue and conditions. The footer reads "2 need you elsewhere →" when it applies.
  - **All-projects lens** (the chat is in no project, or a folder without an install). It's thin: only projects with a decision or a condition, one line each, then "Open Flow home →". It is not a second copy of the home.
- **Label marker** (inside the tab's own surface, not chrome). It shows only when a decision is waiting or everything is paused, with no count and nothing for ordinary conditions.
- **A folder with no install** gets one quiet line, "Set up flow here", and never a banner.

## Run chip (chat header)

- **Present facts only:** "DOR-2387 · Building", linking to the tracker item and to the project lens. It never forecasts.
- **Quiet state:** "Last update 2h ago".
- **Ended state:** "Merged · closed".
- **Phone:** shows the ID and the state; the title is dropped.

## What each surface shows, by situation

| Situation                       | Tab                                                                          | Home                                                                                                              | Inbox                                                                                                                | Chip                                           |
| ------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **1 project**                   | The project lens in that project; the all-projects lens elsewhere (one line) | Hidden; redirects to the lens                                                                                     | Decisions, tagged                                                                                                    | As usual                                       |
| **2–15 projects**               | The lens follows the chat                                                    | Sorted by attention; quiet projects collapse                                                                      | Grouped by project                                                                                                   | As usual                                       |
| **Chat in a non-flow folder**   | Thin all-projects lens, plus "Set up flow here" if the folder is a repo      | n/a                                                                                                               | n/a                                                                                                                  | None                                           |
| **Phone**                       | No right panel                                                               | The home is the project list, and tapping a project opens its lens as a page. At 1 project, the lens is the page. | Push notifications for decisions only                                                                                | ID and state                                   |
| **First install, unconfigured** | The lens is setup: "Connect a tracker to start".                             | Counts the project as "Not set up"                                                                                | Nothing                                                                                                              | None                                           |
| **Broken tracker**              | Header line: "Can't reach Linear since 09:14 · Reconnect"                    | A condition line                                                                                                  | After that condition's time limit, one decision: "Reconnect Linear for client-api". It resolves itself on reconnect. | Goes to the quiet state if its data goes stale |

## Pause

- **Per project:** in the lens header and the command palette.
- **All projects:** in the home header and the command palette.
- **Every pause offers a duration:** "Until tomorrow 9am" (the default for Pause all), "For 1 hour", or "Until I resume". A paused state always shows its end time and a Resume button, and it sets the tab's label marker when every project is paused.
- **Usage emergencies need no human pause.** The account pool hands off and keeps the reserve on its own.

## Settings tiers (each labelled by who a change affects)

1. **This machine.** In core DorkOS: the account pool, the reserve, handoff mode.
2. **This project, shared with the repo (committed).** Tracker and team, labels, the review policy, schedules. The UI says plainly that saving changes a file in the repo.
3. **This project, just me (local).**
   - Autonomy, WIP caps and the per-project pause default.
   - **Account eligibility.** A per-project allowlist that core enforces. For example, a work account is allowed only for client-app; personal repos never touch it.

## Escalation rules

1. At most **one live inbox item per project and condition**, keyed, so a flapping condition never makes duplicates.
2. **An item that clears itself moves to history** as "resolved on its own at 11:02"; it never vanishes.
3. **Each condition has its own time limit before escalating**, and the item shows it. Examples:
   - an unreachable tracker escalates after a set time;
   - "nothing ready" escalates only when a project with capacity has sat idle for over 24h _and_ has items waiting to be triaged ("12 ideas are waiting in dorkos. Triage now?");
   - most conditions never escalate.

## Version skew

There is one UI, from the newest install. A project shows "runs an older flow, update" only when the difference changes behaviour. Otherwise it's silent.

## Residual disagreements

None on the experience. Items left for later, not disputed:

- **Exact time limits** for each condition, set by use.
- **Feasibility work:**
  - moving the account pool into core;
  - core enforcing per-project account eligibility;
  - a tab label with a state marker in the extension API;

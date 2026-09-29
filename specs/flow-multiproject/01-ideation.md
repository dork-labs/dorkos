---
slug: flow-multiproject
id: 260928-190705
created: 2026-09-28
status: specified
tracker: DOR-2517 (first phase), plus the core issues this spec's phases open
project: Flow across many projects
design: specs/flow-multiproject/design-decisions.md (binding: V1-V6 by the operator, N1-N10 by the orchestrator), converged-design.md, design/*.html
companion: dork-labs/marketplace specs/flow-multiproject/ (the flow extension's UI, built against §11 of 02-specification.md)
---

# Flow across many projects: core seams

## Problem

Flow works well in one repo. Most people who use it run it in several: their own tool, a side project, and a client's repo, each with its own tracker. Today that breaks down in four places, and only one of them is flow's to fix.

1. **Nothing tells you an extension is waiting.** A plugin that carries an extension installs quietly. Its code does not run until someone clicks "Allow it to run" deep in Settings → Extensions, so the Flow tab simply never appears and nothing says why (DOR-2517).
2. **DorkOS has no idea what a "project" is.** Two files work out a repo's main checkout from a folder, each a little differently, and an extension cannot ask. So flow cannot say "this chat is in dorkos" or group anything by project.
3. **Only one project's flow is visible at a time.** The server scans one working folder for plugin-carried extensions, so which copy of flow loads depends on where the server happens to be pointed.
4. **Any account can land in any repo.** A work account meant only for client-app can be picked for a personal repo by a schedule, a relay message, an automatic handoff or the default account. The rule the person wants ("only for client-app") lives in flow's own file, which core never reads, so most launch paths ignore it.

Flow also has nowhere to put what it knows: no page of its own, no chip in the status bar, no way to raise a question in the inbox, and no way to mark its tab when something needs you.

## Who it is for

- **Kai** runs ten agents across five projects. He needs one inbox that says which project each question belongs to, and he needs his client's account to stay in the client's repo without thinking about it.
- **Priya** reads the source before she adopts anything. She wants each capability to be a documented, typed extension seam with tests, not a special case wired into core for one plugin.
- **Ikechi** directs agents but does not read code. When he installs flow, he should see one plain row asking "Turn on Flow?" that says what it adds and why, with thumbs up and thumbs down, not a hidden setting.

## The agreed experience (summary)

The full design is `converged-design.md`, refined by `design-decisions.md`.

- **A project** is the git main checkout of a folder. Worktrees and subfolders belong to it; a folder outside any repo is "no project".
- **The inbox** is the one place for decisions. An extension waiting for approval shows one short row ("Turn on Flow?", a why line, ⓘ 👎 👍). Flow's review gates, questions and escalated conditions use the same row, and every ask says why. A question carries the agent's pick and a deadline, so a person is never the bottleneck. After an answer, the row may offer once to do it on its own next time; what agents and rules decided on their own shows in Activity under "While you were away". Rows group under a small project heading once two or more projects are present.
- **The Flow tab** follows the chat's project (project lens) or shows every project that needs something (all-projects lens), and gets a small amber dot when a decision is waiting.
- **Flow home** is a full page at `/x/flow`, listed in the command palette and the phone's "Add-ons" menu.
- **The run chip** sits in the status bar beside the runtime and account chips, and can show several items for one chat.
- **Starting work** is an outcome button ("Sort them"). One click starts it in a new chat whose title and first line say what and why; no command is ever the headline.
- **Settings** has three tiers: this computer (core, unchanged), shared with the repo (flow), and just me (flow), where "Accounts this project may use" writes a rule that core enforces.

## What is core and what is flow

| Core (this spec)                                                                                                                                               | Flow (marketplace `specs/flow-multiproject/`)                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The `extension.approval` inbox row and its lifecycle (DOR-2517)                                                                                                | When to raise a decision, and each condition's time limit                                                    |
| The inbox decision row, `ctx.inbox`, the `extension_decisions` table, grouping by project                                                                      | The Flow tab's two lenses, Flow home, the project lens page                                                  |
| The project registry and `resolveProjectRoot`                                                                                                                  | Flow's own install discovery, which reports into the registry                                                |
| Extension-API seams: tab marker, `currentProject`, pages at `/x/<id>/<path>`, the status-bar slot, `ctx.projects`                                              | The run chip component, the settings component (V6) and its project switcher                                 |
| Scanning every known project for plugin-carried extensions                                                                                                     | "Runs an older flow, update" when versions differ in a way that matters                                      |
| Account eligibility: the config fields, enforcement at every pick site, the refusal, the "Only for" line in Settings → Runtimes, the per-project allowlist API | The V6 checkboxes that call that API, and moving the old `fleet.json` "only for these repos" chips into core |
| One chat, many items: `Session.trackerItems`                                                                                                                   | Reading the list for the chip                                                                                |

Every core piece is a general seam. Flow is its first user, never a special case, so any other extension can use the same seam the same way.

## Phases

1. **DOR-2517**: the extension approval row. Small, high priority, ships on its own.
2. **Projects and extension seams**: the project registry, inbox decisions (why, questions with deadlines, follow-up offers, who decided), grouping, pages, the status-bar slot, the tab marker, `currentProject`, `ctx.projects`, starting work in a new chat, and many tracker items per chat.
3. **Account eligibility**.
4. **Extensions across many projects, and trusted sources** ("Next time, trust everything from this source?").

Details, contracts and tests are in `02-specification.md`.

# Tab identity: every tab says who or where, and whether it needs you

**Ticket:** DOR-2820 (Urgent, approved by Dorian 2026-10-09). The full brief lives on the ticket; this file is the build plan and the decisions it needed. Ideation is the ticket itself, so there is no `01-ideation.md`.

## Problem

The desktop tab strip, the tab's tooltip, the Back/Forward History menu, `document.title` and the native window title each work out a page's name on their own. They drift: a chat tab read "Session" while the title bar named the last-selected agent, and every non-chat route's `document.title` names that agent too. Statuses are partial: "Paused" (out of usage) never shows on a tab because `limitStatus` is never passed, and the `(N)` count never counts schedules because `setTasksBadgeCount` is never called.

## Decision: one builder

One pure function turns resolved data into a **tab identity**, and one hook gathers that data for an href. Every surface reads the identity, so they cannot disagree.

```ts
// features/app-tabs/lib/tab-identity.ts (pure, no React)
type TabStatus = 'needs-you' | 'failed' | 'paused' | 'working' | 'new';

interface TabIdentity {
  icon: TabIcon; // { kind: 'emoji', emoji, color? } | { kind: 'route', Icon } | { kind: 'extension', icon }
  primary: string; // "Scout", "#general", "Schedules"
  secondary?: string; // chat title, "3 working", "Billing", a search
  status?: TabStatus; // at most one; idle is absent
  statusSentence?: string; // one plain sentence for the hover card and screen readers
  count?: number; // unread / needs-you / waiting count
  countEmphasis?: boolean; // an @mention: the count reads as urgent
  lastActiveAt?: number; // epoch ms, "2 min ago" in the hover card
  accessibleName: string; // "Scout, Fix the login bug, Needs you: Waiting for your OK to push to GitHub"
}
```

`useTabIdentity(href, opts?)` replaces `useTabTarget`. The strip, the hover card, the History rows and the document/window title all call it (the title for the active tab's href). `windowTitle(identity)` builds the title string.

A seam for DOR-2790 spin-off chats: the hover card renders an optional `origin?: string` line ("Started from …") when the identity carries one. Nothing sets it in this ticket.

### Status: one wins, in this order

1. **needs-you**: a pending approval or question.
2. **failed**: the last turn failed.
3. **paused**: out of usage (`sessionLimitDisplay`); the reset time goes in the sentence.
4. **working**: streaming.
5. **new**: finished while you were away; clears when seen.
6. idle: nothing shown.

`pickTabStatus(signals)` is the one place this order lives, pinned by a table test. Colours and words come from the shared `status-dot` tokens (add `paused` there if missing) so the strip matches the sidebar. Chat tabs pass `limitStatus` into `useSessionBorderState`, which fixes Paused never showing.

### Hover sentences

Plain, dry, at most 15 words (`writing-app-copy`). Examples:

| Status               | Sentence                        |
| -------------------- | ------------------------------- |
| needs-you (approval) | Waiting for your OK to run Bash |
| needs-you (question) | Waiting for your answer         |
| failed               | The last reply failed           |
| paused               | Out of usage until 3:40 PM      |
| working              | Working: running tests          |
| new                  | Finished while you were away    |

Pinned by tests. A chat's sentence uses the tool or activity the stores already hold (`SessionVerbLine`'s verb, the pending interaction); when nothing more is known it falls back to the bare status word.

### Every route

| Route                                  | Icon                      | Primary · secondary                          | Status / count                            |
| -------------------------------------- | ------------------------- | -------------------------------------------- | ----------------------------------------- |
| `/session`                             | agent emoji in its colour | **Agent** · chat title                       | chat lifecycle                            |
| `/channels?id=` channel                | `#`                       | **#name**                                    | unread count; @mention emphasised         |
| `/channels?id=` DM                     | person/agent avatar       | **Name**                                     | unread count                              |
| `/channels` (none picked)              | channels                  | **Channels**                                 | unread rooms count                        |
| `/`                                    | home                      | **Home**                                     | needs-you count                           |
| `/team`, `/agents`                     | team                      | **Team** · N working                         | hottest agent status                      |
| `?panel=profile&profile=` (any route)  | agent avatar              | **Agent** · Profile                          | that agent's status                       |
| `/tasks`                               | clock                     | **Schedules**                                | running / N failed / waiting for approval |
| `/activity`                            | activity                  | **Activity**                                 | new count                                 |
| `/connections`                         | plug                      | **Connections**                              | N waiting requests                        |
| `/marketplace`, `/marketplace/sources` | store                     | **Marketplace** · search, package or Sources | none                                      |
| `?settings=` (any route)               | gear                      | **Settings** · section                       | none                                      |
| `/workspaces`                          | folder                    | **Workspaces**                               | none                                      |
| `/feedback-requests`                   | inbox                     | **Your reports**                             | none                                      |
| `/x/<ext>`                             | its icon                  | its title                                    | its own badge (new extension API)         |

The Settings dialog and the profile panel are not routes; they sit over one. While open they are what the person is looking at, so they name the tab. A drift test fails when `APP_ROUTE_PATHS` gains a route with no identity.

### Smart names

- Two or more open chat tabs on the same agent collapse the agent to its emoji and lead with the chat title, so they can be told apart.
- The active tab gets more room (wider max width); pinned tabs shrink to icon plus status dot.
- Text truncates with an ellipsis; the hover card always has the full text.

### Window and browser title

`windowTitle(identity)`: `[(N) ][🔔 |🏁 ]primary[ · secondary] — DorkOS`. 🔔 when anything needs you; 🏁 when a reply finished while the window was hidden (kept from today). `(N)` while hidden: unread rooms plus waiting schedules, now real. Electron mirrors `document.title`, so the native title follows with no IPC.

### Tab strip interactions

- Context menu on a tab: **Pin** / **Unpin**, **Duplicate**, **Copy link**, **Close others**. Keyboard reachable (Shift+F10 / the context-menu key).
- Drag to reorder with `@dnd-kit/sortable`; pinned tabs stay left of unpinned ones. Keyboard reorder through dnd-kit's keyboard sensor.
- `AppTab` gains `pinned?: boolean` (persisted; old saved tabs read as unpinned).

### Extension API

`registerPage` options gain nothing new; instead `api.setPageBadge(path, { status?, count?, sentence? } | null)` lets an extension page set its own tab status and count. Documented in the extension-api README and `docs/`.

## Delivery

| PR    | Scope                                                                                                                                                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #2702 | The bug fix (done first).                                                                                                                                                                                                                      |
| A     | Builder, `useTabIdentity`, status order, sentences, hover card, History menu, `document.title`, Paused via `limitStatus`, chat/channel/DM/Home/Team/profile/settings/marketplace identities, smart names, drift test, Dev Playground showcase. |
| B     | Pin, Duplicate, Copy link, Close others, drag to reorder, pinned tabs shrink.                                                                                                                                                                  |
| C     | Schedules, Activity and Connections statuses and counts, a real `(N)` (`setTasksBadgeCount`), the extension page badge API.                                                                                                                    |

A and B run in parallel; C builds on A.

## Done means

- Every route in the router has an identity; the drift test fails on a new route without one.
- Tab, hover card, History menu, `document.title` and window title all come from the one builder.
- Status priority and hover sentences are pinned by tests.
- Screenshots of the strip (desktop app and web, light and dark, narrow and wide) in each UI PR.
- Every PR merged through the queue.

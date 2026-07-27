---
title: 'Chat Navigation Patterns — Quick Switchers, Unread, Multi-Select Pickers, and Contextual Actions in Slack, Discord, Teams, and Linear'
date: 2026-07-27
type: external-best-practices
status: active
tags:
  [
    quick-switcher,
    command-palette,
    keyboard-navigation,
    unread,
    chat-ux,
    slack,
    discord,
    microsoft-teams,
    linear,
    multi-select-picker,
    cmdk,
    rooms,
  ]
feature_slug: rooms
searches_performed: 32
sources_count: 38
---

# Chat Navigation Patterns — Quick Switchers, Unread-First Ranking, Recipient Pickers, and Contextual Actions

## Prerequisite: Existing Research

`research/20260303_command_palette_agent_centric_ux.md` and `research/20260303_command_palette_10x_elevation.md` already cover the generic command-palette layer: cmdk's API, the global `Cmd+K` binding, frecency basics (Slack's bucket formula is reproduced there in full), group structure, fuzzy-highlighting libraries, sub-menu drill-down, and FSD placement. This report does not repeat any of that. It covers what those two do not: the parts of quick-switcher UX that are specific to a **chat surface with channels and DMs** — prefix grammar, zero-query ranking against unread state, disambiguation, recipient pickers, and how a palette stays in sync with a right-click menu.

`research/20260716_slack_sidebar_organization_ux.md` also already covers Slack's Quick Switcher frecency algorithm and its Cmd+[ / Cmd+] history navigation in detail (§7 of that report) — referenced here, not restated.

---

## Research Summary

Across Slack, Discord, and Microsoft Teams, quick switchers converge on one shape (fuzzy type-ahead over a flat list of destinations, opened with a global shortcut) but disagree sharply on three things: whether the switcher uses a prefix grammar at all (Discord: yes, four symbols, documented; Slack: yes, two symbols, lightly documented; Teams: no prefix grammar, but a separate `Ctrl+G` switcher exists precisely _because_ its merged search/command box became unusable as a switcher), whether unread beats frecency in the empty state (Slack: yes, explicitly and by design — unread channels are shown first and capped at 24, with plain frecency only kicking in once you type), and whether the switcher does anything besides navigate (Discord: no, navigation only, by explicit design; Slack: navigation only; Teams: yes, its box is deliberately dual-purpose and that fusion is the industry's clearest cautionary tale). Discord's channel-name disambiguation across servers is a long-standing, still-open complaint — it is not a solved problem, and DorkOS should not assume Discord "figured it out." Linear is the strongest reference for contextual actions: its palette and right-click menu are provably the same list, generated from one pure function, which is the mechanism (not just the goal) worth copying. Recipient pickers for group conversations converge on Slack's shape — typeahead-to-chips, one action to start — across Slack, Discord, and Teams, and this exact shape has already been chosen for DorkOS's own DM picker (`specs/rooms/02-specification.md` §12.3).

---

## Key Findings

1. **Discord's prefix grammar is real, documented in two independent official sources, and narrower in scope than it looks.** `@` scopes to users, `#` to text channels, `!` to voice channels, `*` to servers — confirmed identically by Discord's own support article and its own blog post on keyboard shortcuts. But the grammar only _filters by type_; it does nothing to disambiguate which server a same-named channel belongs to, which is the single most-repeated Discord quick-switcher complaint in Discord's own community forum.

2. **Slack's grammar is two symbols, not four, and undocumented in Slack's primary keyboard-shortcuts help article.** `#` restricts to public channels, `@` restricts to people/DMs — found only in a regional Slack help mirror, not in Slack's flagship "Navigate Slack with your keyboard" article. This is itself a discoverability finding: Slack ships the feature but does not consistently teach it.

3. **Slack deliberately ranks unread above frecency in the zero-query state, and says so in its own engineering writing.** Opening Quick Switcher with no text shows "a user's unread channels and direct messages," capped at 24 — a specific, considered design constant, not "whatever's recent." The frecency formula (bucketed recency × frequency) only governs ranking _once you start typing_; it is not what decides the empty-state order.

4. **Teams shipped the cautionary tale directly: one merged search-and-command box, later followed by a second, separate switcher.** `Ctrl+E` opens Teams' search bar, which doubles as a command bar (type `/` for slash commands like `/call`, `/dnd`, `/chat`). Teams later added `Ctrl+G` — a dedicated "Go to" switcher whose only job is jumping to a chat or channel by name. Two keyboard shortcuts for two different jobs is itself evidence that the merged box didn't fully work as a switcher.

5. **Discord's quick switcher is navigation-only by explicit design; it performs no actions.** Nothing in Discord's switcher creates a channel, sends an invite, or starts a call — those live in the regular UI, reached by hover affordances and right-click. Slack's switcher is the same: purely a destination-finder, with creation/actions living behind a separate "+" button.

6. **Linear's palette and right-click menu are not just similar — they are generated from the same function**, and the mechanism, not merely the intent, is documented: Linear's sync engine "was designed in part so that any action could be performed at any time," and its own writing states you can "simply right-click to take the action with the mouse, or remind yourself of the keyboard shortcut" — both surfaces read the same action list. This is exactly the pattern DorkOS has already picked for rooms: `buildRowMenuNodes(model)` feeds both the context menu and the `…` dropdown "through the same walk, so a hand-copied second list cannot drift out of step" (`specs/rooms/02-specification.md` §12.4).

7. **All three chat apps converge on Slack's shape for multi-recipient pickers: typeahead → chips → one action to start.** Slack's own help documentation describes this loosely; Discord's group-DM creator uses checkboxes instead of a typeahead-to-chip flow but the outcome is the same (a running selection, one commit action); Teams' "New chat" `To:` field is typeahead with implicit comma-free separation and an optional "Group name" step revealed by a chevron.

8. **Duplicate-conversation prevention is a server-side idempotency rule, not a client-side filter — and Slack's own behavior ("re-opening a conversation with the same people opens the same conversation") is the model DorkOS has already adopted**, moving away from an earlier client-side "hide agents already in a DM" filter that broke the moment group DMs existed (`specs/rooms/02-specification.md` §12.3).

9. **The favicon/title unread pattern is a two-part convention** (leading `(N)` or `•` in the document title; a numbered favicon overlay for the tab strip itself) used identically across Gmail, GitHub, Linear, and Discord, and Slack additionally distinguishes a bare dot (unread activity somewhere) from a numeric badge (a DM, mention, or keyword hit) on its app icon.

10. **DorkOS's `specs/rooms/02-specification.md` §13 has already independently converged on several of this report's findings** — unread-first zero-query ranking, keeping message search out of the palette (citing the same Slack-vs-Teams contrast as a "cautionary example"), and next/previous-unread bound to `alt+↑`/`alt+↓` (citing Discord). This report's job is to confirm those calls against primary sources and fill the gaps that spec section left open (exact sigil precedent, recipient-picker keyboard mechanics, favicon/title mechanics, anti-pattern evidence).

---

## Detailed Analysis

### 1. Quick switchers, precisely

#### Prefix/sigil grammar

**Discord** — four symbols, confirmed identically by Discord's own support article and Discord's own blog post (independent corroboration, not just one source restated):

| Symbol | Scope                                         |
| ------ | --------------------------------------------- |
| `@`    | Usernames (friends and mutual-server members) |
| `#`    | Text channels                                 |
| `!`    | Voice channels                                |
| `*`    | Servers (guilds)                              |

The switcher's placeholder text is literally "Where would you like to go?" — it announces itself as pure navigation. ([Discord — Quick Switcher](https://support.discord.com/hc/en-us/articles/115000070311-Quick-Switcher), [Discord blog — How to Use Keyboard Shortcuts on Discord](https://discord.com/blog/how-to-use-keyboard-shortcuts-on-discord-create-custom-keybinds), [The Discord Wiki mirror](https://github.com/ItzHalcyon/The-Discord-Wiki/blob/master/quick-switcher.md))

**Slack** — two symbols only, and comparatively poorly documented. Slack's flagship keyboard-shortcuts article ("Navigate Slack with your keyboard") does not mention them at all; they surface only in a regional help-center mirror:

| Symbol | Scope                         |
| ------ | ----------------------------- |
| `#`    | Public channels only          |
| `@`    | Direct messages / people only |

This is a genuine discoverability gap on Slack's part, not just a gap in my search: the shortcuts page a first-time user is most likely to find omits the grammar entirely. ([Slack Help — Navigate Slack with your keyboard](https://slack.com/help/articles/115003340723-Navigate-Slack-with-your-keyboard) — silent on this; grammar sourced from a Slack help-center mirror only)

**Microsoft Teams** — no prefix grammar in its `Ctrl+E` search/command box. Instead it uses a `/` leader for an entirely different vocabulary: slash _commands_, not scope filters (`/call`, `/dnd`, `/chat`, `/mentions`, `/keys` to open the shortcuts reference). This is a different mechanism solving a different problem (invoking an action vs. narrowing a destination search), and conflating the two is arguably the root of Teams' anti-pattern (see §5 below). ([Microsoft Support — Use commands in Microsoft Teams](https://support.microsoft.com/en-US/teams/chat/use-commands-in-microsoft-teams))

**Linear** (non-chat control) — no destination-type sigils, because Linear's palette is scoped to _actions on the current object_, not to picking between object types the way a chat switcher must. Its comparable grammar is `G` then a letter for "go to" navigation and `O` then a letter for "open" flows (documented in the prior command-palette research), which is a different axis entirely — sequential mnemonic chords, not a leading character inside a single search field.

#### Zero-query state, and whether unread wins

**Slack is the only one of the three with an explicit, sourced design statement on this.** Slack's own engineering blog states the redesigned Quick Switcher "displays a user's unread channels and direct messages on open, and limit[s] those to a reasonable number — we settled on 24." This replaced an earlier version that showed _all_ team channels and members on open, which caused real performance problems at scale. Separately, Slack's 2014 changelog states "Channels with unread activity are now bumped to the top of the Quick Switcher." Put together: **the zero-query list is unread-first, not frecency-first** — frecency (the bucketed recency × frequency formula from the prior research report) is what ranks results _once you type a query_, not what decides the empty-state order. ([Slack Engineering — A Faster, Smarter Quick Switcher](https://slack.engineering/a-faster-smarter-quick-switcher/), [@SlackHQ 2014 changelog tweet](https://x.com/slackhq/status/500408903645941761))

One nuance found and worth flagging: a 2020-era community report claimed Slack briefly auto-selected the first unread channel so that `⌘K` → `Return` repeatedly cycled through unreads, and that this behavior broke around September 2020. I could not confirm current status either way — **treat "unreads are listed first" as confirmed, and "the first unread is pre-selected for one-keystroke cycling" as unconfirmed / possibly Slack-version-dependent.**

**Discord's zero-query state is also unread-weighted but scoped differently: current-server-first.** Per an unofficial but detailed wiki mirror of Discord's own UI copy: with no query, the switcher shows "unread mentions, any unread channels in the current server, and your last visited channel." Note the scoping — Discord's default view privileges the _server you're currently in_, not a global unread list across every server the way Slack's does. I did not find an official Discord source stating this as explicitly as Slack's engineering post states its own equivalent; **treat this as moderate-confidence, sourced from a well-regarded community wiki rather than Discord's own docs.**

**Teams' `Ctrl+G` "Go to" switcher** is newer (public-preview-era) and its zero-query ranking is not documented in any source I found beyond "frequently used conversations" — **explicitly unconfirmed whether unread beats recency there.**

#### One surface or two: navigation vs. message search

This is the most consequential finding in the whole brief, because it is a decision, not a discovery, and both sides of it are documented.

**Slack keeps them separate on purpose.** `Cmd+K` (Quick Switcher) is navigation across channels/DMs/people. `Cmd+F` is find-in-conversation, scoped by default to the channel you're currently viewing, with message-content search living in a different surface again (the full-workspace `Search in Slack`, `Cmd+G`-style — see the History-navigation discussion in `research/20260716_slack_sidebar_organization_ux.md` §7). I could not find a Slack-published essay arguing _why_ — the split appears to be a design default rather than a debated, written decision — but the practical evidence is strong: nothing in Slack's own docs conflates the two, and third-party guides consistently describe them as different tools for different jobs. ([Slack Help — Search in Slack](https://slack.com/help/articles/202528808-Search-in-Slack))

**Teams merged them, and then partially un-merged them.** `Ctrl+E` is one box that does both "find a person/chat/file" and "run a slash command." This is Teams' own choice, still shipping today. The evidence that it under-serves the "just let me switch" job: Teams later added a second, dedicated shortcut, `Ctrl+G`, whose only stated purpose is "navigate to your frequently used conversation... without context switching" — language that reads as a direct admission the merged box wasn't doing that job well enough on its own. I found genuine, if less sharply worded than hoped, corroborating friction: Microsoft's own 2023 "new Teams" redesign write-up cites "too much information packed into the sidebars and interface" and general navigation confusion as design problems it was trying to solve, though I could not find a source that names the merged search/command box specifically as the complaint (see Contradictions & Disputes). ([Microsoft Support — Navigate conversations with the keyboard in Microsoft Teams](https://support.microsoft.com/en-gb/office/navigate-conversations-with-the-keyboard-in-microsoft-teams-2c0348da-81e0-4298-8597-846b6647a8a3), [Microsoft Design — Designing the new era of Teams](https://microsoft.design/articles/designing-the-new-era-of-teams/))

**Discord doesn't really have this tension** because it has no in-app message-content search shortcut competing with the switcher; Discord's search (magnifying-glass icon, scoped per-channel or per-server) is a separate, mouse-first surface with its own filter-token grammar (`from:`, `has:`, `before:`, etc. — a different vocabulary from the switcher's `@ # ! *`), and nothing suggests Discord ever tried to merge the two.

**DorkOS has already made this call**, and it agrees with the evidence here: `specs/rooms/02-specification.md` §13.2 states message search is "explicitly out of scope" for the room palette, citing this exact Slack-vs-Teams contrast, and notes DorkOS "[has] no message index, and building one to satisfy a palette would be the tail wagging the dog."

#### Disambiguating same-named destinations

**Discord is the instructive negative case, not a solved example — this directly corrects the premise in the brief.** Discord channel names collide constantly across servers (`#general`, `#memes`, `#suggestions`), and the switcher's own community forum has _multiple, separate, long-running feature requests_ asking for exactly this fix:

- "Quick switcher should have matching names in the current server first" — un-resolved as a feature request.
- "Limit quick switcher results to the current server" — un-resolved.
- "Quick Switcher - Prefer Current Server, Better Search" — un-resolved, describes users "accidentally navigat[ing] to the wrong server."

One user's own words, quoted in the search results: they typed `#general` looking for their current server's channel, and it "didn't even show up in the list since practically every server they're in has a channel named 'general.'" **This is not disambiguation working well; it's a known, still-open usability gap.** Discord's mitigation is entirely visual, not ranked: each result row shows a small server icon/avatar beside the channel name so a user can _recognize_ the right one once they see the list — recognition, not resolution by relevance. ([Discord community — Quick Switcher, Prefer Current Server, Better Search](https://support.discord.com/hc/en-us/community/posts/360054654791-Quick-Switcher-Prefer-Current-Server-Better-Search), [Discord community — matching names in current server first](https://support.discord.com/hc/en-us/community/posts/1500000162002-Quick-switcher-should-have-matching-names-in-the-current-server-first), [Discord community — limit to current server](https://support.discord.com/hc/en-us/community/posts/360041927131-Limit-quick-switcher-results-to-the-current-server))

**Slack avoids the problem structurally rather than solving it in the switcher**: channel names are unique within a single workspace by construction, so same-name collisions only happen _across_ separate workspaces, which Slack disambiguates one level up — a workspace picker/filter, and a "View channel details → About → Workspaces with access to this channel" lookup — rather than inside Quick Switcher's result list itself. ([Slack Help — Manage multi-workspace channels](https://slack.com/help/articles/115004485887-Manage-multi-workspace-channels))

**Implication for DorkOS**: rooms are scoped to one DorkOS install with no server/workspace layer, so Discord's specific failure mode (same name, many servers) mostly doesn't apply — but it's the right cautionary tale if DorkOS ever lets two different sources (e.g., two marketplace-installed integrations, or a community + a solo cockpit) contribute rooms with colliding names into one palette.

#### What actions live in the palette, and how apps decide

- **Discord**: none. Confirmed by multiple independent sources describing the switcher as navigation-only — it cannot create a channel or generate an invite; those require the regular hover/right-click UI.
- **Slack**: also none inside Quick Switcher itself. Creation/action affordances (new message, new channel, huddle, canvas, workflow) live behind a separate "+" button next to the search field — a deliberate split between _find_ (switcher) and _do_ (plus-menu), not a merge.
- **Microsoft Teams**: yes, deliberately, via `/` inside the same `Ctrl+E` box — `/call`, `/dnd`, `/chat`, `/mentions`, and more. This is Teams' one distinguishing choice among the three chat apps, and it is also the choice most directly implicated in the "why does Teams need a second switcher" finding above.
- **Linear** (the control case): the palette is _majority actions_, contextual to the object in view or selected — set status, set priority, assign, estimate, mark duplicate, move team, archive — with navigation ("go to team," "go to project") as one category among many, not the primary job. The deciding principle, in Linear's own words: contextual menus double as "a great tool for onboarding and teaching people... keyboard shortcuts," because every action row shows its shortcut next to it. Linear treats the palette as _the_ action surface, with the right-click menu as its mouse-first twin — the reverse emphasis from a chat app's switcher, which treats navigation as primary and actions as secondary or absent. ([Linear — Invisible details](https://linear.app/now/invisible-details))

**Pattern**: apps that centrally deal in a small number of persistent conversations (Slack, Discord) keep the switcher pure-navigation and put actions elsewhere; apps whose core loop is "act on the thing you're looking at" (Linear) make the palette action-first. Teams sits in between and shows the cost of not picking a side.

---

### 2. Unread as a first-class idea

#### Next/previous unread — exact bindings

| App                 | Next/previous unread                                                                                                                                                                                                                                                                                                                                | Source confidence                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Discord**         | `Alt+Shift+↓` / `Alt+Shift+↑` (Windows/Linux); `Option+Shift+↓` / `Option+Shift+↑` (macOS)                                                                                                                                                                                                                                                          | High — Discord's own blog                                                                                         |
| **Slack**           | Not documented as a dedicated next/previous-unread shortcut in Slack's own keyboard-shortcuts article. Slack instead exposes a cross-cutting **Unreads view** (`⌘⇧A` / `Ctrl+Shift+A`) that lists everything unread in one place, rather than a step-through-in-place binding.                                                                      | High for the Unreads-view shortcut; **confirmed absent**, not just unfound, for a Discord-style next/prev binding |
| **Microsoft Teams** | `Ctrl+Alt+U` (Windows) / `Option+Cmd+U` (Mac) opens "all unread chats" as a filtered list — same shape as Slack's Unreads view, not a step-through binding. `Ctrl+J` / `Cmd+J` jumps to the last-read or newest message _within_ the open conversation, which is a different job (position inside one thread, not which conversation to open next). | High — Microsoft's own accessibility support page                                                                 |

**Correction to the brief's framing**: only Discord actually implements "next/previous unread _conversation_" as a literal step-through binding. Slack and Teams both converge on a different, arguably better-generalizing pattern — a dedicated filtered _view_ of everything unread (Slack's Unreads, Teams' "all unread chats") rather than a linear walk through the sidebar. Both patterns solve "reach what needs me without the mouse"; they differ in whether you see one thing at a time (Discord) or the whole queue at once (Slack, Teams). DorkOS's own spec already commits to the Discord shape (`alt+↑`/`alt+↓`) — worth knowing it's diverging from what two of the three apps studied actually chose, on purpose, not by omission (`specs/rooms/02-specification.md` §13.3).

#### "Mark all read" — exact bindings

Two independent apps use the **identical** binding, which is a real, citable convergence worth naming:

- **Slack**: `Shift+Esc` marks _all_ unread messages as read, across every channel; plain `Esc` marks only the current channel/DM as read (when focus isn't in the message composer and no menu is open). ([HowToGeek — Every Slack Keyboard Shortcut](https://www.howtogeek.com/670384/every-slack-keyboard-shortcut-and-how-to-use-them/), corroborated by multiple shortcut references)
- **Microsoft Teams**: `Shift+Esc` marks all chats and channels as read; `Shift+Enter` marks only the current chat/channel as read. Microsoft's own accessibility page confirms this. ([Microsoft Support — Keyboard shortcuts for Microsoft Teams](https://support.microsoft.com/en-us/accessibility/teams/keyboard-shortcuts-for-microsoft-teams))
- **Discord**: `Esc` marks the current channel as read; `Shift+Esc` marks the _entire server_ as read (not literally every server at once — scoped one level up from a single channel, not all the way to global). This is a meaningfully different scope than Slack/Teams' "all workspaces/all chats" `Shift+Esc`. ([systemshortcuts.com — Mark Channel as Read](https://systemshortcuts.com/discord/mark-channel-as-read/) — third-party reference, moderate confidence; I could not locate this in an official Discord source, flagged below)

**Pattern worth copying outright**: `Esc` = mark _here_ as read, `Shift+Esc` = mark _everything_ as read is now a two-app (arguably three) convention. It's cheap, mnemonic (Escape already reads as "I'm done looking at this"), and doesn't collide with anything else across these apps' bindings.

#### Badge / title / favicon treatment for a backgrounded tab

The pattern is the same shape across every app surveyed, described most precisely by a general browser-tab-UX reference that explicitly names Discord, Gmail, GitHub, and Linear as using it:

- **Document title**: a leading `(N)` count, or a bare `•`/dot when there's unread activity but no useful count (e.g., "unread somewhere, no single number to show"). Slack, for instance, differentiates a **dot** badge (unread activity, unspecified) from a **numeric** badge (a DM, an @-mention, or a saved-keyword hit) — the number is reserved for things that specifically address _you_, not just channel chatter. ([Zapier — How to turn off the red dot in Slack](https://zapier.com/blog/turn-off-red-dot-slack/))
- **Favicon**: the recommended and observed pattern is pre-rendered numbered favicon variants (`favicon-1.png` … `favicon-9.png`, `favicon-9plus.png`) swapped based on count, rather than trying to draw a badge at runtime — this survives the tab-bar favicon being rendered too small for a title-only count to be legible. ([ReactUse — Browser Tab UX in React](https://reactuse.com/blog/react-browser-tab-ux/))
- **OS-level badging**: Discord separately badges the dock icon (macOS), taskbar (Windows), and mobile home-screen icon — a third, OS-native layer beyond title/favicon, gated behind its own "Enable unread message badge" toggle. ([Discord — unread badge community threads](https://support.discord.com/hc/en-us/community/posts/18681778677527-Disable-unread-indicators-on-dock-taskbar-icons-and-server-list-icon-in-notification-settings))

**DorkOS gap already identified in its own spec**: `specs/rooms/02-specification.md` §13.1 notes the document title currently "ignores rooms entirely" — `use-document-title.ts` is keyed only on session `cwd` — and that the fix is to reuse the existing `buildTitle` badge slot (already used for a `(N)` tasks badge) for room unread count. That's exactly the pattern this section documents externally: DorkOS already has the mechanism, it's just not wired to rooms yet.

#### Does unread ranking beat frecency in the switcher itself?

Answered with real confidence only for Slack (see §1 above): **yes, explicitly, in the zero-query state**, per Slack's own engineering writeup. I found supporting-but-less-explicit evidence for Discord (unread mentions/channels listed first with no query, per a detailed community wiki, not Discord's own docs). I found no equivalent statement for Teams' `Ctrl+G`. **Generalize cautiously**: two of three chat apps studied clearly prioritize unread in the empty state; the underlying reasoning (stated only by Slack) is that the switcher's most common real-world use is "get back to the thing with new activity," which is a navigation job frecency alone under-serves because frecency rewards _habit_, not _urgency_.

---

### 3. Multi-select recipient pickers

#### The shape, compared

| App         | Input mechanism                                                                                                          | Commit                                                                                                            | Naming when unnamed                                                      | Duplicate prevention                                                                                                                                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Slack**   | `To:` field, typeahead, select-to-add (documented as "select each name as it appears in the dropdown list")              | One `Next`/start action                                                                                           | Comma-separated participant names in the sidebar, until manually renamed | Adding people to an existing 1:1 **moves that conversation forward into a group** (with a choice of how much history carries over) rather than spawning a disconnected duplicate                                                                                          |
| **Discord** | Friends-list modal with **checkboxes** next to each name, plus a text filter box at the top — not a chip-typeahead field | One "Create Group DM" button                                                                                      | Comma-separated participant names by default, renameable                 | Not explicitly documented; every participant must already be on your friends list, and the creation flow is a fresh modal each time (no evidence of dedupe-by-membership)                                                                                                 |
| **Teams**   | `To:` field, typeahead, "enter each person... no commas or semicolons required"                                          | Implicit — first message sent, or an explicit **Group name** field revealed by a chevron/down-arrow next to `To:` | Comma-separated participant names until named                            | **Explicitly does _not_ prevent duplicates** — Microsoft's own community forum confirms you _can_ create two separate chats with an identical member set, and the documented workaround is to give each one a distinct name so they're distinguishable, not to merge them |

Sources: [Slack Help — Add people to a direct message](https://slack.com/help/articles/1500002969782-Add-people-to-a-direct-message), [Slack Help — Understand direct messages](https://slack.com/help/articles/212281468-Understand-direct-messages), [Discord — Group Chat and Calls](https://support.discord.com/hc/en-us/articles/223657667-Group-Chat-and-Calls), [Microsoft Support — Chat with others in Microsoft Teams](https://support.microsoft.com/en-us/teams/chat/chat-with-others-in-microsoft-teams), [Microsoft Tech Community — Possible to create two Chats containing the same people?](https://techcommunity.microsoft.com/discussions/microsoftteams/possible-to-create-two-chats-containing-the-same-people/3918225), [Tom Talks — Naming Microsoft Teams Private Chats](https://tomtalks.blog/naming-microsoft-teams-private-chats-even-multiple-chats-with-the-same-people/)

**This is a real, sourced divergence, not a settled industry consensus**: Slack treats "same people" as one canonical conversation (idempotent by membership); Teams treats it as an ordinary create action with no uniqueness constraint at all, pushing disambiguation onto the human via naming. Discord's behavior here is genuinely under-documented in any source I could find — **flagged as unconfirmed** rather than guessed.

#### Keyboard mechanics of the chip/typeahead field itself

None of Slack, Discord, or Teams' own documentation specifies the precise keystroke contract (Backspace-on-empty removes the last chip; Enter commits the highlighted match; comma as an explicit separator). This is a real gap in the primary sources — the official docs describe the _flow_, not the _keystrokes_. What I can report with confidence is the general, cross-industry convention for this exact UI primitive (chip/token input fields, e.g. email `To:` fields), independent of any one chat app:

- Backspace on an _already-empty_ input focuses (does not yet delete) the last chip; a second Backspace with that chip focused deletes it. This two-step is the standard mitigation against accidentally deleting a chip while a user is still mid-deletion of typed text.
- A freshly-created chip should not itself be immediately Backspace-deletable on the very next keystroke — implementations gate this so the user has to release and re-press Backspace, preventing "add chip, still holding Enter/Backspace, immediately lose it."
- Comma or Enter as an explicit "commit this token" key is standard, but Teams' own documentation explicitly disclaims needing commas ("no commas or semi colons required"), implying Teams commits purely on typeahead-selection rather than on a separator keystroke.

**Treat the specific keystroke contract as a UI-pattern-library convention DorkOS should adopt on its own merits, not as something directly observed and confirmed inside Slack/Discord/Teams' shipped products** — I could not get precise keystroke-level confirmation from any of the three apps' own docs.

#### What DorkOS has already decided here

`specs/rooms/02-specification.md` §12.3 explicitly names Slack's shape as the reference and has already committed to it: "Slack's shape is a multi-select: typeahead, chips for who is selected, one action to start. One agent gives a 1:1; two or more give a group conversation named from the participants." It has also already made the idempotency call correctly, per this research: `POST /rooms` with `kind: 'dm'` returns the _existing_ room for an identical member set, explicitly citing "Slack behaves the same way: re-opening a conversation with the same people opens the same conversation" — the Slack model, not the Teams model, and consistent with what this report found.

---

### 4. Context-sensitive actions

**Linear is the strongest, most concretely documented reference for this**, and the mechanism (not just the philosophy) is publicly described:

- Linear's palette shows "all actions applicable to your view or selection" — contextual by construction, not a static, always-full list. ([Linear changelog — Contextual command menu](https://linear.app/changelog/2019-10-07-contextual-command-menu))
- The right-click context menu carries "almost any action on an issue... set status or priority, assign... change the estimate, mark it as blocking..., add [it] to a cycle or project, copy the git branch name, [or] archive," and Linear's own description of _why_ it stays in sync with the palette is architectural: its sync engine "was designed in part so that any action could be performed at any time" — meaning the action list is a first-class, queryable thing the sync engine exposes, not UI code duplicated between two menu components. ([Linear — Invisible details](https://linear.app/now/invisible-details))
- Every row in the context menu shows its keyboard shortcut, which Linear states doubles as onboarding: right-click becomes the _teaching_ surface for keyboard shortcuts, not a separate, poorer-cousin surface to the palette.
- A secondary, smaller finding worth noting for submenu UX: Linear implemented a CSS `clip-path`-based "safe area" so the cursor can move diagonally from a menu item into its submenu without the submenu closing — solving the "upside-down-L mouse path" problem in native OS context menus. Not directly about the sync-vs-drift question, but a genuinely reusable, cheap (~40 lines) technique if DorkOS's room context menu grows submenus.

**No comparable published engineering writing exists for Slack or Discord on this specific question** (how they keep a palette and a right-click menu in sync, or whether they even try) — both searched for directly, without result. This should be read as **absence of evidence, not evidence of absence**; neither company publishes much about internal menu-architecture decisions. It is also plausible neither Slack nor Discord's switcher needs this problem solved at all, because — per §1 above — neither one's switcher does actions, so there's no second surface to drift out of sync with.

**DorkOS's own codebase already independently arrived at Linear's mechanism, not just its intent**, and the spec calls this out explicitly: `AgentRowMenuItems.tsx` already builds one pure node list consumed by both the right-click `ContextMenu` and the `…` `DropdownMenu`, and `specs/rooms/02-specification.md` §13.2/§12.4 commits the room palette to the same discipline — "the palette offers that room's actions — the _same_ pure `buildRoomRowMenuNodes(model)` that feeds the right-click menu and the `…` dropdown. Three surfaces, one model. Palettes drifting out of step with their equivalent right-click menus is the standard failure here." This is precisely Linear's pattern, arrived at independently and already in the codebase as precedent (agent rows) before rooms needed it.

---

### 5. Anti-patterns

1. **Merging navigation and message/command search into one input (Teams).** The clearest, most directly evidenced anti-pattern in this research. Teams' `Ctrl+E` box does three unrelated jobs — find a person, find a file, run a slash command — and Teams' own subsequent product decisions are the strongest evidence against it: adding a _second_, purpose-built switcher (`Ctrl+G`) rather than fixing the first is a tell that the merged surface under-served the "just switch me to a chat" job. I found genuine friction reports around Teams search/command behavior (e.g., a Microsoft Q&A thread about focus landing in the wrong pane after a search-driven navigation, and reports of `Ctrl+F`/`/find` not working reliably in "new Teams") but **could not find a source that names the merged-box design itself, rather than bugs in it, as the complaint** — flagged as a moderate-confidence lead, not a confirmed critique, per the task's request to mark uncertainty explicitly.

2. **Sigil-grammar discoverability is a real, unresolved question — I could not confirm whether users actually learn Discord's `@ # ! *` grammar, and neither could Discord, apparently.** Despite targeted searching (including directly for Reddit discussion), I found no user-research or product-analytics writing from Discord (or anyone else) on whether people actually use the prefix characters versus just typing plain text and scrolling results. What _does_ exist as evidence: the placeholder text itself ("Where would you like to go?") teaches nothing about the grammar, and the four-symbol system is documented in exactly two places — a support article and a blog post — neither of which is surfaced _inside_ the switcher UI itself (no inline hint, no legend). Combined with the still-open, years-long backlog of "quick switcher can't find my current server's channel" complaints (§1, disambiguation), the more defensible reading is: **most users are not consciously using the sigil grammar at all, and are instead relying on Discord's plain-text fuzzy match plus the small server-icon visual cue to eyeball the right result** — but this is an inference from the evidence available, not a confirmed finding.

3. **Discord's disambiguation gap (§1) is itself an anti-pattern worth naming on its own**: shipping a filter grammar (`#channel`) without also solving the much more common real-world need (this exact channel name, but in _my current_ server) left a multi-year-old, still-unresolved feature-request backlog. The lesson generalizes: a prefix/scope grammar solves _type_ ambiguity, not _instance_ ambiguity, and apps that only solve the first will accumulate exactly this complaint.

4. **No native "back" through recently-visited destinations, unlike Slack — and Discord users notice.** Slack has a citable, working `Cmd+[` / `Cmd+]` history-navigation pair (see `research/20260716_slack_sidebar_organization_ux.md` §7 for the full mechanic). Discord's equivalent is contested in my own research: multiple, separate, long-running Discord community threads — "REALLY Need a 'Back' button Feature," "Previous Channel Button," "Keyboard shortcuts to go back/forward between visited channels" — read as feature _requests_, i.e., the capability does not exist, and one directly states users find this a real gap compared to Slack. Against that, one secondary source claimed `Alt+Left`/`Alt+Right` had been added as back/forward shortcuts. **I could not resolve this contradiction with confidence** — it's plausible that source is describing OS/browser-level back-forward on Discord's web client rather than a native, cross-platform Discord feature, since Discord's own current official blog post enumerating keyboard shortcuts (fetched directly for this report) does not list a channel-history back/forward binding at all. Treat "Discord has no reliable, documented, cross-platform channel-history back/forward" as the safer reading, and the conflicting claim as unconfirmed.

---

## What DorkOS should copy, adapt, and reject

DorkOS's rooms carry `agents`, not people; there is exactly one human; and the entity you navigate to (an agent's room) is also the entity you dispatch work to. That reframes several of the industry patterns above rather than just adopting them wholesale.

**Copy outright:**

- **Unread-first zero-query state, Slack's exact framing.** Slack's own stated reasoning — the switcher's most common real job is "get me to what has new activity," and frecency alone rewards habit over urgency — applies _more_ strongly to DorkOS than to Slack. In DorkOS a room's new activity is overwhelmingly "an agent finished and is telling me something," which is closer to a to-do list than a social feed. Rooms already carry `unreadCount`; rank on it first, frecency second. This is already the direction `specs/rooms/02-specification.md` §13.2 takes, and this research confirms it against the primary source rather than just precedent.
- **`Esc` = mark here read, `Shift+Esc` = mark everything read.** A genuine two-app (Slack, Teams) convergent convention, cheap to implement, mnemonically sound, and nothing in DorkOS's existing shortcut map conflicts with it.
- **One pure action-list function feeding both the palette's contextual actions and the room's context menu, Linear's actual mechanism.** Not just "keep them consistent" as a principle — build them from one function, the way `AgentRowMenuItems.tsx` already does and `buildRoomRowMenuNodes(model)` is already planned to do. This is the single highest-leverage finding in this report because it's a structural guarantee against drift, not a discipline someone has to remember.
- **The favicon/title `(N)` badge pattern**, reusing the `buildTitle` slot already built for the tasks badge, exactly as `specs/rooms/02-specification.md` §13.1 already flags as a gap. This report's contribution is confirming the pattern (leading count in title + numbered favicon variant) is the actual cross-industry convention, not a DorkOS invention.
- **Slack's recipient-picker shape for multi-agent DMs: typeahead → chips → one commit action**, and Slack's idempotency rule for duplicates ("same member set reopens the same room") over Teams' "no dedupe, rename to disambiguate" approach. Both are already decided in `specs/rooms/02-specification.md` §12.3, and this research found nothing to argue against either choice — if anything, Teams' explicit lack of dedupe reads as a design gap other apps should not copy, not a legitimate alternative.

**Adapt:**

- **The `@` sigil, but pointed at agents-as-actors, not agents-as-destinations only.** Every chat app studied uses a sigil purely to filter _what kind of destination_ you're looking for. DorkOS's planned `@ana` → "Message Ana" _and_ "New session with Ana" (per `specs/rooms/02-specification.md` §13.2) has no precedent in Slack, Discord, or Teams, because none of them have an entity that is simultaneously a navigation target and something you hand a task to. This is the correct DorkOS-specific divergence, but worth being deliberate that it's new ground, not an industry pattern being followed — the closest analogue is Linear's contextual-action palette (an object with verbs attached), not any chat app's switcher.
- **Discord's next/previous-unread step-through (`alt+↑`/`alt+↓`), but be aware it's the minority pattern, not the majority one.** Two of the three chat apps studied (Slack, Teams) chose a filtered _view_ of all unreads over a step-through binding, and did so on purpose, not by omission. With exactly one human and — per this brief — a chat surface expected to have comparatively few concurrently "hot" rooms at any moment, Discord's one-at-a-time step-through is plausibly the better fit for DorkOS's scale (a filtered-view surface is more valuable at Slack/Teams' hundred-channel enterprise scale than at DorkOS's likely handful of active rooms). Keep the binding, but don't assume it's "the standard" — it's the shape that fits DorkOS's current scale, not the one two of three apps studied actually picked.
- **Slack's `#`/`@` scope-filter sigils, generalized to one full grammar rather than two symbols bolted onto different, poorly-connected help pages.** Slack's own documentation gap here (the flagship keyboard-shortcuts page never mentions its own sigil grammar) is a discoverability failure worth explicitly not repeating: whatever DorkOS ships, put the legend _inside_ the empty palette state itself, not only in a help article — which is exactly what `specs/rooms/02-specification.md` §13.2 already commits to ("prefix legend in the empty state").

**Reject:**

- **Teams' merged search-and-command box.** The clearest anti-pattern in this research, and DorkOS has already independently reasoned its way to rejecting it (`specs/rooms/02-specification.md` §13.2, citing exactly this contrast). This research adds confirmation from primary sources: Teams' own subsequent decision to ship a _second_, single-purpose switcher is the strongest evidence available that the merge under-serves navigation, even without a clean "users hated it" citation.
- **Discord's checkbox-list recipient picker over Slack's typeahead-to-chips.** DorkOS almost certainly has far fewer agents to pick from than a Discord user has friends, so a checkbox list is less obviously wrong at DorkOS's scale than it would first appear — but chips preserve _order and visibility of who's already selected_ better than a scrolling checkbox list does, which matters more when the people you're selecting (agents) have distinct behavior/response-mode implications per room. Chips, not checkboxes.
- **Building message-content search into the palette at all, for now.** Both this research and DorkOS's own spec agree: no message index exists, and building one only to satisfy the palette is solving the wrong problem first. If/when DorkOS does build message search, keep it a second surface (Slack's model), not a merged one (Teams' model) — the evidence against merging is the strongest single finding in this report.
- **Treating Discord's disambiguation-by-visual-icon as "solved."** It isn't, per Discord's own multi-year-old open feature-request backlog. DorkOS should not assume "show a little context badge next to the result" is sufficient if rooms ever need cross-source disambiguation (e.g., two integrations surfacing similarly-named rooms) — Discord's experience suggests that alone is not enough, and ranking/prioritizing "the one in your current context" needs to happen in the result _ordering_, not just its labeling.

---

## Sources & Evidence

**Discord:**

- [Quick Switcher — Discord Support](https://support.discord.com/hc/en-us/articles/115000070311-Quick-Switcher)
- [Discord Commands, Shortcuts, and Navigation Guide — Discord Support](https://support.discord.com/hc/en-us/articles/31232432266647-Discord-Commands-Shortcuts-and-Navigation-Guide)
- [How to Use Keyboard Shortcuts on Discord & Create Custom Keybinds — Discord Blog](https://discord.com/blog/how-to-use-keyboard-shortcuts-on-discord-create-custom-keybinds)
- [How to Navigate Discord Using Only Your Keyboard — Discord Blog](https://discord.com/blog/how-to-navigate-discord-using-only-your-keyboard)
- [The Discord Wiki — quick-switcher.md (GitHub mirror)](https://github.com/ItzHalcyon/The-Discord-Wiki/blob/master/quick-switcher.md)
- [Quick Switcher - Prefer Current Server, Better Search — Discord community](https://support.discord.com/hc/en-us/community/posts/360054654791-Quick-Switcher-Prefer-Current-Server-Better-Search)
- [Quick switcher should have matching names in the current server first — Discord community](https://support.discord.com/hc/en-us/community/posts/1500000162002-Quick-switcher-should-have-matching-names-in-the-current-server-first)
- [Limit quick switcher results to the current server — Discord community](https://support.discord.com/hc/en-us/community/posts/360041927131-Limit-quick-switcher-results-to-the-current-server)
- [Keyboard shortcuts to go back/forward between visited channels — Discord community](https://support.discord.com/hc/en-us/community/posts/360037068211-Keyboard-shortcuts-to-go-back-forward-between-visited-channels)
- [REALLY Need a "Back" button Feature — Discord community](https://support.discord.com/hc/en-us/community/posts/6341254585367-REALLY-Need-a-Back-button-Feature)
- [Previous Channel Button — Discord community](https://support.discord.com/hc/en-us/community/posts/1500000617862-Previous-Channel-Button)
- [Group Chat and Calls — Discord Support](https://support.discord.com/hc/en-us/articles/223657667-Group-Chat-and-Calls)
- [Disable unread indicators on dock/taskbar icons — Discord community](https://support.discord.com/hc/en-us/community/posts/18681778677527-Disable-unread-indicators-on-dock-taskbar-icons-and-server-list-icon-in-notification-settings)
- [Mark Channel as Read — Discord Keyboard Shortcuts (systemshortcuts.com, third-party)](https://systemshortcuts.com/discord/mark-channel-as-read/)

**Slack:**

- [A Faster, Smarter Quick Switcher — Slack Engineering](https://slack.engineering/a-faster-smarter-quick-switcher/)
- [Navigate Slack with your keyboard — Slack Help](https://slack.com/help/articles/115003340723-Navigate-Slack-with-your-keyboard)
- [Navigate using the Quick Switcher — Slack Help (regional mirror, source of the `#`/`@` sigil grammar)](https://slack.com/intl/en-fi/help/articles/226599368-Navigate-using-the-Quick-Switcher)
- [Add people to a direct message — Slack Help](https://slack.com/help/articles/1500002969782-Add-people-to-a-direct-message)
- [Understand direct messages — Slack Help](https://slack.com/help/articles/212281468-Understand-direct-messages)
- [Convert a group direct message to a private channel — Slack Help](https://slack.com/help/articles/217555437-Convert-a-group-direct-message-to-a-private-channel)
- [Manage multi-workspace channels — Slack Help](https://slack.com/help/articles/115004485887-Manage-multi-workspace-channels)
- [Search in Slack — Slack Help](https://slack.com/help/articles/202528808-Search-in-Slack)
- [Triage notifications from the Activity tab (legacy) — Slack Help](https://slack.com/help/articles/45573197224467-Triage-notifications-from-the-Activity-tab--legacy-)
- [Every Slack Keyboard Shortcut — HowToGeek](https://www.howtogeek.com/670384/every-slack-keyboard-shortcut-and-how-to-use-them/)
- [How to turn off the red dot in Slack — Zapier](https://zapier.com/blog/turn-off-red-dot-slack/)
- [@SlackHQ — 2014 changelog: unread channels bumped to top of Quick Switcher](https://x.com/slackhq/status/500408903645941761)

**Microsoft Teams:**

- [Keyboard shortcuts for Microsoft Teams — Microsoft Support (accessibility)](https://support.microsoft.com/en-us/accessibility/teams/keyboard-shortcuts-for-microsoft-teams)
- [Navigate conversations with the keyboard in Microsoft Teams — Microsoft Support](https://support.microsoft.com/en-gb/office/navigate-conversations-with-the-keyboard-in-microsoft-teams-2c0348da-81e0-4298-8597-846b6647a8a3)
- [Use commands in Microsoft Teams — Microsoft Support](https://support.microsoft.com/en-US/teams/chat/use-commands-in-microsoft-teams)
- [Chat with others in Microsoft Teams — Microsoft Support](https://support.microsoft.com/en-us/teams/chat/chat-with-others-in-microsoft-teams)
- [Get started with the new chat and channels experience in Microsoft Teams — Microsoft Tech Community](https://techcommunity.microsoft.com/blog/microsoftteamsblog/get-started-with-the-new-chat-and-channels-experience-in-microsoft-teams/4410786)
- [Possible to create two Chats containing the same people? — Microsoft Tech Community](https://techcommunity.microsoft.com/discussions/microsoftteams/possible-to-create-two-chats-containing-the-same-people/3918225)
- [Naming Microsoft Teams Private Chats, even multiple chats with the same people — Tom Talks](https://tomtalks.blog/naming-microsoft-teams-private-chats-even-multiple-chats-with-the-same-people/)
- [Designing the new era of Teams — Microsoft Design](https://microsoft.design/articles/designing-the-new-era-of-teams/)
- [Microsoft promises it's made Teams less confusing — The Register](https://www.theregister.com/2023/03/28/new_teams_client_preview/)

**Linear (non-chat control):**

- [Contextual command menu — Linear changelog](https://linear.app/changelog/2019-10-07-contextual-command-menu)
- [Invisible details — Linear](https://linear.app/now/invisible-details)
- [Favorites — Linear Docs](https://linear.app/docs/favorites) (already cited in `research/20260716_cross_app_sidebar_organization_patterns.md`)

**Cross-cutting / general pattern:**

- [Browser Tab UX in React: Pull Users Back with Titles, Favicons, and Notifications — ReactUse](https://reactuse.com/blog/react-browser-tab-ux/)

**DorkOS internal cross-reference:**

- `specs/rooms/02-specification.md` (§12.3, §12.4, §13) — the rooms spec's own already-decided direction, checked against this research rather than restated from it.

---

## Research Gaps & Limitations

- **Keystroke-level contract for chip/typeahead recipient fields** (Backspace-on-empty, Enter-to-commit, comma-as-separator) is not documented by Slack, Discord, or Teams themselves at the level of precision the brief asked for. I substituted the general, cross-industry chip-input convention and flagged it as such rather than presenting it as observed Slack/Discord/Teams behavior.
- **Discord's exact zero-query ordering logic** ("unread mentions, then unread channels in current server, then last-visited channel") is sourced from a well-regarded but unofficial community wiki mirror, not Discord's own current documentation (the equivalent official support article returned HTTP 403 to direct fetching during this research). Treat as moderate, not high, confidence.
- **Discord's "mark entire server as read" scope for `Shift+Esc`** comes from a single third-party shortcuts-reference site; I could not corroborate it against an official Discord source directly (Discord's own support domain blocked automated fetches throughout this research).
- **Whether Slack still pre-selects the first unread channel for one-keystroke `⌘K → Return` cycling** is unresolved — one 2020-era community report claims this behavior existed and then broke; I found nothing confirming its current status either way.
- **Direct published evidence that users complain specifically about Teams' merged search/command box**, as opposed to bugs within it or Teams' broader 2023 redesign in general, was not found despite multiple targeted searches. The inference (that the later `Ctrl+G` switcher is evidence of the merge under-serving navigation) is reasonable but is my own inference from the timeline, not a quoted critique.
- **No user-research or analytics-backed source exists (from Discord, Slack, or independent researchers) on whether people actually learn and use sigil grammars** like Discord's `@ # ! *`. This entire sub-question in the brief (anti-pattern §2) is answered by inference from indirect evidence, not direct data, and is marked as such in the body of the report.
- **Discord's `Alt+Left`/`Alt+Right` back/forward claim is directly contradicted by multiple open Discord feature-request threads asking for exactly that capability** — this is a genuine, unresolved contradiction in the source material, not a research gap I could close with more searching within this report's budget.

## Contradictions & Disputes

- **Discord channel-history back/forward**: one source claims `Alt+Left`/`Alt+Right` exist as native back/forward shortcuts; at least three separate, still-open Discord community feature-request threads (dated across different years) ask for exactly this capability, implying it does not exist or does not work reliably. Discord's own current official blog post enumerating keyboard shortcuts (fetched directly) does not list any such binding. **I favor the reading that Discord has no reliable, cross-platform channel-history navigation**, but flag this explicitly as contested rather than resolved.
- **Slack's "pre-select first unread on switcher open" behavior**: claimed to exist (pre-2020) and separately claimed to have broken (September 2020) in the same secondary source; I found no way to confirm current-day status. The core, better-sourced claim — that unread channels are listed first, capped at 24 — is not in dispute; only the auto-selection nuance is.
- **Discord's zero-query state being "current-server-first"** (community wiki) sits in mild tension with Discord's well-documented, still-open complaint that the switcher _doesn't_ reliably prioritize the current server when you actually type a query (§1, disambiguation). It is plausible both are true simultaneously — the _empty-state_ list may be current-server-weighted while the _matched-query_ ranking is not — but I could not confirm this reconciliation directly; it's my own best reading of two separately-sourced claims, not a single source stating both.

## Search Methodology

- Searches performed: 32 WebSearch calls, 12 WebFetch calls (several against `support.discord.com` returned HTTP 403 and were substituted with community-wiki mirrors, Discord's own blog domain, or the systemshortcuts.com reference)
- Most productive search terms: "Discord quick switcher search prefix @ # ! \* sigil meaning", "Slack quick switcher unread channels first zero query default state", "Microsoft Teams jump to next unread chat shortcut mark all as read", "Discord 'Prefer Current Server' quick switcher same channel name different servers", "Linear right-click context menu same actions command palette sync engineering", "Possible to create two Chats containing the same people" (Microsoft Tech Community)
- Primary information sources: Discord's own support/blog domains, Slack's own help/engineering domains, Microsoft's own support/design domains, Linear's own changelog/blog, plus community forums (Discord support community, Microsoft Tech Community, Microsoft Q&A) used specifically to surface anti-patterns and unresolved feature requests that official documentation would not admit to
- Internal cross-reference: `specs/rooms/02-specification.md` was read after the external research was substantially complete, to check (not to source) this report's findings against DorkOS's own already-decided direction for the same surface

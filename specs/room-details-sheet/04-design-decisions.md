---
slug: room-details-sheet
id: 260730-112334
created: 2026-07-30
---

# Design decisions

Visual companion session: `.dork/visual-companion/27428-1785409067/`
Reviewed with Dorian, 2026-07-30.

## 1. What is actually wrong with the panel

**Screen:** `members-audit-v2.html`

Rebuilt from a screenshot of the running cockpit (`#testcwd`) rather than assessed from source, per spec `rooms` §14.5. Seven findings, three of them invisible in code: the inverted weight between member and setting, two identical mode sentences stacked, and the add list rendering as a plain-text directory listing of every project folder on disk.

**Outcome:** accepted as the shared diagnosis. No dissent on any finding.

## 2. Which problem to attack first

**Screen:** `members-audit-v2.html` (options A–D)
**Options:** A) make the modes obvious · B) make the roster a crew · C) fix the directory listing · D) make every change land

**Chosen:** all four, implicitly — the response asked to see the whole design rather than pick a slice. Dorian then raised the mode labels directly ("I don't understand some of the options, such as 'Replies while it is in the conversation'"), confirming A as the sharpest edge.

## 3. Prior art: Slack

**Screen:** `members-proposal.html`
Dorian shared Slack's channel member sheet with "I think we can do better than them."

**Taken:** adding as a row rather than a second panel; the count in the title; a second line per member; the reader present as "(you)"; the right-aligned pill slot.
**Rejected:** the Members / Agents & apps tab split; a search field at four members; the "Everyone" filter; six tabs over three fields.
**Noted:** Slack's own "Add people, agents, or apps" button contradicts its tab split — they mix where it matters and segregate where it is visible. And Slack has no per-member behaviour concept at all, so its row offers nowhere to put a mode. That empty pill slot is where ours goes.

## 4. Panel, or sheet?

**Screen:** `members-proposal.html` (options A–B)
**Options:** A) keep it a members panel, smaller change · B) make it the room sheet, absorbing topic/rename/archive

**Chosen: B.** Dorian: _"I like option B as well. That may mean that we need to rename RoomMembersDialog maybe... I'll leave that decision up to you."_

**Naming, decided:** `RoomMembersDialog` → `RoomDetailsDialog`; slice `features/room-membership` → `features/room-management`. The slice now holds create-a-room, manage-a-room and who-is-in-it, so "membership" has stopped being true. It stays **one** slice: splitting create from manage would force a sibling-feature model import, which the FSD rule forbids.

## 5. Two calls the orchestrator made, and the operator confirmed

**Screen:** `room-sheet-states.html`

1. **"managed by you" is hidden, not shown.** Every agent is the operator's today, so printing it on every row is zero information. It appears only when the owner is not the reader. Confirmed: _"I agree with hiding managed by you until we have other people in our community or external agents."_

2. **Rename and Archive keep their existing entry points.** A correction to an overclaim: B was said to retire three surfaces; on inspection it cleanly retires **one** (`RoomTopicDialog`). Inline rename matches the group-rename gesture the sidebar already uses, and the archive confirm is the right pattern — so the sheet adds a second door rather than replacing them. Confirmed: _"I also agree with rename and archive keeping their existing entry points."_

## 6. People and agents in one list

Raised by Dorian: _"In the future, we'll be able to add people and agents… Please look at how Buzz handles this, because they handle it well. Each agent has a robot icon and says 'managed by {the person managing the agent}'."_

**Decided:** one list, grouped by kind with headers, never segregated into tabs. Agents carry a bot glyph on the disc; **people carry nothing** — absence is the signal, so a roster of humans stays visually quiet. The glyph is a `badge` slot added to `shared/ui/IdentityAvatar`, which must live in `shared` because `entities/room` may not import `entities/agent`. Designed now, before mixed rosters exist, so nothing is redesigned the day people join.

Buzz's NIP-OA — a cryptographic proof binding an agent key to the human who vouches for it — is the model for the "managed by" relationship when it becomes real.

## 7. The standard agent avatars

Raised by Dorian: _"we're not using the standard agent avatars in the agent list… and we probably should be."_

**Decided:** three tiers by freshness — resolved manifest visual, then the author render cache (which goes stale on rename), then a neutral letter disc. Hashing the agent's _path_ as a fallback is forbidden: it yields a confident face that differs from every other surface. `AgentPickerCandidate` is widened to carry the resolved visual, which fixes the faceless picker and deletes a third copy of the same derivation in `features/tasks/ui/AgentPicker.tsx`.

## 8. Dev playground

Raised by Dorian: _"we need to make sure that this is part of the dev playground… We might want to add a new section specifically for community stuff… I'll leave it to you."_

**Decided: a `rooms` page, not a `community` one.** Every playground page is named for what you see (chat, marketplace, tables, onboarding), never for a backend seam — and `CommunityAdapter` is a port. Rooms grows a section when outside members land; a community page earns its own existence only if federation brings genuinely new surfaces (invites, directory, trust state).

Rooms currently have **zero** playground coverage across 18 pages and 40 showcase files, and twelve of this sheet's states are unreachable without a live server. The state gallery in `room-sheet-states.html` is the page's spec.

## Final design summary

One responsive sheet. Header carries the room's mark, its inline-editable name and topic, and an archived badge. Beneath it, a single line states what the room will actually do — a four-bar loudness meter and a plain sentence, aggregated across the roster.

Then one list: people first, then agents, each group with a count, the reader included and marked "(you)". Each member is one row — disc with a bot badge for agents and a live dot when present, name, one secondary line that is only ever a verifiable fact, a loudness pill on the right, and a `⋯` menu. Pressing the pill expands the row into a segmented control of the rungs this room kind offers, ordered quiet to loud, with the true rule spelled out beneath it in real numbers.

Adding is the last row of the list, not a second panel; it expands in place into the existing chip picker, now with faces. The footer states when the room was created and offers to archive it.

Hovering or arrowing across a rung slides the room's own meter to what it would become and rewrites the sentence — the whole model taught in about three seconds, with no help text, and honest because the consequence is real.

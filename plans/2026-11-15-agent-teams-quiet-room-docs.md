# Project leads and quiet rooms: documentation plan

DOR-4470 and DOR-4082. Discovery base: `f9c8ca281cfa5e33e909ae5c5e5c896648e14d19`; integration base: `c1bd9ecc9984390ca7d51d7c2311371b89092e08`. Documentation was drafted alongside the preceding source work. Publish only after DOR-4472, DOR-4328 and DOR-4469 behavior is independently reviewed; review the combined prompt/docs contract before integration. Parallel authoring does not mark any unrun check as passing.

## Intended behavior

A short room question gets a short answer now. Longer work belongs to one named project lead in an ongoing chat. The lead coordinates directly with the one agent who must act, checks results, and owns the outcome. The room hears when work starts, when a person must unblock it, and when it ships. These are useful update kinds, not a three-message quota. Direct questions, urgent risks and new facts still get timely answers.

Routine chasing and delegate reports stay in the working chats. No room status relays or cc fan-out. Existing cc syntax remains a way for a person to share an FYI without waking agents; it is not retired or redefined. A lead is a working convention, not a new profile role, permission grant or automatic manager assignment.

## Evidence and ownership

- `meta/agent-etiquette.md` E33 still says to post whenever delegates report. E31 names an owner/time but does not say where to chase. The reaction section names the removed `ROOM_TOOLS_CONTEXT` constant; production uses `buildRoomToolsBlock`.
- `meta/PROACTIVE-AGENTS.md` P4 lacks the project lead's direct coordination route. P5 ranks every direct message above a room post, though direct agent coordination is usually quieter for people. Preserve P6 human working hours and escalation ownership.
- `docs/guides/spin-off-chats.mdx` explains chats and reports but lacks the lead pattern. Avoid promising automatic report-back into heartbeat/schedule chats: the launch code disables those parents. An unattended kickoff must name a permitted ongoing destination.
- `docs/concepts/rooms.mdx` has the shipped Stay responsive explanation but no optional tightening snippet. Its instruction precedence and permission boundary remain true.
- DOR-4469 owns built-in prompt strings and operating skills. DOR-4472 owns private seat-message routing; DOR-4328 owns bounded seat recovery. This documentation change consumes their verified behavior instead of redefining it.
- DorkOS Code owns DOR-4467 operational agent files, live DOR-4471/4081 measurement, Security/Design routing, arming, releases and Done checks.

## Proposed edits

1. Rewrite E33 for one lead, direct coordination and useful room update kinds. Preserve Security's E31 bound: one late-reply nudge in a direct chat, then wait. Correct only the live constant reference to `buildRoomToolsBlock`.
2. Add the lead route to P4. Rewrite P5 so an agent-to-agent direct message for action is ordinary coordination. Keep human interruption/quiet-hours rules and record-first behavior. Align 9.5 with the verified report destination exceptions and prompt contract where needed.
3. Add a short project example to the spin-off guide: name a lead, define done, give it the ongoing report destination, and keep routine exchanges in working chats. Explain room updates without claiming new automatic behavior.
4. Update the existing rooms explanation and add the optional ROOM.md example below. Link to the spin-off guide rather than duplicating its technical reference.
5. Search current room/heartbeat guides for conflicting every-report wording. Edit only active guidance relevant to this contract; historical specifications remain history.
6. Review the complete prose against writing-for-humans, the north-star set and the final implementation. Do not claim automatic recovery of every error, new bridge reach, new permissions, turn-loop replacement or automatic posting.

## Draft optional ROOM.md snippet

```md
## Project work

Ana leads this project. Give her the goal and what done means.
Answer short questions here right away.
For longer work, name the lead and continue in an ongoing chat.
Message the one agent who must act. Keep routine chasing out of this room.
Post here when work starts, a person must unblock it, or it ships.
Answer direct questions, requested reports and urgent new facts when needed.
Do not relay every report or copy the room into status exchanges.
```

The surrounding guide says to replace Ana with a real project lead and tailor the convention. ROOM.md adds to agent instructions and cannot widen authority or force a prohibited destination. The three update kinds are not a posting cap.

## Verification and review

No implementation-mirroring test is needed for prose. After source authorization, run formatting and relevant docs link/vocabulary checks under the machine-load rule. Search removed wording and live symbol references across current docs, meta and operating skills; distinguish archival references. Check new Markdown links against actual paths and anchors. Review final prompt/docs composition against DOR-4469 on an isolated combined tree. No browser, live ports, desktop build, keychain or paid paths. Live behavior measurement belongs to Code/QA.

Open each PR with `hold` and `review:deep`. Code owns Security labels and arming after required checks and reviews. The project owner granted standing shipping approval on November 15, superseding the earlier launch cut; no further permission to ship is needed for this project. Do not open a standalone docs PR before the prerequisite implementation and independent review are ready. Retain the worktree until its work is merged, verified and clean.

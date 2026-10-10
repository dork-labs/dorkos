---
slug: your-activity-first
number: 261008-165653
created: 2026-10-08
status: ideation
---

# Your activity first — ideation

**Linear:** DOR-2789. **Brief:** Dorian, 2026-10-08: the sidebar and chat lists should follow your own activity first and agent activity second. Every click goes to what you were last doing.

The ticket carries a diagnosis verified in code on 2026-10-08 and the rules to build; Dorian approved both. This page only records what the code showed and what was checked on this machine, so [`02-specification.md`](./02-specification.md) can stay short.

## What was wrong (verified)

1. **Today drops chats you used.** `use-sidebar-state.ts` cut the shared 24-chat answer to 10 by `updatedAt` before `partitionSessionsByOrigin`, so busy agents' chats pushed yours out. The open chat survived only through the anchor row (BC-21).
2. **How a chat started decided forever whether it was yours.** A chat whose first message was a room turn is `origin: 'room'` even after days of you typing in it, and `user-last-message-origin.ts` dropped its `userLastMessageAt`. It folded into "+ N automated" the moment you left.
3. **Clicking an agent opened the chat anyone touched last.** `resolveSessionForCwd` took `conversations[0]` by transcript mtime and read neither `startedBy` nor what you opened.
4. **"Opened" was recorded only on some clicks, in one browser** (`dorkos:interactions-v1`). Deep links, reloads, notifications, "Started from" and room links recorded nothing.

## Seen on this machine (2026-10-08, `GET /api/sessions/recent?limit=24`)

- The #dorkos coordinator chat (`0713ffca`) is `origin: room`, title "Other agents in #dorkos", no `userLastMessageAt`, although Dorian typed in it directly for days.
- The release chat (`7c2a29af`) has no origin and `startedBy.kind: chat`; while busy it is the newest chat in its folder and wins the agent click.
- Of 24 recent chats, 15 are room or task runs.

## Shape of the fix

One server-held "you touched it" time, one ownership rule decided by what you did, one chat list for both surfaces, one word ("chat"). Decisions D1–D13 in the spec.

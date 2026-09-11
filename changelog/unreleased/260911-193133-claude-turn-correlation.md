---
covers:
  - "feat(claude-code): close turn windows from the SDK's full list of answered messages"
  - 'feat(claude-code): keep waiting on a steer when the CLI says another turn is queued'
---

### Changed

- DorkOS now knows exactly which of your messages a reply answered, so nothing is left hanging
  when you send several at once. Claude Code reports the whole list instead of just the last
  one, and DorkOS reads it — a reply that covers two messages closes both, and a message it
  already answered can no longer be mistaken for one it still owes you.
- A message you send mid-reply is less likely to get a silent answer. When Claude Code says it
  still has one of your messages waiting, DorkOS now waits longer for that answer before it ends
  the turn. It never cuts the wait short, so an answer that was already on its way still reaches
  you.
- If Claude takes a long time thinking about something you sent mid-reply, that answer now
  reaches you. DorkOS used to give up waiting after five seconds and the whole answer went
  nowhere.
- When Claude ends a turn nobody asked for — it re-ran one that was cut short, or it ran a slash
  command on its own — the log now says which, instead of reporting it as a surprise.

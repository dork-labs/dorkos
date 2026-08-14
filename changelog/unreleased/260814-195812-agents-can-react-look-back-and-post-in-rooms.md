---
covers:
  - 'feat(server): give room agents a typed tool hand — post, react, read, search (DOR-1202)'
---

### Added

- Agents in a room can now react with an emoji instead of writing a filler message. A 👍 or a ✅ says "seen" without adding a line everyone has to read, and it interrupts nobody — no one is woken up by a reaction. There is a limit on how many an agent can leave in one room each hour, so a room can never fill up with them. (DOR-1202)
- Agents can look back through a room's history when you ask them to. They can read the recent messages of any room they are in, or search it for the words they remember, so "what did we decide about the migration?" is a question your agent can answer instead of one it has forgotten. An agent only ever sees rooms it is a member of, and only what was said after it joined. (DOR-1202)
- An agent can post an update into a channel, or into the thread it is working in, at the moment it has something worth saying — rather than only when it finishes its turn. If it posts this way, that post is its answer: you get one message, not the update and a summary of the update. (DOR-1202)

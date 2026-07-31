---
covers:
  - 'fix(rooms): a room answers everyone who asked, and tells the truth about why an agent is quiet (DOR-781)'
---

### Fixed

- Ask a busy agent again by name and the room answers you again. It used to say
  "busy" once and then stay silent for good, so a second or third "@ana are you
  there?" got nothing back — indistinguishable from a message that was never
  delivered. Ordinary messages you did not address to that agent still get one
  line between you, not one apiece (DOR-781)
- The room now says something true and useful when an agent is busy: it is still
  working on an earlier message here, and that answer will land in this
  conversation. The old line said "send it again when it is free", which points
  at a state a room never shows you (DOR-781)
- A reply that arrives late no longer pings everyone the original question
  mentioned. It quotes the message it answers, and that quote used to count as
  addressing people all over again — including, in one case, the agent writing
  it. What the agent says in its own words still reaches whoever it names
  (DOR-781)
- Names inside quoted text and code no longer address anybody. Quoting a
  colleague's message is not a way to summon everyone they mentioned (DOR-781)
- An agent that pauses to use a tool no longer runs its two sentences together.
  What it said before the tool and what it said after are kept as separate
  paragraphs (DOR-781)
- Every error an agent hits is reported, not just the first one. A run of failed
  turns used to go quiet after one line, which read as the agent having
  recovered (DOR-781)
- Your message can no longer fail because of something that happened after it
  was posted. A database hiccup while working out who to notify used to surface
  as an error on the message you had already sent successfully (DOR-781)

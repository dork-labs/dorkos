---
covers:
  - 'fix(server): agents are taught DorkOS tools by the names they can actually call (DOR-1292)'
  - 'fix(server): a reaction is the whole answer, so the turn says nothing else (DOR-1292)'
---

### Fixed

- Agents are now told the real name of every DorkOS tool. Claude Code gives your agent these tools under longer names than the ones DorkOS registers them with, and the instructions the agent reads were using the short ones. An agent that followed those instructions exactly got "no such tool" and gave up. Bigger models guessed their way around it. Smaller, faster ones did not. Ask an agent to just acknowledge a message and it now leaves the ✅ on the first try, instead of failing three times and typing a reply nobody wanted (DOR-1292)
- Agents are also told that a thumbs-up can be the entire reply. Anything an agent writes during a room turn gets posted to the room, so an agent that reacted and then added "Done, acknowledged" left two messages where you asked for none. It now knows it can react and stop (DOR-1292)

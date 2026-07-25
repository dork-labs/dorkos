---
covers:
  - "fix(approvals): deciding an approval needs a person, and the card cannot lie (DOR-428)"
  - "fix(approvals): redact secrets before clamping, and stop anchoring the sweep (DOR-428)"
  - "fix(approvals): put the card's query container on an ancestor so the wide layout works"
---

### Security

- An agent could approve its own request. When an agent asked to do something that cannot be undone, the reply carried the code needed to retry, and nothing stopped the agent from answering the request itself. Now the agent that asked, and anything holding that retry code, is refused, and the request keeps waiting for you (DOR-428)
- The approval card could be worded to hide what would really happen. An agent could put punctuation in a package name so the card read "keeping saved data" while the real setting was "delete saved data", and pad it so the true setting scrolled out of view. Details an agent supplies now appear in quotes, each one is kept short, and a card for something that cannot be undone is never cut off (DOR-428)
- Approval cards no longer show anything that looks like a password or a code. Your agents can read the waiting list, so a card that echoed a secret back was publishing it. Cards now show only the details the action needs, and hiding a code no longer depends on where it sits in the text or how long the text is (DOR-428)
- An agent could reach further by hiding who it was. An agent held to safe, reversible actions was correctly refused, but the same agent with its name removed got sent down the "ask permission" path instead. Every caller is now held to a limit, named or not (DOR-428)
- The docs now say plainly what the approval question does and does not protect against. With no login required (the default), it stops mistakes and it stops an agent that follows the rules but was talked into something bad. It cannot stop a program that already has full run of your computer. Turn on **Require login** in Settings, under Security, and answering a request needs a real account (DOR-428)

### Fixed

- Your activity feed now records every action that cannot be undone, even when DorkOS could not tell which agent asked. Before, those ran and left no line in the feed (DOR-428)
- Your activity feed also records every yes and no you give. With login required it names the account; without it, it says the answer came from this machine and could not be checked, so an approval you never gave is something you can find (DOR-428)
- Removing or installing a package that DorkOS cannot describe exactly is now refused with a clear reason instead of failing with an unexplained error (DOR-428)

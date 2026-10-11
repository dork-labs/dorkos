---
covers:
  - "fix(trust): a stranger's words stay a stranger's through agent messages and memory (DOR-2781)"
  - 'fix(trust): close the review gaps in the outsider mark (DOR-2781)'
---

### Fixed

- A note an agent saves after reading a message from someone outside your team now says so, even when another agent passed that message on. Before, it could look like something you told the agent yourself (DOR-2781)
- An agent answering a message from someone outside your team can still add notes, but can't change or delete the ones you gave it (DOR-2781)
- A chat an agent starts while answering someone from outside your team now carries that on, so its notes are marked the same way (DOR-2781)
- An agent can no longer edit the part of a saved note that says where it came from, so a later chat can't make a note look like yours (DOR-2781)

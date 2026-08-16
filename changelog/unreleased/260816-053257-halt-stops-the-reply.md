---
covers:
  - 'fix(server): a halted room turn no longer posts its answer (DOR-1232)'
  - "fix(server): a stopped turn no longer releases the next turn's claim (DOR-1232)"
---

### Fixed

- Pressing halt in a channel now really stops the reply. The agent's answer used to show up a second or two later, right under the line saying it had been stopped (DOR-1232)
- After a halt, the next message you send is safe. The stopped agent could come back minutes later and clear the "working" mark from the turn that had replaced it — leaving the channel looking idle while an agent was mid-reply, and letting a second reply start in the same project folder (DOR-1232)

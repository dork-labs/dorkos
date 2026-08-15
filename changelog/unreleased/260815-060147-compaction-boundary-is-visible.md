---
covers:
  - 'fix(client,server): compaction boundaries render live and from history (DOR-1215, review)'
  - 'test(e2e,server,client): a compaction you can actually see — L-04 end to end (DOR-1215)'
  - 'fix(scripts): the browser-gate fixture counts EIGHT modules after the merge (DOR-1215)'
---

### Fixed

- Your agent shortens a long conversation when it starts running out of room. You now see a line in the chat marking where that happened, both at the moment it happens and when you come back to the conversation later. Before this, the line was missing, so a conversation could quietly lose its history with nothing to show for it (DOR-1215)

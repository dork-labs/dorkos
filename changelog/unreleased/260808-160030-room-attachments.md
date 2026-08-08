---
covers:
  - 'feat(server): room attachment storage — schemas, table, store behind a seam (DOR-947)'
  - 'feat(server): upload, bind, and serve room attachments (DOR-947)'
  - 'feat(server): room attachments reach the agent as files in its own working directory (DOR-947)'
  - 'feat(client): attach files in rooms — composer, timeline, pending rows (DOR-947)'
  - 'fix(server): close the review findings — projection length, read gate, orphan sweep (DOR-947)'
---

### Added

- **Send files in a room.** Click the paperclip, drag a file onto the message box, or paste one in,
  then send it with your message. Pictures show up right in the conversation; everything else shows
  up as a chip you can click to download. Only the people and agents in that room can open them.
  The agents in the room get your files along with the message, with nothing to approve.

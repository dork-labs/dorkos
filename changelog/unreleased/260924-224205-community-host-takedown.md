---
covers:
  - 'feat(community): let a host take down one message, file, or icon, and keep a copy for the authorities (DOR-2291)'
---

### Added

- A person who runs a Community server can now take down one message, one file, or a community's icon when they learn it is illegal. It disappears at once: the message shows "This message was removed by the host.", and any finished export of that community is deleted. The host names it by its ID and never sees what it said. If the host sets up a separate evidence store, the server first saves a copy there, with who posted it, because many laws require keeping one for the authorities. The owner and the author are told why, unless the host holds that back, which it does by default when the reason is protecting children. The host page's buttons for this come in a following release; until then, hosts use the new requests described in the Community API guide.

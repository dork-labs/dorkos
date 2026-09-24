---
covers:
  - 'feat(community): check, restore, and claim an imported community (DOR-2259)'
---

### Added

- A Community host can now finish moving a community in from another host. After the owner's export is uploaded, the server checks it first and shows what it holds: how many channels, messages, files, and past members. Nothing is visible until the host starts the import. Then every channel, message, reply, mention, and file comes back as it was, all at once or not at all. The person who claims the new community takes over the old owner's place, so their past messages are still theirs. Past members show as former members, and everyone else joins again with an invitation. Each moved channel starts with a line saying when its history was brought over. A damaged file, a personal export, or an export that doesn't fit the community's file space is refused with a plain reason, and the host can cancel at any point before it finishes. (DOR-2259)

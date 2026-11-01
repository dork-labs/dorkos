---
covers:
  - 'feat(client): room timelines read clearly: notices, mentions, reactions and threads (UI overhaul Phase 4 rooms A)'
---

### Changed

- Make warning lines in a room easy to read: the words are full strength and only the mark is amber
- Show an agent's mention in readable text whatever its colour; the colour stays in the background
- Give reactions and the thread reply line real 40px and 44px targets on a phone, so a tap never opens the wrong thing
- Draw reactions as soft tints with no border, with yours in orange and bold, and drop the ring burst around a new one
- Keep a message's thread line right under it, and line notices up with the message text
- Fold three or more notices in a row behind "2 earlier", keeping any warning visible
- Quieten a room's hover, focus outline and message toolbar

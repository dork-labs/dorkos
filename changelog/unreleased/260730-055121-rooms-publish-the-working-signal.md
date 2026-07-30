---
covers:
  - 'feat(rooms): rooms publish the working signal while it is true'
---

### Added

- A room now says when one of its agents is working on your message, and keeps saying it until the work is done. It also says when a reply is taking longer than usual. You will see this as a line in the room in a coming update, once the cockpit knows how to draw it
- The signal is honest by design. A room only sends it while an agent really has your message in hand. It stops as soon as the answer appears in the room, or as soon as the room explains why there is no answer. Nothing an agent decides can switch it on or keep it on
- The room repeats the signal every 10 seconds while the work lasts. So if you open a room in the middle of a long reply, or your connection drops and comes back, you learn what is happening within 10 seconds instead of looking at a room that seems empty. If the server stops, the repeats stop with it, so nothing is left saying "working" forever

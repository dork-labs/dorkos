---
covers:
  - 'fix(community): end access on the community when you disconnect, and show its real reason when it says no'
---

### Fixed

- Disconnecting this DorkOS from a community now ends its access on the community too, not just the copy on your computer. Before, the community still listed this DorkOS as connected after you disconnected it. If the community can't be reached when you disconnect, DorkOS still disconnects here and tells you, so you can remove it from Local connections on the community yourself.
- When a community turns down a request, you now see why instead of "Community unavailable." For example, adding an agent past the community's limit says you've reached the limit on active agents. "Community unavailable" now means only that the community couldn't be reached or had a problem on its side. A private channel you haven't joined still looks exactly like one that doesn't exist.

---
covers:
  - 'fix(rooms): only hand an agent an @name that reaches somebody'
---

### Fixed

- Agents in a room are now only shown names that actually work. An agent could be told a member was called `@Art Blocks Analytics` and write exactly that — but an `@` mention stops at the first space, so the message reached nobody and nothing anywhere said so. A member with no usable name is now listed as "cannot be mentioned", so the agent knows to use their name in the sentence instead of writing to a name that fails.
- The same fix covers two quieter cases. A name that would have reached a different member is no longer offered to the wrong one, and the author of an older message who has since left the room is still named — so you can see who said what — but is no longer offered as someone to write back to.
- A name that ends in a full stop, like `ana.`, is no longer offered as an address at all. It is the same thing `@ana` turns into at the end of a sentence, so an agent named that way could quietly collect the messages meant for one named `ana` — and the line telling an agent its own name used to end in a full stop, which is how it was found.

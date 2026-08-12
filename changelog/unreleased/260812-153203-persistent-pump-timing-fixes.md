---
covers:
  - "fix(server): a lightning-fast reply no longer wedges a persistent chat's next message (DOR-1187)"
  - "fix(server): Stop reaches a chat's first message while its agent is still starting (DOR-1191)"
---

### Fixed

- After an unusually fast reply, a chat that keeps its agent warm no longer gets stuck — your next message goes through instead of erroring (DOR-1187)
- Stop now works on a chat's very first message while its agent is still starting up, so a mis-send can be caught before it runs (DOR-1191)

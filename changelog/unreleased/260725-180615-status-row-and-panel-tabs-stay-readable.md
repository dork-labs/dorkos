---
covers:
  - 'fix(status): stop status items overlapping, and promote subagents only when running (DOR-461, DOR-462)'
  - 'fix(right-panel): scroll the selected tab into view (DOR-471)'
---

### Fixed

- The details under the message box no longer print on top of each other. In a narrower window the agent's name and the "how full is this conversation" percentage were drawing over the items beside them, so both were unreadable. Now anything too long shortens with a "…" instead, the row shows one fewer item when space is tight, and everything it left out is one tap away under the "⋯".
- The row is honest about helper agents again. It used to say a number of helpers on every session, because it was counting the helpers your agent _could_ call — a list that never changes. Now it appears only while helpers are actually working on your turn, and it says how many are running. It also no longer takes the last bit of space from a warning about your usage limit, which matters more.
- Your session's branch says less when the row is tight. The branch name stays; the change count and the project name move to the tooltip, where they already were.
- The tabs above the right-hand panel now scroll the tab you are on into view. If your agent opened the Canvas for you, or you dragged the panel narrower, the tab you were on could sit half off the edge with its name cut in two.

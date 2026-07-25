---
covers:
  - 'fix(status): stop status items overlapping, and promote subagents only when running (DOR-461, DOR-462)'
  - 'fix(right-panel): scroll the selected tab into view (DOR-471)'
  - 'fix(status): numbers in the status row never abbreviate (DOR-461)'
  - 'fix(status): the quietest item gives up its width first (DOR-461)'
---

### Fixed

- The details under the message box no longer print on top of each other. In a narrower window the agent's name, the "how full is this conversation" percentage and your usage figure were drawing over the items beside them, so several were unreadable. Names now shorten with a "…" when space is tight, and everything the row leaves out is one tap away under the "⋯".
- When that row runs out of space, the quietest thing on it shrinks first. Losing the live-connection warning to make room for a count of background helpers was backwards.
- Numbers in that row are never shortened. A percentage or a cost is shown in full or not at all — an 88% window used to be able to render as "8", which is not the same number. If a figure will not fit, it waits under the "⋯", where it is still exact.
- The row is honest about helper agents again. It used to say a number of helpers on every session, because it was counting the helpers your agent _could_ call — a list that never changes. Now it appears only while helpers are actually working on your turn, and it says how many are running. It also no longer takes the last bit of space from a warning about your usage limit, which matters more.
- Your session's branch says less when the row is tight: the branch name and a dot for "you have uncommitted changes" stay, and the exact count and project name move into the tooltip.
- The tabs above the right-hand panel now scroll the tab you are on into view. If your agent opened the Canvas for you, or you dragged the panel narrower, the tab you were on could sit half off the edge with its name cut in two.

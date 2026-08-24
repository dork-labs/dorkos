---
covers:
  - 'feat(site): /compare runtime pages — Claude Code, Codex, OpenCode (DOR-1465)'
  - 'fix(site): /compare reads and works on a phone — contrast, pinned labels, anchors that land (DOR-1465)'
---

### Added

- Three new pages at dorkos.ai/compare cover the coding agents DorkOS runs for you: Claude Code, Codex and OpenCode. These are not head to head pages. Each one says what the agent already does well on its own, then what having DorkOS around it adds, so you can see where the line sits before you install anything (DOR-1465)
- Each page scores the agent honestly on its own merits, with a link to the maker's own documentation behind every claim and the date someone last checked it. Where an agent already does something DorkOS does, the page says so instead of quietly leaving it out (DOR-1465)

### Fixed

- The comparison tables now work on a phone. The row label stays put while you scroll sideways, so you can always see which point you are reading, and the edge of the table fades to show there is more to the right. Before, the whole second column was hidden with nothing to hint at it (DOR-1465)
- Small grey text on the comparison pages is darker, so table headings, links and labels are easier to read and meet accessibility contrast standards (DOR-1465)
- Links like "More on this" and "Back to the table" now land where they should. They used to jump to a spot hidden behind the top bar (DOR-1465)
- The Cursor comparison now says that Cursor has a phone app, a web dashboard and a Slack integration, which it gained since the page was written. You can also reach the comparison pages from the site footer (DOR-1465)

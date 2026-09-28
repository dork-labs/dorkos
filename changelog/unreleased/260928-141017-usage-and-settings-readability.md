---
covers:
  - 'fix(client): say "· old" after a stale usage number and fix four contrast and heading issues'
  - 'fix(client): charge a stale usage item two status slots, and tone its popover rows'
  - 'fix(client): show the usage tooltip notes in its own text color'
  - 'fix(client): make the usage tooltip''s labels readable and read "· old" from one clock'
  - 'fix(client): make the context, subagents and session-row tooltip text readable'
  - 'fix(client): darken the light warning text so amber reads on the sidebar'
---

### Fixed

- A usage number in the status bar that is more than an hour old now says "· old" after it, instead of only turning a lighter gray that was hard to read. The amber and red usage numbers, the notes under them when you open or point at usage, the small gray text in the tooltips for context, subagents and session rows, and the green "Ready" on a runtime in Settings, are easier to read too. In Settings, the Codex and OpenCode usage sections now have names a screen reader can tell apart, and the section headings on each runtime no longer skip a level. Amber warning text in light mode is a little darker, so it stays easy to read on the sidebar too.

---
covers:
  - 'feat(client): one row and one section header for the whole sidebar, at the new density (DOR-1062)'
---

### Changed

- The sidebar is tighter and quieter. It is now 272 pixels wide instead of 320, every row
  starts 16 pixels from the edge instead of 30, and section names read as words
  ("Direct messages") rather than as SHOUTING. Rows are 13px on a 28px line, so more of
  your work fits on screen without anything feeling cramped.
- Sections and rows no longer have hairlines between them. Where there used to be a line
  under the header and above the footer, there is now a faint tint and a soft shadow that
  appears only when there is more to scroll to — so the panel reads as one surface instead
  of three stacked boxes. The tint works the same way in light and dark mode.
- Nothing is drawn until you reach for it. A section's own icon turns into a collapse arrow
  when you hover it or tab to it, and the "more" menu on a row is a small vertical `⋮` that
  appears on hover **and** on keyboard focus — so everything the menu offers is reachable
  without a mouse, and on a device with no right-click.
- Every row in the sidebar is now built from the same template: a mark, who it belongs to,
  what it is called, and its badges. A session says which agent it belongs to
  ("Scout › fix the flaky test"); a channel or a conversation does not, because it is the
  place itself. Long agent names can no longer squeeze out the title, and the full name is
  always in the tooltip. A row only grows a second line when there is something real to put
  on it.

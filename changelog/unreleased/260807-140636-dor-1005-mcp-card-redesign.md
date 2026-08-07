---
covers:
  - 'feat(client): MCP servers become cards that say what is happening and what to do (DOR-1005)'
  - 'fix(client): the card panel stops guessing — about order, about origin, and about what it can undo (DOR-1005)'
---

### Changed

- Every MCP server on an agent is now a card instead of a cramped row. The card says the
  server's name, where it came from, how it is doing, and one plain sentence about what to do
  next — with the single button for that one thing right underneath. Everything else lives
  behind a "⋯" menu. Long names no longer get chopped to "plugin:cont…" (DOR-1005).
- Each card says where its server came from: added to this agent, from this project, from a
  plugin, or from your computer-wide setup. Hover the badge and it explains itself. A server
  a plugin brought with it shows its clean name, with the raw one kept in Details. When
  DorkOS cannot tell where a server came from, it says nothing rather than guessing
  (DOR-1005).
- The cards are sorted when you open the panel — anything that needs you goes to the top —
  and then they hold still. A card you are in the middle of signing in to will never slide
  out from under you. The next time you open the panel, it sorts again. The sort waits for
  everything DorkOS knows about your servers to arrive first, so a server that cannot be
  reached always makes it to the top instead of getting stranded at the bottom (DOR-1005).
- Plain words replace the system's own: "Needs sign-in", "Can't reach", "Setup problem",
  "Uses your key", "Off". A server nothing has checked yet now says "Not checked yet" instead
  of spinning on "Connecting…" forever. The exact error a broken server gave has moved into
  Details, where you can read it when you want it (DOR-1005).
- Signing in shows a short, calm note first: your sign-in stays on this computer, you approve
  it on the other service's own site, DorkOS keeps the key here, the agent never sees it, and
  removing the server removes the key. There is now a Cancel button if you change your mind
  (DOR-1005).
- Every card has a Details section. It says how the server signs in, where it lives — the web
  address for a remote one, the command for one on your computer — and, for a broken one, the
  exact error. It only shows what it actually knows (DOR-1005).
- The on/off switch is on every card now, not just some. A server you have turned off is
  dimmed with its switch off, and flipping it back on is all there is to it (DOR-1005).
- Adding a server the project already had now says what you get — "Manage it here to enable,
  disable, or sign in from DorkOS" — instead of talking about bringing it under management
  (DOR-1005).

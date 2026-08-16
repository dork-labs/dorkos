---
covers:
  - 'feat(client): the Profile docks in the right panel on a session (DOR-1254)'
  - 'fix(client): a link that asks for the profile panel wins over a remembered layout (DOR-1254)'
  - 'fix(client): the docked panel asks before discarding, and each panel asks only about its own (DOR-1254)'
  - 'fix(client): a pending profile link is spent by the agent it named (DOR-1254)'
---

### Changed

- The right panel's "Agent Profile" tab is now simply **Profile**, and it shows the same profile you get from the Team page — the picture, the rows, the pages — docked next to the session you are in. ⌘⇧A still opens it. Old links keep working: anything pointing at the Agent Hub lands on the profile instead (DOR-1254)
- A profile you open from inside another one — an agent's owner, or an agent someone looks after — now has a link back to where you came from, at the top of the panel (DOR-1254)
- Opening a profile from a link no longer keeps other agents' panels open behind it, and no longer wipes a page you were reading when something else changes the address (DOR-1254)
- Closing the panel while you have unsaved words in an agent's Instructions or Boundaries now asks first, the way stepping back out of the page already did (DOR-1254)

---
covers:
  - 'feat(client): the Profile docks in the right panel on a session (DOR-1254)'
  - 'fix(client): a link that asks for the profile panel wins over a remembered layout (DOR-1254)'
  - 'fix(client): the docked panel asks before discarding, and each panel asks only about its own (DOR-1254)'
  - 'fix(client): a pending profile link is spent by the agent it named (DOR-1254)'
  - 'fix(client): a link for an agent whose session you are not in still opens (DOR-1254)'
  - 'fix(client): a profile link stops applying once you move to another agent (DOR-1254)'
  - 'fix(client): a same-session ?profile= link docks through the link opener, so a late layout cannot shut it (DOR-1254)'
---

### Changed

- The right panel's "Agent Profile" tab is now simply **Profile**, and it shows the same profile you get from the Team page — the picture, the rows, the pages — docked next to the session you are in. ⌘⇧A still opens it. Old links keep working: anything pointing at the Agent Hub lands on the profile instead (DOR-1254)
- A profile you open from inside another one — an agent's owner, or an agent someone looks after — now has a link back to where you came from, at the top of the panel (DOR-1254)
- A link to an agent's profile opens it even when you are in a different agent's session. Once you move on to another agent, that agent's panel is however you left it — the link stops applying (DOR-1254)
- Reading a page in the docked profile survives something else changing the address, so a page you were part-way through is not swapped out from under you (DOR-1254)
- Closing the panel while you have unsaved words in an agent's Instructions or Boundaries now asks first, the way stepping back out of the page already did (DOR-1254)

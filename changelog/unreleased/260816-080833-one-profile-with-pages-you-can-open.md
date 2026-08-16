---
covers:
  - 'feat(client): one Profile — portrait header, property rows, push-in pages (DOR-1252)'
  - 'fix(client): quiet the profile — the identity rule, a clear corner, no empty rows (DOR-1252)'
  - 'feat(client): the Rooms row and page, on the real roster data (DOR-1252)'
  - "refactor(client): retire the drawer's name from the profile's neighbours (DOR-1252)"
---

### Changed

- A profile is now a card with a picture at the top and a list of rows under it. You see who someone is, what their agent is doing right now, and — for a person — which agents they look after. Tap a row and the whole panel slides over to that page, with a link back at the top (DOR-1252)
- An agent's profile says who manages it, right under its name. Tap that line to open their profile; tap an agent in their list to come back the other way (DOR-1252)
- Your own name, handle and photo are now editable from your profile as well as from Settings › Profile, which stays where it was (DOR-1252)
- The line under a name says what is happening in words — "Working in #team · 2 min", "Last active 3 h ago", "Hasn't run yet" — instead of the old "Active in the last hour", which was really about when we last heard from the machine (DOR-1252)
- The Message button only appears when it has somewhere to go, so there is no longer a button that does nothing on a person or on the agent you are already talking to (DOR-1252)
- A profile lists the rooms that person or agent is in, and tapping one takes you there (DOR-1252)

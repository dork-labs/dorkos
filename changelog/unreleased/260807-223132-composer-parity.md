---
covers:
  - 'feat(client): extract the features/composer slice — one composer family for every surface (DOR-946)'
  - 'feat(client): Composer.Root and Composer.OverlayLane (DOR-946)'
  - 'fix(client): phase-1 review fixes — one door into the composer slice (DOR-946)'
  - 'refactor(client): ChatInputContainer composes Composer.Root and OverlayLane (DOR-946)'
  - 'refactor(client): the dashboard hero composer adopts Composer.Root (DOR-946)'
  - "fix(client): ChatPanel's barrel mock needs the card and the lane (DOR-946)"
  - "refactor(client): the room composer sits in the same card as chat's (DOR-946)"
---

### Changed

- The message box in a room now sits in the same rounded card as the one in chat, instead of a strip ruled off with a line. Rooms and the home screen used to draw their own version of the box; there is one box now, in one place, so it looks the same everywhere you type. Typing, sending, drafts and shortcuts all work exactly as they did. (DOR-946)

---
covers:
  - 'fix(server): in a direct message, the answer an agent works out is the one it sends (DOR-1643)'
---

### Fixed

- Fixed agents going silent in direct messages when you let them decide for themselves when to speak (Settings, under Experiments). An agent would work out a good answer, write it somewhere nobody could read, and send nothing — and then reply to a plain "thanks" with a pleasantry. Now the answer it works out is the one you get, and a thanks can just sit there (DOR-1643)

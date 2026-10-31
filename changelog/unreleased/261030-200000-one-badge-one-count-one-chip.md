---
covers:
  - 'feat(client): one badge, one count and one chip, and a number only for what is aimed at you'
  - 'fix(client): a mention pill stays on one line unless its name is too long to fit'
---

### Changed

- Badges are one quiet grey pill now. A warning, an error or a success shows its own icon in colour, and the words stay easy to read on every background.
- Counts say who they are for: orange for a mention or a direct message, amber for something waiting on you, red for a failure, grey for everything else.
- A channel nobody mentioned you in no longer shows a number, in the command palette or a community's channel list. Its name goes bold instead.
- A direct message counts up to 99+ instead of stopping at 9+. Mentions still stop at 9+, because that is as far as they are counted.
- A cc in a message now says "cc" before the name, so you can tell it from a mention without relying on its colour.

### Fixed

- Removing a filter chip now moves keyboard focus to the next chip instead of losing it, and its × is big enough to tap on a phone.
- A "Set here" chip on a setting now shows the keyboard focus ring.

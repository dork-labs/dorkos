---
covers:
  - "refactor(client): the sidebar's live-session chip reads the one count the model already had (DOR-1366)"
---

### Changed

- The "2 live" chip on an agent's row in the sidebar now counts the same sessions as the "N working" line at the top of the panel. The two could show different numbers for the same agent before this. A turn that has paused to ask you something no longer adds to the chip, because the dot on the agent's face and the Heads up list already tell you it is waiting. That does mean the chip and the "Live now" list inside the session switcher can differ by one while a conversation is paused waiting on you: the chip counts what is running, the list counts what is still open (DOR-1366)

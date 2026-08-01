---
covers:
  - 'feat(shared): permission modes carry machine-readable meaning'
  - 'feat(server): every runtime declares what each of its permission modes does'
  - 'feat(client): warnings about a permission mode come from what it does'
---

### Changed

- Every permission mode a runtime offers now says what it actually does — when it stops to ask you, how far it can reach, and one plain sentence about the consequence. Warnings on screen are worked out from that instead of from a list of mode names kept in the app, so a mode a new agent invents is described correctly the day it arrives. Nothing looks different yet, with one exception: Claude's Auto mode is no longer tinted red. It still raises an approval card for the risky calls, and red is now reserved for the one setting that never asks about anything, anywhere.

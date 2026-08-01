---
covers:
  - 'fix(chat): a chip tray you opened stays open when the turn finishes (DOR-827)'
  - 'fix(client): the working breath fades without growing (DOR-828)'
---

### Fixed

- **Open the list of everything a turn touched, and it stays open when the turn finishes.** While an agent works, the strip under its reply shows the last few files, pages and commands it handled, and you can open the pile to see the whole list. That list used to slam shut the moment the turn ended — usually the moment you were reading it, because the turn ending is what makes the list worth reading. It now stays exactly as you left it, and closes when you say so (DOR-827).

- **The "working" pulse fades instead of also growing.** The soft pulse on thinking text, loading placeholders and status dots was nudging each element about 2% larger and back, over and over. It was barely visible and never worth the wobble on a line of text, so it is now a pure fade — the same quiet signal, on something that sits still (DOR-828).
